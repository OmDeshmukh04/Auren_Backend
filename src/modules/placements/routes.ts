import { z } from 'zod';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { CompensationPeriod, CurrencyCode, DateOnly, Id, IdParams, PageQuery, StaffRef, Timestamp, Version, pageOf, queryList } from '../../http/schemas.js';
import { stageHistory } from '../../domain/stages.js';
import { StageHistoryEntry } from '../families/schemas.js';
import { addCheckIn, completeCheckIn, createPlacement, getPlacement, listPlacements, startReplacementSearch, transitionPlacement, updatePlacement } from './service.js';

const PlacementStatus = z.enum(['booked', 'started', 'ended', 'cancelled']).meta({ id: 'PlacementStatus' });
const Fee = z.object({ amountMinor: z.int().min(0), currency: CurrencyCode }).nullable();
const Compensation = z.object({ amountMinor: z.int().min(0), currency: CurrencyCode, period: CompensationPeriod }).nullable();

const CheckIn = z
  .object({
    id: Id,
    dueOn: DateOnly,
    status: z.enum(['scheduled', 'completed', 'skipped', 'cancelled']),
    outcome: z.string().nullable(),
    notes: z.string().nullable(),
    completedAt: Timestamp.nullable()
  })
  .meta({ id: 'PlacementCheckIn' });

const Placement = z
  .object({
    id: Id,
    reference: z.string(),
    status: PlacementStatus,
    jobCandidateId: Id,
    offerId: Id.nullable(),
    job: z.object({ id: Id, reference: z.string(), title: z.string() }),
    family: z.object({ id: Id, displayName: z.string() }),
    candidate: z.object({ id: Id, reference: z.string(), firstName: z.string(), lastName: z.string() }),
    assignedStaff: StaffRef,
    agreedStartDate: DateOnly,
    actualStartDate: DateOnly.nullable(),
    endDate: DateOnly.nullable(),
    endReason: z.string().nullable(),
    fee: Fee,
    compensation: Compensation,
    guaranteeTerms: z.string().nullable(),
    guaranteeEndsOn: DateOnly.nullable().meta({ description: 'As agreed with the family; never inferred.' }),
    replacementObligation: z.string().nullable(),
    replacementJobOrderId: Id.nullable(),
    notes: z.string().nullable(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp
  })
  .meta({ id: 'Placement' });
const PlacementDetail = Placement.extend({ checkIns: z.array(CheckIn) }).meta({ id: 'PlacementDetail' });

const Terms = {
  fee: Fee.optional(),
  compensation: Compensation.optional(),
  guaranteeTerms: z.string().max(2000).nullable().optional(),
  guaranteeEndsOn: DateOnly.nullable().optional(),
  replacementObligation: z.string().max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional()
};

export const placementRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/placements',
    operationId: 'listPlacements',
    summary: 'List placements',
    tags: ['Placements'],
    access: { kind: 'staff', permission: 'placements.read' },
    query: z.object({
      q: z.string().max(120).optional(),
      status: queryList(PlacementStatus).optional(),
      familyId: Id.optional(),
      candidateId: Id.optional(),
      startFrom: DateOnly.optional(),
      startTo: DateOnly.optional(),
      ...PageQuery
    }),
    response: pageOf(Placement, 'PlacementPage'),
    async handler({ deps, query }) {
      return listPlacements(deps, query) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/placements',
    operationId: 'createPlacement',
    summary: 'Record a placement from an accepted offer',
    description: 'Moves the candidate to "placed" on that job and the job to "filled" in the same transaction.',
    tags: ['Placements'],
    access: { kind: 'staff', permission: 'placements.write' },
    body: z.object({ jobCandidateId: Id, jobCandidateVersion: Version, agreedStartDate: DateOnly, ...Terms }),
    response: PlacementDetail,
    status: 201,
    async handler({ deps, meta, staff, body }) {
      return createPlacement(deps, meta, staff, body) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/placements/:id',
    operationId: 'getPlacement',
    summary: 'Placement detail',
    tags: ['Placements'],
    access: { kind: 'staff', permission: 'placements.read' },
    params: IdParams,
    response: PlacementDetail,
    async handler({ deps, staff, params }) {
      return getPlacement(deps.db, staff, params.id) as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/placements/:id',
    operationId: 'updatePlacement',
    summary: 'Update agreed terms or start date',
    description: 'Changing agreedStartDate emits placement.start_changed so scheduled check-ins are recomputed.',
    tags: ['Placements'],
    access: { kind: 'staff', permission: 'placements.write' },
    params: IdParams,
    body: z.object({ version: Version, agreedStartDate: DateOnly.optional(), ...Terms }),
    response: PlacementDetail,
    async handler({ deps, meta, staff, params, body }) {
      return updatePlacement(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/placements/:id/transition',
    operationId: 'transitionPlacement',
    summary: 'Start, end or cancel a placement',
    tags: ['Placements'],
    access: { kind: 'staff', permission: 'placements.write' },
    params: IdParams,
    body: z.object({ to: z.enum(['started', 'ended', 'cancelled']), version: Version, actualStartDate: DateOnly.optional(), endDate: DateOnly.optional(), reason: z.string().max(1000).optional() }),
    response: PlacementDetail,
    async handler({ deps, meta, staff, params, body }) {
      return transitionPlacement(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/placements/:id/history',
    operationId: 'getPlacementHistory',
    summary: 'Placement status history',
    tags: ['Placements'],
    access: { kind: 'staff', permission: 'placements.read' },
    params: IdParams,
    response: z.object({ items: z.array(StageHistoryEntry) }),
    async handler({ deps, staff, params }) {
      await getPlacement(deps.db, staff, params.id);
      return { items: await stageHistory(deps.db, 'placement', params.id) };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/placements/:id/replacement-search',
    operationId: 'startReplacementSearch',
    summary: 'Open a linked replacement job order',
    tags: ['Placements'],
    access: { kind: 'staff', permission: 'placements.write' },
    params: IdParams,
    body: z.object({ version: Version, title: z.string().max(160).optional() }),
    response: z.object({ jobOrderId: Id }),
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      return startReplacementSearch(deps, meta, staff, params.id, body);
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/placements/:id/check-ins',
    operationId: 'schedulePlacementCheckIn',
    summary: 'Schedule a post-placement check-in',
    tags: ['Placements'],
    access: { kind: 'staff', permission: 'placements.write' },
    params: IdParams,
    body: z.object({ dueOn: DateOnly }),
    response: CheckIn,
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      return addCheckIn(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/placements/:id/check-ins/:checkInId/complete',
    operationId: 'completePlacementCheckIn',
    summary: 'Record a check-in outcome',
    tags: ['Placements'],
    access: { kind: 'staff', permission: 'placements.write' },
    params: z.object({ id: Id, checkInId: Id }),
    body: z.object({ status: z.enum(['completed', 'skipped']).default('completed'), outcome: z.enum(['going_well', 'minor_concern', 'escalated']), notes: z.string().max(4000).nullable().optional() }),
    response: CheckIn,
    async handler({ deps, meta, staff, params, body }) {
      return completeCheckIn(deps, meta, staff, params.id, params.checkInId, body) as never;
    }
  })
];
