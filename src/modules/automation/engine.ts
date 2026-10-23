import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { AppDeps } from '../../context.js';
import { systemMeta } from '../../context.js';
import type { Executor, Tx } from '../../db/index.js';
import { audit } from '../../domain/audit.js';
import { calendarOf, getSettings, type AgencySettings } from '../../domain/settings.js';
import { addDelay, HOUR, MINUTE, outsideQuietHours, type Calendar } from '../../lib/time.js';
import { createTask } from '../operations/tasks.js';
import { uniqueReference } from '../../domain/records.js';
import { DEFAULT_FIELDS } from '../presentations/content.js';
import { createDelivery, dispatchDeliveries, TemplateMissingError, type DeliveryRecipient } from './deliveries.js';
import { evaluateConditions, isExternal, triggerFor, WorkflowDefinition, type StepT, type WorkflowDefinitionT } from './definition.js';
import { loadSubject, type SubjectContext } from './subjects.js';

/**
 * Durable workflow execution.
 *
 *   outbox event --(processOutbox)--> stop matching runs; enroll enabled workflows (unique per
 *   workflow + event) with every step persisted and scheduled --(executeSteps)--> each due step
 *   reloads the current record and settings, re-checks pauses, stop conditions, revisions,
 *   staleness, quiet hours and frequency caps, then acts. Messages go through the delivery
 *   ledger (permanent idempotency key per run/step/recipient/revision).
 *
 * Every claim uses FOR UPDATE SKIP LOCKED with a lease, so overlapping cron invocations and a
 * worker crash mid-step never duplicate work.
 */

const STEP_LEASE_MS = 2 * MINUTE;
const MAX_STEP_ATTEMPTS = 5;
const MAX_EVENT_ATTEMPTS = 10;

type EventRow = { id: number; eventType: string; subjectType: string; subjectId: string | null; payload: unknown; occurredAt: string };

/** Every record an event concerns: its own subject plus payload.related. */
function relatedSet(event: EventRow) {
  const set = new Set<string>();
  if (event.subjectId) set.add(`${event.subjectType}:${event.subjectId}`);
  const related = (event.payload as { related?: Record<string, string | null> })?.related ?? {};
  for (const [type, id] of Object.entries(related)) if (id) set.add(`${type}:${id}`);
  return set;
}

function stopMatches(stopOn: string[], event: EventRow) {
  const to = (event.payload as { to?: string })?.to;
  return stopOn.some(rule => {
    const [type, stage] = rule.split(':');
    return type === event.eventType && (!stage || stage === to);
  });
}

async function cancelRunsForEvent(trx: Tx, event: EventRow, now: Date) {
  const subjects = relatedSet(event);
  if (!subjects.size) return 0;
  const pairs = [...subjects].map(entry => entry.split(':') as [string, string]);
  const runs = await trx
    .selectFrom('workflowRuns as r')
    .innerJoin('workflowVersions as v', 'v.id', 'r.workflowVersionId')
    .select(['r.id', 'r.subjectType', 'r.subjectId', 'r.triggerEventId', 'v.definition'])
    .where('r.status', '=', 'active')
    .where(eb => eb.or(pairs.map(([type, id]) => eb.and([eb('r.subjectType', '=', type), eb('r.subjectId', '=', id)]))))
    .execute();
  let cancelled = 0;
  for (const run of runs) {
    // A run is only stopped by events after the one that started it.
    if (run.triggerEventId !== null && run.triggerEventId >= event.id) continue;
    const definition = run.definition as WorkflowDefinitionT;
    if (!stopMatches(definition.stopOn ?? [], event)) continue;
    await cancelRun(trx, run.id, `Stopped by ${event.eventType}`, now, null);
    cancelled++;
  }
  return cancelled;
}

export async function cancelRun(db: Executor, runId: string, reason: string, now: Date, staffId: string | null) {
  await db
    .updateTable('workflowRuns')
    .set({ status: 'cancelled', cancelReason: reason, cancelledAt: now.toISOString(), cancelledBy: staffId, finishedAt: now.toISOString() })
    .where('id', '=', runId)
    .where('status', '=', 'active')
    .execute();
  await db
    .updateTable('workflowStepExecutions')
    .set({ status: 'cancelled', skipReason: reason, finishedAt: now.toISOString(), lockedUntil: null })
    .where('runId', '=', runId)
    .where('status', 'in', ['scheduled', 'awaiting_approval'])
    .execute();
}

