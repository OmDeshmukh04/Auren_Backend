import { z } from 'zod';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { AgeGroup, Id, IdParams, PageQuery, Provenance, ScheduleType, Version, WeeklyWindow, pageOf, queryBoolean, queryList } from '../../http/schemas.js';
import { stageHistory } from '../../domain/stages.js';
import { notFound } from '../../http/errors.js';
import { ContactLog, StageHistoryEntry, Transition } from '../families/schemas.js';
import { logContact } from '../families/service.js';
import { audit } from '../../domain/audit.js';
import { assertInScope } from '../../domain/records.js';
import {
  AvailabilityChange, AvailabilityStatus, CandidateCreate, CandidateDetail, CandidateSummary, CandidateUpdate, EligibilityResult,
  EmploymentInput, LanguageCode, Proficiency, QualificationInput, RecruitmentStage
} from './schemas.js';
import { SearchCriteria } from './search.js';
import {
  addEmployment, addQualification, candidateEligibility, changeAvailability, createCandidate, deleteEmployment, getCandidate,
  replaceAvailabilityWindows, replaceLanguages, replaceSkills, reviewQualification, searchCandidates, setFieldVerification,
  transitionCandidate, updateCandidate, updateEmployment, updateQualification
} from './service.js';

const Sort = z.enum(['updated_desc', 'submitted_desc', 'professional_years_desc', 'name_asc']).default('updated_desc');
const Detail = CandidateDetail;
const Versioned = <T extends z.ZodRawShape>(shape: T) => z.object({ version: Version, ...shape });

