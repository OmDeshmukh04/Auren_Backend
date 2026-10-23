import { sql } from 'kysely';
import { z } from 'zod';
import type { Executor } from '../../db/index.js';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { Id, IdParams, Ok, Timestamp, Version } from '../../http/schemas.js';
import { conflict, notFound, unprocessable, validationFailed } from '../../http/errors.js';
import { audit } from '../../domain/audit.js';
import { updateVersioned } from '../../domain/records.js';
import { AnswerType, DisplayCondition, FormLayout, ItemField, QuestionOption, QuestionValidation, type FormLayoutT } from './layout.js';

const FormKey = z.enum(['family_enquiry', 'candidate_application']);
const CORE_SECTIONS: Record<string, string[]> = {
  family_enquiry: ['contact', 'household', 'role'],
  candidate_application: ['contact', 'experience', 'employment', 'qualifications', 'preferences', 'references', 'documents']
};

const Question = z
  .object({
    key: z.string(), scope: z.enum(['family_enquiry', 'candidate_application']), answerType: AnswerType, label: z.string(), helpText: z.string().nullable(),
    options: z.array(QuestionOption), validation: z.unknown(), itemFields: z.array(ItemField), classification: z.enum(['standard', 'contact', 'sensitive']),
    filterable: z.boolean(), status: z.enum(['active', 'retired']), usedInPublishedVersion: z.boolean(), version: Version, updatedAt: Timestamp
  })
  .meta({ id: 'QuestionDefinition' });

const DraftLayout = z
  .object({
    sections: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), title: z.string().min(1).max(160), description: z.string().max(1000).optional(), core: z.boolean(), questions: z.array(z.object({ key: z.string(), required: z.boolean().default(false), showIf: DisplayCondition.optional() })).max(60) })).min(1).max(20),
    requiredConsents: z.array(z.enum(['accuracy_attestation', 'privacy_notice', 'reference_contact_authorization', 'presentation_sharing'])).default([]),
    optionalConsents: z.array(z.enum(['reference_contact_authorization', 'presentation_sharing', 'marketing_email'])).default([]),
    documents: z.object({ allowedTypes: z.array(z.enum(['resume', 'certificate', 'photo', 'introduction', 'reference_letter'])), requiredTypes: z.array(z.enum(['resume', 'certificate', 'photo', 'introduction', 'reference_letter'])).default([]) }).optional(),
    minimumReferences: z.int().min(0).max(10).optional(),
    minimumEmployments: z.int().min(0).max(10).optional()
  })
  .meta({ id: 'FormLayoutDraft', description: 'Question entries reference question keys; definitions are embedded when the version is published.' });

const FormVersion = z
  .object({ id: Id, formKey: FormKey, versionNumber: z.int(), status: z.enum(['draft', 'published', 'retired']), layout: z.unknown(), notes: z.string().nullable(), publishedAt: Timestamp.nullable(), retiredAt: Timestamp.nullable(), createdAt: Timestamp, version: Version })
  .meta({ id: 'FormVersion' });

async function usedQuestionKeys(db: Executor) {
  const rows = await db.selectFrom('formVersions').select('layout').where('status', '<>', 'draft').execute();
  return new Set(rows.flatMap(row => (row.layout as FormLayoutT).sections.flatMap(section => section.questions.map(q => q.key))));
}

