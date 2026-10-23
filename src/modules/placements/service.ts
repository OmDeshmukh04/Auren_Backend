import type { AppDeps, RequestMeta, StaffActor } from '../../context.js';
import type { Executor } from '../../db/index.js';
import { audit, changedFields } from '../../domain/audit.js';
import { emit } from '../../domain/outbox.js';
import { assertTransitionAllowed, recordTransition } from '../../domain/stages.js';
import { assertInScope, likeEscape, pageArgs, uniqueReference, updateVersioned } from '../../domain/records.js';
import { notFound, unprocessable, validationFailed } from '../../http/errors.js';
import { transitionJob, transitionJobCandidate } from '../jobs/service.js';

/**
 * Placements link one job, family and candidate (enforced by composite foreign keys). Terms are
 * recorded as agreed; no guarantee period or fee formula is inferred. History is never
 * overwritten: an ended placement stays, and a replacement is a new linked job order.
 */

type MoneyInput = { amountMinor: number; currency: string } | null | undefined;
type CompInput = { amountMinor: number; currency: string; period: string } | null | undefined;

function termColumns(input: { fee?: MoneyInput; compensation?: CompInput } & Record<string, unknown>) {
  const { fee, compensation, ...rest } = input;
  const values: Record<string, unknown> = { ...rest };
  if (fee !== undefined) Object.assign(values, { feeAmountMinor: fee?.amountMinor ?? null, feeCurrency: fee?.currency ?? null });
  if (compensation !== undefined) {
    Object.assign(values, { compensationAmountMinor: compensation?.amountMinor ?? null, compensationCurrency: compensation?.currency ?? null, compensationPeriod: compensation?.period ?? null });
  }
  for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
  return values;
}

const staffRef = (id: string | null, name: string | null) => (id ? { id, displayName: name ?? '' } : null);

