import { sql } from 'kysely';
import type { AppDeps, RequestMeta, StaffActor } from '../../context.js';
import type { Executor, Tx } from '../../db/index.js';
import { audit, changedFields } from '../../domain/audit.js';
import { emit } from '../../domain/outbox.js';
import { assertTransitionAllowed, recordTransition } from '../../domain/stages.js';
import { assertInScope, assignedOnly, normalizePhone, pageArgs, uniqueReference, updateVersioned } from '../../domain/records.js';
import { detectCandidateDuplicates } from '../../domain/duplicates.js';
import { getSettings } from '../../domain/settings.js';
import { notFound, unprocessable, validationFailed } from '../../http/errors.js';
import { hhmmToMinutes, minutesToHhmm } from '../../http/schemas.js';
import { localDate } from '../../lib/time.js';
import { criteriaPredicates, currentQualificationKeys, type SearchCriteriaT } from './search.js';
import { evaluateEligibility } from '../screening/eligibility.js';
import type { CandidateProfileT } from './schemas.js';

const staffRef = (id: string | null, name: string | null) => (id ? { id, displayName: name ?? '' } : null);

async function today(deps: AppDeps) {
  return localDate(deps.clock.now(), (await getSettings(deps.db)).timezone);
}

const SUMMARY_COLUMNS = [
  'c.id', 'c.reference', 'c.firstName', 'c.lastName', 'c.preferredName', 'c.email', 'c.phone', 'c.city', 'c.state',
  'c.recruitmentStage', 'c.availabilityStatus', 'c.availableFrom', 'c.professionalNannyYears', 'c.childcareYears', 'c.ageGroups',
  'c.desiredScheduleTypes', 'c.desiredArrangement', 'c.drivingEligible', 'c.assignedStaffId', 'c.isTest', 'c.submittedAt',
  'c.updatedAt', 'c.version'
] as const;

export async function searchCandidates(
  deps: AppDeps,
  staff: StaffActor,
  criteria: SearchCriteriaT,
  paging: { page: number; pageSize: number; sort: string }
) {
  const day = await today(deps);
  const predicates = criteriaPredicates(criteria, day);
  if (await assignedOnly(deps.db, staff)) predicates.push(sql`(c.assigned_staff_id = ${staff.staffId} or c.assigned_staff_id is null)`);
  const base = deps.db.selectFrom('candidates as c').where(eb => eb.and(predicates));
  const total = await base.select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const sorts: Record<string, [string, 'asc' | 'desc']> = {
    updated_desc: ['c.updatedAt', 'desc'],
    submitted_desc: ['c.submittedAt', 'desc'],
    professional_years_desc: ['c.professionalNannyYears', 'desc'],
    name_asc: ['c.lastName', 'asc']
  };
  const [column, direction] = sorts[paging.sort] ?? sorts.updated_desc!;
  const { limit, offset } = pageArgs(paging.page, paging.pageSize);
  const rows = await base
    .leftJoin('staffMembers as s', 's.id', 'c.assignedStaffId')
    .select([...SUMMARY_COLUMNS, 's.displayName as assignedName'])
    .orderBy(sql.ref(column), ob => (direction === 'desc' ? ob.desc().nullsLast() : ob.asc().nullsLast()))
    .orderBy('c.id')
    .limit(limit)
    .offset(offset)
    .execute();
  const qualifications = await currentQualificationKeys(deps.db, rows.map(row => row.id), day);
  return {
    items: rows.map(row => ({
      ...row,
      assignedStaff: staffRef(row.assignedStaffId, row.assignedName),
      currentQualifications: qualifications.get(row.id) ?? []
    })),
    page: paging.page,
    pageSize: paging.pageSize,
    total: Number(total.n)
  };
}

