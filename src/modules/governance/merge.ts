import { sql } from 'kysely';
import type { AppDeps, RequestMeta } from '../../context.js';
import type { Tx } from '../../db/index.js';
import { audit } from '../../domain/audit.js';
import { conflict, notFound, unprocessable, versionConflict } from '../../http/errors.js';
import { normalizePhone } from '../../domain/records.js';

/**
 * Owner-confirmed merges. The surviving record keeps its id; dependent records are re-pointed,
 * the merged record is archived with merged_into set, and a merge record keeps the merged
 * record's previous values and what moved. Both versions are checked so a concurrent edit of
 * either record causes a conflict rather than silent loss.
 */

type Choice = 'survivor' | 'merged';

async function lockPair<T extends 'families' | 'candidates'>(trx: Tx, table: T, survivorId: string, mergedId: string) {
  // Lock in id order to avoid deadlocks between concurrent merges.
  const rows = await trx.selectFrom(table as 'families').selectAll().where('id', 'in', [survivorId, mergedId]).orderBy('id').forUpdate().execute();
  const survivor = rows.find(r => r.id === survivorId);
  const merged = rows.find(r => r.id === mergedId);
  if (!survivor || !merged) throw notFound('Record');
  return { survivor, merged } as unknown as { survivor: Record<string, any>; merged: Record<string, any> };
}

async function count(trx: Tx, query: { numUpdatedRows?: bigint; numDeletedRows?: bigint } | Array<unknown>) {
  if (Array.isArray(query)) return query.length;
  return Number(query.numUpdatedRows ?? query.numDeletedRows ?? 0);
}

async function closeDuplicateCases(trx: Tx, entityType: 'family' | 'candidate', survivorId: string, mergedId: string, staffId: string, now: string, caseId?: string) {
  if (caseId) await trx.updateTable('duplicateCases').set({ status: 'merged', resolvedAt: now, resolvedBy: staffId }).where('id', '=', caseId).execute();
  const [a, b] = survivorId < mergedId ? [survivorId, mergedId] : [mergedId, survivorId];
  await trx.updateTable('duplicateCases').set({ status: 'merged', resolvedAt: now, resolvedBy: staffId }).where('entityType', '=', entityType).where('firstRecordId', '=', a).where('secondRecordId', '=', b).execute();
  // Other open cases involving the merged record now point at the survivor (or close if they become self-pairs).
  const others = await trx.selectFrom('duplicateCases').selectAll().where('entityType', '=', entityType).where('status', '=', 'open').where(eb => eb.or([eb('firstRecordId', '=', mergedId), eb('secondRecordId', '=', mergedId)])).execute();
  for (const other of others) {
    const otherId = other.firstRecordId === mergedId ? other.secondRecordId : other.firstRecordId;
    await trx.updateTable('duplicateCases').set({ status: 'merged', resolvedAt: now, resolvedBy: staffId, resolutionNote: `Superseded by merge into ${survivorId}` }).where('id', '=', other.id).execute();
    if (otherId === survivorId) continue;
    const [x, y] = survivorId < otherId ? [survivorId, otherId] : [otherId, survivorId];
    await trx.insertInto('duplicateCases').values({ entityType, firstRecordId: x, secondRecordId: y, matchReasons: other.matchReasons, detectedAt: now }).onConflict(oc => oc.columns(['entityType', 'firstRecordId', 'secondRecordId']).doNothing()).execute();
  }
}

export const FAMILY_MERGE_FIELDS = ['displayName', 'city', 'state', 'postalCode', 'serviceArea', 'householdSummary', 'assignedStaffId', 'relationshipStatus'] as const;

