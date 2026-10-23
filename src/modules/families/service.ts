import { sql } from 'kysely';
import type { AppDeps, RequestMeta, StaffActor } from '../../context.js';
import type { Executor, Tx } from '../../db/index.js';
import { audit, changedFields } from '../../domain/audit.js';
import { emit } from '../../domain/outbox.js';
import { assertTransitionAllowed, recordTransition } from '../../domain/stages.js';
import { applyAssignedScope, assertInScope, assignedOnly, likeEscape, normalizePhone, pageArgs, uniqueReference, updateVersioned } from '../../domain/records.js';
import { detectFamilyDuplicates } from '../../domain/duplicates.js';
import { notFound, unprocessable } from '../../http/errors.js';
import { actorStaffId } from '../../context.js';

/** Family CRM: households, their contacts and relationship status. */

const staffRef = (id: string | null, name: string | null) => (id ? { id, displayName: name ?? '' } : null);

export async function listFamilies(
  deps: AppDeps,
  staff: StaffActor,
  query: { q?: string; status?: string[]; assignedStaffId?: string; includeTest?: boolean; includeMerged?: boolean; sort: string; page: number; pageSize: number }
) {
  const scoped = await assignedOnly(deps.db, staff);
  let base = deps.db.selectFrom('families as f');
  base = applyAssignedScope(base as never, 'f.assignedStaffId', staff.staffId, scoped) as typeof base;
  let filtered = base;
  if (!query.includeMerged) filtered = filtered.where('f.mergedIntoFamilyId', 'is', null);
  if (!query.includeTest) filtered = filtered.where('f.isTest', '=', false);
  if (query.status?.length) filtered = filtered.where('f.relationshipStatus', 'in', query.status);
  if (query.assignedStaffId) filtered = filtered.where('f.assignedStaffId', '=', query.assignedStaffId);
  if (query.q) {
    const term = `%${likeEscape(query.q.trim())}%`;
    filtered = filtered.where(eb =>
      eb.or([
        eb('f.displayName', 'ilike', term),
        eb('f.reference', 'ilike', term),
        eb('f.city', 'ilike', term),
        eb.exists(
          eb.selectFrom('familyContacts as fc')
            .select('fc.id')
            .whereRef('fc.familyId', '=', 'f.id')
            .where(inner => inner.or([inner('fc.email', 'ilike', term), inner('fc.firstName', 'ilike', term), inner('fc.lastName', 'ilike', term), inner('fc.phone', 'ilike', term)]))
        )
      ])
    );
  }
  const total = await filtered.select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const sorts: Record<string, [string, 'asc' | 'desc']> = {
    updated_desc: ['f.updatedAt', 'desc'],
    created_desc: ['f.createdAt', 'desc'],
    name_asc: ['f.displayName', 'asc']
  };
  const [column, direction] = sorts[query.sort] ?? sorts.updated_desc!;
  const { limit, offset } = pageArgs(query.page, query.pageSize);
  const rows = await filtered
    .leftJoin('staffMembers as s', 's.id', 'f.assignedStaffId')
    .leftJoinLateral(
      eb => eb.selectFrom('familyContacts as c').select(['c.id', 'c.firstName', 'c.lastName', 'c.email', 'c.phone']).whereRef('c.familyId', '=', 'f.id').where('c.archivedAt', 'is', null).orderBy('c.isPrimary', 'desc').orderBy('c.createdAt').limit(1).as('pc'),
      join => join.onTrue()
    )
    .select([
      'f.id', 'f.reference', 'f.displayName', 'f.relationshipStatus', 'f.city', 'f.state', 'f.isTest', 'f.mergedIntoFamilyId', 'f.version', 'f.createdAt', 'f.updatedAt',
      'f.assignedStaffId', 's.displayName as assignedName',
      'pc.id as contactId', 'pc.firstName', 'pc.lastName', 'pc.email', 'pc.phone',
      eb => eb.selectFrom('jobOrders as j').select(eb2 => eb2.fn.countAll<number>().as('n')).whereRef('j.familyId', '=', 'f.id').where('j.status', 'in', ['draft', 'open', 'on_hold']).as('openJobCount'),
      eb => eb.selectFrom('enquiries as e').select(eb2 => eb2.fn.countAll<number>().as('n')).whereRef('e.familyId', '=', 'f.id').as('enquiryCount')
    ])
    .orderBy(column as never, direction)
    .orderBy('f.id')
    .limit(limit)
    .offset(offset)
    .execute();
  return {
    items: rows.map(row => ({
      ...row,
      relationshipStatus: row.relationshipStatus as 'prospect',
      assignedStaff: staffRef(row.assignedStaffId, row.assignedName),
      primaryContact: row.contactId ? { id: row.contactId, firstName: row.firstName!, lastName: row.lastName, email: row.email, phone: row.phone } : null,
      openJobCount: Number(row.openJobCount ?? 0),
      enquiryCount: Number(row.enquiryCount ?? 0)
    })),
    page: query.page,
    pageSize: query.pageSize,
    total: Number(total.n)
  };
}

