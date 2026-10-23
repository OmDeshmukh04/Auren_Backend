import { z } from 'zod';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { DateOnly, Email, Id, IdParams, Ok, Phone, Timestamp, Version } from '../../http/schemas.js';
import { PolicyRequirement } from './eligibility.js';
import {
  addReference, closeReference, completeInterview, createCheck, createOverride, createPolicyDraft, listChecks, listInterviewTemplates, listInterviews,
  listOverrides, listPolicies, listReferences, logReferenceAttempt, publishInterviewTemplate, publishPolicy, recordCheckAuthorization, revokeOverride,
  reviewCheck, saveInterviewEvaluation, saveReferenceEvaluation, scheduleInterview, setReferencePermission, startReferenceOutreach, updateCheckStatus, updateReference
} from './service.js';

const Relationship = z.enum(['employer_family', 'agency_supervisor', 'workplace_supervisor', 'colleague', 'teacher', 'other']);

const Reference = z
  .object({
    id: Id,
    candidateId: Id,
    applicationId: Id.nullable(),
    fullName: z.string(),
    relationship: Relationship,
    relationshipDetail: z.string().nullable(),
    organizationDescription: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    employmentStart: DateOnly.nullable(),
    employmentEnd: DateOnly.nullable(),
    permissionToContact: z.boolean(),
    permissionActive: z.boolean().meta({ description: 'Permission recorded and not revoked. Outreach is refused otherwise.' }),
    permissionRecordedAt: Timestamp.nullable(),
    permissionSource: z.string().nullable(),
    permissionRevokedAt: Timestamp.nullable(),
    status: z.enum(['not_started', 'in_progress', 'completed', 'unable_to_reach', 'declined', 'cancelled']),
    completedAt: Timestamp.nullable(),
    reviewOutcome: z.enum(['satisfactory', 'concerns', 'unsatisfactory']).nullable(),
    reviewedAt: Timestamp.nullable(),
    attempts: z.array(z.object({ id: Id, method: z.string(), outcome: z.string(), occurredAt: Timestamp, notes: z.string().nullable(), actorStaffId: Id.nullable() })),
    evaluation: z
      .object({ id: Id, answers: z.unknown(), verifiedDates: z.boolean().nullable(), verifiedRole: z.boolean().nullable(), strengths: z.string().nullable(), concerns: z.string().nullable(), wouldRehire: z.boolean().nullable(), recommendation: z.string(), completedAt: Timestamp, version: Version })
      .nullable(),
    version: Version
  })
  .meta({ id: 'Reference', description: 'Confidential. Never shown to families or included in presentations.' });

const ReferenceInput = z
  .object({
    fullName: z.string().trim().min(1).max(160),
    relationship: Relationship,
    relationshipDetail: z.string().max(200).nullable().optional(),
    organizationDescription: z.string().max(200).nullable().optional(),
    email: Email.nullable().optional(),
    phone: Phone.nullable().optional(),
    employmentStart: DateOnly.nullable().optional(),
    employmentEnd: DateOnly.nullable().optional()
  });

const Interview = z
  .object({
    id: Id,
    candidateId: Id,
    jobOrderId: Id.nullable(),
    kind: z.enum(['general', 'job_fit']),
    method: z.enum(['in_person', 'video', 'phone']),
    status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']),
    appointmentId: Id.nullable(),
    appointmentVersion: z.int().nullable(),
    startsAt: Timestamp.nullable(),
    endsAt: Timestamp.nullable(),
    interviewerStaffId: Id.nullable(),
    interviewerName: z.string().nullable(),
    templateVersionId: Id.nullable(),
    templateQuestions: z.unknown(),
    completedAt: Timestamp.nullable(),
    evaluationId: Id.nullable(),
    answers: z.unknown(),
    generalAssessment: z.string().nullable(),
    jobFitAssessment: z.string().nullable(),
    strengths: z.string().nullable(),
    concerns: z.string().nullable(),
    followUp: z.string().nullable(),
    recommendation: z.enum(['advance', 'hold', 'do_not_advance']).nullable(),
    submittedAt: Timestamp.nullable(),
    evaluationVersion: z.int().nullable(),
    version: Version
  })
  .meta({ id: 'Interview' });

