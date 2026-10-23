import { sql } from 'kysely';
import { z } from 'zod';
import type { AppDeps, RequestMeta, StaffActor } from '../../context.js';
import type { Executor, Tx } from '../../db/index.js';
import { audit, changedFields } from '../../domain/audit.js';
import { emit } from '../../domain/outbox.js';
import { assertTransitionAllowed, recordTransition } from '../../domain/stages.js';
import { applyAssignedScope, assertInScope, assignedOnly, likeEscape, pageArgs, uniqueReference, updateVersioned } from '../../domain/records.js';
import { detectFamilyDuplicates } from '../../domain/duplicates.js';
import { noticeFor } from '../../domain/consents.js';
import { getSettings } from '../../domain/settings.js';
import { notFound, unavailable, validationFailed } from '../../http/errors.js';
import { ChildAgeBand, DateOnly, Email, Phone, ScheduleType } from '../../http/schemas.js';
import { currentFormVersion, validateCustomAnswers } from '../forms/layout.js';
import { createFamilyRecord, insertContact, logContact } from './service.js';
import { runIdempotent } from '../../http/security.js';
import { makeReference } from '../../lib/crypto.js';

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;
export const Utm = z
  .object(Object.fromEntries(UTM_KEYS.map(key => [key, z.string().trim().max(100).regex(/^[\w .:/-]*$/).optional()])) as Record<(typeof UTM_KEYS)[number], z.ZodOptional<z.ZodString>>)
  .strict()
  .meta({ id: 'Utm', description: 'Allowlisted campaign values only; other tracking data is rejected.' });

export const PublicEnquiryInput = z
  .object({
    contact: z.object({
      firstName: z.string().trim().min(1, 'Enter your first name').max(80),
      lastName: z.string().trim().min(1, 'Enter your last name').max(80),
      email: Email,
      phone: Phone.optional(),
      preferredContactMethod: z.enum(['email', 'phone', 'text', 'any']).optional()
    }),
    household: z.object({
      city: z.string().trim().min(1, 'Enter your city').max(120),
      state: z.string().trim().min(2).max(40),
      postalCode: z.string().trim().max(20).optional(),
      childrenCount: z.int().min(0).max(20).optional(),
      childrenAgeBands: z.array(ChildAgeBand).max(7).default([])
    }),
    role: z.object({
      serviceTypeKey: z.string().max(64).optional(),
      scheduleTypes: z.array(ScheduleType).max(9).default([]),
      arrangement: z.enum(['live_in', 'live_out', 'either', 'unsure']).optional(),
      startTiming: z.enum(['asap', 'within_1_month', 'within_3_months', 'flexible', 'specific_date']).optional(),
      startDate: DateOnly.optional(),
      budgetNotes: z.string().trim().max(1000).optional(),
      details: z.string().trim().max(4000).optional().meta({ description: 'General priorities only. Do not include child names, birth dates or health details.' })
    }),
    custom: z.record(z.string(), z.unknown()).default({}),
    consents: z.object({
      privacyNotice: z.literal(true, { error: 'Please confirm you have read the privacy notice' }),
      marketingEmail: z.boolean().default(false)
    }),
    source: z.string().trim().max(60).regex(/^[\w .:/-]*$/).optional(),
    utm: Utm.optional(),
    captchaToken: z.string().max(4000).optional(),
    /** Honeypot: must be empty. Bots that fill it receive a normal-looking response. */
    website: z.string().max(500).optional()
  })
  .refine(v => v.role.startTiming !== 'specific_date' || Boolean(v.role.startDate), { message: 'Choose a start date', path: ['role', 'startDate'] })
  .meta({ id: 'PublicEnquiryInput' });
export type PublicEnquiryInputT = z.infer<typeof PublicEnquiryInput>;

export const PublicEnquiryReceipt = z
  .object({ reference: z.string(), receivedAt: z.string(), message: z.string() })
  .meta({ id: 'PublicEnquiryReceipt', description: 'Returned only after the enquiry is durably saved. Identical whether or not the email is already known.' });

const RECEIPT_MESSAGE = 'Thank you. Your enquiry has been received and a member of our team will be in touch.';