export async function getCandidate(deps: AppDeps, db: Executor, staff: StaffActor | null, id: string) {
  const row = await db
    .selectFrom('candidates as c')
    .leftJoin('staffMembers as s', 's.id', 'c.assignedStaffId')
    .selectAll('c')
    .select('s.displayName as assignedName')
    .where('c.id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Candidate');
  if (staff) await assertInScope(db, staff, row.assignedStaffId);
  const day = localDate(deps.clock.now(), (await getSettings(db)).timezone);
  const [employments, qualifications, languages, skills, windows, verifications, customAnswers, applications] = await Promise.all([
    db.selectFrom('candidateEmployments').selectAll().where('candidateId', '=', id).orderBy('sortOrder').orderBy('startDate', 'desc').execute(),
    db.selectFrom('candidateQualifications as q').innerJoin('qualificationTypes as t', 't.key', 'q.qualificationKey').selectAll('q').select(['t.label', 't.hasExpiry']).where('q.candidateId', '=', id).orderBy('t.sortOrder').execute(),
    db.selectFrom('candidateLanguages').select(['languageCode', 'proficiency']).where('candidateId', '=', id).orderBy('languageCode').execute(),
    db.selectFrom('candidateSkills as cs').innerJoin('skills as k', 'k.key', 'cs.skillKey').select(['cs.skillKey', 'k.label', 'cs.provenance']).where('cs.candidateId', '=', id).orderBy('k.sortOrder').execute(),
    db.selectFrom('candidateAvailabilityWindows').select(['dayOfWeek', 'startMinute', 'endMinute']).where('candidateId', '=', id).orderBy('dayOfWeek').orderBy('startMinute').execute(),
    db.selectFrom('candidateFieldVerifications as v').leftJoin('staffMembers as s', 's.id', 'v.verifiedBy').selectAll('v').select('s.displayName as verifierName').where('v.candidateId', '=', id).execute(),
    db.selectFrom('candidateCustomAnswers').select(['questionKey', 'value', 'formVersionId']).where('candidateId', '=', id).execute(),
    db.selectFrom('applications').select(['id', 'reference', 'submittedAt', 'formVersionId']).where('candidateId', '=', id).orderBy('submittedAt', 'desc').execute()
  ]);
  const qualificationDtos = qualifications.map(q => ({
    ...q,
    current: q.reviewState === 'verified' && (!q.hasExpiry || (q.expiresOn !== null && q.expiresOn >= day))
  }));
  return {
    ...row,
    assignedStaff: staffRef(row.assignedStaffId, row.assignedName),
    currentQualifications: [...new Set(qualificationDtos.filter(q => q.current).map(q => q.qualificationKey))],
    compensation:
      row.compensationCurrency && row.compensationPeriod
        ? { minMinor: row.compensationMinMinor, maxMinor: row.compensationMaxMinor, currency: row.compensationCurrency, period: row.compensationPeriod }
        : null,
    employments,
    qualifications: qualificationDtos,
    languages,
    skills,
    availabilityWindows: windows.map(w => ({ dayOfWeek: w.dayOfWeek, start: minutesToHhmm(w.startMinute), end: minutesToHhmm(w.endMinute) })),
    fieldVerifications: verifications.map(v => ({ ...v, verifiedBy: staffRef(v.verifiedBy, v.verifierName) })),
    customAnswers,
    applications
  };
}

/** Maps API profile fields to columns (compensation is split into its columns). */
export function profileToColumns(input: Partial<CandidateProfileT>) {
  const { compensation, phone, ...rest } = input;
  const values: Record<string, unknown> = { ...rest };
  if (phone !== undefined) {
    values.phone = phone;
    values.phoneNormalized = normalizePhone(phone);
  }
  if (compensation !== undefined) {
    values.compensationMinMinor = compensation?.minMinor ?? null;
    values.compensationMaxMinor = compensation?.maxMinor ?? null;
    values.compensationCurrency = compensation?.currency ?? null;
    values.compensationPeriod = compensation?.period ?? null;
  }
  for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
  return values;
}

