import type { AppDeps, RequestMeta, StaffActor } from '../../context.js';
import type { Executor, Tx } from '../../db/index.js';
import { audit } from '../../domain/audit.js';
import { emit, type EventType } from '../../domain/outbox.js';
import { assertTransitionAllowed, recordTransition } from '../../domain/stages.js';
import { assertInScope, assignedOnly, updateVersioned } from '../../domain/records.js';
import { notFound, unprocessable, validationFailed } from '../../http/errors.js';
import { actorStaffId } from '../../context.js';

/**
 * Appointments (consultations, interviews, family interviews, trials, check-ins). Every
 * reschedule or cancellation increments `revision`; reminders bound to an older revision are
 * recognised as stale by the runner and never sent.
 */

const EVENT_PREFIX: Record<string, string | undefined> = {
  consultation: 'consultation',
  candidate_interview: 'interview',
  family_interview: 'family_interview'
};

function related(row: { id: string; familyId: string | null; enquiryId: string | null; candidateId: string | null; jobOrderId: string | null; jobCandidateId: string | null }) {
  return {
    appointment: row.id,
    ...(row.familyId ? { family: row.familyId } : {}),
    ...(row.enquiryId ? { enquiry: row.enquiryId } : {}),
    ...(row.candidateId ? { candidate: row.candidateId } : {}),
    ...(row.jobOrderId ? { job_order: row.jobOrderId } : {}),
    ...(row.jobCandidateId ? { job_candidate: row.jobCandidateId } : {})
  };
}

export async function emitAppointmentEvent(trx: Tx, meta: RequestMeta, appointment: Parameters<typeof related>[0] & { kind: string; revision: number }, action: 'scheduled' | 'rescheduled' | 'cancelled' | 'completed') {
  const prefix = EVENT_PREFIX[appointment.kind];
  if (!prefix) return;
  if (action === 'completed' && prefix === 'family_interview') return;
  const type = `${prefix}.${action}` as EventType;
  await emit(trx, meta, {
    type,
    subjectType: 'appointment',
    subjectId: appointment.id,
    payload: { revision: appointment.revision, related: related(appointment) },
    dedupeKey: `${type}:${appointment.id}:${appointment.revision}`
  });
}

export interface AppointmentInput {
  kind: 'consultation' | 'candidate_interview' | 'family_interview' | 'trial' | 'check_in' | 'other';
  title: string;
  startsAt: string;
  endsAt: string;
  locationType: 'in_person' | 'video' | 'phone';
  locationDetail?: string | null;
  organizerStaffId?: string | null;
  familyId?: string | null;
  enquiryId?: string | null;
  candidateId?: string | null;
  jobOrderId?: string | null;
  jobCandidateId?: string | null;
  notes?: string | null;
}

/** Validates that linked records exist and agree with each other. */
async function checkLinks(db: Executor, input: AppointmentInput) {
  if (input.jobCandidateId) {
    const jc = await db.selectFrom('jobCandidates as jc').innerJoin('jobOrders as j', 'j.id', 'jc.jobOrderId').select(['jc.candidateId', 'jc.jobOrderId', 'j.familyId']).where('jc.id', '=', input.jobCandidateId).executeTakeFirst();
    if (!jc) throw validationFailed([{ path: 'jobCandidateId', code: 'invalid', message: 'Candidate-job association not found' }]);
    input.candidateId ??= jc.candidateId;
    input.jobOrderId ??= jc.jobOrderId;
    input.familyId ??= jc.familyId;
    if (input.candidateId !== jc.candidateId || input.jobOrderId !== jc.jobOrderId || input.familyId !== jc.familyId) {
      throw validationFailed([{ path: 'jobCandidateId', code: 'invalid', message: 'Linked records do not match the candidate-job association' }]);
    }
  }
  if (input.enquiryId) {
    const enquiry = await db.selectFrom('enquiries').select('familyId').where('id', '=', input.enquiryId).executeTakeFirst();
    if (!enquiry) throw validationFailed([{ path: 'enquiryId', code: 'invalid', message: 'Enquiry not found' }]);
    input.familyId ??= enquiry.familyId;
    if (input.familyId !== enquiry.familyId) throw validationFailed([{ path: 'enquiryId', code: 'invalid', message: 'The enquiry belongs to another family' }]);
  }
  if (!input.familyId && !input.candidateId) throw validationFailed([{ path: 'familyId', code: 'required', message: 'Link the appointment to a family or a candidate' }]);
  if (new Date(input.endsAt) <= new Date(input.startsAt)) throw validationFailed([{ path: 'endsAt', code: 'invalid', message: 'End must be after the start' }]);
}