export async function getFamily(deps: AppDeps, db: Executor, staff: StaffActor | null, id: string) {
  const row = await db
    .selectFrom('families as f')
    .leftJoin('staffMembers as s', 's.id', 'f.assignedStaffId')
    .selectAll('f')
    .select(['s.displayName as assignedName'])
    .where('f.id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Family');
  if (staff) await assertInScope(db, staff, row.assignedStaffId);
  const contacts = await db.selectFrom('familyContacts').selectAll().where('familyId', '=', id).orderBy('isPrimary', 'desc').orderBy('createdAt').execute();
  const counts = await db
    .selectNoFrom(eb => [
      eb.selectFrom('jobOrders').select(eb2 => eb2.fn.countAll<number>().as('n')).where('familyId', '=', id).where('status', 'in', ['draft', 'open', 'on_hold']).as('openJobCount'),
      eb.selectFrom('enquiries').select(eb2 => eb2.fn.countAll<number>().as('n')).where('familyId', '=', id).as('enquiryCount')
    ])
    .executeTakeFirstOrThrow();
  const primary = contacts.find(contact => !contact.archivedAt) ?? null;
  return {
    ...row,
    relationshipStatus: row.relationshipStatus as 'prospect',
    assignedStaff: staffRef(row.assignedStaffId, row.assignedName),
    primaryContact: primary ? { id: primary.id, firstName: primary.firstName, lastName: primary.lastName, email: primary.email, phone: primary.phone } : null,
    openJobCount: Number(counts.openJobCount ?? 0),
    enquiryCount: Number(counts.enquiryCount ?? 0),
    contacts: contacts.map(contact => ({ ...contact, relationship: contact.relationship as 'parent', preferredContactMethod: contact.preferredContactMethod as 'email' | null }))
  };
}

export interface ContactInput {
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  relationship: string;
  isPrimary: boolean;
  authorizedRecipient: boolean;
  preferredContactMethod?: string | null;
}