export async function mergeFamilies(
  deps: AppDeps,
  meta: RequestMeta,
  input: { survivorId: string; mergedId: string; survivorVersion: number; mergedVersion: number; fieldChoices?: Partial<Record<(typeof FAMILY_MERGE_FIELDS)[number], Choice>>; duplicateCaseId?: string; staffId: string }
) {
  if (input.survivorId === input.mergedId) throw unprocessable('Choose two different families.', 'same_record');
  return deps.db.transaction().execute(async trx => {
    await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx);
    const { survivor, merged } = await lockPair(trx, 'families', input.survivorId, input.mergedId);
    if (survivor.version !== input.survivorVersion) throw versionConflict(survivor.version);
    if (merged.version !== input.mergedVersion) throw versionConflict(merged.version);
    if (survivor.mergedIntoFamilyId || merged.mergedIntoFamilyId) throw conflict('One of these families was already merged.', 'already_merged');
    const now = meta.now.toISOString();
    const contacts = await trx.selectFrom('familyContacts').selectAll().where('familyId', '=', input.mergedId).execute();
    const changes: Record<string, unknown> = {};
    for (const field of FAMILY_MERGE_FIELDS) if (input.fieldChoices?.[field] === 'merged') changes[field] = merged[field];
    const survivorHasPrimary = Boolean(await trx.selectFrom('familyContacts').select('id').where('familyId', '=', input.survivorId).where('isPrimary', '=', true).where('archivedAt', 'is', null).executeTakeFirst());
    const reparented: Record<string, number> = {};
    if (survivorHasPrimary) await trx.updateTable('familyContacts').set({ isPrimary: false }).where('familyId', '=', input.mergedId).execute();
    // Fixed allowlist of tables; identifiers are never taken from input.
    for (const table of ['family_contacts', 'enquiries', 'job_orders', 'placements', 'presentations', 'invoices', 'agreements', 'tasks', 'notes', 'communications', 'appointments', 'consultations', 'documents'] as const) {
      const result = await sql`update ${sql.table(table)} set family_id = ${input.survivorId} where family_id = ${input.mergedId}`.execute(trx);
      reparented[table] = Number(result.numAffectedRows ?? 0);
    }
    reparented.workflowRuns = await count(trx, await trx.updateTable('workflowRuns').set({ subjectId: input.survivorId }).where('subjectType', '=', 'family').where('subjectId', '=', input.mergedId).where('status', '=', 'active').executeTakeFirst());
    await trx.updateTable('automationPauses').set({ subjectId: input.survivorId }).where('subjectType', '=', 'family').where('subjectId', '=', input.mergedId).where('releasedAt', 'is', null).execute();
    await trx.updateTable('families').set({ ...changes, version: sql`version + 1` }).where('id', '=', input.survivorId).execute();
    await trx.updateTable('families').set({ mergedIntoFamilyId: input.survivorId, mergedAt: now, archivedAt: now, version: sql`version + 1` }).where('id', '=', input.mergedId).execute();
    await closeDuplicateCases(trx, 'family', input.survivorId, input.mergedId, input.staffId, now, input.duplicateCaseId);
    const record = await trx
      .insertInto('mergeRecords')
      .values({ entityType: 'family', survivorId: input.survivorId, mergedId: input.mergedId, duplicateCaseId: input.duplicateCaseId ?? null, fieldChoices: JSON.stringify(input.fieldChoices ?? {}), mergedRecordSnapshot: JSON.stringify({ family: merged, contacts }), reparented: JSON.stringify(reparented), actorStaffId: input.staffId, occurredAt: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, meta, { action: 'family.merged', subjectType: 'family', subjectId: input.survivorId, metadata: { mergedId: input.mergedId, mergeRecordId: record.id, reparented, fields: Object.keys(changes) } });
    return { mergeRecordId: record.id, reparented };
  });
}

