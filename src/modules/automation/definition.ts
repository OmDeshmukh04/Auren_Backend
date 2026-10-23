import { z } from 'zod';
import { EVENT_TYPES } from '../../domain/outbox.js';

/**
 * Workflow definitions: a constrained, typed language the owner edits. No arbitrary code,
 * no arbitrary webhook URLs, no automatic screening approval or rejection.
 */

export const STEP_ACTIONS = [
  'create_task',
  'notify_staff',
  'send_email',
  'request_information',
  'schedule_follow_up',
  'generate_draft_presentation'
] as const;

const Delay = z
  .object({
    minutes: z.int().min(0).max(60 * 24 * 365).optional(),
    hours: z.int().min(-24 * 90).max(24 * 365).optional(),
    days: z.int().min(-365).max(365).optional(),
    businessDays: z.int().min(0).max(60).optional()
  })
  .meta({ id: 'WorkflowDelay', description: 'Offset from the step anchor in agency-local time. Negative hours/days schedule before a date anchor (reminders).' });

const ConditionOp = z.enum(['equals', 'not_equals', 'in', 'not_in', 'is_set', 'is_not_set', 'gte', 'lte']);

export const Condition = z
  .object({
    field: z.string().regex(/^[a-zA-Z]+(\.[a-zA-Z]+)+$/),
    op: ConditionOp,
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional()
  })
  .meta({ id: 'WorkflowCondition', description: 'Typed condition over a field from the trigger catalogue.' });
export type ConditionT = z.infer<typeof Condition>;

const RecipientKey = z.enum([
  'enquiry_contact',
  'family_primary_contact',
  'presentation_recipient',
  'candidate',
  'applicant',
  'reference',
  'staff_user'
]);
const StaffRecipient = z.enum(['notification_inbox', 'assignee', 'owners', 'digest_subscribers']);
const AssignTo = z.enum(['assignee', 'assignee_or_owner', 'owners', 'unassigned']);

const StepBase = {
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  name: z.string().max(120).optional(),
  delay: Delay.default({}),
  /** What the delay is relative to: enrollment time, or a date/instant field of the subject. */
  anchor: z.string().regex(/^(enrolled_at|[a-zA-Z]+(\.[a-zA-Z]+)+)$/).default('enrolled_at'),
  /** Skip the step when any of these conditions is true at execution time. */
  skipIf: z.array(Condition).max(10).default([])
};

export const Step = z
  .discriminatedUnion('action', [
    z.object({
      ...StepBase,
      action: z.literal('send_email'),
      template: z.string(),
      recipient: RecipientKey,
      /** Staff approval before sending; defaults to required for delayed outreach. */
      approval: z.enum(['none', 'required']).default('none'),
      respectQuietHours: z.boolean().default(true)
    }),
    z.object({ ...StepBase, action: z.literal('notify_staff'), template: z.string(), recipients: StaffRecipient.default('notification_inbox') }),
    z.object({
      ...StepBase,
      action: z.enum(['create_task', 'schedule_follow_up']),
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      kind: z.enum(['general', 'follow_up', 'review', 'feedback', 'check_in', 'renewal']).default('follow_up'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
      dueIn: Delay.default({ businessDays: 1 }),
      assignTo: AssignTo.default('assignee_or_owner')
    }),
    z.object({
      ...StepBase,
      action: z.literal('request_information'),
      template: z.string(),
      deadlineIn: Delay.default({ days: 7 }),
      approval: z.enum(['none', 'required']).default('none')
    }),
    z.object({ ...StepBase, action: z.literal('generate_draft_presentation') })
  ])
  .meta({ id: 'WorkflowStep' });
export type StepT = z.infer<typeof Step>;

export const WorkflowDefinition = z
  .object({
    conditions: z.array(Condition).max(10).default([]),
    steps: z.array(Step).min(1).max(20),
    /** Events that cancel an active run for the same subject. "type" or "type:toStage". */
    stopOn: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+(:[a-z_]+)?$/)).max(20).default([]),
    /** Cancel the run when any of these is true at a step's execution time. */
    stopWhen: z.array(Condition).max(10).default([]),
    /** One enrollment per subject while a run is active (default) or per event. */
    enrollment: z.enum(['one_active_per_subject', 'per_event']).default('one_active_per_subject'),
    frequencyCap: z
      .object({ maxExternalMessages: z.int().min(1).max(20), perDays: z.int().min(1).max(90) })
      .optional()
  })
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    for (const [index, step] of value.steps.entries()) {
      if (keys.has(step.key)) ctx.addIssue({ code: 'custom', path: ['steps', index, 'key'], message: 'Step keys must be unique' });
      keys.add(step.key);
    }
  })
  .meta({ id: 'WorkflowDefinition' });