const ScreeningCheck = z
  .object({
    id: Id,
    candidateId: Id,
    checkTypeKey: z.string(),
    label: z.string(),
    requiresAuthorization: z.boolean(),
    validityMonths: z.int().nullable(),
    status: z.enum(['not_requested', 'authorization_pending', 'requested', 'pending', 'completed', 'reviewed', 'follow_up_required', 'expired']),
    provider: z.string().nullable(),
    providerReference: z.string().nullable(),
    authorizationReference: z.string().nullable(),
    authorizationRecordedAt: Timestamp.nullable(),
    requestedAt: Timestamp.nullable(),
    completedAt: Timestamp.nullable(),
    resultCategory: z.enum(['clear', 'consider', 'adverse', 'inconclusive', 'not_applicable']).nullable(),
    reviewedAt: Timestamp.nullable(),
    reviewOutcome: z.enum(['acceptable', 'not_acceptable', 'needs_follow_up']).nullable(),
    reviewNote: z.string().nullable(),
    validUntil: DateOnly.nullable(),
    version: Version,
    createdAt: Timestamp
  })
  .meta({ id: 'ScreeningCheck', description: 'Stores provider references, not full reports. A provider result is not an agency approval; the review is.' });

const Policy = z
  .object({ id: Id, versionNumber: z.int(), status: z.enum(['draft', 'active', 'retired']), requirements: z.array(PolicyRequirement), notes: z.string().nullable(), publishedAt: Timestamp.nullable(), createdAt: Timestamp })
  .meta({ id: 'ScreeningPolicy' });

const Override = z
  .object({ id: Id, candidateId: Id, requirementKey: z.string(), jobOrderId: Id.nullable(), reason: z.string(), actorStaffId: Id, createdAt: Timestamp, expiresAt: Timestamp.nullable(), revokedAt: Timestamp.nullable(), revokeReason: z.string().nullable() })
  .meta({ id: 'EligibilityOverride' });

const CandidateParam = IdParams;

