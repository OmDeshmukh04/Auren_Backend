import { sql } from 'kysely';
import type { AppDeps, RequestMeta, StaffActor } from '../../context.js';
import type { Executor, Tx } from '../../db/index.js';
import { audit, changedFields } from '../../domain/audit.js';
import { emit } from '../../domain/outbox.js';
import { assertTransitionAllowed, recordTransition } from '../../domain/stages.js';
import { applyAssignedScope, assertInScope, assignedOnly, likeEscape, pageArgs, uniqueReference, updateVersioned } from '../../domain/records.js';
import { getSettings } from '../../domain/settings.js';
import { conflict, notFound, unprocessable, validationFailed } from '../../http/errors.js';
import { minutesToHhmm } from '../../http/schemas.js';
import { localDate } from '../../lib/time.js';
import { compareCandidateToJob, windowsToRows } from './compare.js';

const staffRef = (id: string | null, name: string | null) => (id ? { id, displayName: name ?? '' } : null);

function compensationOf(row: { compensationMinMinor: number | null; compensationMaxMinor: number | null; compensationCurrency: string | null; compensationPeriod: string | null }) {
  return row.compensationCurrency && row.compensationPeriod
    ? { minMinor: row.compensationMinMinor, maxMinor: row.compensationMaxMinor, currency: row.compensationCurrency, period: row.compensationPeriod as 'hour' }
    : null;
}

function jobColumns(input: Record<string, unknown>) {
  const { compensation, ...rest } = input as { compensation?: { minMinor: number | null; maxMinor: number | null; currency: string; period: string } | null };
  const values: Record<string, unknown> = { ...rest };
  if (compensation !== undefined) {
    Object.assign(values, {
      compensationMinMinor: compensation?.minMinor ?? null,
      compensationMaxMinor: compensation?.maxMinor ?? null,
      compensationCurrency: compensation?.currency ?? null,
      compensationPeriod: compensation?.period ?? null
    });
  }
  for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
  return values;
}

function jobBase(db: Executor) {
  return db
    .selectFrom('jobOrders as j')
    .innerJoin('families as f', 'f.id', 'j.familyId')
    .leftJoin('staffMembers as s', 's.id', 'j.assignedStaffId');
}

const candidateCount = sql<number>`(select count(*)::int from job_candidates jc where jc.job_order_id = j.id and jc.stage not in ('declined', 'withdrawn'))`;

export async function listJobs(deps: AppDeps, staff: StaffActor, query: { q?: string; status?: string[]; familyId?: string; assignedStaffId?: string; includeTest?: boolean; page: number; pageSize: number; sort: string }) {
  let base = jobBase(deps.db);
  base = applyAssignedScope(base as never, 'j.assignedStaffId', staff.staffId, await assignedOnly(deps.db, staff)) as typeof base;
  if (!query.includeTest) base = base.where('j.isTest', '=', false);
  if (query.status?.length) base = base.where('j.status', 'in', query.status);
  if (query.familyId) base = base.where('j.familyId', '=', query.familyId);
  if (query.assignedStaffId) base = base.where('j.assignedStaffId', '=', query.assignedStaffId);
  if (query.q) {
    const term = `%${likeEscape(query.q.trim())}%`;
    base = base.where(eb => eb.or([eb('j.title', 'ilike', term), eb('j.reference', 'ilike', term), eb('f.displayName', 'ilike', term), eb('j.locationCity', 'ilike', term)]));
  }
  const total = await base.select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const sorts: Record<string, [string, 'asc' | 'desc']> = { updated_desc: ['j.updatedAt', 'desc'], created_desc: ['j.createdAt', 'desc'], start_asc: ['j.startDate', 'asc'] };
  const [column, direction] = sorts[query.sort] ?? sorts.updated_desc!;
  const { limit, offset } = pageArgs(query.page, query.pageSize);
  const rows = await base
    .selectAll('j')
    .select(['f.displayName as familyName', 's.displayName as assignedName', candidateCount.as('candidateCount')])
    .orderBy(sql.ref(column), ob => (direction === 'desc' ? ob.desc().nullsLast() : ob.asc().nullsLast()))
    .orderBy('j.id')
    .limit(limit)
    .offset(offset)
    .execute();
  return {
    items: rows.map(row => ({ ...row, compensation: compensationOf(row), assignedStaff: staffRef(row.assignedStaffId, row.assignedName) })),
    page: query.page,
    pageSize: query.pageSize,
    total: Number(total.n)
  };
}