/** Computes when a step is due from its anchor and delay, in agency-local time. */
export function stepDueAt(step: StepT, enrolledAt: Date, ctx: SubjectContext, calendar: Calendar): Date | null {
  let anchor = enrolledAt;
  if (step.anchor !== 'enrolled_at') {
    const value = ctx.dates[step.anchor];
    if (!value) return null;
    // Date-only anchors (expiry dates, start dates) are taken as 09:00 agency-local on that day.
    anchor = value.length === 10 ? DateTime.fromISO(`${value}T09:00`, { zone: calendar.timezone }).toJSDate() : new Date(value);
  }
  return addDelay(anchor, step.delay ?? {}, calendar);
}

async function enroll(trx: Tx, deps: AppDeps, event: EventRow, settings: AgencySettings) {
  const trigger = triggerFor(event.eventType);
  if (!trigger) return 0;
  const workflows = await trx
    .selectFrom('workflowDefinitions as w')
    .innerJoin('workflowVersions as v', 'v.id', 'w.currentVersionId')
    .select(['w.id', 'w.key', 'v.id as versionId', 'v.definition'])
    .where('w.triggerEvent', '=', event.eventType)
    .where('w.enabled', '=', true)
    .where('v.status', '=', 'published')
    .execute();
  if (!workflows.length || (!event.subjectId && trigger.subject !== 'agency')) return 0;
  const ctx = await loadSubject(deps, trx, trigger.subject, trigger.subject === 'agency' ? null : event.subjectId);
  if (!ctx) return 0;
  const calendar = calendarOf(settings);
  const enrolledAt = new Date(event.occurredAt);
  let created = 0;
  for (const workflow of workflows) {
    const definition = WorkflowDefinition.parse(workflow.definition);
    if (!evaluateConditions(definition.conditions, ctx.fields)) continue;
    if (definition.enrollment === 'one_active_per_subject' && event.subjectId) {
      const active = await trx.selectFrom('workflowRuns').select('id').where('workflowId', '=', workflow.id).where('subjectType', '=', trigger.subject).where('subjectId', '=', event.subjectId).where('status', '=', 'active').executeTakeFirst();
      if (active) continue;
    }
    const run = await trx
      .insertInto('workflowRuns')
      .values({
        workflowId: workflow.id,
        workflowVersionId: workflow.versionId,
        triggerEventId: event.id,
        enrollmentKey: `event:${event.id}`,
        subjectType: trigger.subject,
        subjectId: trigger.subject === 'agency' ? null : event.subjectId,
        context: JSON.stringify({ revision: ctx.revision, eventPayload: event.payload }),
        startedAt: deps.clock.now().toISOString()
      })
      .onConflict(oc => oc.columns(['workflowId', 'enrollmentKey']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!run) continue;
    const steps = definition.steps.map((step, index) => {
      const due = stepDueAt(step, enrolledAt, ctx, calendar);
      return { step, index, due };
    });
    const now = deps.clock.now();
    for (const { step, index, due } of steps) {
      // A reminder anchored before the booking itself (booked at short notice) is not sent late.
      const tooLate = due !== null && step.anchor !== 'enrolled_at' && due.getTime() < enrolledAt.getTime();
      const skipped = due === null || tooLate;
      const dueAt = (due ?? now).toISOString();
      await trx
        .insertInto('workflowStepExecutions')
        .values({
          runId: run.id,
          stepKey: step.key,
          stepIndex: index,
          action: step.action,
          status: skipped ? 'skipped' : 'scheduled',
          skipReason: due === null ? `No value for anchor ${step.anchor}` : tooLate ? 'Scheduled time had already passed when enrolled' : null,
          dueAt,
          nextAttemptAt: dueAt,
          subjectRevision: ctx.revision,
          createdAt: now.toISOString()
        })
        .execute();
    }
    created++;
  }
  return created;
}

export async function processOutbox(deps: AppDeps, limit: number) {
  const now = deps.clock.now();
  const claimed = await deps.db.transaction().execute(async trx => {
    const rows = await trx
      .selectFrom('outboxEvents')
      .select('id')
      .where(eb => eb.or([
        eb.and([eb('status', '=', 'pending'), eb('availableAt', '<=', now.toISOString())]),
        eb.and([eb('status', '=', 'processing'), eb('lockedUntil', '<', now.toISOString())])
      ]))
      .orderBy('id')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    if (!rows.length) return [];
    return trx
      .updateTable('outboxEvents')
      .set({ status: 'processing', lockedUntil: new Date(now.getTime() + 5 * MINUTE).toISOString(), attempts: sql`attempts + 1` })
      .where('id', 'in', rows.map(row => row.id))
      .returning(['id', 'eventType', 'subjectType', 'subjectId', 'payload', 'occurredAt', 'attempts'])
      .execute();
  });
  const settings = await getSettings(deps.db, { fresh: true });
  let processed = 0;
  for (const event of claimed.sort((a, b) => a.id - b.id)) {
    try {
      await deps.db.transaction().execute(async trx => {
        await cancelRunsForEvent(trx, event, deps.clock.now());
        await enroll(trx, deps, event, settings);
        await trx.updateTable('outboxEvents').set({ status: 'processed', processedAt: deps.clock.now().toISOString(), lockedUntil: null, lastError: null }).where('id', '=', event.id).execute();
      });
      processed++;
    } catch (error) {
      const failed = event.attempts >= MAX_EVENT_ATTEMPTS;
      await deps.db
        .updateTable('outboxEvents')
        .set({
          status: failed ? 'failed' : 'pending',
          lockedUntil: null,
          lastError: (error as Error).message.slice(0, 1000),
          availableAt: new Date(deps.clock.now().getTime() + Math.min(2 ** event.attempts * 30_000, HOUR)).toISOString()
        })
        .where('id', '=', event.id)
        .execute();
      deps.log.error({ err: error, eventId: event.id }, 'Outbox event failed');
    }
  }
  return processed;
}

// ------------------------------------------------------------------------------------- steps

type StepOutcome =
  | { kind: 'succeeded'; result?: Record<string, unknown>; deliveryIds?: string[] }
  | { kind: 'skipped'; reason: string }
  | { kind: 'cancel_run'; reason: string }
  | { kind: 'hold'; until: Date; reason: string }
  | { kind: 'awaiting_approval' };

async function resolveAssignee(db: Executor, mode: string, ctx: SubjectContext) {
  if (mode === 'unassigned') return null;
  if ((mode === 'assignee' || mode === 'assignee_or_owner') && ctx.assigneeStaffId) {
    const staff = await db.selectFrom('staffMembers').select(['id', 'status']).where('id', '=', ctx.assigneeStaffId).executeTakeFirst();
    if (staff?.status === 'active') return staff.id;
  }
  if (mode === 'assignee') return null;
  const owner = await db.selectFrom('staffMembers').select('id').where('role', '=', 'owner').where('status', '=', 'active').orderBy('createdAt').executeTakeFirst();
  return owner?.id ?? null;
}

async function staffRecipients(db: Executor, mode: string, ctx: SubjectContext, settings: AgencySettings): Promise<DeliveryRecipient[]> {
  if (mode === 'notification_inbox' && settings.notificationEmail) return [{ type: 'staff', id: null, email: settings.notificationEmail }];
  if (mode === 'assignee' && ctx.assigneeStaffId) {
    const staff = await db.selectFrom('staffMembers').select(['id', 'email', 'status']).where('id', '=', ctx.assigneeStaffId).executeTakeFirst();
    if (staff?.status === 'active') return [{ type: 'staff', id: staff.id, email: staff.email }];
  }
  const owners = await db.selectFrom('staffMembers').select(['id', 'email']).where('role', '=', 'owner').where('status', '=', 'active').execute();
  return owners.map(owner => ({ type: 'staff' as const, id: owner.id, email: owner.email }));
}

/** Per-person daily digest: only staff who opted in and have something due. */
async function digestDeliveries(trx: Tx, deps: AppDeps, step: { id: string; runId: string }, ctx: SubjectContext, now: Date) {
  const staff = await trx.selectFrom('staffMembers').select(['id', 'email', 'displayName', 'notificationPreferences', 'role']).where('status', '=', 'active').where('role', 'in', ['owner', 'coordinator']).execute();
  const ids: string[] = [];
  for (const member of staff) {
    if ((member.notificationPreferences as { dailyDigest?: boolean })?.dailyDigest === false) continue;
    const endOfDay = DateTime.fromJSDate(now, { zone: (await getSettings(trx)).timezone }).endOf('day').toJSDate().toISOString();
    const due = await trx.selectFrom('tasks').select(['title', 'dueAt']).where('assignedStaffId', '=', member.id).where('status', 'in', ['open', 'in_progress']).where('dueAt', '<=', endOfDay).orderBy('dueAt').limit(50).execute();
    if (!due.length) continue;
    const overdue = due.filter(task => task.dueAt && task.dueAt < now.toISOString()).length;
    const delivery = await createDelivery(trx, {
      idempotencyKey: `${step.runId}:${step.id}:${member.id}`,
      templateKey: 'staff.daily_digest',
      category: 'staff_notification',
      recipient: { type: 'staff', id: member.id, email: member.email },
      variables: {
        ...ctx.variables,
        'digest.taskCount': due.length,
        'digest.overdueCount': overdue,
        'digest.summary': `${due.length} task${due.length === 1 ? '' : 's'} due today${overdue ? `, ${overdue} overdue` : ''}:\n${due.slice(0, 15).map(task => `- ${task.title}`).join('\n')}`,
        'links.tasks': `${deps.config.STAFF_APP_URL.replace(/\/$/, '')}/tasks`
      },
      stepExecutionId: step.id,
      logCommunication: false,
      now
    });
    ids.push(delivery.id);
  }
  return ids;
}

async function sendStepEmail(
  trx: Tx,
  deps: AppDeps,
  input: { stepRow: { id: string; runId: string; subjectRevision: number | null }; step: StepT & { template: string }; recipient: DeliveryRecipient; ctx: SubjectContext; now: Date }
) {
  return createDelivery(trx, {
    idempotencyKey: `${input.stepRow.runId}:${input.step.key}:${input.recipient.id ?? input.recipient.email}:${input.stepRow.subjectRevision ?? 0}`,
    templateKey: input.step.template,
    recipient: input.recipient,
    variables: input.ctx.variables,
    stepExecutionId: input.stepRow.id,
    links: input.ctx.commLinks,
    now: input.now
  });
}

async function runAction(
  trx: Tx,
  deps: AppDeps,
  stepRow: { id: string; runId: string; subjectRevision: number | null; dueAt: string; approvedBy: string | null },
  step: StepT,
  definition: WorkflowDefinitionT,
  ctx: SubjectContext,
  settings: AgencySettings,
  now: Date
): Promise<StepOutcome> {
  const calendar = calendarOf(settings);
  const meta = systemMeta('workflow', now, `workflow:${stepRow.runId}`);
  switch (step.action) {
    case 'create_task':
    case 'schedule_follow_up': {
      const assignedStaffId = await resolveAssignee(trx, step.assignTo, ctx);
      const task = await createTask(trx, meta, {
        title: step.title,
        description: step.description ?? null,
        kind: step.kind,
        priority: step.priority,
        dueAt: addDelay(now, step.dueIn, calendar).toISOString(),
        assignedStaffId,
        sourceStepExecutionId: stepRow.id,
        ...ctx.taskLinks
      });
      return { kind: 'succeeded', result: { taskId: task.id } };
    }
    case 'notify_staff': {
      if (step.recipients === 'digest_subscribers') {
        const ids = await digestDeliveries(trx, deps, stepRow, ctx, now);
        return { kind: 'succeeded', result: { deliveries: ids.length }, deliveryIds: ids };
      }
      const recipients = await staffRecipients(trx, step.recipients, ctx, settings);
      const ids: string[] = [];
      for (const recipient of recipients) {
        const delivery = await createDelivery(trx, {
          idempotencyKey: `${stepRow.runId}:${step.key}:${recipient.id ?? recipient.email}:${stepRow.subjectRevision ?? 0}`,
          templateKey: step.template,
          category: 'staff_notification',
          recipient,
          variables: ctx.variables,
          stepExecutionId: stepRow.id,
          logCommunication: false,
          now
        });
        ids.push(delivery.id);
      }
      return { kind: 'succeeded', result: { deliveries: ids.length }, deliveryIds: ids };
    }
    case 'send_email':
    case 'request_information': {
      const recipientKey = step.action === 'send_email' ? step.recipient : 'candidate';
      const recipient = ctx.recipients[recipientKey];
      if (!recipient) return { kind: 'skipped', reason: `No ${recipientKey.replace('_', ' ')} email on record` };
      if (ctx.isTest && !deps.config.isTest) return { kind: 'skipped', reason: 'Test record: external email not sent' };
      if (step.action === 'send_email' && step.respectQuietHours) {
        const release = outsideQuietHours(now, calendar);
        if (release.getTime() > now.getTime()) return { kind: 'hold', until: release, reason: 'Quiet hours' };
      }
      if (definition.frequencyCap) {
        const since = new Date(now.getTime() - definition.frequencyCap.perDays * 24 * HOUR).toISOString();
        const recent = await trx.selectFrom('deliveries').select(eb => eb.fn.countAll<number>().as('n')).where('toAddress', '=', recipient.email.toLowerCase()).where('category', '=', 'outreach').where('createdAt', '>=', since).executeTakeFirstOrThrow();
        if (Number(recent.n) >= definition.frequencyCap.maxExternalMessages) return { kind: 'skipped', reason: 'Frequency cap reached' };
      }
      if (step.approval === 'required' && !stepRow.approvedBy) return { kind: 'awaiting_approval' };
      const delivery = await sendStepEmail(trx, deps, { stepRow, step: step as StepT & { template: string }, recipient, ctx, now });
      if (step.action === 'request_information') {
        const assignedStaffId = await resolveAssignee(trx, 'assignee_or_owner', ctx);
        await createTask(trx, meta, {
          title: 'Check requested information was received',
          kind: 'follow_up',
          dueAt: addDelay(now, step.deadlineIn, calendar).toISOString(),
          assignedStaffId,
          sourceStepExecutionId: stepRow.id,
          ...ctx.taskLinks
        });
      }
      return { kind: 'succeeded', result: { deliveryId: delivery.id }, deliveryIds: [delivery.id] };
    }
    case 'generate_draft_presentation': {
      const jobCandidateId = ctx.taskLinks.jobCandidateId;
      if (!jobCandidateId) return { kind: 'skipped', reason: 'No candidate-job association' };
      const jc = await trx.selectFrom('jobCandidates as jc').innerJoin('jobOrders as j', 'j.id', 'jc.jobOrderId').select(['jc.jobOrderId', 'jc.candidateId', 'j.familyId', 'j.title']).where('jc.id', '=', jobCandidateId).executeTakeFirstOrThrow();
      const existing = await trx.selectFrom('presentationCandidates as pc').innerJoin('presentations as p', 'p.id', 'pc.presentationId').select('p.id').where('pc.jobCandidateId', '=', jobCandidateId).where('p.status', 'in', ['draft', 'approved']).executeTakeFirst();
      if (existing) return { kind: 'skipped', reason: 'A draft presentation already exists' };
      const presentation = await trx.insertInto('presentations').values({ reference: await uniqueReference(trx, 'presentations', 'R'), jobOrderId: jc.jobOrderId, familyId: jc.familyId, title: `Candidates for ${jc.title}`, createdAt: now.toISOString() }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('presentationCandidates').values({ presentationId: presentation.id, jobOrderId: jc.jobOrderId, jobCandidateId, candidateId: jc.candidateId, includedFields: DEFAULT_FIELDS }).execute();
      return { kind: 'succeeded', result: { presentationId: presentation.id } };
    }
    default:
      return { kind: 'skipped', reason: 'Unsupported action' };
  }
}

async function isPaused(db: Executor, ctx: SubjectContext) {
  if (!ctx.related.length) return false;
  const pairs = ctx.related;
  const row = await db
    .selectFrom('automationPauses')
    .select('id')
    .where('releasedAt', 'is', null)
    .where(eb => eb.or(pairs.map(({ type, id }) => eb.and([eb('subjectType', '=', type), eb('subjectId', '=', id)]))))
    .executeTakeFirst();
  return Boolean(row);
}

function backoff(attempt: number) {
  const base = Math.min(30_000 * 2 ** (attempt - 1), HOUR);
  return base + Math.floor(Math.random() * base * 0.25);
}

export async function executeSteps(deps: AppDeps, limit: number, options: { stepIds?: string[] } = {}) {
  const now = deps.clock.now();
  const claimed = await deps.db.transaction().execute(async trx => {
    let q = trx
      .selectFrom('workflowStepExecutions')
      .select('id')
      .where(eb => eb.or([
        eb.and([eb('status', '=', 'scheduled'), eb('nextAttemptAt', '<=', now.toISOString())]),
        eb.and([eb('status', '=', 'running'), eb('lockedUntil', '<', now.toISOString())])
      ]))
      .orderBy('nextAttemptAt')
      .limit(limit)
      .forUpdate()
      .skipLocked();
    if (options.stepIds?.length) q = q.where('id', 'in', options.stepIds);
    const rows = await q.execute();
    if (!rows.length) return [];
    return trx
      .updateTable('workflowStepExecutions')
      .set({ status: 'running', lockedUntil: new Date(now.getTime() + STEP_LEASE_MS).toISOString(), attempts: sql`attempts + 1`, startedAt: sql`coalesce(started_at, ${now.toISOString()}::timestamptz)` })
      .where('id', 'in', rows.map(row => row.id))
      .returning(['id', 'runId', 'stepKey', 'stepIndex', 'action', 'dueAt', 'attempts', 'subjectRevision', 'approvedBy'])
      .execute();
  });

  const settings = await getSettings(deps.db, { fresh: true });
  const toDispatch: string[] = [];
  let executed = 0;
  for (const stepRow of claimed) {
    try {
      const deliveryIds = await deps.db.transaction().execute(async trx => {
        const run = await trx
          .selectFrom('workflowRuns as r')
          .innerJoin('workflowVersions as v', 'v.id', 'r.workflowVersionId')
          .innerJoin('workflowDefinitions as w', 'w.id', 'r.workflowId')
          .select(['r.id', 'r.status', 'r.subjectType', 'r.subjectId', 'r.context', 'v.definition', 'w.enabled', 'w.key'])
          .where('r.id', '=', stepRow.runId)
          .executeTakeFirstOrThrow();
        const finish = async (status: string, values: Record<string, unknown> = {}) => {
          await trx.updateTable('workflowStepExecutions').set({ status, lockedUntil: null, finishedAt: deps.clock.now().toISOString(), ...values }).where('id', '=', stepRow.id).execute();
        };
        const hold = async (until: Date, reason: string) => {
          await trx.updateTable('workflowStepExecutions').set({ status: 'scheduled', lockedUntil: null, nextAttemptAt: until.toISOString(), attempts: sql`greatest(attempts - 1, 0)`, lastError: reason }).where('id', '=', stepRow.id).execute();
        };
        if (run.status !== 'active') {
          await finish('cancelled', { skipReason: `Run ${run.status}` });
          return [];
        }
        if (!run.enabled) {
          await cancelRun(trx, run.id, 'Workflow turned off', now, null);
          return [];
        }
        if (settings.automationPaused) {
          await hold(new Date(now.getTime() + 15 * MINUTE), 'Automation paused');
          return [];
        }
        const definition = WorkflowDefinition.parse(run.definition);
        const step = definition.steps.find(s => s.key === stepRow.stepKey);
        if (!step) {
          await finish('skipped', { skipReason: 'Step not in this workflow version' });
          return [];
        }
        const ctx = await loadSubject(deps, trx, run.subjectType, run.subjectId);
        if (!ctx) {
          await cancelRun(trx, run.id, 'The record no longer exists', now, null);
          return [];
        }
        if (await isPaused(trx, ctx)) {
          await hold(new Date(now.getTime() + 15 * MINUTE), 'Paused for this record');
          return [];
        }
        if (definition.stopWhen.length && evaluateConditions(definition.stopWhen, ctx.fields, 'any')) {
          await cancelRun(trx, run.id, 'Stop condition met', now, null);
          return [];
        }
        const runRevision = (run.context as { revision?: number | null }).revision ?? null;
        if (runRevision !== null && ctx.revision !== runRevision) {
          await cancelRun(trx, run.id, `Superseded: appointment revision ${runRevision} is no longer current`, now, null);
          return [];
        }
        if (step.skipIf.length && evaluateConditions(step.skipIf, ctx.fields, 'any')) {
          await finish('skipped', { skipReason: 'Skip condition met' });
          return [];
        }
        if (isExternal(step) && now.getTime() - new Date(stepRow.dueAt).getTime() > settings.staleMessageHours * HOUR) {
          await finish('skipped', { skipReason: `Stale: more than ${settings.staleMessageHours} hours overdue` });
          return [];
        }
        const outcome = await runAction(trx, deps, stepRow, step, definition, ctx, settings, now);
        switch (outcome.kind) {
          case 'succeeded':
            await finish('succeeded', { result: JSON.stringify(outcome.result ?? {}), lastError: null });
            break;
          case 'skipped':
            await finish('skipped', { skipReason: outcome.reason });
            break;
          case 'cancel_run':
            await cancelRun(trx, run.id, outcome.reason, now, null);
            break;
          case 'hold':
            await hold(outcome.until, outcome.reason);
            break;
          case 'awaiting_approval': {
            await trx.updateTable('workflowStepExecutions').set({ status: 'awaiting_approval', lockedUntil: null }).where('id', '=', stepRow.id).execute();
            const assignedStaffId = await resolveAssignee(trx, 'assignee_or_owner', ctx);
            await createTask(trx, systemMeta('workflow', now), {
              title: `Approve message: ${run.key} / ${step.key}`,
              description: 'An automated email is waiting for approval. Review it in Automation → Approvals before it is sent.',
              kind: 'review',
              dueAt: now.toISOString(),
              assignedStaffId,
              ...ctx.taskLinks
            });
            break;
          }
        }
        await completeRunIfDone(trx, run.id, now);
        return outcome.kind === 'succeeded' ? outcome.deliveryIds ?? [] : [];
      });
      toDispatch.push(...deliveryIds);
      executed++;
    } catch (error) {
      const permanent = error instanceof TemplateMissingError || stepRow.attempts >= MAX_STEP_ATTEMPTS;
      await deps.db
        .updateTable('workflowStepExecutions')
        .set(permanent
          ? { status: 'action_needed', lockedUntil: null, lastError: (error as Error).message.slice(0, 1000) }
          : { status: 'scheduled', lockedUntil: null, lastError: (error as Error).message.slice(0, 1000), nextAttemptAt: new Date(now.getTime() + backoff(stepRow.attempts)).toISOString() })
        .where('id', '=', stepRow.id)
        .execute();
      if (permanent) await attentionTask(deps, stepRow.id, (error as Error).message, now);
      deps.log.warn({ err: error, stepId: stepRow.id }, 'Workflow step failed');
    }
  }
  if (toDispatch.length) await dispatchDeliveries(deps, { ids: toDispatch, limit: toDispatch.length }).catch(error => deps.log.warn({ err: error }, 'Dispatch deferred to next tick'));
  return executed;
}

async function attentionTask(deps: AppDeps, stepId: string, error: string, now: Date) {
  const owner = await deps.db.selectFrom('staffMembers').select('id').where('role', '=', 'owner').where('status', '=', 'active').orderBy('createdAt').executeTakeFirst();
  await createTask(deps.db, systemMeta('workflow', now), {
    title: 'Automation step needs attention',
    description: `A workflow step failed and was not retried further. Review it in Automation and retry or skip it.\nError: ${error.slice(0, 300)}`,
    kind: 'action_needed',
    priority: 'high',
    dueAt: now.toISOString(),
    assignedStaffId: owner?.id ?? null
  }).catch(() => undefined);
}

async function completeRunIfDone(db: Executor, runId: string, now: Date) {
  const open = await db.selectFrom('workflowStepExecutions').select('id').where('runId', '=', runId).where('status', 'in', ['scheduled', 'running', 'awaiting_approval', 'action_needed']).executeTakeFirst();
  if (!open) await db.updateTable('workflowRuns').set({ status: 'completed', finishedAt: now.toISOString() }).where('id', '=', runId).where('status', '=', 'active').execute();
}

/** Staff approval of an awaiting external message: sends it now (or at the next allowed time). */
export async function approveStep(deps: AppDeps, stepId: string, staffId: string) {
  const now = deps.clock.now();
  const updated = await deps.db
    .updateTable('workflowStepExecutions')
    .set({ status: 'scheduled', approvedBy: staffId, approvedAt: now.toISOString(), nextAttemptAt: now.toISOString(), dueAt: now.toISOString(), attempts: 0 })
    .where('id', '=', stepId)
    .where('status', '=', 'awaiting_approval')
    .returning('id')
    .executeTakeFirst();
  if (!updated) return false;
  await audit(deps.db, systemMeta('workflow', now), { action: 'workflow.step_approved', subjectType: 'workflow_step', subjectId: stepId, metadata: { staffId } });
  await executeSteps(deps, 1, { stepIds: [stepId] });
  return true;
}

export async function rejectStep(deps: AppDeps, stepId: string, staffId: string, reason: string) {
  const now = deps.clock.now();
  const row = await deps.db
    .updateTable('workflowStepExecutions')
    .set({ status: 'skipped', skipReason: `Rejected: ${reason}`, finishedAt: now.toISOString(), approvedBy: staffId, approvedAt: now.toISOString() })
    .where('id', '=', stepId)
    .where('status', '=', 'awaiting_approval')
    .returning('runId')
    .executeTakeFirst();
  if (!row) return false;
  await completeRunIfDone(deps.db, row.runId, now);
  await audit(deps.db, systemMeta('workflow', now), { action: 'workflow.step_rejected', subjectType: 'workflow_step', subjectId: stepId, metadata: { staffId } });
  return true;
}

export async function retryStep(deps: AppDeps, stepId: string) {
  const now = deps.clock.now();
  const row = await deps.db
    .updateTable('workflowStepExecutions')
    .set({ status: 'scheduled', attempts: 0, nextAttemptAt: now.toISOString(), dueAt: now.toISOString(), lastError: null, finishedAt: null })
    .where('id', '=', stepId)
    .where('status', 'in', ['action_needed', 'failed'])
    .returning('id')
    .executeTakeFirst();
  if (!row) return false;
  await executeSteps(deps, 1, { stepIds: [stepId] });
  return true;
}

/** Dry run: which enabled workflows would enroll for a subject now, and when each step would run. */
export async function previewEnrollment(deps: AppDeps, definitionInput: unknown, triggerEvent: string, subjectId: string | null) {
  const definition = WorkflowDefinition.parse(definitionInput);
  const trigger = triggerFor(triggerEvent);
  if (!trigger) return { matches: false, reason: 'Unknown trigger', steps: [] };
  const ctx = await loadSubject(deps, deps.db, trigger.subject, subjectId);
  if (!ctx) return { matches: false, reason: 'Record not found', steps: [] };
  const settings = await getSettings(deps.db);
  const calendar = calendarOf(settings);
  const now = deps.clock.now();
  const matches = evaluateConditions(definition.conditions, ctx.fields);
  return {
    matches,
    reason: matches ? null : 'Conditions not met',
    fields: ctx.fields,
    recipients: Object.fromEntries(Object.entries(ctx.recipients).map(([key, value]) => [key, value ? value.email.replace(/^(.).*(@.*)$/, '$1***$2') : null])),
    steps: definition.steps.map(step => {
      const due = stepDueAt(step, now, ctx, calendar);
      return { key: step.key, action: step.action, dueAt: due ? (isExternal(step) && 'respectQuietHours' in step && step.respectQuietHours ? outsideQuietHours(due, calendar) : due).toISOString() : null };
    })
  };
}