/** Public family enquiry: one atomic transaction, idempotent per Idempotency-Key. */
export async function submitPublicEnquiry(deps: AppDeps, meta: RequestMeta, input: PublicEnquiryInputT, idempotencyKey: string, ip: string) {
  const settings = await getSettings(deps.db);
  if (!settings.acceptingSubmissions) throw unavailable('We are not accepting new enquiries online right now. Please call or email us.', 'submissions_closed');
  const now = deps.clock.now();
  if (input.website) {
    return { status: 202, body: { reference: makeReference('E'), receivedAt: now.toISOString(), message: RECEIPT_MESSAGE }, replayed: false };
  }
  if (deps.captcha.enabled && !(await deps.captcha.verify(input.captchaToken, ip))) {
    throw validationFailed([{ path: 'captchaToken', code: 'captcha_failed', message: 'Please complete the verification step.' }]);
  }
  const form = await currentFormVersion(deps.db, 'family_enquiry');
  const custom = validateCustomAnswers(form.layout, input.custom, { partial: false });
  if (custom.errors.length) throw validationFailed(custom.errors);
  if (input.role.serviceTypeKey) {
    const service = await deps.db.selectFrom('serviceTypes').select('key').where('key', '=', input.role.serviceTypeKey).where('active', '=', true).executeTakeFirst();
    if (!service) throw validationFailed([{ path: 'role.serviceTypeKey', code: 'invalid', message: 'Choose a service from the list' }]);
  }
  const privacy = await noticeFor(deps.db, deps.config, 'privacy_notice');
  const marketing = input.consents.marketingEmail ? await noticeFor(deps.db, deps.config, 'marketing_consent') : null;
  const { website: _honeypot, captchaToken: _captcha, ...snapshot } = input;

  return runIdempotent(deps.db, { scope: 'public:enquiry', key: idempotencyKey, request: snapshot, now }, async trx => {
    const family = await createFamilyRecord(trx, meta, {
      displayName: `${input.contact.lastName} family`,
      city: input.household.city,
      state: input.household.state,
      postalCode: input.household.postalCode ?? null,
      firstSource: input.source ?? 'website',
      firstSourceDetail: input.utm as Record<string, string> | undefined
    });
    const contact = await insertContact(trx, family.id, {
      firstName: input.contact.firstName,
      lastName: input.contact.lastName,
      email: input.contact.email,
      phone: input.contact.phone ?? null,
      relationship: 'parent',
      isPrimary: true,
      authorizedRecipient: false,
      preferredContactMethod: input.contact.preferredContactMethod ?? null
    });
    const enquiry = await trx
      .insertInto('enquiries')
      .values({
        reference: await uniqueReference(trx, 'enquiries', 'E'),
        familyId: family.id,
        contactId: contact.id,
        formVersionId: form.id,
        channel: 'website',
        serviceTypeKey: input.role.serviceTypeKey ?? null,
        scheduleTypes: input.role.scheduleTypes,
        arrangement: input.role.arrangement ?? null,
        startTiming: input.role.startTiming ?? null,
        startDate: input.role.startDate ?? null,
        childrenCount: input.household.childrenCount ?? null,
        childrenAgeBands: input.household.childrenAgeBands,
        locationCity: input.household.city,
        locationState: input.household.state,
        postalCode: input.household.postalCode ?? null,
        budgetNotes: input.role.budgetNotes ?? null,
        details: input.role.details ?? null,
        source: input.source ?? null,
        utm: JSON.stringify(input.utm ?? {}),
        submissionSnapshot: JSON.stringify({ formVersionId: form.id, formVersion: form.versionNumber, submittedAt: now.toISOString(), ...snapshot }),
        submittedAt: now.toISOString()
      })
      .returning(['id', 'reference', 'submittedAt'])
      .executeTakeFirstOrThrow();
    for (const [questionKey, value] of Object.entries(custom.accepted)) {
      await trx.insertInto('enquiryCustomAnswers').values({ enquiryId: enquiry.id, questionKey, formVersionId: form.id, value: JSON.stringify(value) }).execute();
    }
    await trx
      .insertInto('consents')
      .values({
        consentType: 'privacy_notice',
        familyContactId: contact.id,
        legalNoticeId: privacy.id,
        noticeVersion: privacy.version,
        granted: true,
        recordedByType: 'family',
        evidence: JSON.stringify({ method: 'web_form', formVersionId: form.id, enquiryId: enquiry.id, placeholderNotice: privacy.placeholder })
      })
      .execute();
    if (marketing) {
      await trx
        .insertInto('consents')
        .values({
          consentType: 'marketing_email',
          familyContactId: contact.id,
          legalNoticeId: marketing.id,
          noticeVersion: marketing.version,
          granted: true,
          recordedByType: 'family',
          evidence: JSON.stringify({ method: 'web_form', formVersionId: form.id, enquiryId: enquiry.id, placeholderNotice: marketing.placeholder })
        })
        .execute();
    }
    await recordTransition(trx, meta, { dimension: 'enquiry', subjectId: enquiry.id, from: null, to: 'new' });
    const duplicates = await detectFamilyDuplicates(trx, family.id, contact.email, contact.phoneNormalized);
    await audit(trx, meta, { action: 'enquiry.submitted', subjectType: 'enquiry', subjectId: enquiry.id, metadata: { familyId: family.id, possibleDuplicates: duplicates } });
    await emit(trx, meta, {
      type: 'enquiry.submitted',
      subjectType: 'enquiry',
      subjectId: enquiry.id,
      payload: { related: { family: family.id, enquiry: enquiry.id } },
      dedupeKey: `enquiry.submitted:${enquiry.id}`
    });
    return { status: 202, body: { reference: enquiry.reference, receivedAt: enquiry.submittedAt, message: RECEIPT_MESSAGE } };
  });
}