export async function getJob(deps: AppDeps, db: Executor, staff: StaffActor | null, id: string) {
  const row = await jobBase(db)
    .selectAll('j')
    .select(['f.displayName as familyName', 's.displayName as assignedName', candidateCount.as('candidateCount')])
    .where('j.id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Job');
  if (staff) await assertInScope(db, staff, row.assignedStaffId);
  const [criteria, windows] = await Promise.all([
    db.selectFrom('jobOrderCriteria').select(['id', 'importance', 'criterion', 'params', 'note', 'sortOrder']).where('jobOrderId', '=', id).orderBy('sortOrder').execute(),
    db.selectFrom('jobOrderScheduleWindows').select(['dayOfWeek', 'startMinute', 'endMinute']).where('jobOrderId', '=', id).orderBy('dayOfWeek').orderBy('startMinute').execute()
  ]);
  return {
    ...row,
    compensation: compensationOf(row),
    assignedStaff: staffRef(row.assignedStaffId, row.assignedName),
    criteria,
    scheduleWindows: windows.map(w => ({ dayOfWeek: w.dayOfWeek, start: minutesToHhmm(w.startMinute), end: minutesToHhmm(w.endMinute) }))
  };
}

type CriterionInput = { importance: string; criterion: string; params: Record<string, unknown>; note?: string | null; sortOrder: number };

async function replaceCriteria(trx: Tx, jobOrderId: string, criteria: CriterionInput[]) {
  await trx.deleteFrom('jobOrderCriteria').where('jobOrderId', '=', jobOrderId).execute();
  if (criteria.length) {
    await trx
      .insertInto('jobOrderCriteria')
      .values(criteria.map((c, index) => ({ jobOrderId, importance: c.importance, criterion: c.criterion, params: JSON.stringify(c.params ?? {}), note: c.note ?? null, sortOrder: c.sortOrder ?? index })))
      .execute();
  }
}

export async function createJob(deps: AppDeps, meta: RequestMeta, staff: StaffActor, input: Record<string, unknown> & { familyId: string; title: string; criteria: CriterionInput[]; scheduleWindows: Array<{ dayOfWeek: number; start: string; end: string }> }) {
  const { criteria, scheduleWindows, ...fields } = input;
  const id = await deps.db.transaction().execute(async trx => {
    const family = await trx.selectFrom('families').select(['id', 'mergedIntoFamilyId', 'assignedStaffId', 'isTest']).where('id', '=', input.familyId).executeTakeFirst();
    if (!family) throw validationFailed([{ path: 'familyId', code: 'invalid', message: 'Family not found' }]);
    if (family.mergedIntoFamilyId) throw validationFailed([{ path: 'familyId', code: 'record_merged', message: 'This family was merged; use the surviving record' }]);
    await assertInScope(trx, staff, family.assignedStaffId);
    if (input.enquiryId) {
      const enquiry = await trx.selectFrom('enquiries').select('familyId').where('id', '=', input.enquiryId as string).executeTakeFirst();
      if (!enquiry || enquiry.familyId !== input.familyId) throw validationFailed([{ path: 'enquiryId', code: 'invalid', message: 'The enquiry belongs to a different family' }]);
    }
    const job = await trx
      .insertInto('jobOrders')
      .values({ reference: await uniqueReference(trx, 'jobOrders', 'J'), isTest: family.isTest, assignedStaffId: staff.staffId, ...jobColumns(fields) } as never)
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();
    await replaceCriteria(trx, job.id, criteria);
    if (scheduleWindows.length) await trx.insertInto('jobOrderScheduleWindows').values(windowsToRows(job.id, scheduleWindows)).execute();
    await recordTransition(trx, meta, { dimension: 'job_order', subjectId: job.id, from: null, to: job.status });
    await audit(trx, meta, { action: 'job.created', subjectType: 'job_order', subjectId: job.id, metadata: { familyId: input.familyId } });
    return job.id;
  });
  return getJob(deps, deps.db, null, id);
}

