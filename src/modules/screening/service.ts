import { DateTime } from 'luxon';
import type { AppDeps, RequestMeta, StaffActor } from '../../context.js';
import type { Executor, Tx } from '../../db/index.js';
import { audit } from '../../domain/audit.js';
import { emit } from '../../domain/outbox.js';
import { assertInScope, updateVersioned } from '../../domain/records.js';
import { noticeFor } from '../../domain/consents.js';
import { getSettings } from '../../domain/settings.js';
import { conflict, notFound, unprocessable, validationFailed } from '../../http/errors.js';
import { localDate } from '../../lib/time.js';
import { closeAppointment, createAppointment } from '../operations/appointments.js';
import { PolicyRequirements } from './eligibility.js';

/**
 * Screening records. References need recorded permission before any outreach; interviews are
 * evaluated only after they are completed; checks separate the provider's result from the
 * agency's review. None of these approve a candidate automatically.
 */

async function candidateInScope(db: Executor, staff: StaffActor, candidateId: string) {
  const candidate = await db.selectFrom('candidates').select(['id', 'assignedStaffId']).where('id', '=', candidateId).executeTakeFirst();
  if (!candidate) throw notFound('Candidate');
  await assertInScope(db, staff, candidate.assignedStaffId);
}

// ------------------------------------------------------------------------------------- references

export async function listReferences(db: Executor, staff: StaffActor, candidateId: string) {
  await candidateInScope(db, staff, candidateId);
  const refs = await db.selectFrom('candidateReferences').selectAll().where('candidateId', '=', candidateId).orderBy('createdAt').execute();
  const ids = refs.map(r => r.id);
  const [attempts, evaluations] = ids.length
    ? await Promise.all([
        db.selectFrom('referenceContactAttempts').selectAll().where('referenceId', 'in', ids).orderBy('occurredAt').execute(),
        db.selectFrom('referenceEvaluations').selectAll().where('referenceId', 'in', ids).execute()
      ])
    : [[], []];
  return refs.map(ref => ({
    ...ref,
    permissionActive: ref.permissionToContact && !ref.permissionRevokedAt,
    attempts: attempts.filter(a => a.referenceId === ref.id),
    evaluation: evaluations.find(e => e.referenceId === ref.id) ?? null
  }));
}

async function loadReference(db: Executor, staff: StaffActor, id: string, lock = false) {
  let q = db.selectFrom('candidateReferences').selectAll().where('id', '=', id);
  if (lock) q = q.forUpdate();
  const ref = await q.executeTakeFirst();
  if (!ref) throw notFound('Reference');
  await candidateInScope(db, staff, ref.candidateId);
  return ref;
}