export const CANDIDATE_MERGE_FIELDS = [
  'firstName', 'lastName', 'preferredName', 'email', 'phone', 'city', 'state', 'postalCode', 'preferredAreas', 'maxCommuteMiles', 'childcareYears', 'professionalNannyYears',
  'ageGroups', 'maxChildrenCared', 'educationLevel', 'drivingEligible', 'hasVehicle', 'desiredServiceTypes', 'desiredArrangement', 'desiredScheduleTypes', 'earliestStartDate',
  'compensationMinMinor', 'compensationMaxMinor', 'compensationCurrency', 'compensationPeriod', 'introduction', 'recruitmentStage', 'availabilityStatus', 'availableFrom', 'assignedStaffId'
] as const;

export async function mergeCandidates(
  deps: AppDeps,
  meta: RequestMeta,
  input: { survivorId: string; mergedId: string; survivorVersion: number; mergedVersion: number; fieldChoices?: Partial<Record<(typeof CANDIDATE_MERGE_FIELDS)[number], Choice>>; duplicateCaseId?: string; staffId: string }
) {
  if (input.survivorId === input.mergedId) throw unprocessable('Choose two different candidates.', 'same_record');
  return deps.db.transaction().execute(async trx => {
    await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx);
    const { survivor, merged } = await lockPair(trx, 'candidates', input.survivorId, input.mergedId);
    if (survivor.version !== input.survivorVersion) throw versionConflict(survivor.version);
    if (merged.version !== input.mergedVersion) throw versionConflict(merged.version);
    if (survivor.mergedIntoCandidateId || merged.mergedIntoCandidateId) throw conflict('One of these candidates was already merged.', 'already_merged');
    const now = meta.now.toISOString();
    const S = input.survivorId;
    const M = input.mergedId;
    const changes: Record<string, unknown> = {};
    for (const field of CANDIDATE_MERGE_FIELDS) if (input.fieldChoices?.[field] === 'merged') changes[field] = merged[field];
    if (changes.phone !== undefined) changes.phoneNormalized = normalizePhone(changes.phone as string | null);
    if (!survivor.presentationPhotoDocumentId && merged.presentationPhotoDocumentId) changes.presentationPhotoDocumentId = merged.presentationPhotoDocumentId;
    const reparented: Record<string, number> = {};
    const tally = async (key: string, result: { numUpdatedRows?: bigint; numDeletedRows?: bigint }) => (reparented[key] = (reparented[key] ?? 0) + (await count(trx, result)));

    for (const table of ['applications', 'candidate_employments', 'candidate_qualifications', 'candidate_references', 'interviews', 'screening_checks', 'eligibility_overrides', 'documents', 'consents', 'information_requests', 'tasks', 'notes', 'communications', 'appointments'] as const) {
      const result = await sql`update ${sql.table(table)} set candidate_id = ${S} where candidate_id = ${M}`.execute(trx);
      reparented[table] = Number(result.numAffectedRows ?? 0);
    }
    // Set-like child records: keep the survivor's, add what only the merged record had.
    await sql`insert into candidate_languages (candidate_id, language_code, proficiency) select ${S}::uuid, language_code, proficiency from candidate_languages where candidate_id = ${M} on conflict do nothing`.execute(trx);
    await tally('languagesRemoved', await trx.deleteFrom('candidateLanguages').where('candidateId', '=', M).executeTakeFirst());
    await sql`insert into candidate_skills (candidate_id, skill_key, provenance) select ${S}::uuid, skill_key, provenance from candidate_skills where candidate_id = ${M} on conflict do nothing`.execute(trx);
    await trx.deleteFrom('candidateSkills').where('candidateId', '=', M).execute();
    await sql`insert into candidate_field_verifications (candidate_id, field_key, provenance, verified_by, verified_at, evidence_document_id, note) select ${S}::uuid, field_key, provenance, verified_by, verified_at, evidence_document_id, note from candidate_field_verifications where candidate_id = ${M} on conflict do nothing`.execute(trx);
    await trx.deleteFrom('candidateFieldVerifications').where('candidateId', '=', M).execute();
    await sql`insert into candidate_custom_answers (candidate_id, question_key, form_version_id, value, value_text, value_number, value_boolean, value_date, value_options, updated_at) select ${S}::uuid, question_key, form_version_id, value, value_text, value_number, value_boolean, value_date, value_options, updated_at from candidate_custom_answers where candidate_id = ${M} on conflict do nothing`.execute(trx);
    await trx.deleteFrom('candidateCustomAnswers').where('candidateId', '=', M).execute();
    const survivorWindows = await trx.selectFrom('candidateAvailabilityWindows').select('id').where('candidateId', '=', S).executeTakeFirst();
    if (!survivorWindows) await trx.updateTable('candidateAvailabilityWindows').set({ candidateId: S }).where('candidateId', '=', M).execute();
    else await trx.deleteFrom('candidateAvailabilityWindows').where('candidateId', '=', M).execute();

    // Job associations: move unless the survivor is already on that job, in which case the
    // merged record's association is withdrawn and kept for history.
    const associations = await trx.selectFrom('jobCandidates').select(['id', 'jobOrderId', 'stage']).where('candidateId', '=', M).execute();
    const survivorJobs = new Set((await trx.selectFrom('jobCandidates').select('jobOrderId').where('candidateId', '=', S).execute()).map(r => r.jobOrderId));
    let kept = 0;
    for (const assoc of associations) {
      if (survivorJobs.has(assoc.jobOrderId)) {
        const placed = await trx.selectFrom('placements').select('id').where('jobCandidateId', '=', assoc.id).executeTakeFirst();
        if (placed) throw conflict('Both candidates are linked to the same job and one has a placement there. Resolve the job association first.', 'merge_conflict_job');
        if (!['withdrawn', 'declined'].includes(assoc.stage)) await trx.updateTable('jobCandidates').set({ stage: 'withdrawn', closedReason: `Merged into candidate ${S}` }).where('id', '=', assoc.id).execute();
        kept++;
        continue;
      }
      await trx.updateTable('jobCandidates').set({ candidateId: S }).where('id', '=', assoc.id).execute();
      await trx.updateTable('placements').set({ candidateId: S }).where('jobCandidateId', '=', assoc.id).execute();
      await trx.updateTable('presentationCandidates').set({ candidateId: S }).where('jobCandidateId', '=', assoc.id).execute();
      reparented.jobAssociations = (reparented.jobAssociations ?? 0) + 1;
    }
    reparented.jobAssociationsWithdrawn = kept;
    reparented.workflowRuns = await count(trx, await trx.updateTable('workflowRuns').set({ subjectId: S }).where('subjectType', '=', 'candidate').where('subjectId', '=', M).where('status', '=', 'active').executeTakeFirst());
    await trx.updateTable('automationPauses').set({ subjectId: S }).where('subjectType', '=', 'candidate').where('subjectId', '=', M).where('releasedAt', 'is', null).execute();

    await trx.updateTable('candidates').set({ ...changes, version: sql`version + 1` }).where('id', '=', S).execute();
    await trx.updateTable('candidates').set({ mergedIntoCandidateId: S, mergedAt: now, archivedAt: now, recruitmentStage: 'archived', presentationPhotoDocumentId: null, version: sql`version + 1` }).where('id', '=', M).execute();
    await closeDuplicateCases(trx, 'candidate', S, M, input.staffId, now, input.duplicateCaseId);
    const record = await trx
      .insertInto('mergeRecords')
      .values({ entityType: 'candidate', survivorId: S, mergedId: M, duplicateCaseId: input.duplicateCaseId ?? null, fieldChoices: JSON.stringify(input.fieldChoices ?? {}), mergedRecordSnapshot: JSON.stringify(merged), reparented: JSON.stringify(reparented), actorStaffId: input.staffId, occurredAt: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, meta, { action: 'candidate.merged', subjectType: 'candidate', subjectId: S, metadata: { mergedId: M, mergeRecordId: record.id, reparented, fields: Object.keys(changes) } });
    return { mergeRecordId: record.id, reparented };
  });
}