export async function updateJob(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: Record<string, unknown> & { version: number }) {
  const { version, ...fields } = input;
  await deps.db.transaction().execute(async trx => {
    const before = await trx.selectFrom('jobOrders').selectAll().where('id', '=', id).executeTakeFirst();
    if (!before) throw notFound('Job');
    await assertInScope(trx, staff, before.assignedStaffId);
    const values = jobColumns(fields);
    await updateVersioned(trx, 'jobOrders', id, version, values, 'Job');
    await audit(trx, meta, { action: 'job.updated', subjectType: 'job_order', subjectId: id, metadata: { fields: changedFields(before as never, values) } });
  });
  return getJob(deps, deps.db, null, id);
}

export async function replaceJobCriteria(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, version: number, criteria: CriterionInput[], windows?: Array<{ dayOfWeek: number; start: string; end: string }>) {
  await deps.db.transaction().execute(async trx => {
    const job = await trx.selectFrom('jobOrders').select('assignedStaffId').where('id', '=', id).executeTakeFirst();
    if (!job) throw notFound('Job');
    await assertInScope(trx, staff, job.assignedStaffId);
    await updateVersioned(trx, 'jobOrders', id, version, {}, 'Job');
    await replaceCriteria(trx, id, criteria);
    if (windows) {
      await trx.deleteFrom('jobOrderScheduleWindows').where('jobOrderId', '=', id).execute();
      if (windows.length) await trx.insertInto('jobOrderScheduleWindows').values(windowsToRows(id, windows)).execute();
    }
    await audit(trx, meta, { action: 'job.criteria_replaced', subjectType: 'job_order', subjectId: id, metadata: { criteria: criteria.length, windows: windows?.length ?? null } });
  });
  return getJob(deps, deps.db, null, id);
}