export const screeningRoutes: AnyRoute[] = [
  // ---------------------------------------------------------------- references
  defineRoute({ method: 'GET', path: '/candidates/:id/references', operationId: 'listReferences', summary: 'References with attempts and evaluations (confidential)', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.read' }, params: CandidateParam, response: z.object({ items: z.array(Reference) }),
    async handler({ deps, staff, params }) { return { items: (await listReferences(deps.db, staff, params.id)) as never }; } }),
  defineRoute({ method: 'POST', path: '/candidates/:id/references', operationId: 'addReference', summary: 'Add a reference', description: 'permissionToContact=true requires permissionEvidence describing how the candidate gave permission.', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: CandidateParam,
    body: ReferenceInput.extend({ permissionToContact: z.boolean().default(false), permissionEvidence: z.string().max(500).nullable().optional() }).refine(v => Boolean(v.email || v.phone), { message: 'Add an email or phone', path: ['email'] }),
    response: z.object({ id: Id }), status: 201,
    async handler({ deps, meta, staff, params, body }) { return { id: await addReference(deps, meta, staff, params.id, body) }; } }),
  defineRoute({ method: 'PATCH', path: '/references/:id', operationId: 'updateReference', summary: 'Correct reference details', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ version: Version, fullName: z.string().trim().min(1).max(160).optional(), relationship: Relationship.optional(), relationshipDetail: z.string().max(200).nullable().optional(), organizationDescription: z.string().max(200).nullable().optional(), email: Email.nullable().optional(), phone: Phone.nullable().optional(), employmentStart: DateOnly.nullable().optional(), employmentEnd: DateOnly.nullable().optional() }),
    response: Ok, async handler({ deps, meta, staff, params, body }) { await updateReference(deps, meta, staff, params.id, body); return { ok: true as const }; } }),
  defineRoute({ method: 'POST', path: '/references/:id/permission', operationId: 'setReferencePermission', summary: 'Record or revoke permission to contact', description: 'Revoking stops any outreach sequence.', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ granted: z.boolean(), evidence: z.string().max(500).nullable().optional(), version: Version }), response: Ok,
    async handler({ deps, meta, staff, params, body }) { await setReferencePermission(deps, meta, staff, params.id, body); return { ok: true as const }; } }),
  defineRoute({ method: 'POST', path: '/references/:id/start-outreach', operationId: 'startReferenceOutreach', summary: 'Begin reference outreach', description: '422 reference_permission_required without recorded permission.', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ version: Version }), response: Ok, async handler({ deps, meta, staff, params, body }) { await startReferenceOutreach(deps, meta, staff, params.id, body); return { ok: true as const }; } }),
  defineRoute({ method: 'POST', path: '/references/:id/attempts', operationId: 'logReferenceAttempt', summary: 'Log a contact attempt', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ method: z.enum(['email', 'phone', 'text', 'other']), outcome: z.enum(['no_answer', 'left_message', 'spoke', 'email_sent', 'bounced', 'declined', 'callback_scheduled', 'wrong_contact']), notes: z.string().max(2000).nullable().optional(), occurredAt: Timestamp.optional() }),
    response: z.object({ id: Id }), status: 201, async handler({ deps, meta, staff, params, body }) { const row = await logReferenceAttempt(deps, meta, staff, params.id, body); return { id: row.id }; } }),
  defineRoute({ method: 'PUT', path: '/references/:id/evaluation', operationId: 'saveReferenceEvaluation', summary: 'Save the reference conversation notes and recommendation', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ version: Version.optional(), answers: z.record(z.string(), z.unknown()).default({}), verifiedDates: z.boolean().nullable().optional(), verifiedRole: z.boolean().nullable().optional(), strengths: z.string().max(4000).nullable().optional(), concerns: z.string().max(4000).nullable().optional(), wouldRehire: z.boolean().nullable().optional(), recommendation: z.enum(['positive', 'mixed', 'negative', 'inconclusive']) }),
    response: Ok, async handler({ deps, meta, staff, params, body }) { await saveReferenceEvaluation(deps, meta, staff, params.id, body); return { ok: true as const }; } }),
  defineRoute({ method: 'POST', path: '/references/:id/close', operationId: 'closeReference', summary: 'Complete (with agency review) or close a reference', description: 'Only completed + satisfactory references count toward eligibility.', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ status: z.enum(['completed', 'unable_to_reach', 'declined', 'cancelled']), reviewOutcome: z.enum(['satisfactory', 'concerns', 'unsatisfactory']).optional(), version: Version }),
    response: Ok, async handler({ deps, meta, staff, params, body }) { await closeReference(deps, meta, staff, params.id, body); return { ok: true as const }; } }),

  // ---------------------------------------------------------------- interviews
  defineRoute({ method: 'GET', path: '/interview-templates', operationId: 'listInterviewTemplates', summary: 'Interview templates (current version questions)', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.read' },
    response: z.object({ items: z.array(z.object({ id: Id, key: z.string(), name: z.string(), kind: z.string(), status: z.string(), versionId: Id.nullable(), versionNumber: z.int().nullable(), questions: z.unknown() })) }),
    async handler({ deps }) { return { items: await listInterviewTemplates(deps.db) }; } }),
  defineRoute({ method: 'POST', path: '/interview-templates', operationId: 'publishInterviewTemplate', summary: 'Publish a new interview template version', description: 'Existing interviews keep the version they used.', tags: ['Screening', 'Settings'], access: { kind: 'staff', permission: 'settings.write' },
    body: z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/), name: z.string().trim().min(1).max(120), kind: z.enum(['general', 'job_fit']), questions: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), prompt: z.string().min(1).max(500), type: z.enum(['long_text', 'short_text', 'rating', 'yes_no']) })).min(1).max(40) }),
    response: z.object({ templateId: Id, versionId: Id, versionNumber: z.int() }), status: 201,
    async handler({ deps, meta, body }) { return publishInterviewTemplate(deps, meta, body); } }),
  defineRoute({ method: 'GET', path: '/candidates/:id/interviews', operationId: 'listInterviews', summary: 'Interviews and evaluations', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.read' }, params: CandidateParam, response: z.object({ items: z.array(Interview) }),
    async handler({ deps, staff, params }) { return { items: (await listInterviews(deps.db, staff, params.id)) as never }; } }),
  defineRoute({ method: 'POST', path: '/candidates/:id/interviews', operationId: 'scheduleInterview', summary: 'Schedule an interview (creates a calendar appointment)', description: 'Reschedule or cancel through /appointments/{appointmentId}.', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: CandidateParam,
    body: z.object({ kind: z.enum(['general', 'job_fit']).default('general'), jobOrderId: Id.nullable().optional(), templateKey: z.string().optional(), method: z.enum(['in_person', 'video', 'phone']), startsAt: Timestamp, endsAt: Timestamp, interviewerStaffId: Id.nullable().optional(), locationDetail: z.string().max(500).nullable().optional() }),
    response: z.object({ id: Id }), status: 201, async handler({ deps, meta, staff, params, body }) { return { id: await scheduleInterview(deps, meta, staff, params.id, body) }; } }),
  defineRoute({ method: 'POST', path: '/interviews/:id/complete', operationId: 'completeInterview', summary: 'Mark an interview held', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ version: Version }), response: Ok, async handler({ deps, meta, staff, params, body }) { await completeInterview(deps, meta, staff, params.id, body); return { ok: true as const }; } }),
  defineRoute({ method: 'PUT', path: '/interviews/:id/evaluation', operationId: 'saveInterviewEvaluation', summary: 'Record the interview evaluation', description: 'Only for completed interviews. General evaluation and job-specific fit are kept separate.', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ version: Version.optional(), answers: z.record(z.string(), z.unknown()).default({}), generalAssessment: z.string().max(5000).nullable().optional(), jobFitAssessment: z.string().max(5000).nullable().optional(), strengths: z.string().max(4000).nullable().optional(), concerns: z.string().max(4000).nullable().optional(), followUp: z.string().max(2000).nullable().optional(), recommendation: z.enum(['advance', 'hold', 'do_not_advance']) }),
    response: Ok, async handler({ deps, meta, staff, params, body }) { await saveInterviewEvaluation(deps, meta, staff, params.id, body); return { ok: true as const }; } }),

  // ---------------------------------------------------------------- checks
  defineRoute({ method: 'GET', path: '/candidates/:id/checks', operationId: 'listScreeningChecks', summary: 'Background and other screening checks', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.read' }, params: CandidateParam, response: z.object({ items: z.array(ScreeningCheck) }),
    async handler({ deps, staff, params }) { return { items: (await listChecks(deps.db, staff, params.id)) as never }; } }),
  defineRoute({ method: 'POST', path: '/candidates/:id/checks', operationId: 'createScreeningCheck', summary: 'Start tracking a check', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: CandidateParam,
    body: z.object({ checkTypeKey: z.string().max(64), provider: z.string().max(120).nullable().optional() }), response: z.object({ id: Id }), status: 201,
    async handler({ deps, meta, staff, params, body }) { return { id: await createCheck(deps, meta, staff, params.id, body) }; } }),
  defineRoute({ method: 'POST', path: '/checks/:id/authorization', operationId: 'recordCheckAuthorization', summary: 'Record the candidate\'s authorization for the check', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ authorizationReference: z.string().trim().min(1).max(200).meta({ description: 'Provider authorization id or signed-form reference.' }), method: z.enum(['provider_portal', 'signed_form', 'other']), version: Version }),
    response: Ok, async handler({ deps, meta, staff, params, body }) { await recordCheckAuthorization(deps, meta, staff, params.id, body); return { ok: true as const }; } }),
  defineRoute({ method: 'POST', path: '/checks/:id/status', operationId: 'updateScreeningCheckStatus', summary: 'Record progress with the provider', description: 'requested/pending/completed require authorization when the check type does. completed requires resultCategory.', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ to: z.enum(['authorization_pending', 'requested', 'pending', 'completed', 'not_requested']), provider: z.string().max(120).nullable().optional(), providerReference: z.string().max(300).nullable().optional(), resultCategory: z.enum(['clear', 'consider', 'adverse', 'inconclusive', 'not_applicable']).nullable().optional(), version: Version }),
    response: Ok, async handler({ deps, meta, staff, params, body }) { await updateCheckStatus(deps, meta, staff, params.id, body); return { ok: true as const }; } }),
  defineRoute({ method: 'POST', path: '/checks/:id/review', operationId: 'reviewScreeningCheck', summary: 'Agency review of a completed check', description: 'validUntil defaults to the check type validity period.', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.write' }, params: IdParams,
    body: z.object({ outcome: z.enum(['acceptable', 'not_acceptable', 'needs_follow_up']), note: z.string().max(2000).nullable().optional(), validUntil: DateOnly.nullable().optional(), version: Version }),
    response: Ok, async handler({ deps, meta, staff, params, body }) { await reviewCheck(deps, meta, staff, params.id, body); return { ok: true as const }; } }),

  // ---------------------------------------------------------------- policy & overrides
  defineRoute({ method: 'GET', path: '/screening-policies', operationId: 'listScreeningPolicies', summary: 'Screening policy versions', tags: ['Screening', 'Settings'], access: { kind: 'staff', permission: 'screening.read' }, response: z.object({ items: z.array(Policy) }),
    async handler({ deps }) { return { items: (await listPolicies(deps.db)) as never }; } }),
  defineRoute({ method: 'POST', path: '/screening-policies', operationId: 'createScreeningPolicyDraft', summary: 'Draft a new screening policy version', tags: ['Screening', 'Settings'], access: { kind: 'staff', permission: 'settings.write' },
    body: z.object({ requirements: z.array(PolicyRequirement).max(30), notes: z.string().max(2000).nullable().optional() }), response: Policy, status: 201,
    async handler({ deps, meta, body }) { return (await createPolicyDraft(deps, meta, body)) as never; } }),
  defineRoute({ method: 'POST', path: '/screening-policies/:id/publish', operationId: 'publishScreeningPolicy', summary: 'Make a draft the active policy', description: 'Eligibility is re-evaluated against the new policy from now on; nothing is approved retroactively.', tags: ['Screening', 'Settings'], access: { kind: 'staff', permission: 'settings.write' }, params: IdParams, response: Policy,
    async handler({ deps, meta, params }) { return (await publishPolicy(deps, meta, params.id)) as never; } }),
  defineRoute({ method: 'GET', path: '/candidates/:id/eligibility-overrides', operationId: 'listEligibilityOverrides', summary: 'Overrides recorded for a candidate', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.read' }, params: CandidateParam, response: z.object({ items: z.array(Override) }),
    async handler({ deps, params }) { return { items: (await listOverrides(deps.db, params.id)) as never }; } }),
  defineRoute({ method: 'POST', path: '/candidates/:id/eligibility-overrides', operationId: 'createEligibilityOverride', summary: 'Treat one requirement as met (owner)', description: 'Scoped to a requirement and optionally one job; requires a reason; may expire. Never overrides a legal obligation.', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.override' }, params: CandidateParam,
    body: z.object({ requirementKey: z.string().max(80), jobOrderId: Id.nullable().optional(), reason: z.string().trim().min(10).max(2000), expiresAt: Timestamp.nullable().optional() }), response: Override, status: 201,
    async handler({ deps, meta, staff, params, body }) { return (await createOverride(deps, meta, staff, params.id, body)) as never; } }),
  defineRoute({ method: 'POST', path: '/eligibility-overrides/:id/revoke', operationId: 'revokeEligibilityOverride', summary: 'Revoke an override (owner)', tags: ['Screening'], access: { kind: 'staff', permission: 'screening.override' }, params: IdParams,
    body: z.object({ reason: z.string().trim().min(3).max(1000) }), response: Ok, async handler({ deps, meta, staff, params, body }) { await revokeOverride(deps, meta, staff, params.id, body.reason); return { ok: true as const }; } })
];