export async function insertContact(trx: Tx, familyId: string, input: ContactInput) {
  if (input.isPrimary) {
    await trx.updateTable('familyContacts').set({ isPrimary: false }).where('familyId', '=', familyId).where('isPrimary', '=', true).execute();
  }
  return trx
    .insertInto('familyContacts')
    .values({
      familyId,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      phoneNormalized: normalizePhone(input.phone),
      relationship: input.relationship,
      isPrimary: input.isPrimary,
      authorizedRecipient: input.authorizedRecipient,
      preferredContactMethod: input.preferredContactMethod ?? null
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function createFamilyRecord(
  trx: Tx,
  meta: RequestMeta,
  input: {
    displayName: string;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    serviceArea?: string | null;
    householdSummary?: string | null;
    assignedStaffId?: string | null;
    firstSource?: string | null;
    firstSourceDetail?: Record<string, string>;
    isTest?: boolean;
  }
) {
  const family = await trx
    .insertInto('families')
    .values({
      reference: await uniqueReference(trx, 'families', 'F'),
      displayName: input.displayName,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      serviceArea: input.serviceArea ?? null,
      householdSummary: input.householdSummary ?? null,
      assignedStaffId: input.assignedStaffId ?? null,
      firstSource: input.firstSource ?? null,
      firstSourceDetail: JSON.stringify(input.firstSourceDetail ?? {}),
      isTest: input.isTest ?? false
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordTransition(trx, meta, { dimension: 'family_relationship', subjectId: family.id, from: null, to: family.relationshipStatus });
  return family;
}

export async function createFamily(deps: AppDeps, meta: RequestMeta, input: Parameters<typeof createFamilyRecord>[2] & { primaryContact?: ContactInput }) {
  const id = await deps.db.transaction().execute(async trx => {
    const family = await createFamilyRecord(trx, meta, { ...input, firstSource: input.firstSource ?? 'staff_entry' });
    if (input.primaryContact) {
      const contact = await insertContact(trx, family.id, { ...input.primaryContact, isPrimary: true });
      await detectFamilyDuplicates(trx, family.id, contact.email, contact.phoneNormalized);
    }
    await audit(trx, meta, { action: 'family.created', subjectType: 'family', subjectId: family.id });
    return family.id;
  });
  return getFamily(deps, deps.db, null, id);
}

export async function updateFamily(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: Record<string, unknown> & { version: number }) {
  const { version, ...values } = input;
  await deps.db.transaction().execute(async trx => {
    const before = await trx.selectFrom('families').selectAll().where('id', '=', id).executeTakeFirst();
    if (!before) throw notFound('Family');
    await assertInScope(trx, staff, before.assignedStaffId);
    if (before.mergedIntoFamilyId) throw unprocessable('This family was merged into another record.', 'record_merged');
    await updateVersioned(trx, 'families', id, version, values, 'Family');
    await audit(trx, meta, { action: 'family.updated', subjectType: 'family', subjectId: id, metadata: { fields: changedFields(before as never, values) } });
  });
  return getFamily(deps, deps.db, null, id);
}

export async function transitionFamily(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { to: string; reason?: string; version: number }) {
  await deps.db.transaction().execute(async trx => {
    const current = await trx.selectFrom('families').select(['relationshipStatus', 'assignedStaffId']).where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Family');
    await assertInScope(trx, staff, current.assignedStaffId);
    await assertTransitionAllowed(trx, 'family_relationship', current.relationshipStatus, input.to);
    await updateVersioned(trx, 'families', id, input.version, { relationshipStatus: input.to }, 'Family');
    await recordTransition(trx, meta, { dimension: 'family_relationship', subjectId: id, from: current.relationshipStatus, to: input.to, reason: input.reason });
    await audit(trx, meta, { action: 'family.status_changed', subjectType: 'family', subjectId: id, metadata: { from: current.relationshipStatus, to: input.to } });
  });
  return getFamily(deps, deps.db, null, id);
}

export async function addContact(deps: AppDeps, meta: RequestMeta, staff: StaffActor, familyId: string, input: ContactInput) {
  return deps.db.transaction().execute(async trx => {
    const family = await trx.selectFrom('families').select(['id', 'assignedStaffId']).where('id', '=', familyId).executeTakeFirst();
    if (!family) throw notFound('Family');
    await assertInScope(trx, staff, family.assignedStaffId);
    const contact = await insertContact(trx, familyId, input);
    await detectFamilyDuplicates(trx, familyId, contact.email, contact.phoneNormalized);
    await audit(trx, meta, { action: 'family.contact_added', subjectType: 'family', subjectId: familyId, metadata: { contactId: contact.id } });
    return contact;
  });
}

export async function updateContact(deps: AppDeps, meta: RequestMeta, staff: StaffActor, familyId: string, contactId: string, input: Partial<ContactInput> & { version: number; archived?: boolean }) {
  return deps.db.transaction().execute(async trx => {
    const contact = await trx
      .selectFrom('familyContacts as c')
      .innerJoin('families as f', 'f.id', 'c.familyId')
      .select(['c.id', 'c.email', 'c.phone', 'f.assignedStaffId'])
      .where('c.id', '=', contactId)
      .where('c.familyId', '=', familyId)
      .executeTakeFirst();
    if (!contact) throw notFound('Contact');
    await assertInScope(trx, staff, contact.assignedStaffId);
    const { version, archived, ...fields } = input;
    if (fields.isPrimary) {
      await trx.updateTable('familyContacts').set({ isPrimary: false }).where('familyId', '=', familyId).where('id', '<>', contactId).where('isPrimary', '=', true).execute();
    }
    const values: Record<string, unknown> = { ...fields };
    if (fields.phone !== undefined) values.phoneNormalized = normalizePhone(fields.phone);
    if (archived !== undefined) values.archivedAt = archived ? deps.clock.now().toISOString() : null;
    if (archived) values.isPrimary = false;
    const updated = await updateVersioned(trx, 'familyContacts', contactId, version, values, 'Contact');
    await audit(trx, meta, { action: 'family.contact_updated', subjectType: 'family', subjectId: familyId, metadata: { contactId, fields: Object.keys(values) } });
    return updated;
  });
}

/** Chronological activity for a family: enquiries, stage changes, communications, notes, jobs, placements. */
export async function familyTimeline(deps: AppDeps, staff: StaffActor, familyId: string) {
  const family = await deps.db.selectFrom('families').select(['id', 'assignedStaffId']).where('id', '=', familyId).executeTakeFirst();
  if (!family) throw notFound('Family');
  await assertInScope(deps.db, staff, family.assignedStaffId);
  const ownerOnly = staff.permissions.has('notes.owner_only');
  const [enquiries, transitions, communications, notes, jobs, placements] = await Promise.all([
    deps.db.selectFrom('enquiries').select(['id', 'reference', 'stage', 'submittedAt']).where('familyId', '=', familyId).execute(),
    deps.db.selectFrom('stageTransitions').select(['id', 'dimension', 'subjectId', 'fromKey', 'toKey', 'reason', 'occurredAt']).where(eb => eb.or([
      eb('subjectId', '=', familyId),
      eb('subjectId', 'in', eb.selectFrom('enquiries').select('enquiries.id').where('enquiries.familyId', '=', familyId)),
      eb('subjectId', 'in', eb.selectFrom('jobOrders').select('jobOrders.id').where('jobOrders.familyId', '=', familyId))
    ])).execute(),
    deps.db.selectFrom('communications').select(['id', 'channel', 'direction', 'status', 'subject', 'summary', 'isReply', 'occurredAt']).where('familyId', '=', familyId).execute(),
    deps.db.selectFrom('notes').select(['id', 'body', 'visibility', 'createdAt', 'authorStaffId']).where('familyId', '=', familyId).where('deletedAt', 'is', null)
      .$if(!ownerOnly, qb => qb.where('visibility', '=', 'agency')).execute(),
    deps.db.selectFrom('jobOrders').select(['id', 'reference', 'title', 'status', 'createdAt']).where('familyId', '=', familyId).execute(),
    deps.db.selectFrom('placements').select(['id', 'reference', 'status', 'createdAt']).where('familyId', '=', familyId).execute()
  ]);
  const items = [
    ...enquiries.map(e => ({ type: 'enquiry_submitted', at: e.submittedAt, id: e.id, title: `Enquiry ${e.reference}`, detail: e.stage })),
    ...transitions.map(t => ({ type: `${t.dimension}_changed`, at: t.occurredAt, id: String(t.id), title: `${t.fromKey ?? 'start'} → ${t.toKey}`, detail: t.reason })),
    ...communications.map(c => ({ type: `communication_${c.direction}`, at: c.occurredAt, id: c.id, title: c.subject ?? `${c.channel} ${c.direction}`, detail: c.summary ?? c.status })),
    ...notes.map(n => ({ type: 'note', at: n.createdAt, id: n.id, title: 'Note', detail: n.body })),
    ...jobs.map(j => ({ type: 'job_created', at: j.createdAt, id: j.id, title: `Job ${j.reference}: ${j.title}`, detail: j.status })),
    ...placements.map(p => ({ type: 'placement_created', at: p.createdAt, id: p.id, title: `Placement ${p.reference}`, detail: p.status }))
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  return { items };
}

/** Manual log of a call/email/meeting. Recording a reply stops follow-up sequences. */
export async function logContact(
  trx: Tx,
  deps: AppDeps,
  meta: RequestMeta,
  input: { familyId?: string | null; enquiryId?: string | null; candidateId?: string | null; channel: string; direction: string; summary: string; isReply: boolean; occurredAt?: string }
) {
  const occurredAt = input.occurredAt ?? deps.clock.now().toISOString();
  const communication = await trx
    .insertInto('communications')
    .values({
      channel: input.channel,
      direction: input.direction,
      status: 'logged',
      summary: input.summary,
      isReply: input.isReply,
      familyId: input.familyId ?? null,
      enquiryId: input.enquiryId ?? null,
      candidateId: input.candidateId ?? null,
      loggedBy: actorStaffId(meta),
      occurredAt
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (input.enquiryId) {
    await trx.updateTable('enquiries').set({ firstResponseAt: sql`coalesce(first_response_at, ${occurredAt}::timestamptz)` }).where('id', '=', input.enquiryId).execute();
    await emit(trx, meta, { type: 'enquiry.contact_recorded', subjectType: 'enquiry', subjectId: input.enquiryId, payload: { related: { family: input.familyId, enquiry: input.enquiryId }, isReply: input.isReply } });
  }
  if (input.isReply && input.familyId) {
    await emit(trx, meta, { type: 'family.reply_recorded', subjectType: 'family', subjectId: input.familyId, payload: { related: { family: input.familyId, enquiry: input.enquiryId ?? null } } });
  }
  if (input.isReply && input.candidateId) {
    await emit(trx, meta, { type: 'candidate.reply_recorded', subjectType: 'candidate', subjectId: input.candidateId, payload: { related: { candidate: input.candidateId } } });
  }
  return communication;
}