export async function transitionJob(deps: AppDeps, meta: RequestMeta, staff: StaffActor | null, id: string, input: { to: string; reason?: string; version?: number }, options: { viaCommand?: boolean; trx?: Tx } = {}) {
  const work = async (trx: Tx) => {
    const current = await trx.selectFrom('jobOrders').select(['status', 'assignedStaffId', 'version']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw notFound('Job');
    if (staff) await assertInScope(trx, staff, current.assignedStaffId);
    await assertTransitionAllowed(trx, 'job_order', current.status, input.to, { viaCommand: options.viaCommand });
    const now = deps.clock.now().toISOString();
    const values: Record<string, unknown> = { status: input.to };
    if (input.to === 'open' && current.status === 'draft') values.openedAt = now;
    if (input.to === 'filled') values.filledAt = now;
    if (input.to === 'cancelled' || input.to === 'closed') Object.assign(values, { closedAt: now, closeReason: input.reason ?? null });
    if (input.to === 'open' && ['closed', 'filled'].includes(current.status)) Object.assign(values, { closedAt: null, closeReason: null, filledAt: null });
    await updateVersioned(trx, 'jobOrders', id, input.version ?? current.version, values, 'Job');
    await recordTransition(trx, meta, { dimension: 'job_order', subjectId: id, from: current.status, to: input.to, reason: input.reason });
    await audit(trx, meta, { action: 'job.status_changed', subjectType: 'job_order', subjectId: id, metadata: { from: current.status, to: input.to } });
  };
  if (options.trx) await work(options.trx);
  else await deps.db.transaction().execute(work);
  return options.trx ? null : getJob(deps, deps.db, null, id);
}

// ------------------------------------------------------------------------------------- job candidates

export async function getJobCandidate(db: Executor, id: string) {
  const row = await db
    .selectFrom('jobCandidates as jc')
    .innerJoin('candidates as c', 'c.id', 'jc.candidateId')
    .innerJoin('jobOrders as j', 'j.id', 'jc.jobOrderId')
    .innerJoin('families as f', 'f.id', 'j.familyId')
    .leftJoin('staffMembers as s', 's.id', 'jc.addedBy')
    .leftJoin('offers as o', join => join.onRef('o.jobCandidateId', '=', 'jc.id').on('o.status', 'in', ['draft', 'extended']))
    .selectAll('jc')
    .select([
      'c.reference as candidateReference', 'c.firstName', 'c.lastName', 'c.recruitmentStage', 'c.availabilityStatus',
      'j.reference as jobReference', 'j.title', 'j.status as jobStatus', 'j.familyId', 'j.assignedStaffId as jobAssignee', 'f.displayName as familyName',
      's.displayName as addedByName', 'o.id as offerId', 'o.status as offerStatus', 'o.reviewDate as offerReviewDate'
    ])
    .where('jc.id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Job candidate');
  return toJobCandidate(row);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJobCandidate(r: Record<string, any>) {
  return {
    id: r.id, jobOrderId: r.jobOrderId, candidateId: r.candidateId, stage: r.stage, rationale: r.rationale, closedReason: r.closedReason,
    version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt, jobAssignee: r.jobAssignee as string | null,
    candidate: { reference: r.candidateReference, firstName: r.firstName, lastName: r.lastName, recruitmentStage: r.recruitmentStage, availabilityStatus: r.availabilityStatus },
    job: { reference: r.jobReference, title: r.title, status: r.jobStatus, familyId: r.familyId, familyName: r.familyName },
    addedBy: staffRef(r.addedBy, r.addedByName),
    openOffer: r.offerId ? { id: r.offerId, status: r.offerStatus, reviewDate: r.offerReviewDate } : null
  };
}

export async function listJobCandidates(deps: AppDeps, staff: StaffActor, filter: { jobOrderId?: string; candidateId?: string }) {
  const rows = await deps.db
    .selectFrom('jobCandidates as jc')
    .innerJoin('candidates as c', 'c.id', 'jc.candidateId')
    .innerJoin('jobOrders as j', 'j.id', 'jc.jobOrderId')
    .innerJoin('families as f', 'f.id', 'j.familyId')
    .leftJoin('staffMembers as s', 's.id', 'jc.addedBy')
    .leftJoin('offers as o', join => join.onRef('o.jobCandidateId', '=', 'jc.id').on('o.status', 'in', ['draft', 'extended']))
    .selectAll('jc')
    .select([
      'c.reference as candidateReference', 'c.firstName', 'c.lastName', 'c.recruitmentStage', 'c.availabilityStatus',
      'j.reference as jobReference', 'j.title', 'j.status as jobStatus', 'j.familyId', 'j.assignedStaffId as jobAssignee', 'f.displayName as familyName',
      's.displayName as addedByName', 'o.id as offerId', 'o.status as offerStatus', 'o.reviewDate as offerReviewDate'
    ])
    .$if(Boolean(filter.jobOrderId), qb => qb.where('jc.jobOrderId', '=', filter.jobOrderId!))
    .$if(Boolean(filter.candidateId), qb => qb.where('jc.candidateId', '=', filter.candidateId!))
    .orderBy('jc.createdAt')
    .execute();
  const scoped = await assignedOnly(deps.db, staff);
  return rows
    .filter(row => !scoped || !row.jobAssignee || row.jobAssignee === staff.staffId)
    .map(row => toJobCandidate(row as never));
}

export async function addJobCandidate(deps: AppDeps, meta: RequestMeta, staff: StaffActor, jobOrderId: string, input: { candidateId: string; rationale?: string | null }) {
  const id = await deps.db.transaction().execute(async trx => {
    const job = await trx.selectFrom('jobOrders').select(['status', 'assignedStaffId']).where('id', '=', jobOrderId).executeTakeFirst();
    if (!job) throw notFound('Job');
    await assertInScope(trx, staff, job.assignedStaffId);
    if (['cancelled', 'closed'].includes(job.status)) throw unprocessable('This job is no longer active.', 'job_inactive');
    const candidate = await trx.selectFrom('candidates').select(['id', 'mergedIntoCandidateId', 'archivedAt']).where('id', '=', input.candidateId).executeTakeFirst();
    if (!candidate) throw validationFailed([{ path: 'candidateId', code: 'invalid', message: 'Candidate not found' }]);
    if (candidate.mergedIntoCandidateId || candidate.archivedAt) throw validationFailed([{ path: 'candidateId', code: 'invalid', message: 'This candidate is archived or merged' }]);
    const existing = await trx.selectFrom('jobCandidates').select('id').where('jobOrderId', '=', jobOrderId).where('candidateId', '=', input.candidateId).executeTakeFirst();
    if (existing) throw conflict('This candidate is already on the job shortlist.', 'already_shortlisted', { jobCandidateId: existing.id });
    const row = await trx
      .insertInto('jobCandidates')
      .values({ jobOrderId, candidateId: input.candidateId, rationale: input.rationale ?? null, addedBy: staff.staffId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordTransition(trx, meta, { dimension: 'candidate_job', subjectId: row.id, from: null, to: 'shortlisted' });
    await audit(trx, meta, { action: 'job_candidate.added', subjectType: 'job_candidate', subjectId: row.id, metadata: { jobOrderId, candidateId: input.candidateId } });
    return row.id;
  });
  return getJobCandidate(deps.db, id);
}

export async function updateJobCandidate(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { version: number; rationale?: string | null }) {
  const current = await getJobCandidate(deps.db, id);
  await assertInScope(deps.db, staff, current.jobAssignee);
  await updateVersioned(deps.db, 'jobCandidates', id, input.version, { rationale: input.rationale ?? null }, 'Job candidate');
  await audit(deps.db, meta, { action: 'job_candidate.updated', subjectType: 'job_candidate', subjectId: id, metadata: { fields: ['rationale'] } });
  return getJobCandidate(deps.db, id);
}

/** Moves one candidate on one job. Never touches the candidate's global recruitment stage. */
export async function transitionJobCandidate(
  deps: AppDeps,
  meta: RequestMeta,
  staff: StaffActor | null,
  id: string,
  input: { to: string; reason?: string; version?: number },
  options: { viaCommand?: boolean; trx?: Tx } = {}
) {
  const work = async (trx: Tx) => {
    const current = await trx
      .selectFrom('jobCandidates as jc')
      .innerJoin('jobOrders as j', 'j.id', 'jc.jobOrderId')
      .select(['jc.stage', 'jc.version', 'jc.jobOrderId', 'jc.candidateId', 'j.assignedStaffId', 'j.familyId'])
      .where('jc.id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw notFound('Job candidate');
    if (staff) await assertInScope(trx, staff, current.assignedStaffId);
    await assertTransitionAllowed(trx, 'candidate_job', current.stage, input.to, { viaCommand: options.viaCommand });
    const values: Record<string, unknown> = { stage: input.to };
    if (['declined', 'withdrawn'].includes(input.to)) values.closedReason = input.reason ?? null;
    if (input.to === 'shortlisted') values.closedReason = null;
    await updateVersioned(trx, 'jobCandidates', id, input.version ?? current.version, values, 'Job candidate');
    if (['declined', 'withdrawn'].includes(input.to)) {
      await trx.updateTable('offers').set({ status: 'withdrawn', respondedAt: deps.clock.now().toISOString() }).where('jobCandidateId', '=', id).where('status', 'in', ['draft', 'extended']).execute();
    }
    await recordTransition(trx, meta, { dimension: 'candidate_job', subjectId: id, from: current.stage, to: input.to, reason: input.reason, metadata: { jobOrderId: current.jobOrderId, candidateId: current.candidateId } });
    await audit(trx, meta, { action: 'job_candidate.stage_changed', subjectType: 'job_candidate', subjectId: id, metadata: { from: current.stage, to: input.to } });
    await emit(trx, meta, {
      type: 'job_candidate.stage_changed',
      subjectType: 'job_candidate',
      subjectId: id,
      payload: { from: current.stage, to: input.to, related: { job_candidate: id, job_order: current.jobOrderId, candidate: current.candidateId, family: current.familyId } }
    });
  };
  if (options.trx) await work(options.trx);
  else await deps.db.transaction().execute(work);
  return options.trx ? null : getJobCandidate(deps.db, id);
}

export async function compare(deps: AppDeps, staff: StaffActor, jobOrderId: string, candidateId: string) {
  const job = await deps.db.selectFrom('jobOrders').select('assignedStaffId').where('id', '=', jobOrderId).executeTakeFirst();
  if (!job) throw notFound('Job');
  await assertInScope(deps.db, staff, job.assignedStaffId);
  const candidate = await deps.db.selectFrom('candidates').select('id').where('id', '=', candidateId).executeTakeFirst();
  if (!candidate) throw notFound('Candidate');
  const day = localDate(deps.clock.now(), (await getSettings(deps.db)).timezone);
  return compareCandidateToJob(deps.db, jobOrderId, candidateId, day);
}

// ------------------------------------------------------------------------------------- offers

export async function listOffers(db: Executor, jobCandidateId: string) {
  return db.selectFrom('offers').selectAll().where('jobCandidateId', '=', jobCandidateId).orderBy('createdAt', 'desc').execute();
}

export async function extendOffer(
  deps: AppDeps,
  meta: RequestMeta,
  staff: StaffActor,
  jobCandidateId: string,
  input: { version: number; compensation?: { amountMinor: number; currency: string; period: string } | null; proposedStartDate?: string | null; reviewDate?: string | null; termsSummary?: string | null }
) {
  return deps.db.transaction().execute(async trx => {
    const now = deps.clock.now().toISOString();
    // Any open offer is superseded by the new one (history is kept).
    const previous = await trx.selectFrom('offers').select('id').where('jobCandidateId', '=', jobCandidateId).where('status', 'in', ['draft', 'extended']).executeTakeFirst();
    if (previous) await trx.updateTable('offers').set({ status: 'superseded', respondedAt: now }).where('id', '=', previous.id).execute();
    const current = await trx.selectFrom('jobCandidates').select('stage').where('id', '=', jobCandidateId).executeTakeFirst();
    if (!current) throw notFound('Job candidate');
    if (current.stage !== 'offer') {
      await transitionJobCandidate(deps, meta, staff, jobCandidateId, { to: 'offer', version: input.version }, { viaCommand: true, trx });
    } else {
      await updateVersioned(trx, 'jobCandidates', jobCandidateId, input.version, {}, 'Job candidate');
    }
    const offer = await trx
      .insertInto('offers')
      .values({
        jobCandidateId,
        status: 'extended',
        compensationAmountMinor: input.compensation?.amountMinor ?? null,
        compensationCurrency: input.compensation?.currency ?? null,
        compensationPeriod: input.compensation?.period ?? null,
        proposedStartDate: input.proposedStartDate ?? null,
        reviewDate: input.reviewDate ?? null,
        termsSummary: input.termsSummary ?? null,
        extendedAt: now,
        recordedBy: staff.staffId
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (previous) await trx.updateTable('offers').set({ supersededByOfferId: offer.id }).where('id', '=', previous.id).execute();
    await audit(trx, meta, { action: 'offer.extended', subjectType: 'offer', subjectId: offer.id, metadata: { jobCandidateId } });
    await emit(trx, meta, { type: 'offer.extended', subjectType: 'offer', subjectId: offer.id, payload: { related: { job_candidate: jobCandidateId, offer: offer.id } } });
    return offer;
  });
}

export async function respondToOffer(deps: AppDeps, meta: RequestMeta, staff: StaffActor, offerId: string, input: { outcome: 'accepted' | 'declined' | 'withdrawn'; version: number; reason?: string }) {
  return deps.db.transaction().execute(async trx => {
    const offer = await trx.selectFrom('offers').selectAll().where('id', '=', offerId).forUpdate().executeTakeFirst();
    if (!offer) throw notFound('Offer');
    if (offer.status !== 'extended' && offer.status !== 'draft') throw unprocessable(`This offer is already ${offer.status}.`, 'offer_closed');
    const updated = await updateVersioned(trx, 'offers', offerId, input.version, { status: input.outcome, respondedAt: deps.clock.now().toISOString() }, 'Offer');
    await transitionJobCandidate(deps, meta, staff, offer.jobCandidateId, { to: input.outcome, reason: input.reason }, { viaCommand: true, trx });
    await audit(trx, meta, { action: 'offer.closed', subjectType: 'offer', subjectId: offerId, metadata: { outcome: input.outcome } });
    await emit(trx, meta, { type: 'offer.closed', subjectType: 'offer', subjectId: offerId, payload: { outcome: input.outcome, related: { job_candidate: offer.jobCandidateId, offer: offerId } } });
    return updated;
  });
}
