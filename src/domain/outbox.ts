import type { Executor } from '../db/index.js';
import { actorStaffId, actorType, type RequestMeta } from '../context.js';

/**
 * Domain events written in the same transaction as the business change (transactional outbox).
 * The runner turns them into workflow runs. Payloads hold ids and revisions only.
 */
export const EVENT_TYPES = [
  'enquiry.submitted',
  'enquiry.stage_changed',
  'enquiry.contact_recorded',
  'family.reply_recorded',
  'consultation.scheduled',
  'consultation.rescheduled',
  'consultation.cancelled',
  'consultation.completed',
  'application.draft_started',
  'application.resume_requested',
  'application.submitted',
  'candidate.stage_changed',
  'candidate.availability_changed',
  'candidate.information_requested',
  'candidate.information_received',
  'candidate.reply_recorded',
  'interview.scheduled',
  'interview.rescheduled',
  'interview.cancelled',
  'interview.completed',
  'reference.outreach_started',
  'reference.completed',
  'reference.permission_revoked',
  'screening.check_requested',
  'screening.check_completed',
  'screening.check_reviewed',
  'qualification.expiring',
  'qualification.expired',
  'availability.refresh_due',
  'job_candidate.stage_changed',
  'presentation.released',
  'family_interview.scheduled',
  'family_interview.rescheduled',
  'family_interview.cancelled',
  'offer.extended',
  'offer.closed',
  'placement.booked',
  'placement.start_changed',
  'placement.started',
  'placement.ended',
  'placement.cancelled',
  'placement.guarantee_ending',
  'placement.check_in_due',
  'staff.invited',
  'staff.password_reset_requested',
  'schedule.daily_digest',
  'export.requested',
  'retention.review_due',
  'task.assigned'
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EmitInput {
  type: EventType;
  subjectType: string;
  subjectId: string | null;
  payload?: Record<string, unknown>;
  /** Suppresses duplicates of the same logical event (e.g. scheduled triggers). */
  dedupeKey?: string;
  availableAt?: Date;
}

export async function emit(db: Executor, meta: RequestMeta, input: EmitInput): Promise<number | null> {
  const query = db
    .insertInto('outboxEvents')
    .values({
      eventType: input.type,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload: JSON.stringify(input.payload ?? {}),
      dedupeKey: input.dedupeKey ?? null,
      actorType: actorType(meta),
      actorStaffId: actorStaffId(meta),
      requestId: meta.requestId,
      occurredAt: meta.now.toISOString(),
      availableAt: (input.availableAt ?? meta.now).toISOString()
    })
    .returning('id');
  const row = input.dedupeKey
    ? await query.onConflict(oc => oc.column('dedupeKey').doNothing()).executeTakeFirst()
    : await query.executeTakeFirst();
  return row?.id ?? null;
}