const staffRef = (id: string | null, name: string | null) => (id ? { id, displayName: name ?? '' } : null);

function enquiryQuery(db: Executor) {
  return db
    .selectFrom('enquiries as e')
    .innerJoin('families as f', 'f.id', 'e.familyId')
    .leftJoin('familyContacts as c', 'c.id', 'e.contactId')
    .leftJoin('staffMembers as s', 's.id', 'e.assignedStaffId');
}

const SUMMARY_COLUMNS = [
  'e.id', 'e.reference', 'e.familyId', 'f.displayName as familyName', 'c.firstName', 'c.lastName', 'c.email as contactEmail',
  'e.channel', 'e.stage', 'e.serviceTypeKey', 'e.locationCity', 'e.locationState', 'e.startTiming', 'e.startDate', 'e.submittedAt',
  'e.firstResponseAt', 'e.assignedStaffId', 's.displayName as assignedName', 'e.isTest', 'e.version', 'e.updatedAt'
] as const;

function toSummary(row: Record<string, unknown> & { firstName: string | null; lastName: string | null; assignedStaffId: string | null; assignedName: string | null; possibleDuplicate?: unknown }) {
  return {
    ...row,
    contactName: [row.firstName, row.lastName].filter(Boolean).join(' ') || null,
    assignedStaff: staffRef(row.assignedStaffId, row.assignedName),
    possibleDuplicate: Boolean(row.possibleDuplicate)
  };
}

const possibleDuplicate = sql<boolean>`exists (select 1 from duplicate_cases d where d.entity_type = 'family' and d.status = 'open' and (d.first_record_id = e.family_id or d.second_record_id = e.family_id))`;