async function validateDraftLayout(db: Executor, formKey: string, layout: z.infer<typeof DraftLayout>) {
  const errors: Array<{ path: string; code: string; message: string }> = [];
  const keys = layout.sections.map(s => s.key);
  for (const core of CORE_SECTIONS[formKey]!) {
    if (!layout.sections.some(s => s.key === core && s.core)) errors.push({ path: 'layout.sections', code: 'core_section_required', message: `The core section "${core}" cannot be removed` });
  }
  if (new Set(keys).size !== keys.length) errors.push({ path: 'layout.sections', code: 'duplicate', message: 'Section keys must be unique' });
  const questionKeys = layout.sections.flatMap(s => s.questions.map(q => q.key));
  if (new Set(questionKeys).size !== questionKeys.length) errors.push({ path: 'layout.sections', code: 'duplicate', message: 'A question can appear only once in a form' });
  const definitions = questionKeys.length ? await db.selectFrom('questionDefinitions').select(['key', 'scope', 'status']).where('key', 'in', questionKeys).execute() : [];
  layout.sections.forEach((section, s) =>
    section.questions.forEach((question, q) => {
      const definition = definitions.find(d => d.key === question.key);
      if (!definition) errors.push({ path: `layout.sections.${s}.questions.${q}.key`, code: 'unknown_question', message: `No question "${question.key}"` });
      else if (definition.scope !== formKey) errors.push({ path: `layout.sections.${s}.questions.${q}.key`, code: 'wrong_scope', message: 'This question belongs to the other form' });
      else if (definition.status !== 'active') errors.push({ path: `layout.sections.${s}.questions.${q}.key`, code: 'retired', message: 'This question is retired' });
      if (question.showIf && !questionKeys.includes(question.showIf.questionKey)) errors.push({ path: `layout.sections.${s}.questions.${q}.showIf`, code: 'invalid', message: 'The condition refers to a question not in this form' });
    })
  );
  if (errors.length) throw validationFailed(errors);
}

/** What publishing this version would change, for the owner's review. */
async function impactOf(db: Executor, versionId: string) {
  const version = await db.selectFrom('formVersions').select(['formKey', 'layout']).where('id', '=', versionId).executeTakeFirst();
  if (!version) throw notFound('Form version');
  const current = await db.selectFrom('formDefinitions as f').innerJoin('formVersions as v', 'v.id', 'f.currentVersionId').select(['v.id', 'v.layout']).where('f.key', '=', version.formKey).executeTakeFirst();
  const layout = version.layout as FormLayoutT;
  const currentLayout = (current?.layout as FormLayoutT | undefined) ?? { sections: [] as FormLayoutT['sections'] };
  const now = layout.sections.flatMap(s => s.questions);
  const before = currentLayout.sections.flatMap(s => s.questions);
  const removed = before.filter(q => !now.some(n => n.key === q.key)).map(q => q.key);
  const added = now.filter(q => !before.some(b => b.key === q.key)).map(q => q.key);
  const newlyRequired = now.filter(q => q.required && !before.some(b => b.key === q.key && b.required)).map(q => q.key);
  const activeDrafts = current && version.formKey === 'candidate_application'
    ? Number((await db.selectFrom('applicationDrafts').select(eb => eb.fn.countAll<number>().as('n')).where('formVersionId', '=', current.id).where('status', '=', 'active').executeTakeFirstOrThrow()).n)
    : 0;
  const searches = removed.length ? await db.selectFrom('savedSearches').select(['id', 'name', 'criteria']).execute() : [];
  const affectedSearches = searches.filter(s => removed.some(key => JSON.stringify(s.criteria).includes(`"${key}"`))).map(s => ({ id: s.id, name: s.name }));
  return { formKey: version.formKey, removedQuestions: removed, addedQuestions: added, newlyRequiredQuestions: newlyRequired, activeDraftsOnCurrentVersion: activeDrafts, savedSearchesUsingRemovedQuestions: affectedSearches };
}