export const candidateRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/candidates',
    operationId: 'listCandidates',
    summary: 'List candidates with common filters',
    description: 'For combined criteria (qualification groups, schedule windows, custom questions) use POST /candidates/search.',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.read' },
    query: z.object({
      q: z.string().max(120).optional(),
      stage: queryList(RecruitmentStage).optional(),
      availability: queryList(AvailabilityStatus).optional(),
      city: queryList(z.string().max(120)).optional(),
      minProfessionalNannyYears: z.coerce.number().min(0).max(70).optional(),
      ageGroup: queryList(AgeGroup).optional(),
      currentQualification: queryList(z.string().max(64)).optional().meta({ description: 'All listed keys must be current.' }),
      scheduleType: queryList(ScheduleType).optional(),
      drivingEligible: queryBoolean.optional(),
      assignedStaffId: Id.optional(),
      includeArchived: queryBoolean.optional(),
      includeTest: queryBoolean.optional(),
      sort: Sort,
      ...PageQuery
    }),
    response: pageOf(CandidateSummary, 'CandidatePage'),
    async handler({ deps, staff, query }) {
      const criteria = SearchCriteria.parse({
        text: query.q,
        recruitmentStages: query.stage,
        availability: query.availability,
        location: query.city ? { cities: query.city } : undefined,
        minProfessionalNannyYears: query.minProfessionalNannyYears,
        ageGroups: query.ageGroup ? { values: query.ageGroup, match: 'any' } : undefined,
        currentQualifications: query.currentQualification ? { keys: query.currentQualification, match: 'all' } : undefined,
        scheduleTypes: query.scheduleType ? { values: query.scheduleType, match: 'any' } : undefined,
        drivingEligible: query.drivingEligible,
        assignedStaffId: query.assignedStaffId,
        includeArchived: query.includeArchived ?? false,
        includeTest: query.includeTest ?? false
      });
      return searchCandidates(deps, staff, criteria, query) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/candidates/search',
    operationId: 'searchCandidates',
    summary: 'Combined candidate search',
    description: 'Dimensions combine with AND; values inside a dimension with OR unless match="all". Unknown values never match.',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.read' },
    body: z.object({ criteria: SearchCriteria, sort: Sort, page: PageQuery.page, pageSize: PageQuery.pageSize }),
    response: pageOf(CandidateSummary, 'CandidatePage'),
    async handler({ deps, staff, body }) {
      return searchCandidates(deps, staff, body.criteria, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/candidates',
    operationId: 'createCandidate',
    summary: 'Create a candidate profile (staff entry)',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    body: CandidateCreate,
    response: Detail,
    status: 201,
    async handler({ deps, meta, body }) {
      return createCandidate(deps, meta, body) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/candidates/:id',
    operationId: 'getCandidate',
    summary: 'Full candidate profile',
    description: 'Excludes references, screening and interview records, which have their own endpoints and permissions.',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.read' },
    params: IdParams,
    response: Detail,
    async handler({ deps, staff, params }) {
      return getCandidate(deps, deps.db, staff, params.id) as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/candidates/:id',
    operationId: 'updateCandidate',
    summary: 'Correct or update candidate profile fields',
    description: 'Send only changed fields with the current version. A stale version returns 409 version_conflict.',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: IdParams,
    body: CandidateUpdate,
    response: Detail,
    async handler({ deps, meta, staff, params, body }) {
      return updateCandidate(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/candidates/:id/transition',
    operationId: 'transitionCandidate',
    summary: 'Change recruitment stage',
    description: 'Entering "eligible" re-runs the screening policy; failures return 422 eligibility_not_met with details.eligibility.',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: IdParams,
    body: Transition,
    response: Detail,
    async handler({ deps, meta, staff, params, body }) {
      return transitionCandidate(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/candidates/:id/availability',
    operationId: 'changeCandidateAvailability',
    summary: 'Set availability (independent of recruitment stage)',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: IdParams,
    body: AvailabilityChange,
    response: Detail,
    async handler({ deps, meta, staff, params, body }) {
      return changeAvailability(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/candidates/:id/history',
    operationId: 'getCandidateHistory',
    summary: 'Recruitment stage and availability history',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.read' },
    params: IdParams,
    response: z.object({ recruitment: z.array(StageHistoryEntry), availability: z.array(StageHistoryEntry) }),
    async handler({ deps, staff, params }) {
      const candidate = await deps.db.selectFrom('candidates').select('assignedStaffId').where('id', '=', params.id).executeTakeFirst();
      if (!candidate) throw notFound('Candidate');
      await assertInScope(deps.db, staff, candidate.assignedStaffId);
      return {
        recruitment: await stageHistory(deps.db, 'candidate_recruitment', params.id),
        availability: await stageHistory(deps.db, 'candidate_availability', params.id)
      };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/candidates/:id/eligibility',
    operationId: 'getCandidateEligibility',
    summary: 'Presentation eligibility under the active screening policy',
    tags: ['Candidates', 'Screening'],
    access: { kind: 'staff', permission: 'screening.read' },
    params: IdParams,
    query: z.object({ jobOrderId: Id.optional() }),
    response: EligibilityResult,
    async handler({ deps, staff, params, query }) {
      return candidateEligibility(deps, staff, params.id, query.jobOrderId);
    }
  }),
  defineRoute({
    method: 'PUT',
    path: '/candidates/:id/availability-windows',
    operationId: 'replaceCandidateAvailabilityWindows',
    summary: 'Replace weekly availability windows',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: IdParams,
    body: Versioned({ windows: z.array(WeeklyWindow).max(28) }),
    response: Detail,
    async handler({ deps, meta, staff, params, body }) {
      return replaceAvailabilityWindows(deps, meta, staff, params.id, body.version, body.windows) as never;
    }
  }),
  defineRoute({
    method: 'PUT',
    path: '/candidates/:id/languages',
    operationId: 'replaceCandidateLanguages',
    summary: 'Replace languages and proficiency',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: IdParams,
    body: Versioned({ languages: z.array(z.object({ languageCode: LanguageCode, proficiency: Proficiency })).max(20) }),
    response: Detail,
    async handler({ deps, meta, staff, params, body }) {
      return replaceLanguages(deps, meta, staff, params.id, body.version, body.languages) as never;
    }
  }),
  defineRoute({
    method: 'PUT',
    path: '/candidates/:id/skills',
    operationId: 'replaceCandidateSkills',
    summary: 'Replace skills',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: IdParams,
    body: Versioned({ skills: z.array(z.object({ skillKey: z.string().max(64), provenance: Provenance.default('self_reported') })).max(60) }),
    response: Detail,
    async handler({ deps, meta, staff, params, body }) {
      return replaceSkills(deps, meta, staff, params.id, body.version, body.skills) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/candidates/:id/employments',
    operationId: 'addCandidateEmployment',
    summary: 'Add an employment history entry',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: IdParams,
    body: z.object({ version: Version, employment: EmploymentInput }),
    response: Detail,
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      return addEmployment(deps, meta, staff, params.id, body.version, body.employment) as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/candidates/:id/employments/:employmentId',
    operationId: 'updateCandidateEmployment',
    summary: 'Edit or verify an employment entry',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: z.object({ id: Id, employmentId: Id }),
    body: z.object({
      version: Version,
      employment: z.object({
        employerDescription: z.string().trim().min(1).max(200).optional(),
        roleTitle: z.string().trim().min(1).max(120).optional(),
        employmentType: z.enum(['private_household', 'agency', 'childcare_center', 'school', 'hospitality', 'other']).optional(),
        startDate: z.iso.date().optional(),
        endDate: z.iso.date().nullable().optional(),
        isCurrent: z.boolean().optional(),
        hoursPerWeek: z.int().min(1).max(168).nullable().optional(),
        liveIn: z.boolean().nullable().optional(),
        staffedHousehold: z.boolean().nullable().optional(),
        childrenCount: z.int().min(0).max(20).nullable().optional(),
        ageGroups: z.array(AgeGroup).optional(),
        responsibilities: z.string().max(3000).nullable().optional(),
        departureReason: z.string().max(1000).nullable().optional(),
        provenance: Provenance.optional(),
        sortOrder: z.int().optional()
      })
    }),
    response: Detail,
    async handler({ deps, meta, staff, params, body }) {
      return updateEmployment(deps, meta, staff, params.id, params.employmentId, body.version, body.employment) as never;
    }
  }),
  defineRoute({
    method: 'DELETE',
    path: '/candidates/:id/employments/:employmentId',
    operationId: 'deleteCandidateEmployment',
    summary: 'Remove an employment entry',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: z.object({ id: Id, employmentId: Id }),
    query: z.object({ version: z.coerce.number().int().positive() }),
    response: Detail,
    async handler({ deps, meta, staff, params, query }) {
      return deleteEmployment(deps, meta, staff, params.id, params.employmentId, query.version) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/candidates/:id/qualifications',
    operationId: 'addCandidateQualification',
    summary: 'Record a certificate, training or license',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: IdParams,
    body: z.object({ version: Version, qualification: QualificationInput }),
    response: Detail,
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      return addQualification(deps, meta, staff, params.id, body.version, body.qualification) as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/candidates/:id/qualifications/:qualificationId',
    operationId: 'updateCandidateQualification',
    summary: 'Edit qualification evidence (resets review)',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'candidates.write' },
    params: z.object({ id: Id, qualificationId: Id }),
    body: z.object({
      version: Version,
      qualification: z.object({
        issuer: z.string().trim().max(160).nullable().optional(),
        issuedOn: z.iso.date().nullable().optional(),
        expiresOn: z.iso.date().nullable().optional(),
        documentId: Id.nullable().optional()
      })
    }),
    response: Detail,
    async handler({ deps, meta, staff, params, body }) {
      return updateQualification(deps, meta, staff, params.id, params.qualificationId, body.version, body.qualification) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/candidates/:id/qualifications/:qualificationId/review',
    operationId: 'reviewCandidateQualification',
    summary: 'Verify or reject a qualification',
    description: 'Certificates whose type expires cannot be verified without an expiry date.',
    tags: ['Candidates', 'Screening'],
    access: { kind: 'staff', permission: 'screening.write' },
    params: z.object({ id: Id, qualificationId: Id }),
    body: z.object({ decision: z.enum(['verified', 'rejected']), note: z.string().max(1000).optional(), qualificationVersion: Version }),
    response: Detail,
    async handler({ deps, meta, staff, params, body }) {
      return reviewQualification(deps, meta, staff, params.id, params.qualificationId, body) as never;
    }
  }),
  defineRoute({
    method: 'PUT',
    path: '/candidates/:id/verifications/:fieldKey',
    operationId: 'setCandidateFieldVerification',
    summary: 'Record how a profile fact was verified',
    tags: ['Candidates', 'Screening'],
    access: { kind: 'staff', permission: 'screening.write' },
    params: z.object({
      id: Id,
      fieldKey: z.enum(['childcare_years', 'professional_nanny_years', 'age_groups', 'max_children_cared', 'education_level', 'driving_eligible', 'live_in_experience', 'staffed_household_experience', 'special_needs_experience'])
    }),
    body: z.object({ version: Version, provenance: Provenance, note: z.string().max(1000).nullable().optional(), evidenceDocumentId: Id.nullable().optional() }),
    response: Detail,
    async handler({ deps, meta, staff, params, body }) {
      return setFieldVerification(deps, meta, staff, params.id, params.fieldKey, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/candidates/:id/contact-log',
    operationId: 'logCandidateContact',
    summary: 'Log a call, email or meeting with the candidate',
    description: 'With isReply=true, candidate follow-up sequences stop.',
    tags: ['Candidates'],
    access: { kind: 'staff', permission: 'communications.write' },
    params: IdParams,
    body: ContactLog,
    response: z.object({ id: Id, channel: z.string(), direction: z.string(), status: z.string(), summary: z.string().nullable(), isReply: z.boolean(), occurredAt: z.string() }),
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      return deps.db.transaction().execute(async trx => {
        const candidate = await trx.selectFrom('candidates').select('assignedStaffId').where('id', '=', params.id).executeTakeFirst();
        if (!candidate) throw notFound('Candidate');
        await assertInScope(trx, staff, candidate.assignedStaffId);
        const communication = await logContact(trx, deps, meta, { ...body, candidateId: params.id });
        await audit(trx, meta, { action: 'candidate.contact_logged', subjectType: 'candidate', subjectId: params.id, metadata: { channel: body.channel, isReply: body.isReply } });
        return communication;
      });
    }
  })
];