export async function createAppointment(trx: Tx, meta: RequestMeta, input: AppointmentInput, options: { emitEvent?: boolean } = {}) {
  await checkLinks(trx, input);
  const appointment = await trx
    .insertInto('appointments')
    .values({
      kind: input.kind,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      locationType: input.locationType,
      locationDetail: input.locationDetail ?? null,
      organizerStaffId: input.organizerStaffId ?? actorStaffId(meta),
      familyId: input.familyId ?? null,
      enquiryId: input.enquiryId ?? null,
      candidateId: input.candidateId ?? null,
      jobOrderId: input.jobOrderId ?? null,
      jobCandidateId: input.jobCandidateId ?? null,
      notes: input.notes ?? null,
      createdAt: meta.now.toISOString()
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx.insertInto('appointmentChanges').values({ appointmentId: appointment.id, revision: 1, change: 'created', actorStaffId: actorStaffId(meta), occurredAt: meta.now.toISOString() }).execute();
  await audit(trx, meta, { action: 'appointment.created', subjectType: 'appointment', subjectId: appointment.id, metadata: { kind: input.kind } });
  if (options.emitEvent !== false) await emitAppointmentEvent(trx, meta, appointment, 'scheduled');
  return appointment;
}

async function scopeCheck(db: Executor, staff: StaffActor, appointment: { familyId: string | null; candidateId: string | null }) {
  if (appointment.familyId) {
    const family = await db.selectFrom('families').select('assignedStaffId').where('id', '=', appointment.familyId).executeTakeFirst();
    await assertInScope(db, staff, family?.assignedStaffId);
  }
  if (appointment.candidateId) {
    const candidate = await db.selectFrom('candidates').select('assignedStaffId').where('id', '=', appointment.candidateId).executeTakeFirst();
    await assertInScope(db, staff, candidate?.assignedStaffId);
  }
}

export async function getAppointment(db: Executor, staff: StaffActor | null, id: string) {
  const row = await db
    .selectFrom('appointments as a')
    .leftJoin('staffMembers as s', 's.id', 'a.organizerStaffId')
    .leftJoin('families as f', 'f.id', 'a.familyId')
    .leftJoin('candidates as c', 'c.id', 'a.candidateId')
    .selectAll('a')
    .select(['s.displayName as organizerName', 'f.displayName as familyName', 'c.firstName as candidateFirstName', 'c.lastName as candidateLastName'])
    .where('a.id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Appointment');
  if (staff) await scopeCheck(db, staff, row);
  const changes = await db.selectFrom('appointmentChanges').select(['revision', 'change', 'previousStartsAt', 'previousEndsAt', 'reason', 'actorStaffId', 'occurredAt']).where('appointmentId', '=', id).orderBy('id').execute();
  return toAppointmentDto(row, changes);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toAppointmentDto(row: Record<string, any>, changes: unknown[] = []) {
  return {
    ...row,
    organizer: row.organizerStaffId ? { id: row.organizerStaffId, displayName: row.organizerName ?? '' } : null,
    family: row.familyId ? { id: row.familyId, displayName: row.familyName ?? '' } : null,
    candidate: row.candidateId ? { id: row.candidateId, firstName: row.candidateFirstName ?? '', lastName: row.candidateLastName ?? '' } : null,
    changes
  };
}

export async function listAppointments(deps: AppDeps, staff: StaffActor, query: { from: string; to: string; kind?: string[]; organizerStaffId?: string; familyId?: string; candidateId?: string; includeCancelled?: boolean }) {
  let q = deps.db
    .selectFrom('appointments as a')
    .leftJoin('staffMembers as s', 's.id', 'a.organizerStaffId')
    .leftJoin('families as f', 'f.id', 'a.familyId')
    .leftJoin('candidates as c', 'c.id', 'a.candidateId')
    .selectAll('a')
    .select(['s.displayName as organizerName', 'f.displayName as familyName', 'f.assignedStaffId as familyAssignee', 'c.firstName as candidateFirstName', 'c.lastName as candidateLastName', 'c.assignedStaffId as candidateAssignee'])
    .where('a.startsAt', '<', query.to)
    .where('a.endsAt', '>', query.from);
  if (!query.includeCancelled) q = q.where('a.status', '<>', 'cancelled');
  if (query.kind?.length) q = q.where('a.kind', 'in', query.kind);
  if (query.organizerStaffId) q = q.where('a.organizerStaffId', '=', query.organizerStaffId);
  if (query.familyId) q = q.where('a.familyId', '=', query.familyId);
  if (query.candidateId) q = q.where('a.candidateId', '=', query.candidateId);
  const scoped = await assignedOnly(deps.db, staff);
  if (scoped) q = q.where(eb => eb.and([
    eb.or([eb('a.familyId', 'is', null), eb('f.assignedStaffId', 'is', null), eb('f.assignedStaffId', '=', staff.staffId)]),
    eb.or([eb('a.candidateId', 'is', null), eb('c.assignedStaffId', 'is', null), eb('c.assignedStaffId', '=', staff.staffId)]),
    eb.or([eb('a.familyId', 'is not', null), eb('a.candidateId', 'is not', null), eb('a.organizerStaffId', 'is', null), eb('a.organizerStaffId', '=', staff.staffId)])
  ]));
  const rows = await q.orderBy('a.startsAt').orderBy('a.id').limit(501).execute();
  if (rows.length > 500) throw unprocessable('This calendar range has more than 500 appointments. Choose a shorter date range.', 'calendar_range_too_large');
  return rows.map(row => toAppointmentDto(row));
}

export async function rescheduleAppointment(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { startsAt: string; endsAt: string; reason?: string; version: number; locationType?: string; locationDetail?: string | null }) {
  if (new Date(input.endsAt) <= new Date(input.startsAt)) throw validationFailed([{ path: 'endsAt', code: 'invalid', message: 'End must be after the start' }]);
  await deps.db.transaction().execute(async trx => {
    const current = await trx.selectFrom('appointments').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw notFound('Appointment');
    await scopeCheck(trx, staff, current);
    if (current.status !== 'scheduled') throw unprocessable(`A ${current.status} appointment cannot be rescheduled.`, 'appointment_closed');
    const updated = await updateVersioned(trx, 'appointments', id, input.version, {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      revision: current.revision + 1,
      ...(input.locationType ? { locationType: input.locationType } : {}),
      ...(input.locationDetail !== undefined ? { locationDetail: input.locationDetail } : {})
    }, 'Appointment');
    await trx.insertInto('appointmentChanges').values({ appointmentId: id, revision: current.revision + 1, change: 'rescheduled', previousStartsAt: current.startsAt, previousEndsAt: current.endsAt, reason: input.reason ?? null, actorStaffId: staff.staffId, occurredAt: meta.now.toISOString() }).execute();
    await audit(trx, meta, { action: 'appointment.rescheduled', subjectType: 'appointment', subjectId: id });
    // The old revision's reminders are cancelled; the new revision starts its own sequence.
    await emitAppointmentEvent(trx, meta, { ...current, revision: current.revision }, 'rescheduled');
    await emitAppointmentEvent(trx, meta, { ...current, revision: updated.revision as number }, 'scheduled');
    if (current.kind === 'candidate_interview') {
      await trx.updateTable('interviews').set({ scheduledStart: input.startsAt }).where('appointmentId', '=', id).execute();
    }
  });
  return getAppointment(deps.db, null, id);
}

export async function closeAppointment(trx: Tx, meta: RequestMeta, id: string, input: { status: 'cancelled' | 'completed' | 'no_show'; reason?: string; version?: number }) {
  const current = await trx.selectFrom('appointments').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!current) throw notFound('Appointment');
  if (current.status !== 'scheduled') throw unprocessable(`This appointment is already ${current.status}.`, 'appointment_closed');
  const revision = input.status === 'cancelled' ? current.revision + 1 : current.revision;
  await updateVersioned(trx, 'appointments', id, input.version ?? current.version, { status: input.status, revision, cancelledReason: input.status === 'cancelled' ? input.reason ?? null : null }, 'Appointment');
  await trx.insertInto('appointmentChanges').values({ appointmentId: id, revision, change: input.status === 'no_show' ? 'no_show' : input.status, reason: input.reason ?? null, actorStaffId: actorStaffId(meta), occurredAt: meta.now.toISOString() }).execute();
  await audit(trx, meta, { action: `appointment.${input.status}`, subjectType: 'appointment', subjectId: id });
  if (input.status === 'cancelled') await emitAppointmentEvent(trx, meta, { ...current, revision: current.revision }, 'cancelled');
  if (input.status === 'completed') await emitAppointmentEvent(trx, meta, current, 'completed');
  // Keep the linked consultation or interview record in step.
  const linkedStatus = input.status === 'completed' ? null : input.status;
  if (linkedStatus) {
    await trx.updateTable('consultations').set({ status: linkedStatus }).where('appointmentId', '=', id).where('status', '=', 'scheduled').execute();
    await trx.updateTable('interviews').set({ status: linkedStatus }).where('appointmentId', '=', id).where('status', '=', 'scheduled').execute();
  }
  return current;
}

// ------------------------------------------------------------------------------------- consultations

export async function scheduleConsultation(deps: AppDeps, meta: RequestMeta, staff: StaffActor, enquiryId: string, input: Omit<AppointmentInput, 'kind' | 'title' | 'enquiryId' | 'familyId' | 'candidateId' | 'jobOrderId' | 'jobCandidateId'> & { title?: string }) {
  return deps.db.transaction().execute(async trx => {
    const enquiry = await trx.selectFrom('enquiries as e').innerJoin('families as f', 'f.id', 'e.familyId').select(['e.id', 'e.stage', 'e.version', 'e.familyId', 'e.assignedStaffId', 'f.relationshipStatus', 'f.version as familyVersion', 'f.displayName']).where('e.id', '=', enquiryId).forUpdate().executeTakeFirst();
    if (!enquiry) throw notFound('Enquiry');
    await assertInScope(trx, staff, enquiry.assignedStaffId);
    const appointment = await createAppointment(trx, meta, { ...input, kind: 'consultation', title: input.title ?? `Consultation: ${enquiry.displayName}`, enquiryId, familyId: enquiry.familyId });
    const consultation = await trx.insertInto('consultations').values({ familyId: enquiry.familyId, enquiryId, appointmentId: appointment.id, createdAt: meta.now.toISOString() }).returningAll().executeTakeFirstOrThrow();
    if (enquiry.stage !== 'consultation_scheduled') {
      const allowed = await trx.selectFrom('stageTransitionRules').select('toKey').where('dimension', '=', 'enquiry').where('fromKey', '=', enquiry.stage).where('toKey', '=', 'consultation_scheduled').executeTakeFirst();
      if (allowed) {
        await updateVersioned(trx, 'enquiries', enquiryId, enquiry.version, { stage: 'consultation_scheduled' }, 'Enquiry');
        await trx.updateTable('enquiries').set({ firstResponseAt: meta.now.toISOString() }).where('id', '=', enquiryId).where('firstResponseAt', 'is', null).execute();
        await recordTransition(trx, meta, { dimension: 'enquiry', subjectId: enquiryId, from: enquiry.stage, to: 'consultation_scheduled', reason: 'Consultation booked' });
      }
    }
    if (enquiry.relationshipStatus === 'prospect') {
      await updateVersioned(trx, 'families', enquiry.familyId, enquiry.familyVersion, { relationshipStatus: 'consultation' }, 'Family');
      await recordTransition(trx, meta, { dimension: 'family_relationship', subjectId: enquiry.familyId, from: 'prospect', to: 'consultation', reason: 'Consultation booked' });
    }
    return { consultation, appointment };
  });
}

export async function completeConsultation(deps: AppDeps, meta: RequestMeta, staff: StaffActor, consultationId: string, input: { outcome: 'proceed' | 'follow_up' | 'not_proceeding'; summary?: string | null; version: number }) {
  return deps.db.transaction().execute(async trx => {
    const consultation = await trx.selectFrom('consultations').selectAll().where('id', '=', consultationId).forUpdate().executeTakeFirst();
    if (!consultation) throw notFound('Consultation');
    const family = await trx.selectFrom('families').select('assignedStaffId').where('id', '=', consultation.familyId).executeTakeFirstOrThrow();
    await assertInScope(trx, staff, family.assignedStaffId);
    if (consultation.status !== 'scheduled') throw unprocessable(`This consultation is ${consultation.status}.`, 'consultation_closed');
    const updated = await updateVersioned(trx, 'consultations', consultationId, input.version, { status: 'completed', outcome: input.outcome, summary: input.summary ?? null, completedAt: meta.now.toISOString(), recordedBy: staff.staffId }, 'Consultation');
    if (consultation.appointmentId) await closeAppointment(trx, meta, consultation.appointmentId, { status: 'completed' });
    if (consultation.enquiryId) {
      const enquiry = await trx.selectFrom('enquiries').select(['stage', 'version']).where('id', '=', consultation.enquiryId).executeTakeFirstOrThrow();
      if (enquiry.stage === 'consultation_scheduled') {
        await assertTransitionAllowed(trx, 'enquiry', enquiry.stage, 'consultation_completed', { viaCommand: true });
        await updateVersioned(trx, 'enquiries', consultation.enquiryId, enquiry.version, { stage: 'consultation_completed' }, 'Enquiry');
        await recordTransition(trx, meta, { dimension: 'enquiry', subjectId: consultation.enquiryId, from: enquiry.stage, to: 'consultation_completed', reason: `Outcome: ${input.outcome}` });
      }
    }
    await audit(trx, meta, { action: 'consultation.completed', subjectType: 'consultation', subjectId: consultationId, metadata: { outcome: input.outcome } });
    return updated;
  });
}

export async function listConsultations(db: Executor, filter: { familyId?: string; enquiryId?: string }) {
  let q = db.selectFrom('consultations as c').leftJoin('appointments as a', 'a.id', 'c.appointmentId').selectAll('c').select(['a.startsAt', 'a.endsAt', 'a.locationType', 'a.locationDetail', 'a.revision']);
  if (filter.familyId) q = q.where('c.familyId', '=', filter.familyId);
  if (filter.enquiryId) q = q.where('c.enquiryId', '=', filter.enquiryId);
  return q.orderBy('a.startsAt', 'desc').execute();
}
