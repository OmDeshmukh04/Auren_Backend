import { z } from 'zod';
import type { Executor } from '../../db/index.js';
import type { FieldError } from '../../http/errors.js';
import { unavailable } from '../../http/errors.js';

/**
 * Form version layouts. Core sections have fixed, typed fields (see the section schemas); the
 * owner adds custom questions to sections. Publishing embeds a frozen copy of each question
 * definition so a later label edit never changes what an applicant saw.
 */

export const AnswerType = z.enum(['short_text', 'long_text', 'number', 'yes_no', 'date', 'single_choice', 'multiple_choice', 'repeating_group']);

export const QuestionOption = z.object({ value: z.string().regex(/^[a-z0-9_]{1,60}$/), label: z.string().min(1).max(200), retired: z.boolean().optional() });

export const QuestionValidation = z
  .object({
    minLength: z.int().min(0).optional(),
    maxLength: z.int().min(1).max(10000).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    minItems: z.int().min(0).optional(),
    maxItems: z.int().min(1).max(50).optional()
  })
  .default({});

export const ItemField = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  label: z.string().min(1).max(200),
  answerType: z.enum(['short_text', 'long_text', 'number', 'yes_no', 'date', 'single_choice']),
  required: z.boolean().default(false),
  options: z.array(QuestionOption).default([])
});

export const FrozenQuestion = z
  .object({
    key: z.string(),
    answerType: AnswerType,
    label: z.string(),
    helpText: z.string().nullable().optional(),
    options: z.array(QuestionOption).default([]),
    validation: QuestionValidation,
    itemFields: z.array(ItemField).default([]),
    classification: z.enum(['standard', 'contact', 'sensitive']).default('standard'),
    filterable: z.boolean().default(false)
  })
  .meta({ id: 'FormQuestion' });

export const DisplayCondition = z
  .object({ questionKey: z.string(), equals: z.union([z.string(), z.number(), z.boolean()]).optional(), in: z.array(z.string()).optional(), isAnswered: z.boolean().optional() })
  .meta({ id: 'FormDisplayCondition', description: 'Show the question only when another custom answer matches.' });

export const LayoutQuestion = z
  .object({ key: z.string(), required: z.boolean().default(false), showIf: DisplayCondition.optional(), definition: FrozenQuestion.optional() })
  .meta({ id: 'FormLayoutQuestion' });

export const LayoutSection = z
  .object({ key: z.string(), title: z.string(), description: z.string().optional(), core: z.boolean(), questions: z.array(LayoutQuestion).default([]) })
  .meta({ id: 'FormSection' });

export const FormLayout = z
  .object({
    sections: z.array(LayoutSection),
    requiredConsents: z.array(z.string()).default([]),
    optionalConsents: z.array(z.string()).default([]),
    documents: z.object({ allowedTypes: z.array(z.string()), requiredTypes: z.array(z.string()).default([]) }).optional(),
    minimumReferences: z.int().min(0).optional(),
    minimumEmployments: z.int().min(0).optional()
  })
  .meta({ id: 'FormLayout' });
export type FormLayoutT = z.infer<typeof FormLayout>;

export async function currentFormVersion(db: Executor, formKey: 'family_enquiry' | 'candidate_application') {
  const row = await db
    .selectFrom('formDefinitions as f')
    .innerJoin('formVersions as v', 'v.id', 'f.currentVersionId')
    .select(['v.id', 'v.formKey', 'v.versionNumber', 'v.layout', 'v.publishedAt', 'v.status'])
    .where('f.key', '=', formKey)
    .executeTakeFirst();
  if (!row || row.status !== 'published') throw unavailable('This form is not available right now.', 'form_unavailable');
  return { ...row, layout: FormLayout.parse(row.layout) };
}

export async function formVersionById(db: Executor, id: string) {
  const row = await db.selectFrom('formVersions').select(['id', 'formKey', 'versionNumber', 'layout', 'publishedAt', 'status']).where('id', '=', id).executeTakeFirst();
  return row ? { ...row, layout: FormLayout.parse(row.layout) } : null;
}

function conditionMet(condition: z.infer<typeof DisplayCondition> | undefined, answers: Record<string, unknown>) {
  if (!condition) return true;
  const value = answers[condition.questionKey];
  const answered = value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
  if (condition.isAnswered !== undefined) return condition.isAnswered === answered;
  if (condition.equals !== undefined) return value === condition.equals;
  if (condition.in) return Array.isArray(value) ? value.some(item => condition.in!.includes(String(item))) : condition.in.includes(String(value));
  return answered;
}