export async function listEnquiries(
  deps: AppDeps,
  staff: StaffActor,
  query: { q?: string; stage?: string[]; familyId?: string; assignedStaffId?: string; submittedFrom?: string; submittedTo?: string; includeTest?: boolean; page: number; pageSize: number; sort: string }
) {
  const scoped = await assignedOnly(deps.db, staff);
  let base = enquiryQuery(deps.db);
  base = applyAssignedScope(base as never, 'e.assignedStaffId', staff.staffId, scoped) as typeof base;
  if (!query.includeTest) base = base.where('e.isTest', '=', false);
  if (query.stage?.length) base = base.where('e.stage', 'in', query.stage);
  if (query.familyId) base = base.where('e.familyId', '=', query.familyId);
  if (query.assignedStaffId) base = base.where('e.assignedStaffId', '=', query.assignedStaffId);
  if (query.submittedFrom) base = base.where('e.submittedAt', '>=', query.submittedFrom);
  if (query.submittedTo) base = base.where('e.submittedAt', '<', query.submittedTo);
  if (query.q) {
    const term = `%${likeEscape(query.q.trim())}%`;
    base = base.where(eb => eb.or([eb('e.reference', 'ilike', term), eb('f.displayName', 'ilike', term), eb('c.email', 'ilike', term), eb('c.firstName', 'ilike', term), eb('c.lastName', 'ilike', term), eb('e.locationCity', 'ilike', term)]));
  }
  const total = await base.select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const sorts: Record<string, [string, 'asc' | 'desc']> = { submitted_desc: ['e.submittedAt', 'desc'], submitted_asc: ['e.submittedAt', 'asc'], updated_desc: ['e.updatedAt', 'desc'] };
  const [column, direction] = sorts[query.sort] ?? sorts.submitted_desc!;
  const { limit, offset } = pageArgs(query.page, query.pageSize);
  const rows = await base
    .select([...SUMMARY_COLUMNS, possibleDuplicate.as('possibleDuplicate')])
    .orderBy(column as never, direction)
    .orderBy('e.id')
    .limit(limit)
    .offset(offset)
    .execute();
  return { items: rows.map(row => toSummary(row as never)), page: query.page, pageSize: query.pageSize, total: Number(total.n) };
}

export async function getEnquiry(deps: AppDeps, db: Executor, staff: StaffActor, id: string) {
  const row = await enquiryQuery(db)
    .select([
      ...SUMMARY_COLUMNS,
      'e.contactId', 'e.formVersionId', 'e.scheduleTypes', 'e.arrangement', 'e.childrenCount', 'e.childrenAgeBands', 'e.postalCode',
      'e.budgetNotes', 'e.details', 'e.source', 'e.utm', 'e.closedReason', 'e.closedAt', 'e.submissionSnapshot',
      possibleDuplicate.as('possibleDuplicate')
    ])
    .where('e.id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Enquiry');
  await assertInScope(db, staff, row.assignedStaffId);
  const customAnswers = await db.selectFrom('enquiryCustomAnswers').select(['questionKey', 'value']).where('enquiryId', '=', id).execute();
  return { ...row, ...toSummary(row as never), utm: (row.utm ?? {}) as Record<string, string>, customAnswers };
}