export type WorkflowDefinitionT = z.infer<typeof WorkflowDefinition>;

// ---------------------------------------------------------------------------------------------
// Trigger catalogue: which events can start workflows, their subject, condition fields, template
// variables and recipients. The editor only offers what is listed here.
// ---------------------------------------------------------------------------------------------

export type SubjectType =
  | 'enquiry' | 'family' | 'candidate' | 'application' | 'appointment' | 'reference' | 'screening_check'
  | 'qualification' | 'job_candidate' | 'presentation' | 'offer' | 'placement' | 'information_request'
  | 'staff' | 'agency';

export interface TriggerSpec {
  event: (typeof EVENT_TYPES)[number];
  subject: SubjectType;
  description: string;
}

export const TRIGGERS: TriggerSpec[] = [
  { event: 'enquiry.submitted', subject: 'enquiry', description: 'A family enquiry was accepted' },
  { event: 'enquiry.stage_changed', subject: 'enquiry', description: 'An enquiry moved stage' },
  { event: 'consultation.scheduled', subject: 'appointment', description: 'A consultation was booked (also after a reschedule)' },
  { event: 'consultation.completed', subject: 'appointment', description: 'A consultation outcome was recorded' },
  { event: 'application.submitted', subject: 'application', description: 'A candidate application was submitted' },
  { event: 'candidate.information_requested', subject: 'information_request', description: 'Staff requested missing information' },
  { event: 'candidate.stage_changed', subject: 'candidate', description: 'A candidate moved recruitment stage' },
  { event: 'interview.scheduled', subject: 'appointment', description: 'A candidate interview was booked (also after a reschedule)' },
  { event: 'interview.completed', subject: 'appointment', description: 'An interview was marked completed' },
  { event: 'reference.outreach_started', subject: 'reference', description: 'Staff started reference outreach' },
  { event: 'screening.check_requested', subject: 'screening_check', description: 'A screening check was requested' },
  { event: 'screening.check_completed', subject: 'screening_check', description: 'A provider result was recorded' },
  { event: 'qualification.expiring', subject: 'qualification', description: 'A qualification enters its expiry window' },
  { event: 'availability.refresh_due', subject: 'candidate', description: 'A candidate availability confirmation is due' },
  { event: 'presentation.released', subject: 'presentation', description: 'An approved presentation was released' },
  { event: 'family_interview.scheduled', subject: 'appointment', description: 'A family interview was booked' },
  { event: 'offer.extended', subject: 'offer', description: 'An offer was recorded with a review date' },
  { event: 'placement.booked', subject: 'placement', description: 'A placement was confirmed' },
  { event: 'placement.start_changed', subject: 'placement', description: 'A placement start date changed' },
  { event: 'placement.started', subject: 'placement', description: 'A placement started' },
  { event: 'placement.guarantee_ending', subject: 'placement', description: 'A recorded guarantee end date is approaching' },
  { event: 'placement.check_in_due', subject: 'placement', description: 'A scheduled placement check-in is due' },
  { event: 'staff.invited', subject: 'staff', description: 'A staff invitation was created' },
  { event: 'schedule.daily_digest', subject: 'agency', description: 'Agency-local business-day digest' }
];

export function triggerFor(event: string) {
  return TRIGGERS.find(trigger => trigger.event === event);
}

/** Evaluates conditions against a flat field map (missing values are "not set"). */
export function evaluateConditions(conditions: ConditionT[], fields: Record<string, unknown>, mode: 'all' | 'any' = 'all'): boolean {
  const test = (condition: ConditionT) => {
    const actual = fields[condition.field];
    const expected = condition.value;
    switch (condition.op) {
      case 'is_set':
        return actual !== undefined && actual !== null && !(Array.isArray(actual) && actual.length === 0);
      case 'is_not_set':
        return actual === undefined || actual === null || (Array.isArray(actual) && actual.length === 0);
      case 'equals':
        return actual === expected;
      case 'not_equals':
        return actual !== expected;
      case 'in':
        return Array.isArray(expected) && (Array.isArray(actual) ? actual.some(a => expected.includes(String(a))) : expected.includes(String(actual)));
      case 'not_in':
        return Array.isArray(expected) && !(Array.isArray(actual) ? actual.some(a => expected.includes(String(a))) : expected.includes(String(actual)));
      case 'gte':
        return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
      case 'lte':
        return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
      default:
        return false;
    }
  };
  return mode === 'all' ? conditions.every(test) : conditions.some(test);
}

/** True for actions that send to someone outside the agency. */
export const isExternal = (step: StepT) => step.action === 'send_email' || step.action === 'request_information';