function validateValue(question: z.infer<typeof FrozenQuestion>, value: unknown, path: string, errors: FieldError[]) {
  const v = question.validation ?? {};
  const allowedOptions = new Set(question.options.filter(option => !option.retired).map(option => option.value));
  const fail = (message: string, code = 'invalid') => errors.push({ path, code, message });
  switch (question.answerType) {
    case 'short_text':
    case 'long_text': {
      if (typeof value !== 'string') return fail('Enter text');
      const max = v.maxLength ?? (question.answerType === 'short_text' ? 300 : 5000);
      if (value.length > max) fail(`Use at most ${max} characters`, 'too_big');
      if (v.minLength && value.trim().length < v.minLength) fail(`Use at least ${v.minLength} characters`, 'too_small');
      return;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('Enter a number');
      if (v.min !== undefined && value < v.min) fail(`Must be at least ${v.min}`, 'too_small');
      if (v.max !== undefined && value > v.max) fail(`Must be at most ${v.max}`, 'too_big');
      return;
    case 'yes_no':
      if (typeof value !== 'boolean') fail('Choose yes or no');
      return;
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) fail('Enter a date (YYYY-MM-DD)');
      return;
    case 'single_choice':
      if (typeof value !== 'string' || !allowedOptions.has(value)) fail('Choose one of the options');
      return;
    case 'multiple_choice':
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !allowedOptions.has(item))) return fail('Choose from the options');
      if (v.minItems && value.length < v.minItems) fail(`Choose at least ${v.minItems}`, 'too_small');
      if (v.maxItems && value.length > v.maxItems) fail(`Choose at most ${v.maxItems}`, 'too_big');
      return;
    case 'repeating_group': {
      if (!Array.isArray(value)) return fail('Add entries as a list');
      if (v.maxItems && value.length > v.maxItems) fail(`Add at most ${v.maxItems} entries`, 'too_big');
      if (v.minItems && value.length < v.minItems) fail(`Add at least ${v.minItems} entries`, 'too_small');
      value.forEach((item, index) => {
        if (!item || typeof item !== 'object') return errors.push({ path: `${path}.${index}`, code: 'invalid', message: 'Invalid entry' });
        for (const field of question.itemFields) {
          const fieldValue = (item as Record<string, unknown>)[field.key];
          const fieldPath = `${path}.${index}.${field.key}`;
          if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
            if (field.required) errors.push({ path: fieldPath, code: 'required', message: `${field.label} is required` });
            continue;
          }
          validateValue({ ...question, answerType: field.answerType, options: field.options, validation: {}, itemFields: [] }, fieldValue, fieldPath, errors);
        }
      });
      return;
    }
  }
}

/**
 * Validates custom answers against a layout. With `partial`, required rules are skipped (draft
 * autosave); unknown question keys are always rejected. Hidden questions' answers are dropped.
 */
export function validateCustomAnswers(layout: FormLayoutT, answers: Record<string, unknown>, options: { partial: boolean; sectionKey?: string }) {
  const errors: FieldError[] = [];
  const accepted: Record<string, unknown> = {};
  const questions = layout.sections
    .filter(section => !options.sectionKey || section.key === options.sectionKey)
    .flatMap(section => section.questions);
  const known = new Map(questions.map(question => [question.key, question]));
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) errors.push({ path: `custom.${key}`, code: 'unknown_question', message: 'This question is not part of the form' });
  }
  for (const question of questions) {
    if (!question.definition) continue;
    if (!conditionMet(question.showIf, answers)) continue;
    const value = answers[question.key];
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (question.required && !options.partial) errors.push({ path: `custom.${question.key}`, code: 'required', message: `${question.definition.label} is required` });
      continue;
    }
    const before = errors.length;
    validateValue(question.definition, value, `custom.${question.key}`, errors);
    if (errors.length === before) accepted[question.key] = value;
  }
  return { errors, accepted };
}

/** Typed index values for filterable custom answers. */
export function indexedValues(question: z.infer<typeof FrozenQuestion>, value: unknown) {
  return {
    valueText: question.answerType === 'short_text' || question.answerType === 'single_choice' ? String(value) : null,
    valueNumber: question.answerType === 'number' ? Number(value) : null,
    valueBoolean: question.answerType === 'yes_no' ? Boolean(value) : null,
    valueDate: question.answerType === 'date' ? String(value) : null,
    valueOptions: question.answerType === 'multiple_choice' ? (value as string[]) : question.answerType === 'single_choice' ? [String(value)] : null
  };
}

export function questionsByKey(layout: FormLayoutT) {
  return new Map(layout.sections.flatMap(section => section.questions).filter(q => q.definition).map(q => [q.key, q.definition!]));
}
