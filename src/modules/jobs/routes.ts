import { z } from 'zod';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { Id, IdParams, PageQuery, Version, WeeklyWindow, pageOf, queryBoolean, queryList } from '../../http/schemas.js';
import { stageHistory } from '../../domain/stages.js';
import { StageHistoryEntry, Transition } from '../families/schemas.js';
import { Comparison, JobCandidate, JobCreate, JobCriterion, JobDetail, JobStatus, JobSummary, JobUpdate, Offer, OfferCreate } from './schemas.js';
import {
  addJobCandidate, compare, createJob, extendOffer, getJob, getJobCandidate, listJobCandidates, listJobs, listOffers,
  replaceJobCriteria, respondToOffer, transitionJob, transitionJobCandidate, updateJob, updateJobCandidate
} from './service.js';
import { assertInScope } from '../../domain/records.js';

export const jobRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/jobs',
    operationId: 'listJobs',
    summary: 'List job orders',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.read' },
    query: z.object({
      q: z.string().max(120).optional(),
      status: queryList(JobStatus).optional(),
      familyId: Id.optional(),
      assignedStaffId: Id.optional(),
      includeTest: queryBoolean.optional(),
      sort: z.enum(['updated_desc', 'created_desc', 'start_asc']).default('updated_desc'),
      ...PageQuery
    }),
    response: pageOf(JobSummary, 'JobPage'),
    async handler({ deps, staff, query }) {
      return listJobs(deps, staff, query) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/jobs',
    operationId: 'createJob',
    summary: 'Create a job order for a family',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.write' },
    body: JobCreate,
    response: JobDetail,
    status: 201,
    async handler({ deps, meta, staff, body }) {
      return createJob(deps, meta, staff, body as never) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/jobs/:id',
    operationId: 'getJob',
    summary: 'Job order with criteria and schedule',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.read' },
    params: IdParams,
    response: JobDetail,
    async handler({ deps, staff, params }) {
      return getJob(deps, deps.db, staff, params.id) as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/jobs/:id',
    operationId: 'updateJob',
    summary: 'Update a job order',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.write' },
    params: IdParams,
    body: JobUpdate,
    response: JobDetail,
    async handler({ deps, meta, staff, params, body }) {
      return updateJob(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'PUT',
    path: '/jobs/:id/criteria',
    operationId: 'replaceJobCriteria',
    summary: 'Replace required/preferred criteria (and optionally schedule windows)',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.write' },
    params: IdParams,
    body: z.object({ version: Version, criteria: z.array(JobCriterion).max(30), scheduleWindows: z.array(WeeklyWindow).max(28).optional() }),
    response: JobDetail,
    async handler({ deps, meta, staff, params, body }) {
      return replaceJobCriteria(deps, meta, staff, params.id, body.version, body.criteria as never, body.scheduleWindows) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/jobs/:id/transition',
    operationId: 'transitionJob',
    summary: 'Change job status',
    description: '"filled" is set by recording a placement.',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.write' },
    params: IdParams,
    body: Transition,
    response: JobDetail,
    async handler({ deps, meta, staff, params, body }) {
      return transitionJob(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/jobs/:id/history',
    operationId: 'getJobHistory',
    summary: 'Job status history',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.read' },
    params: IdParams,
    response: z.object({ items: z.array(StageHistoryEntry) }),
    async handler({ deps, staff, params }) {
      await getJob(deps, deps.db, staff, params.id);
      return { items: await stageHistory(deps.db, 'job_order', params.id) };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/jobs/:id/candidates',
    operationId: 'listJobCandidates',
    summary: 'Candidates on this job (shortlist and progress)',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.read' },
    params: IdParams,
    response: z.object({ items: z.array(JobCandidate) }),
    async handler({ deps, staff, params }) {
      await getJob(deps, deps.db, staff, params.id);
      return { items: await listJobCandidates(deps, staff, { jobOrderId: params.id }) } as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/jobs/:id/candidates',
    operationId: 'addJobCandidate',
    summary: 'Shortlist a candidate for this job',
    description: 'One association per candidate and job (409 already_shortlisted). The candidate can be on other jobs at the same time.',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.write' },
    params: IdParams,
    body: z.object({ candidateId: Id, rationale: z.string().max(3000).nullable().optional() }),
    response: JobCandidate,
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      return addJobCandidate(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/jobs/:id/candidates/:candidateId/comparison',
    operationId: 'compareCandidateToJob',
    summary: 'Criteria comparison: meets / does not meet / not recorded',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.read' },
    params: z.object({ id: Id, candidateId: Id }),
    response: Comparison,
    async handler({ deps, staff, params }) {
      return compare(deps, staff, params.id, params.candidateId) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/candidates/:id/jobs',
    operationId: 'listCandidateJobs',
    summary: 'Jobs this candidate is associated with',
    tags: ['Candidates', 'Jobs'],
    access: { kind: 'staff', permission: 'jobs.read' },
    params: IdParams,
    response: z.object({ items: z.array(JobCandidate) }),
    async handler({ deps, staff, params }) {
      return { items: await listJobCandidates(deps, staff, { candidateId: params.id }) } as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/job-candidates/:id',
    operationId: 'getJobCandidate',
    summary: 'One candidate-job association',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.read' },
    params: IdParams,
    response: JobCandidate,
    async handler({ deps, staff, params }) {
      const row = await getJobCandidate(deps.db, params.id);
      await assertInScope(deps.db, staff, row.jobAssignee);
      return row as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/job-candidates/:id',
    operationId: 'updateJobCandidate',
    summary: 'Edit the job-specific rationale',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.write' },
    params: IdParams,
    body: z.object({ version: Version, rationale: z.string().max(3000).nullable() }),
    response: JobCandidate,
    async handler({ deps, meta, staff, params, body }) {
      return updateJobCandidate(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/job-candidates/:id/transition',
    operationId: 'transitionJobCandidate',
    summary: 'Move a candidate on this job',
    description:
      'presentation_approved/presented are set by presentation approval and release; offer/accepted by offers; placed by recording a placement ' +
      '(422 stage_requires_command if chosen directly).',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.write' },
    params: IdParams,
    body: Transition,
    response: JobCandidate,
    async handler({ deps, meta, staff, params, body }) {
      return transitionJobCandidate(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/job-candidates/:id/history',
    operationId: 'getJobCandidateHistory',
    summary: 'Stage history for one candidate on one job',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.read' },
    params: IdParams,
    response: z.object({ items: z.array(StageHistoryEntry) }),
    async handler({ deps, staff, params }) {
      const row = await getJobCandidate(deps.db, params.id);
      await assertInScope(deps.db, staff, row.jobAssignee);
      return { items: await stageHistory(deps.db, 'candidate_job', params.id) };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/job-candidates/:id/offers',
    operationId: 'listOffers',
    summary: 'Offers for this candidate on this job (newest first)',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.read' },
    params: IdParams,
    response: z.object({ items: z.array(Offer) }),
    async handler({ deps, staff, params }) {
      const row = await getJobCandidate(deps.db, params.id);
      await assertInScope(deps.db, staff, row.jobAssignee);
      return { items: await listOffers(deps.db, params.id) } as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/job-candidates/:id/offers',
    operationId: 'extendOffer',
    summary: 'Record an offer (moves the candidate to "offer" on this job)',
    description: 'An existing open offer is marked superseded.',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.write' },
    params: IdParams,
    body: OfferCreate,
    response: Offer,
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      const row = await getJobCandidate(deps.db, params.id);
      await assertInScope(deps.db, staff, row.jobAssignee);
      return extendOffer(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/offers/:id/respond',
    operationId: 'respondToOffer',
    summary: 'Record the offer outcome: accepted, declined or withdrawn',
    tags: ['Jobs'],
    access: { kind: 'staff', permission: 'jobs.write' },
    params: IdParams,
    body: z.object({ outcome: z.enum(['accepted', 'declined', 'withdrawn']), version: Version, reason: z.string().max(1000).optional() }),
    response: Offer,
    async handler({ deps, meta, staff, params, body }) {
      return respondToOffer(deps, meta, staff, params.id, body) as never;
    }
  })
];