export async function addReference(deps: AppDeps, meta: RequestMeta, staff: StaffActor, candidateId: string, input: Record<string, unknown> & { permissionToContact: boolean; permissionEvidence?: string | null }) {
  const { permissionToContact, permissionEvidence, ...fields } = input;
  return deps.db.transaction().execute(async trx => {
    await candidateInScope(trx, staff, candidateId);
    let consentId: string | null = null;
    if (permissionToContact) consentId = await recordReferenceConsent(trx, deps, meta, candidateId, permissionEvidence ?? null);
    const row = await trx
      .insertInto('candidateReferences')
      .values({
        candidateId,
        ...(fields as Record<string, never>),
        email: typeof fields.email === 'string' ? fields.email.toLowerCase() : null,
        permissionToContact,
        permissionRecordedAt: permissionToContact ? meta.now.toISOString() : null,
        permissionSource: permissionToContact ? 'staff_recorded' : null,
        permissionConsentId: consentId,
        createdAt: meta.now.toISOString()
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, meta, { action: 'reference.added', subjectType: 'reference', subjectId: row.id, metadata: { candidateId, permission: permissionToContact } });
    return row.id;
  });
}

async function recordReferenceConsent(trx: Tx, deps: AppDeps, meta: RequestMeta, candidateId: string, evidence: string | null) {
  if (!evidence) throw validationFailed([{ path: 'permissionEvidence', code: 'required', message: 'Describe how the candidate gave permission (e.g. "signed form 2026-10-20", "verbal on call")' }]);
  const notice = await noticeFor(trx, deps.config, 'reference_authorization');
  const row = await trx
    .insertInto('consents')
    .values({
      consentType: 'reference_contact_authorization',
      candidateId,
      legalNoticeId: notice.id,
      noticeVersion: notice.version,
      granted: true,
      recordedByType: 'staff',
      recordedByStaffId: meta.actor.type === 'staff' ? meta.actor.staffId : null,
      occurredAt: meta.now.toISOString(),
      evidence: JSON.stringify({ method: 'staff_recorded', note: evidence, placeholderNotice: notice.placeholder })
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function updateReference(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: Record<string, unknown> & { version: number }) {
  const { version, ...values } = input;
  await loadReference(deps.db, staff, id);
  if (typeof values.email === 'string') values.email = values.email.toLowerCase();
  await updateVersioned(deps.db, 'candidateReferences', id, version, values, 'Reference');
  await audit(deps.db, meta, { action: 'reference.updated', subjectType: 'reference', subjectId: id, metadata: { fields: Object.keys(values) } });
}

export async function setReferencePermission(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { granted: boolean; evidence?: string | null; version: number }) {
  await deps.db.transaction().execute(async trx => {
    const ref = await loadReference(trx, staff, id, true);
    if (input.granted) {
      const consentId = await recordReferenceConsent(trx, deps, meta, ref.candidateId, input.evidence ?? null);
      await updateVersioned(trx, 'candidateReferences', id, input.version, { permissionToContact: true, permissionRecordedAt: meta.now.toISOString(), permissionSource: 'staff_recorded', permissionConsentId: consentId, permissionRevokedAt: null }, 'Reference');
    } else {
      await updateVersioned(trx, 'candidateReferences', id, input.version, { permissionRevokedAt: meta.now.toISOString() }, 'Reference');
      if (ref.permissionConsentId) await trx.updateTable('consents').set({ withdrawnAt: meta.now.toISOString(), withdrawnReason: input.evidence ?? 'Permission revoked' }).where('id', '=', ref.permissionConsentId).where('withdrawnAt', 'is', null).execute();
      await emit(trx, meta, { type: 'reference.permission_revoked', subjectType: 'reference', subjectId: id, payload: { related: { reference: id, candidate: ref.candidateId } } });
    }
    await audit(trx, meta, { action: input.granted ? 'reference.permission_recorded' : 'reference.permission_revoked', subjectType: 'reference', subjectId: id });
  });
}

/** Starts outreach. Refused unless permission is recorded and not revoked. */
export async function startReferenceOutreach(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { version: number }) {
  await deps.db.transaction().execute(async trx => {
    const ref = await loadReference(trx, staff, id, true);
    if (!ref.permissionToContact || ref.permissionRevokedAt) throw unprocessable('Record the candidate\'s permission before contacting this reference.', 'reference_permission_required');
    if (['completed', 'declined', 'cancelled'].includes(ref.status)) throw unprocessable(`This reference is ${ref.status}.`, 'reference_closed');
    await updateVersioned(trx, 'candidateReferences', id, input.version, { status: 'in_progress', assignedStaffId: ref.assignedStaffId ?? staff.staffId }, 'Reference');
    await audit(trx, meta, { action: 'reference.outreach_started', subjectType: 'reference', subjectId: id });
    await emit(trx, meta, { type: 'reference.outreach_started', subjectType: 'reference', subjectId: id, payload: { related: { reference: id, candidate: ref.candidateId } }, dedupeKey: `reference.outreach_started:${id}:${ref.version}` });
  });
}

export async function logReferenceAttempt(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { method: string; outcome: string; notes?: string | null; occurredAt?: string }) {
  const ref = await loadReference(deps.db, staff, id);
  if (!ref.permissionToContact || ref.permissionRevokedAt) throw unprocessable('Contact is not permitted for this reference.', 'reference_permission_required');
  const row = await deps.db
    .insertInto('referenceContactAttempts')
    .values({ referenceId: id, method: input.method, outcome: input.outcome, notes: input.notes ?? null, occurredAt: input.occurredAt ?? meta.now.toISOString(), actorStaffId: staff.staffId, createdAt: meta.now.toISOString() })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (ref.status === 'not_started') await deps.db.updateTable('candidateReferences').set({ status: 'in_progress' }).where('id', '=', id).execute();
  await audit(deps.db, meta, { action: 'reference.attempt_logged', subjectType: 'reference', subjectId: id, metadata: { method: input.method, outcome: input.outcome } });
  return row;
}

export async function saveReferenceEvaluation(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: Record<string, unknown> & { recommendation: string; version?: number }) {
  const ref = await loadReference(deps.db, staff, id);
  if (!ref.permissionToContact) throw unprocessable('Contact was not permitted for this reference.', 'reference_permission_required');
  const { version, ...values } = input;
  const existing = await deps.db.selectFrom('referenceEvaluations').select(['id', 'version']).where('referenceId', '=', id).executeTakeFirst();
  const data = { ...values, answers: JSON.stringify(values.answers ?? {}), evaluatorStaffId: staff.staffId, completedAt: meta.now.toISOString() };
  if (existing) {
    await updateVersioned(deps.db, 'referenceEvaluations', existing.id, version ?? existing.version, data, 'Reference evaluation');
  } else {
    await deps.db.insertInto('referenceEvaluations').values({ referenceId: id, ...(data as unknown as Record<string, never>), createdAt: meta.now.toISOString() } as never).execute();
  }
  await audit(deps.db, meta, { action: 'reference.evaluation_saved', subjectType: 'reference', subjectId: id, metadata: { recommendation: input.recommendation } });
}

/** Agency review of a reference; only a satisfactory review counts toward eligibility. */
export async function closeReference(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { status: 'completed' | 'unable_to_reach' | 'declined' | 'cancelled'; reviewOutcome?: 'satisfactory' | 'concerns' | 'unsatisfactory'; version: number }) {
  await deps.db.transaction().execute(async trx => {
    const ref = await loadReference(trx, staff, id, true);
    if (input.status === 'completed') {
      if (!input.reviewOutcome) throw validationFailed([{ path: 'reviewOutcome', code: 'required', message: 'Record the review outcome' }]);
      const evaluation = await trx.selectFrom('referenceEvaluations').select('id').where('referenceId', '=', id).executeTakeFirst();
      if (!evaluation) throw unprocessable('Save the reference evaluation before completing it.', 'evaluation_required');
    }
    await updateVersioned(trx, 'candidateReferences', id, input.version, {
      status: input.status,
      completedAt: meta.now.toISOString(),
      ...(input.status === 'completed' ? { reviewOutcome: input.reviewOutcome, reviewedAt: meta.now.toISOString(), reviewedBy: staff.staffId } : {})
    }, 'Reference');
    await audit(trx, meta, { action: 'reference.closed', subjectType: 'reference', subjectId: id, metadata: { status: input.status, reviewOutcome: input.reviewOutcome ?? null } });
    if (input.status === 'completed') {
      await emit(trx, meta, { type: 'reference.completed', subjectType: 'reference', subjectId: id, payload: { related: { reference: id, candidate: ref.candidateId } } });
    }
  });
}

// ------------------------------------------------------------------------------------- interviews

export async function listInterviewTemplates(db: Executor) {
  return db
    .selectFrom('interviewTemplates as t')
    .leftJoin('interviewTemplateVersions as v', 'v.id', 't.currentVersionId')
    .select(['t.id', 't.key', 't.name', 't.kind', 't.status', 'v.id as versionId', 'v.versionNumber', 'v.questions'])
    .orderBy('t.name')
    .execute();
}

export async function publishInterviewTemplate(deps: AppDeps, meta: RequestMeta, input: { key: string; name: string; kind: 'general' | 'job_fit'; questions: unknown[] }) {
  return deps.db.transaction().execute(async trx => {
    let template = await trx.selectFrom('interviewTemplates').selectAll().where('key', '=', input.key).forUpdate().executeTakeFirst();
    if (!template) template = await trx.insertInto('interviewTemplates').values({ key: input.key, name: input.name, kind: input.kind }).returningAll().executeTakeFirstOrThrow();
    else if (template.kind !== input.kind) throw conflict('A template\'s kind cannot change; create a new template.', 'template_kind_fixed');
    const last = await trx.selectFrom('interviewTemplateVersions').select(eb => eb.fn.max('versionNumber').as('n')).where('templateId', '=', template.id).executeTakeFirst();
    const version = await trx
      .insertInto('interviewTemplateVersions')
      .values({ templateId: template.id, versionNumber: Number(last?.n ?? 0) + 1, questions: JSON.stringify(input.questions), publishedBy: meta.actor.type === 'staff' ? meta.actor.staffId : null, publishedAt: meta.now.toISOString() })
      .returning(['id', 'versionNumber'])
      .executeTakeFirstOrThrow();
    await trx.updateTable('interviewTemplates').set({ currentVersionId: version.id, name: input.name, status: 'active' }).where('id', '=', template.id).execute();
    await audit(trx, meta, { action: 'interview_template.published', subjectType: 'interview_template', subjectId: template.id, metadata: { version: version.versionNumber } });
    return { templateId: template.id, versionId: version.id, versionNumber: version.versionNumber };
  });
}

export async function listInterviews(db: Executor, staff: StaffActor, candidateId: string) {
  await candidateInScope(db, staff, candidateId);
  return db
    .selectFrom('interviews as i')
    .leftJoin('appointments as a', 'a.id', 'i.appointmentId')
    .leftJoin('interviewEvaluations as e', 'e.interviewId', 'i.id')
    .leftJoin('staffMembers as s', 's.id', 'i.interviewerStaffId')
    .leftJoin('interviewTemplateVersions as v', 'v.id', 'i.templateVersionId')
    .selectAll('i')
    .select([
      'a.startsAt', 'a.endsAt', 'a.locationType', 'a.locationDetail', 'a.revision as appointmentRevision', 'a.version as appointmentVersion',
      's.displayName as interviewerName', 'v.questions as templateQuestions',
      'e.id as evaluationId', 'e.answers', 'e.generalAssessment', 'e.jobFitAssessment', 'e.strengths', 'e.concerns', 'e.followUp', 'e.recommendation', 'e.submittedAt', 'e.version as evaluationVersion'
    ])
    .where('i.candidateId', '=', candidateId)
    .orderBy('i.createdAt', 'desc')
    .execute();
}

export async function scheduleInterview(
  deps: AppDeps,
  meta: RequestMeta,
  staff: StaffActor,
  candidateId: string,
  input: { kind: 'general' | 'job_fit'; jobOrderId?: string | null; templateKey?: string; method: 'in_person' | 'video' | 'phone'; startsAt: string; endsAt: string; interviewerStaffId?: string | null; locationDetail?: string | null }
) {
  return deps.db.transaction().execute(async trx => {
    await candidateInScope(trx, staff, candidateId);
    if (input.kind === 'job_fit' && !input.jobOrderId) throw validationFailed([{ path: 'jobOrderId', code: 'required', message: 'A job-fit interview belongs to a job' }]);
    const template = await trx
      .selectFrom('interviewTemplates')
      .select(['currentVersionId', 'kind'])
      .where(eb => (input.templateKey ? eb('key', '=', input.templateKey) : eb('kind', '=', input.kind)))
      .where('status', '=', 'active')
      .orderBy('createdAt')
      .executeTakeFirst();
    const candidate = await trx.selectFrom('candidates').select(['firstName', 'lastName']).where('id', '=', candidateId).executeTakeFirstOrThrow();
    const appointment = await createAppointment(trx, meta, {
      kind: 'candidate_interview',
      title: `${input.kind === 'job_fit' ? 'Job-fit' : 'Screening'} interview: ${candidate.firstName} ${candidate.lastName}`,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      locationType: input.method,
      locationDetail: input.locationDetail ?? null,
      organizerStaffId: input.interviewerStaffId ?? staff.staffId,
      candidateId,
      jobOrderId: input.jobOrderId ?? null
    });
    const interview = await trx
      .insertInto('interviews')
      .values({
        candidateId,
        jobOrderId: input.jobOrderId ?? null,
        kind: input.kind,
        templateVersionId: template?.currentVersionId ?? null,
        appointmentId: appointment.id,
        interviewerStaffId: input.interviewerStaffId ?? staff.staffId,
        method: input.method,
        scheduledStart: input.startsAt,
        createdAt: meta.now.toISOString()
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, meta, { action: 'interview.scheduled', subjectType: 'interview', subjectId: interview.id, metadata: { candidateId, kind: input.kind } });
    return interview.id;
  });
}

export async function completeInterview(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { version: number }) {
  await deps.db.transaction().execute(async trx => {
    const interview = await trx.selectFrom('interviews').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!interview) throw notFound('Interview');
    await candidateInScope(trx, staff, interview.candidateId);
    if (interview.status !== 'scheduled') throw unprocessable(`This interview is ${interview.status}.`, 'interview_closed');
    await updateVersioned(trx, 'interviews', id, input.version, { status: 'completed', completedAt: meta.now.toISOString() }, 'Interview');
    if (interview.appointmentId) {
      const appt = await trx.selectFrom('appointments').select('status').where('id', '=', interview.appointmentId).executeTakeFirst();
      if (appt?.status === 'scheduled') await closeAppointment(trx, meta, interview.appointmentId, { status: 'completed' });
    }
    await audit(trx, meta, { action: 'interview.completed', subjectType: 'interview', subjectId: id });
  });
}

/** An evaluation can only be recorded for a completed interview; there is no automatic outcome. */
export async function saveInterviewEvaluation(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: Record<string, unknown> & { recommendation: string; version?: number }) {
  const interview = await deps.db.selectFrom('interviews').select(['candidateId', 'status']).where('id', '=', id).executeTakeFirst();
  if (!interview) throw notFound('Interview');
  await candidateInScope(deps.db, staff, interview.candidateId);
  if (interview.status !== 'completed') throw unprocessable('Mark the interview completed before evaluating it.', 'interview_not_completed');
  const { version, ...values } = input;
  const existing = await deps.db.selectFrom('interviewEvaluations').select(['id', 'version']).where('interviewId', '=', id).executeTakeFirst();
  const data = { ...values, answers: JSON.stringify(values.answers ?? {}), evaluatorStaffId: staff.staffId, submittedAt: meta.now.toISOString() };
  if (existing) await updateVersioned(deps.db, 'interviewEvaluations', existing.id, version ?? existing.version, data, 'Interview evaluation');
  else await deps.db.insertInto('interviewEvaluations').values({ interviewId: id, ...(data as unknown as Record<string, never>), createdAt: meta.now.toISOString() } as never).execute();
  await audit(deps.db, meta, { action: 'interview.evaluated', subjectType: 'interview', subjectId: id, metadata: { recommendation: input.recommendation } });
}

// ------------------------------------------------------------------------------------- checks

const CHECK_FLOW: Record<string, string[]> = {
  not_requested: ['authorization_pending', 'requested'],
  authorization_pending: ['requested', 'not_requested'],
  requested: ['pending', 'completed', 'not_requested'],
  pending: ['completed', 'requested'],
  completed: [],
  reviewed: [],
  follow_up_required: ['pending', 'completed'],
  expired: ['requested', 'authorization_pending']
};

export async function listChecks(db: Executor, staff: StaffActor, candidateId: string) {
  await candidateInScope(db, staff, candidateId);
  return db
    .selectFrom('screeningChecks as s')
    .innerJoin('screeningCheckTypes as t', 't.key', 's.checkTypeKey')
    .selectAll('s')
    .select(['t.label', 't.requiresAuthorization', 't.validityMonths'])
    .where('s.candidateId', '=', candidateId)
    .orderBy('s.createdAt', 'desc')
    .execute();
}

export async function createCheck(deps: AppDeps, meta: RequestMeta, staff: StaffActor, candidateId: string, input: { checkTypeKey: string; provider?: string | null }) {
  await candidateInScope(deps.db, staff, candidateId);
  const type = await deps.db.selectFrom('screeningCheckTypes').select(['key', 'active']).where('key', '=', input.checkTypeKey).executeTakeFirst();
  if (!type?.active) throw validationFailed([{ path: 'checkTypeKey', code: 'invalid', message: 'Unknown or inactive check type' }]);
  const row = await deps.db
    .insertInto('screeningChecks')
    .values({ candidateId, checkTypeKey: input.checkTypeKey, provider: input.provider ?? null, assignedStaffId: staff.staffId, createdAt: meta.now.toISOString() })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(deps.db, meta, { action: 'screening.check_created', subjectType: 'screening_check', subjectId: row.id, metadata: { checkType: input.checkTypeKey } });
  return row.id;
}

async function loadCheck(db: Executor, staff: StaffActor, id: string) {
  const check = await db
    .selectFrom('screeningChecks as s')
    .innerJoin('screeningCheckTypes as t', 't.key', 's.checkTypeKey')
    .selectAll('s')
    .select(['t.requiresAuthorization', 't.validityMonths'])
    .where('s.id', '=', id)
    .executeTakeFirst();
  if (!check) throw notFound('Screening check');
  await candidateInScope(db, staff, check.candidateId);
  return check;
}

/** Records the candidate's authorization (collected through the provider or a signed form). */
export async function recordCheckAuthorization(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { authorizationReference: string; method: string; version: number }) {
  await deps.db.transaction().execute(async trx => {
    const check = await loadCheck(trx, staff, id);
    const notice = await noticeFor(trx, deps.config, 'background_authorization');
    const consent = await trx
      .insertInto('consents')
      .values({
        consentType: 'background_check_authorization',
        candidateId: check.candidateId,
        legalNoticeId: notice.id,
        noticeVersion: notice.version,
        granted: true,
        recordedByType: 'staff',
        recordedByStaffId: staff.staffId,
        occurredAt: meta.now.toISOString(),
        evidence: JSON.stringify({ method: input.method, reference: input.authorizationReference, checkId: id, placeholderNotice: notice.placeholder })
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await updateVersioned(trx, 'screeningChecks', id, input.version, {
      authorizationConsentId: consent.id,
      authorizationReference: input.authorizationReference,
      authorizationRecordedAt: meta.now.toISOString(),
      ...(check.status === 'authorization_pending' || check.status === 'not_requested' ? { status: 'authorization_pending' } : {})
    }, 'Screening check');
    await audit(trx, meta, { action: 'screening.authorization_recorded', subjectType: 'screening_check', subjectId: id });
  });
}

export async function updateCheckStatus(
  deps: AppDeps,
  meta: RequestMeta,
  staff: StaffActor,
  id: string,
  input: { to: string; provider?: string | null; providerReference?: string | null; resultCategory?: string | null; version: number }
) {
  await deps.db.transaction().execute(async trx => {
    const check = await loadCheck(trx, staff, id);
    if (!(CHECK_FLOW[check.status] ?? []).includes(input.to)) throw unprocessable(`A check cannot move from "${check.status}" to "${input.to}".`, 'transition_not_allowed');
    if (['requested', 'pending', 'completed'].includes(input.to) && check.requiresAuthorization && !check.authorizationRecordedAt) {
      throw unprocessable('Record the candidate\'s authorization before requesting this check.', 'authorization_required');
    }
    if (input.to === 'completed' && !input.resultCategory) throw validationFailed([{ path: 'resultCategory', code: 'required', message: 'Record the provider result category' }]);
    const values: Record<string, unknown> = { status: input.to };
    if (input.provider !== undefined) values.provider = input.provider;
    if (input.providerReference !== undefined) values.providerReference = input.providerReference;
    if (input.to === 'requested' && !check.requestedAt) values.requestedAt = meta.now.toISOString();
    if (input.to === 'completed') Object.assign(values, { completedAt: meta.now.toISOString(), resultCategory: input.resultCategory, requestedAt: check.requestedAt ?? meta.now.toISOString() });
    await updateVersioned(trx, 'screeningChecks', id, input.version, values, 'Screening check');
    await audit(trx, meta, { action: 'screening.check_status_changed', subjectType: 'screening_check', subjectId: id, metadata: { from: check.status, to: input.to } });
    const event = input.to === 'requested' ? 'screening.check_requested' : input.to === 'completed' ? 'screening.check_completed' : null;
    if (event) await emit(trx, meta, { type: event, subjectType: 'screening_check', subjectId: id, payload: { related: { screening_check: id, candidate: check.candidateId } } });
  });
}

/** The agency's own review of a completed check. A provider "clear" is not an approval. */
export async function reviewCheck(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { outcome: 'acceptable' | 'not_acceptable' | 'needs_follow_up'; note?: string | null; validUntil?: string | null; version: number }) {
  await deps.db.transaction().execute(async trx => {
    const check = await loadCheck(trx, staff, id);
    if (!['completed', 'follow_up_required'].includes(check.status)) throw unprocessable('Only a completed check can be reviewed.', 'check_not_completed');
    const timezone = (await getSettings(trx)).timezone;
    const validUntil =
      input.validUntil ??
      (check.validityMonths ? DateTime.fromJSDate(meta.now, { zone: timezone }).plus({ months: check.validityMonths }).toISODate() : null);
    await updateVersioned(trx, 'screeningChecks', id, input.version, {
      status: input.outcome === 'needs_follow_up' ? 'follow_up_required' : 'reviewed',
      reviewOutcome: input.outcome,
      reviewNote: input.note ?? null,
      reviewedAt: meta.now.toISOString(),
      reviewedBy: staff.staffId,
      validUntil: input.outcome === 'acceptable' ? validUntil : null
    }, 'Screening check');
    await audit(trx, meta, { action: 'screening.check_reviewed', subjectType: 'screening_check', subjectId: id, metadata: { outcome: input.outcome } });
    await emit(trx, meta, { type: 'screening.check_reviewed', subjectType: 'screening_check', subjectId: id, payload: { outcome: input.outcome, related: { screening_check: id, candidate: check.candidateId } } });
  });
}

/** Marks reviewed checks past their valid-until date as expired (runner, daily). */
export async function expireChecks(db: Executor, now: Date, timezone: string) {
  const today = localDate(now, timezone);
  return db.updateTable('screeningChecks').set({ status: 'expired' }).where('status', '=', 'reviewed').where('validUntil', '<', today).returning(['id', 'candidateId']).execute();
}

// ------------------------------------------------------------------------------------- policies & overrides

export async function listPolicies(db: Executor) {
  return db.selectFrom('screeningPolicies').selectAll().orderBy('versionNumber', 'desc').execute();
}

export async function createPolicyDraft(deps: AppDeps, meta: RequestMeta, input: { requirements: unknown; notes?: string | null }) {
  const requirements = PolicyRequirements.parse(input.requirements);
  const keys = requirements.map(r => r.key);
  if (new Set(keys).size !== keys.length) throw validationFailed([{ path: 'requirements', code: 'duplicate_key', message: 'Requirement keys must be unique' }]);
  const last = await deps.db.selectFrom('screeningPolicies').select(eb => eb.fn.max('versionNumber').as('n')).executeTakeFirst();
  const row = await deps.db
    .insertInto('screeningPolicies')
    .values({ versionNumber: Number(last?.n ?? 0) + 1, requirements: JSON.stringify(requirements), notes: input.notes ?? null, createdBy: meta.actor.type === 'staff' ? meta.actor.staffId : null, createdAt: meta.now.toISOString() })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(deps.db, meta, { action: 'screening_policy.draft_created', subjectType: 'screening_policy', subjectId: row.id, metadata: { version: row.versionNumber } });
  return row;
}

export async function publishPolicy(deps: AppDeps, meta: RequestMeta, id: string) {
  return deps.db.transaction().execute(async trx => {
    const policy = await trx.selectFrom('screeningPolicies').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!policy) throw notFound('Screening policy');
    if (policy.status !== 'draft') throw unprocessable('Only a draft policy can be published.', 'policy_not_draft');
    PolicyRequirements.parse(policy.requirements);
    await trx.updateTable('screeningPolicies').set({ status: 'retired' }).where('status', '=', 'active').execute();
    const published = await trx
      .updateTable('screeningPolicies')
      .set({ status: 'active', publishedAt: meta.now.toISOString(), publishedBy: meta.actor.type === 'staff' ? meta.actor.staffId : null })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, meta, { action: 'screening_policy.published', subjectType: 'screening_policy', subjectId: id, metadata: { version: policy.versionNumber } });
    return published;
  });
}

export async function listOverrides(db: Executor, candidateId: string) {
  return db.selectFrom('eligibilityOverrides').selectAll().where('candidateId', '=', candidateId).orderBy('createdAt', 'desc').execute();
}

export async function createOverride(deps: AppDeps, meta: RequestMeta, staff: StaffActor, candidateId: string, input: { requirementKey: string; jobOrderId?: string | null; reason: string; expiresAt?: string | null }) {
  await candidateInScope(deps.db, staff, candidateId);
  const policy = await deps.db.selectFrom('screeningPolicies').select('requirements').where('status', '=', 'active').executeTakeFirst();
  const keys = policy ? PolicyRequirements.parse(policy.requirements).map(r => r.key) : [];
  if (!keys.includes(input.requirementKey)) throw validationFailed([{ path: 'requirementKey', code: 'invalid', message: 'Not a requirement of the active policy' }]);
  if (input.expiresAt && new Date(input.expiresAt) <= meta.now) throw validationFailed([{ path: 'expiresAt', code: 'invalid', message: 'Expiry must be in the future' }]);
  const row = await deps.db
    .insertInto('eligibilityOverrides')
    .values({ candidateId, requirementKey: input.requirementKey, jobOrderId: input.jobOrderId ?? null, reason: input.reason, actorStaffId: staff.staffId, expiresAt: input.expiresAt ?? null, createdAt: meta.now.toISOString() })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(deps.db, meta, { action: 'screening.override_created', subjectType: 'candidate', subjectId: candidateId, metadata: { overrideId: row.id, requirementKey: input.requirementKey, jobOrderId: input.jobOrderId ?? null, expiresAt: input.expiresAt ?? null } });
  return row;
}

export async function revokeOverride(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, reason: string) {
  const row = await deps.db
    .updateTable('eligibilityOverrides')
    .set({ revokedAt: meta.now.toISOString(), revokedBy: staff.staffId, revokeReason: reason })
    .where('id', '=', id)
    .where('revokedAt', 'is', null)
    .returning(['id', 'candidateId'])
    .executeTakeFirst();
  if (!row) throw notFound('Active override');
  await audit(deps.db, meta, { action: 'screening.override_revoked', subjectType: 'candidate', subjectId: row.candidateId, metadata: { overrideId: id } });
}