function placementQuery(db: Executor) {
  return db
    .selectFrom('placements as p')
    .innerJoin('jobOrders as j', 'j.id', 'p.jobOrderId')
    .innerJoin('families as f', 'f.id', 'p.familyId')
    .innerJoin('candidates as c', 'c.id', 'p.candidateId')
    .leftJoin('staffMembers as s', 's.id', 'j.assignedStaffId')
    .selectAll('p')
    .select([
      'j.reference as jobReference', 'j.title as jobTitle', 'j.assignedStaffId', 's.displayName as assignedName',
      'f.displayName as familyName', 'c.firstName as candidateFirstName', 'c.lastName as candidateLastName', 'c.reference as candidateReference'
    ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDto(row: Record<string, any>): Record<string, any> {
  return {
    ...row,
    job: { id: row.jobOrderId, reference: row.jobReference, title: row.jobTitle },
    family: { id: row.familyId, displayName: row.familyName },
    candidate: { id: row.candidateId, reference: row.candidateReference, firstName: row.candidateFirstName, lastName: row.candidateLastName },
    assignedStaff: staffRef(row.assignedStaffId, row.assignedName),
    fee: row.feeCurrency ? { amountMinor: row.feeAmountMinor, currency: row.feeCurrency } : null,
    compensation: row.compensationCurrency ? { amountMinor: row.compensationAmountMinor, currency: row.compensationCurrency, period: row.compensationPeriod } : null
  };
}

export async function getPlacement(db: Executor, staff: StaffActor | null, id: string) {
  const row = await placementQuery(db).where('p.id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Placement');
  if (staff && staff.role === 'coordinator') await assertInScope(db, staff, row.assignedStaffId);
  const checkIns = await db.selectFrom('placementCheckIns').selectAll().where('placementId', '=', id).orderBy('dueOn').execute();
  return { ...toDto(row), checkIns } as Record<string, any> & { status: string; checkIns: typeof checkIns };
}

export async function listPlacements(
  deps: AppDeps,
  query: { q?: string; status?: string[]; familyId?: string; candidateId?: string; startFrom?: string; startTo?: string; page: number; pageSize: number }
) {
  let base = placementQuery(deps.db);
  if (query.status?.length) base = base.where('p.status', 'in', query.status);
  if (query.familyId) base = base.where('p.familyId', '=', query.familyId);
  if (query.candidateId) base = base.where('p.candidateId', '=', query.candidateId);
  if (query.startFrom) base = base.where('p.agreedStartDate', '>=', query.startFrom);
  if (query.startTo) base = base.where('p.agreedStartDate', '<=', query.startTo);
  if (query.q) {
    const term = `%${likeEscape(query.q.trim())}%`;
    base = base.where(eb => eb.or([eb('p.reference', 'ilike', term), eb('f.displayName', 'ilike', term), eb('c.lastName', 'ilike', term), eb('j.title', 'ilike', term)]));
  }
  const { limit, offset } = pageArgs(query.page, query.pageSize);
  const [rows, total] = await Promise.all([
    base.orderBy('p.agreedStartDate', 'desc').orderBy('p.id').limit(limit).offset(offset).execute(),
    base.clearSelect().select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()
  ]);
  return { items: rows.map(toDto), page: query.page, pageSize: query.pageSize, total: Number(total.n) };
}

export async function createPlacement(
  deps: AppDeps,
  meta: RequestMeta,
  staff: StaffActor,
  input: {
    jobCandidateId: string;
    jobCandidateVersion: number;
    agreedStartDate: string;
    fee?: MoneyInput;
    compensation?: CompInput;
    guaranteeTerms?: string | null;
    guaranteeEndsOn?: string | null;
    replacementObligation?: string | null;
    notes?: string | null;
  }
) {
  const id = await deps.db.transaction().execute(async trx => {
    const jc = await trx
      .selectFrom('jobCandidates as jc')
      .innerJoin('jobOrders as j', 'j.id', 'jc.jobOrderId')
      .select(['jc.id', 'jc.stage', 'jc.version', 'jc.jobOrderId', 'jc.candidateId', 'j.familyId', 'j.status as jobStatus', 'j.assignedStaffId', 'j.version as jobVersion'])
      .where('jc.id', '=', input.jobCandidateId)
      .forUpdate()
      .executeTakeFirst();
    if (!jc) throw validationFailed([{ path: 'jobCandidateId', code: 'invalid', message: 'Candidate-job association not found' }]);
    await assertInScope(trx, staff, jc.assignedStaffId);
    if (jc.stage !== 'accepted') throw unprocessable('Record an accepted offer before creating the placement.', 'offer_not_accepted', { stage: jc.stage });
    if (jc.version !== input.jobCandidateVersion) throw validationFailed([{ path: 'jobCandidateVersion', code: 'stale', message: 'The shortlist entry changed; reload and try again' }]);
    const offer = await trx.selectFrom('offers').select(['id', 'proposedStartDate']).where('jobCandidateId', '=', jc.id).where('status', '=', 'accepted').orderBy('respondedAt', 'desc').executeTakeFirst();
    const placement = await trx
      .insertInto('placements')
      .values({
        reference: await uniqueReference(trx, 'placements', 'P'),
        jobOrderId: jc.jobOrderId,
        familyId: jc.familyId,
        candidateId: jc.candidateId,
        jobCandidateId: jc.id,
        offerId: offer?.id ?? null,
        agreedStartDate: input.agreedStartDate,
        ...termColumns({ fee: input.fee, compensation: input.compensation, guaranteeTerms: input.guaranteeTerms, guaranteeEndsOn: input.guaranteeEndsOn, replacementObligation: input.replacementObligation, notes: input.notes })
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    await transitionJobCandidate(deps, meta, staff, jc.id, { to: 'placed' }, { viaCommand: true, trx });
    if (['open', 'on_hold'].includes(jc.jobStatus)) {
      if (jc.jobStatus === 'on_hold') await transitionJob(deps, meta, staff, jc.jobOrderId, { to: 'open' }, { viaCommand: true, trx });
      await transitionJob(deps, meta, staff, jc.jobOrderId, { to: 'filled' }, { viaCommand: true, trx });
    }
    const family = await trx.selectFrom('families').select(['relationshipStatus', 'version']).where('id', '=', jc.familyId).executeTakeFirstOrThrow();
    if (family.relationshipStatus !== 'active_client') {
      const allowed = await trx.selectFrom('stageTransitionRules').select('toKey').where('dimension', '=', 'family_relationship').where('fromKey', '=', family.relationshipStatus).where('toKey', '=', 'active_client').executeTakeFirst();
      if (allowed) {
        await updateVersioned(trx, 'families', jc.familyId, family.version, { relationshipStatus: 'active_client' }, 'Family');
        await recordTransition(trx, meta, { dimension: 'family_relationship', subjectId: jc.familyId, from: family.relationshipStatus, to: 'active_client', reason: 'Placement booked' });
      }
    }
    await recordTransition(trx, meta, { dimension: 'placement', subjectId: placement.id, from: null, to: 'booked' });
    await audit(trx, meta, { action: 'placement.booked', subjectType: 'placement', subjectId: placement.id, metadata: { jobOrderId: jc.jobOrderId, candidateId: jc.candidateId } });
    await emit(trx, meta, { type: 'placement.booked', subjectType: 'placement', subjectId: placement.id, payload: { related: { placement: placement.id, family: jc.familyId, candidate: jc.candidateId, job_order: jc.jobOrderId } } });
    return placement.id;
  });
  return getPlacement(deps.db, null, id);
}

export async function updatePlacement(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: Record<string, unknown> & { version: number; fee?: MoneyInput; compensation?: CompInput }) {
  const { version, ...fields } = input;
  await deps.db.transaction().execute(async trx => {
    const before = await placementQuery(trx).where('p.id', '=', id).executeTakeFirst();
    if (!before) throw notFound('Placement');
    await assertInScope(trx, staff, before.assignedStaffId);
    if (['ended', 'cancelled'].includes(before.status) && fields.agreedStartDate) throw unprocessable('The start date of an ended placement cannot change.', 'placement_closed');
    const values = termColumns(fields);
    await updateVersioned(trx, 'placements', id, version, values, 'Placement');
    await audit(trx, meta, { action: 'placement.updated', subjectType: 'placement', subjectId: id, metadata: { fields: changedFields(before as never, values) } });
    if (values.agreedStartDate && values.agreedStartDate !== before.agreedStartDate) {
      await emit(trx, meta, {
        type: 'placement.start_changed',
        subjectType: 'placement',
        subjectId: id,
        payload: { from: before.agreedStartDate, to: values.agreedStartDate, related: { placement: id, family: before.familyId, candidate: before.candidateId } }
      });
    }
  });
  return getPlacement(deps.db, null, id);
}

export async function transitionPlacement(
  deps: AppDeps,
  meta: RequestMeta,
  staff: StaffActor,
  id: string,
  input: { to: 'started' | 'ended' | 'cancelled'; version: number; actualStartDate?: string; endDate?: string; reason?: string }
) {
  await deps.db.transaction().execute(async trx => {
    const current = await placementQuery(trx).where('p.id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Placement');
    await assertInScope(trx, staff, current.assignedStaffId);
    await assertTransitionAllowed(trx, 'placement', current.status, input.to);
    const values: Record<string, unknown> = { status: input.to };
    if (input.to === 'started') {
      if (!input.actualStartDate) throw validationFailed([{ path: 'actualStartDate', code: 'required', message: 'Enter the actual start date' }]);
      values.actualStartDate = input.actualStartDate;
    }
    if (input.to === 'ended') {
      if (!input.endDate) throw validationFailed([{ path: 'endDate', code: 'required', message: 'Enter the end date' }]);
      Object.assign(values, { endDate: input.endDate, endReason: input.reason ?? null });
    }
    if (input.to === 'cancelled') values.endReason = input.reason ?? null;
    await updateVersioned(trx, 'placements', id, input.version, values, 'Placement');
    if (input.to !== 'started') {
      await trx.updateTable('placementCheckIns').set({ status: 'cancelled' }).where('placementId', '=', id).where('status', '=', 'scheduled').execute();
    }
    await recordTransition(trx, meta, { dimension: 'placement', subjectId: id, from: current.status, to: input.to, reason: input.reason });
    await audit(trx, meta, { action: `placement.${input.to}`, subjectType: 'placement', subjectId: id });
    await emit(trx, meta, { type: `placement.${input.to}` as 'placement.started', subjectType: 'placement', subjectId: id, payload: { related: { placement: id, family: current.familyId, candidate: current.candidateId } } });
  });
  return getPlacement(deps.db, null, id);
}

/** Opens a linked replacement search; the original placement and job remain as history. */
export async function startReplacementSearch(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { version: number; title?: string }) {
  return deps.db.transaction().execute(async trx => {
    const placement = await trx.selectFrom('placements').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!placement) throw notFound('Placement');
    if (placement.replacementJobOrderId) throw unprocessable('A replacement search already exists for this placement.', 'replacement_exists', { jobOrderId: placement.replacementJobOrderId });
    const job = await trx.selectFrom('jobOrders').selectAll().where('id', '=', placement.jobOrderId).executeTakeFirstOrThrow();
    await assertInScope(trx, staff, job.assignedStaffId);
    const { id: _id, reference: _ref, status: _status, createdAt: _c, updatedAt: _u, version: _v, openedAt: _o, filledAt: _f, closedAt: _cl, closeReason: _cr, ...copy } = job;
    const replacement = await trx
      .insertInto('jobOrders')
      .values({ ...copy, reference: await uniqueReference(trx, 'jobOrders', 'J'), title: input.title ?? `Replacement: ${job.title}`, replacementForPlacementId: id, status: 'open', openedAt: deps.clock.now().toISOString(), assignedStaffId: job.assignedStaffId ?? staff.staffId } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const criteria = await trx.selectFrom('jobOrderCriteria').selectAll().where('jobOrderId', '=', job.id).execute();
    if (criteria.length) {
      await trx.insertInto('jobOrderCriteria').values(criteria.map(({ id: _cid, createdAt: _cat, ...c }) => ({ ...c, jobOrderId: replacement.id, params: JSON.stringify(c.params) }))).execute();
    }
    const windows = await trx.selectFrom('jobOrderScheduleWindows').selectAll().where('jobOrderId', '=', job.id).execute();
    if (windows.length) await trx.insertInto('jobOrderScheduleWindows').values(windows.map(({ id: _wid, ...w }) => ({ ...w, jobOrderId: replacement.id }))).execute();
    await updateVersioned(trx, 'placements', id, input.version, { replacementJobOrderId: replacement.id }, 'Placement');
    await recordTransition(trx, meta, { dimension: 'job_order', subjectId: replacement.id, from: null, to: 'open', reason: 'Replacement search' });
    await audit(trx, meta, { action: 'placement.replacement_started', subjectType: 'placement', subjectId: id, metadata: { jobOrderId: replacement.id } });
    return { jobOrderId: replacement.id };
  });
}

export async function addCheckIn(deps: AppDeps, meta: RequestMeta, staff: StaffActor, placementId: string, input: { dueOn: string }) {
  const placement = await getPlacement(deps.db, staff, placementId);
  if (['ended', 'cancelled'].includes(placement.status)) throw unprocessable('This placement has ended.', 'placement_closed');
  const row = await deps.db.insertInto('placementCheckIns').values({ placementId, dueOn: input.dueOn }).returningAll().executeTakeFirstOrThrow();
  await audit(deps.db, meta, { action: 'placement.check_in_scheduled', subjectType: 'placement', subjectId: placementId, metadata: { dueOn: input.dueOn } });
  return row;
}

export async function completeCheckIn(deps: AppDeps, meta: RequestMeta, staff: StaffActor, placementId: string, checkInId: string, input: { outcome: string; notes?: string | null; status: 'completed' | 'skipped' }) {
  await getPlacement(deps.db, staff, placementId);
  const row = await deps.db
    .updateTable('placementCheckIns')
    .set({ status: input.status, outcome: input.status === 'completed' ? input.outcome : null, notes: input.notes ?? null, completedAt: deps.clock.now().toISOString(), completedBy: staff.staffId })
    .where('id', '=', checkInId)
    .where('placementId', '=', placementId)
    .where('status', '=', 'scheduled')
    .returningAll()
    .executeTakeFirst();
  if (!row) throw notFound('Scheduled check-in');
  await audit(deps.db, meta, { action: 'placement.check_in_recorded', subjectType: 'placement', subjectId: placementId, metadata: { checkInId, outcome: input.outcome } });
  return row;
}