export const formRoutes: AnyRoute[] = [
  defineRoute({ method: 'GET', path: '/questions', operationId: 'listQuestions', summary: 'Owner-defined questions', tags: ['Forms'], access: { kind: 'staff', permission: 'forms.read' },
    query: z.object({ scope: FormKey.optional(), status: z.enum(['active', 'retired']).optional() }),
    response: z.object({ items: z.array(Question) }),
    async handler({ deps, query }) {
      let q = deps.db.selectFrom('questionDefinitions').selectAll();
      if (query.scope) q = q.where('scope', '=', query.scope);
      if (query.status) q = q.where('status', '=', query.status);
      const [rows, used] = await Promise.all([q.orderBy('scope').orderBy('label').execute(), usedQuestionKeys(deps.db)]);
      return { items: rows.map(row => ({ ...row, usedInPublishedVersion: used.has(row.key) })) as never };
    } }),
  defineRoute({ method: 'POST', path: '/questions', operationId: 'createQuestion', summary: 'Define a new question (its key is permanent)', tags: ['Forms'], access: { kind: 'staff', permission: 'forms.write' },
    body: z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/), scope: FormKey, answerType: AnswerType, label: z.string().trim().min(1).max(300), helpText: z.string().max(1000).nullable().optional(),
      options: z.array(QuestionOption).max(50).default([]), validation: QuestionValidation, itemFields: z.array(ItemField).max(15).default([]),
      classification: z.enum(['standard', 'contact', 'sensitive']).default('standard'), filterable: z.boolean().default(false)
    }).superRefine((v, ctx) => {
      if (['single_choice', 'multiple_choice'].includes(v.answerType) && v.options.length < 2) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least two options' });
      if (v.answerType === 'repeating_group' && !v.itemFields.length) ctx.addIssue({ code: 'custom', path: ['itemFields'], message: 'Add the fields of each entry' });
      if (v.filterable && v.classification === 'sensitive') ctx.addIssue({ code: 'custom', path: ['filterable'], message: 'Sensitive answers cannot be used as search filters' });
    }),
    response: Question, status: 201,
    async handler({ deps, meta, staff, body }) {
      const existing = await deps.db.selectFrom('questionDefinitions').select('key').where('key', '=', body.key).executeTakeFirst();
      if (existing) throw conflict('A question with this key already exists.', 'key_taken');
      const row = await deps.db.insertInto('questionDefinitions').values({ ...body, helpText: body.helpText ?? null, options: JSON.stringify(body.options), validation: JSON.stringify(body.validation), itemFields: JSON.stringify(body.itemFields), createdBy: staff.staffId, createdAt: meta.now.toISOString() }).returningAll().executeTakeFirstOrThrow();
      await audit(deps.db, meta, { action: 'question.created', subjectType: 'question', subjectId: body.key });
      return { ...row, usedInPublishedVersion: false } as never;
    } }),
  defineRoute({ method: 'PATCH', path: '/questions/:key', operationId: 'updateQuestion', summary: 'Edit a question (label/help/options/limits) or retire it', description: 'Keys never change. Once used in a published form, the answer type is fixed and existing option values cannot be removed (retire them instead). Published forms keep their frozen copy until a new version is published.', tags: ['Forms'], access: { kind: 'staff', permission: 'forms.write' },
    params: z.object({ key: z.string() }),
    body: z.object({ version: Version, label: z.string().trim().min(1).max(300).optional(), helpText: z.string().max(1000).nullable().optional(), options: z.array(QuestionOption).max(50).optional(), validation: QuestionValidation.optional(), itemFields: z.array(ItemField).max(15).optional(), filterable: z.boolean().optional(), status: z.enum(['active', 'retired']).optional() }),
    response: Question,
    async handler({ deps, meta, params, body }) {
      const current = await deps.db.selectFrom('questionDefinitions').selectAll().where('key', '=', params.key).executeTakeFirst();
      if (!current) throw notFound('Question');
      const used = (await usedQuestionKeys(deps.db)).has(params.key);
      if (used && body.options) {
        const removedValues = (current.options as Array<{ value: string }>).filter(o => !body.options!.some(n => n.value === o.value)).map(o => o.value);
        if (removedValues.length) throw unprocessable(`Option values in use cannot be removed: ${removedValues.join(', ')}. Mark them retired instead.`, 'option_in_use');
      }
      if (body.filterable && current.classification === 'sensitive') throw unprocessable('Sensitive answers cannot be used as search filters.', 'sensitive_not_filterable');
      const { version, ...rest } = body;
      const values: Record<string, unknown> = { ...rest };
      for (const key of ['options', 'validation', 'itemFields']) if (values[key] !== undefined) values[key] = JSON.stringify(values[key]);
      const updated = await deps.db.updateTable('questionDefinitions').set({ ...values, version: sql`version + 1` }).where('key', '=', params.key).where('version', '=', version).returningAll().executeTakeFirst();
      if (!updated) throw conflict('This question was changed by someone else.', 'version_conflict', { currentVersion: current.version });
      await audit(deps.db, meta, { action: 'question.updated', subjectType: 'question', subjectId: params.key, metadata: { fields: Object.keys(rest) } });
      return { ...updated, usedInPublishedVersion: used } as never;
    } }),
  defineRoute({ method: 'GET', path: '/forms', operationId: 'listForms', summary: 'Forms with current published and draft versions', tags: ['Forms'], access: { kind: 'staff', permission: 'forms.read' },
    response: z.object({ items: z.array(z.object({ key: FormKey, name: z.string(), currentVersionId: Id.nullable(), currentVersionNumber: z.int().nullable(), draftVersionId: Id.nullable() })) }),
    async handler({ deps }) {
      const rows = await deps.db.selectFrom('formDefinitions as f').leftJoin('formVersions as v', 'v.id', 'f.currentVersionId').select(['f.key', 'f.name', 'f.currentVersionId', 'v.versionNumber as currentVersionNumber', sql<string | null>`(select id from form_versions d where d.form_key = f.key and d.status = 'draft' limit 1)`.as('draftVersionId')]).execute();
      return { items: rows as never };
    } }),
  defineRoute({ method: 'GET', path: '/forms/:formKey/versions', operationId: 'listFormVersions', summary: 'Version history of a form', tags: ['Forms'], access: { kind: 'staff', permission: 'forms.read' },
    params: z.object({ formKey: FormKey }), response: z.object({ items: z.array(FormVersion) }),
    async handler({ deps, params }) { return { items: (await deps.db.selectFrom('formVersions').selectAll().where('formKey', '=', params.formKey).orderBy('versionNumber', 'desc').execute()) as never }; } }),
  defineRoute({ method: 'PUT', path: '/forms/:formKey/draft', operationId: 'saveFormDraft', summary: 'Create or replace the draft version of a form', tags: ['Forms'], access: { kind: 'staff', permission: 'forms.write' },
    params: z.object({ formKey: FormKey }), body: z.object({ layout: DraftLayout, notes: z.string().max(1000).optional() }), response: FormVersion,
    async handler({ deps, meta, staff, params, body }) {
      await validateDraftLayout(deps.db, params.formKey, body.layout);
      const draft = await deps.db.transaction().execute(async trx => {
        await trx.deleteFrom('formVersions').where('formKey', '=', params.formKey).where('status', '=', 'draft').execute();
        const last = await trx.selectFrom('formVersions').select(eb => eb.fn.max('versionNumber').as('n')).where('formKey', '=', params.formKey).executeTakeFirst();
        return trx.insertInto('formVersions').values({ formKey: params.formKey, versionNumber: Number(last?.n ?? 0) + 1, layout: JSON.stringify(body.layout), notes: body.notes ?? null, createdBy: staff.staffId, createdAt: meta.now.toISOString() }).returningAll().executeTakeFirstOrThrow();
      });
      await audit(deps.db, meta, { action: 'form.draft_saved', subjectType: 'form', subjectId: params.formKey, metadata: { version: draft.versionNumber } });
      return draft as never;
    } }),
  defineRoute({ method: 'GET', path: '/forms/versions/:id/impact', operationId: 'getFormVersionImpact', summary: 'What publishing this version changes (drafts, filters, removed and newly required questions)', tags: ['Forms'], access: { kind: 'staff', permission: 'forms.read' }, params: IdParams,
    response: z.object({ formKey: z.string(), removedQuestions: z.array(z.string()), addedQuestions: z.array(z.string()), newlyRequiredQuestions: z.array(z.string()), activeDraftsOnCurrentVersion: z.int(), savedSearchesUsingRemovedQuestions: z.array(z.object({ id: Id, name: z.string() })) }).meta({ id: 'FormVersionImpact' }),
    async handler({ deps, params }) { return impactOf(deps.db, params.id); } }),
  defineRoute({ method: 'POST', path: '/forms/versions/:id/publish', operationId: 'publishFormVersion', summary: 'Publish a draft: embed frozen question definitions and make it current', description: 'Drafts started on the previous version follow the agency\'s draft form-change policy.', tags: ['Forms'], access: { kind: 'staff', permission: 'forms.publish' }, params: IdParams,
    body: z.object({ version: Version }), response: FormVersion,
    async handler({ deps, meta, staff, params, body }) {
      const published = await deps.db.transaction().execute(async trx => {
        const draft = await trx.selectFrom('formVersions').selectAll().where('id', '=', params.id).forUpdate().executeTakeFirst();
        if (!draft) throw notFound('Form version');
        if (draft.status !== 'draft') throw unprocessable('Only a draft can be published.', 'not_draft');
        const layout = DraftLayout.parse(draft.layout);
        await validateDraftLayout(trx, draft.formKey, layout);
        const keys = layout.sections.flatMap(s => s.questions.map(q => q.key));
        const definitions = keys.length ? await trx.selectFrom('questionDefinitions').selectAll().where('key', 'in', keys).execute() : [];
        const frozen: FormLayoutT = FormLayout.parse({
          ...layout,
          sections: layout.sections.map(section => ({
            ...section,
            questions: section.questions.map(q => {
              const d = definitions.find(def => def.key === q.key)!;
              return { ...q, definition: { key: d.key, answerType: d.answerType, label: d.label, helpText: d.helpText, options: d.options, validation: d.validation, itemFields: d.itemFields, classification: d.classification, filterable: d.filterable } };
            })
          }))
        });
        await trx.updateTable('formVersions').set({ status: 'retired', retiredAt: meta.now.toISOString() }).where('formKey', '=', draft.formKey).where('status', '=', 'published').execute();
        // Layout is set while still a draft (published versions are frozen by trigger).
        await updateVersioned(trx, 'formVersions', params.id, body.version, { layout: JSON.stringify(frozen) }, 'Form version');
        const row = await trx.updateTable('formVersions').set({ status: 'published', publishedAt: meta.now.toISOString(), publishedBy: staff.staffId }).where('id', '=', params.id).returningAll().executeTakeFirstOrThrow();
        await trx.updateTable('formDefinitions').set({ currentVersionId: params.id }).where('key', '=', draft.formKey).execute();
        await audit(trx, meta, { action: 'form.published', subjectType: 'form', subjectId: draft.formKey, metadata: { version: draft.versionNumber } });
        return row;
      });
      return published as never;
    } }),
  defineRoute({ method: 'DELETE', path: '/forms/versions/:id', operationId: 'discardFormDraft', summary: 'Discard a draft form version', tags: ['Forms'], access: { kind: 'staff', permission: 'forms.write' }, params: IdParams, response: Ok,
    async handler({ deps, meta, params }) {
      const result = await deps.db.deleteFrom('formVersions').where('id', '=', params.id).where('status', '=', 'draft').executeTakeFirst();
      if (!result.numDeletedRows) throw notFound('Draft form version');
      await audit(deps.db, meta, { action: 'form.draft_discarded', subjectType: 'form_version', subjectId: params.id });
      return { ok: true as const };
    } })
];