export async function createStaffEnquiry(
  deps: AppDeps,
  meta: RequestMeta,
  input: {
    familyId?: string;
    newFamily?: { displayName: string; city?: string | null; state?: string | null };
    contactId?: string;
    newContact?: { firstName: string; lastName?: string | null; email?: string | null; phone?: string | null };
    channel: string;
    assignedStaffId?: string | null;
  } & Record<string, unknown>
) {
  const id = await deps.db.transaction().execute(async (trx: Tx) => {
    let familyId = input.familyId;
    if (!familyId) {
      if (!input.newFamily) throw validationFailed([{ path: 'familyId', code: 'required', message: 'Choose a family or add a new one' }]);
      familyId = (await createFamilyRecord(trx, meta, { ...input.newFamily, firstSource: input.channel })).id;
    } else {
      const family = await trx.selectFrom('families').select(['id', 'mergedIntoFamilyId']).where('id', '=', familyId).executeTakeFirst();
      if (!family) throw notFound('Family');
      if (family.mergedIntoFamilyId) throw validationFailed([{ path: 'familyId', code: 'record_merged', message: 'This family was merged; use the surviving record' }]);
    }
    let contactId = input.contactId ?? null;
    if (input.newContact) {
      const contact = await insertContact(trx, familyId, { ...input.newContact, relationship: 'parent', isPrimary: !input.familyId, authorizedRecipient: false });
      contactId = contact.id;
      await detectFamilyDuplicates(trx, familyId, contact.email, contact.phoneNormalized);
    } else if (contactId) {
      const contact = await trx.selectFrom('familyContacts').select('id').where('id', '=', contactId).where('familyId', '=', familyId).executeTakeFirst();
      if (!contact) throw validationFailed([{ path: 'contactId', code: 'invalid', message: 'This contact does not belong to the family' }]);
    }
    const fields = ['serviceTypeKey', 'scheduleTypes', 'arrangement', 'startTiming', 'startDate', 'childrenCount', 'childrenAgeBands', 'locationCity', 'locationState', 'postalCode', 'budgetNotes', 'details'];
    const values = Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    const enquiry = await trx
      .insertInto('enquiries')
      .values({
        reference: await uniqueReference(trx, 'enquiries', 'E'),
        familyId,
        contactId,
        channel: input.channel,
        assignedStaffId: input.assignedStaffId ?? (meta.actor.type === 'staff' ? meta.actor.staffId : null),
        ...values
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordTransition(trx, meta, { dimension: 'enquiry', subjectId: enquiry.id, from: null, to: 'new' });
    await audit(trx, meta, { action: 'enquiry.created', subjectType: 'enquiry', subjectId: enquiry.id, metadata: { channel: input.channel } });
    await emit(trx, meta, { type: 'enquiry.submitted', subjectType: 'enquiry', subjectId: enquiry.id, payload: { related: { family: familyId, enquiry: enquiry.id }, staffEntered: true }, dedupeKey: `enquiry.submitted:${enquiry.id}` });
    return enquiry.id;
  });
  return getEnquiry(deps, deps.db, meta.actor as StaffActor, id);
}

export async function updateEnquiry(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: Record<string, unknown> & { version: number }) {
  const { version, ...values } = input;
  await deps.db.transaction().execute(async trx => {
    const before = await trx.selectFrom('enquiries').selectAll().where('id', '=', id).executeTakeFirst();
    if (!before) throw notFound('Enquiry');
    await assertInScope(trx, staff, before.assignedStaffId);
    await updateVersioned(trx, 'enquiries', id, version, values, 'Enquiry');
    await audit(trx, meta, { action: 'enquiry.updated', subjectType: 'enquiry', subjectId: id, metadata: { fields: changedFields(before as never, values) } });
  });
  return getEnquiry(deps, deps.db, staff, id);
}

export async function transitionEnquiry(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { to: string; reason?: string; version: number }) {
  await deps.db.transaction().execute(async trx => {
    const current = await trx.selectFrom('enquiries').select(['stage', 'familyId', 'assignedStaffId']).where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Enquiry');
    await assertInScope(trx, staff, current.assignedStaffId);
    await assertTransitionAllowed(trx, 'enquiry', current.stage, input.to);
    const values: Record<string, unknown> = { stage: input.to };
    if (input.to === 'closed') Object.assign(values, { closedAt: deps.clock.now().toISOString(), closedReason: input.reason ?? null });
    if (current.stage === 'closed') Object.assign(values, { closedAt: null, closedReason: null });
    if (input.to === 'contacted') values.firstResponseAt = deps.clock.now().toISOString();
    await updateVersioned(trx, 'enquiries', id, input.version, values, 'Enquiry');
    if (input.to === 'contacted') {
      // Keep the earliest first-response time when the enquiry was already answered.
      await trx.updateTable('enquiries').set({ firstResponseAt: deps.clock.now().toISOString() }).where('id', '=', id).where('firstResponseAt', 'is', null).execute();
    }
    await recordTransition(trx, meta, { dimension: 'enquiry', subjectId: id, from: current.stage, to: input.to, reason: input.reason });
    await audit(trx, meta, { action: 'enquiry.stage_changed', subjectType: 'enquiry', subjectId: id, metadata: { from: current.stage, to: input.to } });
    await emit(trx, meta, { type: 'enquiry.stage_changed', subjectType: 'enquiry', subjectId: id, payload: { from: current.stage, to: input.to, related: { family: current.familyId, enquiry: id } } });
  });
  return getEnquiry(deps, deps.db, staff, id);
}

export async function logEnquiryContact(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { channel: string; direction: string; summary: string; isReply: boolean; occurredAt?: string }) {
  return deps.db.transaction().execute(async trx => {
    const enquiry = await trx.selectFrom('enquiries').select(['familyId', 'assignedStaffId']).where('id', '=', id).executeTakeFirst();
    if (!enquiry) throw notFound('Enquiry');
    await assertInScope(trx, staff, enquiry.assignedStaffId);
    const communication = await logContact(trx, deps, meta, { ...input, enquiryId: id, familyId: enquiry.familyId });
    await audit(trx, meta, { action: 'enquiry.contact_logged', subjectType: 'enquiry', subjectId: id, metadata: { channel: input.channel, isReply: input.isReply } });
    return communication;
  });
}