async function assertServiceTypes(db: Executor, keys: string[] | undefined) {
  if (!keys?.length) return;
  const found = await db.selectFrom('serviceTypes').select('key').where('key', 'in', keys).execute();
  const missing = keys.filter(key => !found.some(row => row.key === key));
  if (missing.length) throw validationFailed([{ path: 'desiredServiceTypes', code: 'invalid', message: `Unknown service types: ${missing.join(', ')}` }]);
}

export async function insertCandidate(trx: Tx, meta: RequestMeta, values: Record<string, unknown> & { email: string; firstName: string; lastName: string }) {
  const candidate = await trx
    .insertInto('candidates')
    .values({ reference: await uniqueReference(trx, 'candidates', 'C'), ...values } as never)
    .returning(['id', 'email', 'phoneNormalized', 'recruitmentStage', 'availabilityStatus'])
    .executeTakeFirstOrThrow();
  await recordTransition(trx, meta, { dimension: 'candidate_recruitment', subjectId: candidate.id, from: null, to: candidate.recruitmentStage });
  const duplicates = await detectCandidateDuplicates(trx, candidate.id, candidate.email, candidate.phoneNormalized);
  return { ...candidate, duplicates };
}

export async function createCandidate(deps: AppDeps, meta: RequestMeta, input: Partial<CandidateProfileT> & { firstName: string; lastName: string; email: string; assignedStaffId?: string | null; source?: string }) {
  await assertServiceTypes(deps.db, input.desiredServiceTypes);
  const { assignedStaffId, source, ...profile } = input;
  const id = await deps.db.transaction().execute(async trx => {
    const candidate = await insertCandidate(trx, meta, {
      ...(profileToColumns(profile) as { email: string; firstName: string; lastName: string }),
      assignedStaffId: assignedStaffId ?? null,
      source: source ?? 'staff_entry'
    });
    await audit(trx, meta, { action: 'candidate.created', subjectType: 'candidate', subjectId: candidate.id, metadata: { possibleDuplicates: candidate.duplicates } });
    return candidate.id;
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function updateCandidate(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: Partial<CandidateProfileT> & { version: number; assignedStaffId?: string | null }) {
  await assertServiceTypes(deps.db, input.desiredServiceTypes);
  const { version, assignedStaffId, ...profile } = input;
  await deps.db.transaction().execute(async trx => {
    const before = await trx.selectFrom('candidates').selectAll().where('id', '=', id).executeTakeFirst();
    if (!before) throw notFound('Candidate');
    await assertInScope(trx, staff, before.assignedStaffId);
    if (before.mergedIntoCandidateId) throw unprocessable('This candidate was merged into another record.', 'record_merged');
    const values = { ...profileToColumns(profile), ...(assignedStaffId !== undefined ? { assignedStaffId } : {}) };
    await updateVersioned(trx, 'candidates', id, version, values, 'Candidate');
    await audit(trx, meta, { action: 'candidate.updated', subjectType: 'candidate', subjectId: id, metadata: { fields: changedFields(before as never, values) } });
  });
  return getCandidate(deps, deps.db, null, id);
}

/** Locks the candidate row and checks the caller's version before a child-record change. */
async function lockCandidate(trx: Tx, staff: StaffActor, id: string, version: number) {
  const row = await trx.selectFrom('candidates').select(['id', 'version', 'assignedStaffId', 'mergedIntoCandidateId']).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!row) throw notFound('Candidate');
  await assertInScope(trx, staff, row.assignedStaffId);
  if (row.mergedIntoCandidateId) throw unprocessable('This candidate was merged into another record.', 'record_merged');
  await updateVersioned(trx, 'candidates', id, version, {}, 'Candidate');
}

export async function transitionCandidate(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { to: string; reason?: string; version: number }) {
  await deps.db.transaction().execute(async trx => {
    const current = await trx.selectFrom('candidates').select(['recruitmentStage', 'assignedStaffId']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw notFound('Candidate');
    await assertInScope(trx, staff, current.assignedStaffId);
    await assertTransitionAllowed(trx, 'candidate_recruitment', current.recruitmentStage, input.to);
    let eligibility: Awaited<ReturnType<typeof evaluateEligibility>> | null = null;
    if (input.to === 'eligible') {
      eligibility = await evaluateEligibility(trx, id, { now: deps.clock.now(), timezone: (await getSettings(trx)).timezone });
      if (!eligibility.eligible) {
        throw unprocessable('The candidate does not meet the current screening policy.', 'eligibility_not_met', { eligibility });
      }
    }
    const values: Record<string, unknown> = { recruitmentStage: input.to };
    if (input.to === 'archived') values.archivedAt = deps.clock.now().toISOString();
    if (current.recruitmentStage === 'archived') values.archivedAt = null;
    await updateVersioned(trx, 'candidates', id, input.version, values, 'Candidate');
    await recordTransition(trx, meta, {
      dimension: 'candidate_recruitment',
      subjectId: id,
      from: current.recruitmentStage,
      to: input.to,
      reason: input.reason,
      metadata: eligibility ? { policyVersion: eligibility.policyVersion, overridden: eligibility.requirements.filter(r => r.status === 'overridden').map(r => r.key) } : {}
    });
    await audit(trx, meta, { action: 'candidate.stage_changed', subjectType: 'candidate', subjectId: id, metadata: { from: current.recruitmentStage, to: input.to } });
    await emit(trx, meta, { type: 'candidate.stage_changed', subjectType: 'candidate', subjectId: id, payload: { from: current.recruitmentStage, to: input.to, related: { candidate: id } } });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function changeAvailability(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { status: string; availableFrom?: string | null; version: number; reason?: string }) {
  await deps.db.transaction().execute(async trx => {
    const current = await trx.selectFrom('candidates').select(['availabilityStatus', 'availableFrom', 'assignedStaffId']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw notFound('Candidate');
    await assertInScope(trx, staff, current.assignedStaffId);
    await updateVersioned(trx, 'candidates', id, input.version, {
      availabilityStatus: input.status,
      availableFrom: input.status === 'future_date' ? input.availableFrom : null,
      availabilityConfirmedAt: deps.clock.now().toISOString()
    }, 'Candidate');
    await recordTransition(trx, meta, { dimension: 'candidate_availability', subjectId: id, from: current.availabilityStatus, to: input.status, reason: input.reason, metadata: { availableFrom: input.availableFrom ?? null } });
    await emit(trx, meta, { type: 'candidate.availability_changed', subjectType: 'candidate', subjectId: id, payload: { from: current.availabilityStatus, to: input.status, related: { candidate: id } } });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function replaceAvailabilityWindows(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, version: number, windows: Array<{ dayOfWeek: number; start: string; end: string }>) {
  await deps.db.transaction().execute(async trx => {
    await lockCandidate(trx, staff, id, version);
    await trx.deleteFrom('candidateAvailabilityWindows').where('candidateId', '=', id).execute();
    if (windows.length) {
      await trx.insertInto('candidateAvailabilityWindows').values(windows.map(w => ({ candidateId: id, dayOfWeek: w.dayOfWeek, startMinute: hhmmToMinutes(w.start), endMinute: hhmmToMinutes(w.end) }))).execute();
    }
    await audit(trx, meta, { action: 'candidate.availability_windows_replaced', subjectType: 'candidate', subjectId: id, metadata: { count: windows.length } });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function replaceLanguages(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, version: number, languages: Array<{ languageCode: string; proficiency: string }>) {
  await deps.db.transaction().execute(async trx => {
    await lockCandidate(trx, staff, id, version);
    await trx.deleteFrom('candidateLanguages').where('candidateId', '=', id).execute();
    const unique = [...new Map(languages.map(l => [l.languageCode, l])).values()];
    if (unique.length) await trx.insertInto('candidateLanguages').values(unique.map(l => ({ candidateId: id, ...l }))).execute();
    await audit(trx, meta, { action: 'candidate.languages_replaced', subjectType: 'candidate', subjectId: id });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function replaceSkills(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, version: number, skills: Array<{ skillKey: string; provenance: string }>) {
  await deps.db.transaction().execute(async trx => {
    await lockCandidate(trx, staff, id, version);
    await trx.deleteFrom('candidateSkills').where('candidateId', '=', id).execute();
    const unique = [...new Map(skills.map(s => [s.skillKey, s])).values()];
    if (unique.length) await trx.insertInto('candidateSkills').values(unique.map(s => ({ candidateId: id, ...s }))).execute();
    await audit(trx, meta, { action: 'candidate.skills_replaced', subjectType: 'candidate', subjectId: id });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function addEmployment(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, version: number, input: Record<string, unknown>) {
  await deps.db.transaction().execute(async trx => {
    await lockCandidate(trx, staff, id, version);
    await trx.insertInto('candidateEmployments').values({ candidateId: id, ...input } as never).execute();
    await audit(trx, meta, { action: 'candidate.employment_added', subjectType: 'candidate', subjectId: id });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function updateEmployment(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, employmentId: string, version: number, input: Record<string, unknown>) {
  await deps.db.transaction().execute(async trx => {
    await lockCandidate(trx, staff, id, version);
    const values = { ...input };
    if (values.provenance === 'agency_verified') Object.assign(values, { verifiedAt: deps.clock.now().toISOString(), verifiedBy: staff.staffId });
    const result = await trx.updateTable('candidateEmployments').set(values).where('id', '=', employmentId).where('candidateId', '=', id).executeTakeFirst();
    if (!result.numUpdatedRows) throw notFound('Employment');
    await audit(trx, meta, { action: 'candidate.employment_updated', subjectType: 'candidate', subjectId: id, metadata: { employmentId, fields: Object.keys(values) } });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function deleteEmployment(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, employmentId: string, version: number) {
  await deps.db.transaction().execute(async trx => {
    await lockCandidate(trx, staff, id, version);
    const result = await trx.deleteFrom('candidateEmployments').where('id', '=', employmentId).where('candidateId', '=', id).executeTakeFirst();
    if (!result.numDeletedRows) throw notFound('Employment');
    await audit(trx, meta, { action: 'candidate.employment_removed', subjectType: 'candidate', subjectId: id, metadata: { employmentId } });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function addQualification(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, version: number, input: { qualificationKey: string; issuer?: string | null; issuedOn?: string | null; expiresOn?: string | null; documentId?: string | null }) {
  await deps.db.transaction().execute(async trx => {
    await lockCandidate(trx, staff, id, version);
    const type = await trx.selectFrom('qualificationTypes').select('key').where('key', '=', input.qualificationKey).executeTakeFirst();
    if (!type) throw validationFailed([{ path: 'qualificationKey', code: 'invalid', message: 'Unknown qualification type' }]);
    if (input.documentId) await assertCandidateDocument(trx, id, input.documentId);
    await trx.insertInto('candidateQualifications').values({ candidateId: id, ...input, provenance: input.documentId ? 'document_supplied' : 'self_reported' }).execute();
    await audit(trx, meta, { action: 'candidate.qualification_added', subjectType: 'candidate', subjectId: id, metadata: { qualificationKey: input.qualificationKey } });
  });
  return getCandidate(deps, deps.db, null, id);
}

async function assertCandidateDocument(db: Executor, candidateId: string, documentId: string) {
  const document = await db.selectFrom('documents').select('id').where('id', '=', documentId).where('candidateId', '=', candidateId).where('deletedAt', 'is', null).executeTakeFirst();
  if (!document) throw validationFailed([{ path: 'documentId', code: 'invalid', message: 'The document does not belong to this candidate' }]);
}

export async function updateQualification(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, qualificationId: string, version: number, input: { issuer?: string | null; issuedOn?: string | null; expiresOn?: string | null; documentId?: string | null }) {
  await deps.db.transaction().execute(async trx => {
    await lockCandidate(trx, staff, id, version);
    if (input.documentId) await assertCandidateDocument(trx, id, input.documentId);
    // Changing the evidence resets any earlier review.
    const result = await trx
      .updateTable('candidateQualifications')
      .set({ ...input, reviewState: 'pending_review', reviewedAt: null, reviewedBy: null, version: sql`version + 1` })
      .where('id', '=', qualificationId)
      .where('candidateId', '=', id)
      .executeTakeFirst();
    if (!result.numUpdatedRows) throw notFound('Qualification');
    await audit(trx, meta, { action: 'candidate.qualification_updated', subjectType: 'candidate', subjectId: id, metadata: { qualificationId, fields: Object.keys(input) } });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function reviewQualification(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, qualificationId: string, input: { decision: 'verified' | 'rejected'; note?: string; qualificationVersion: number }) {
  await deps.db.transaction().execute(async trx => {
    const row = await trx
      .selectFrom('candidateQualifications as q')
      .innerJoin('qualificationTypes as t', 't.key', 'q.qualificationKey')
      .innerJoin('candidates as c', 'c.id', 'q.candidateId')
      .select(['q.id', 'q.version', 'q.expiresOn', 't.hasExpiry', 'c.assignedStaffId'])
      .where('q.id', '=', qualificationId)
      .where('q.candidateId', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Qualification');
    await assertInScope(trx, staff, row.assignedStaffId);
    if (input.decision === 'verified' && row.hasExpiry && !row.expiresOn) {
      throw validationFailed([{ path: 'expiresOn', code: 'required', message: 'Record the expiry date before verifying this certificate' }]);
    }
    await updateVersioned(trx, 'candidateQualifications', qualificationId, input.qualificationVersion, {
      reviewState: input.decision,
      reviewNote: input.note ?? null,
      reviewedAt: deps.clock.now().toISOString(),
      reviewedBy: staff.staffId,
      ...(input.decision === 'verified' ? { provenance: 'agency_verified' } : {})
    }, 'Qualification');
    await sql`update candidates set version = version + 1 where id = ${id}`.execute(trx);
    await audit(trx, meta, { action: 'candidate.qualification_reviewed', subjectType: 'candidate', subjectId: id, metadata: { qualificationId, decision: input.decision } });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function setFieldVerification(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, fieldKey: string, input: { provenance: string; note?: string | null; evidenceDocumentId?: string | null; version: number }) {
  await deps.db.transaction().execute(async trx => {
    await lockCandidate(trx, staff, id, input.version);
    if (input.evidenceDocumentId) await assertCandidateDocument(trx, id, input.evidenceDocumentId);
    const values = { provenance: input.provenance, note: input.note ?? null, evidenceDocumentId: input.evidenceDocumentId ?? null, verifiedBy: staff.staffId, verifiedAt: deps.clock.now().toISOString() };
    await trx
      .insertInto('candidateFieldVerifications')
      .values({ candidateId: id, fieldKey, ...values })
      .onConflict(oc => oc.columns(['candidateId', 'fieldKey']).doUpdateSet(values))
      .execute();
    await audit(trx, meta, { action: 'candidate.field_verified', subjectType: 'candidate', subjectId: id, metadata: { fieldKey, provenance: input.provenance } });
  });
  return getCandidate(deps, deps.db, null, id);
}

export async function candidateEligibility(deps: AppDeps, staff: StaffActor, id: string, jobOrderId?: string) {
  const candidate = await deps.db.selectFrom('candidates').select(['id', 'assignedStaffId']).where('id', '=', id).executeTakeFirst();
  if (!candidate) throw notFound('Candidate');
  await assertInScope(deps.db, staff, candidate.assignedStaffId);
  return evaluateEligibility(deps.db, id, { now: deps.clock.now(), timezone: (await getSettings(deps.db)).timezone, jobOrderId: jobOrderId ?? null });
}
