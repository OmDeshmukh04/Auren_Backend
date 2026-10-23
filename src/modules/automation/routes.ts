import { sql } from 'kysely';
import { z } from 'zod';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { DateOnly, Email, Id, IdParams, Ok, PageQuery, Timestamp, Version, pageOf, queryList } from '../../http/schemas.js';
import type { Executor } from '../../db/index.js';
import { conflict, notFound, unauthorized, unprocessable, validationFailed } from '../../http/errors.js';
import { audit } from '../../domain/audit.js';
import { emit, EVENT_TYPES } from '../../domain/outbox.js';
import { invalidateSettings } from '../../domain/settings.js';
import { assertInScope, pageArgs, updateVersioned } from '../../domain/records.js';
import { runnerTick } from './runner.js';
import { approveStep, cancelRun, previewEnrollment, rejectStep, retryStep } from './engine.js';
import { TRIGGERS, WorkflowDefinition } from './definition.js';
import { COMMON_VARIABLES, loadSubject, SUBJECT_VARIABLES } from './subjects.js';
import { assertTemplateVariables, placeholdersIn, publishedTemplate, render, renderSubject } from './templates.js';
import { dispatchDeliveries, shouldApplyStatus } from './deliveries.js';

const WorkflowSummary = z
  .object({
    id: Id, key: z.string(), name: z.string(), description: z.string().nullable(), category: z.string(), triggerEvent: z.string(),
    enabled: z.boolean(), system: z.boolean(), currentVersionId: Id.nullable(), currentVersionNumber: z.int().nullable(), statusReason: z.string().nullable(),
    activeRuns: z.int(), version: Version, updatedAt: Timestamp
  })
  .meta({ id: 'WorkflowSummary' });

const WorkflowVersion = z
  .object({ id: Id, workflowId: Id, versionNumber: z.int(), status: z.enum(['draft', 'published', 'archived']), definition: WorkflowDefinition, changeNote: z.string().nullable(), publishedAt: Timestamp.nullable(), createdAt: Timestamp })
  .meta({ id: 'WorkflowVersion' });

const Step = z
  .object({
    id: Id, runId: Id, stepKey: z.string(), stepIndex: z.int(), action: z.string(),
    status: z.enum(['scheduled', 'running', 'awaiting_approval', 'succeeded', 'skipped', 'failed', 'cancelled', 'action_needed']),
    dueAt: Timestamp, nextAttemptAt: Timestamp, attempts: z.int(), skipReason: z.string().nullable(), lastError: z.string().nullable(), result: z.unknown(),
    approvedBy: Id.nullable(), approvedAt: Timestamp.nullable(), finishedAt: Timestamp.nullable()
  })
  .meta({ id: 'WorkflowStep' });

const Run = z
  .object({ id: Id, workflowId: Id, workflowKey: z.string(), workflowName: z.string(), versionNumber: z.int(), subjectType: z.string(), subjectId: Id.nullable(), status: z.enum(['active', 'completed', 'cancelled', 'failed']), cancelReason: z.string().nullable(), startedAt: Timestamp, finishedAt: Timestamp.nullable() })
  .meta({ id: 'WorkflowRun' });

const Delivery = z
  .object({
    id: Id, category: z.string(), templateKey: z.string().nullable(), recipientType: z.string(), toAddress: z.string(), subject: z.string(),
    status: z.string(), attempts: z.int(), lastError: z.string().nullable(), providerMessageId: z.string().nullable(), acceptedAt: Timestamp.nullable(),
    deliveredAt: Timestamp.nullable(), createdAt: Timestamp, stepExecutionId: Id.nullable()
  })
  .meta({ id: 'Delivery', description: 'provider_accepted means the provider took the message; delivered/bounced come from webhooks. Neither proves a reply.' });

const Template = z
  .object({ id: Id, key: z.string(), name: z.string(), description: z.string().nullable(), category: z.string(), allowedVariables: z.array(z.string()), system: z.boolean(), currentVersionId: Id.nullable(), subject: z.string().nullable(), bodyText: z.string().nullable(), currentVersionNumber: z.int().nullable(), version: Version })
  .meta({ id: 'EmailTemplate' });
const TemplateVersion = z
  .object({ id: Id, templateId: Id, versionNumber: z.int(), status: z.enum(['draft', 'published', 'archived']), subject: z.string(), bodyText: z.string(), publishedAt: Timestamp.nullable(), createdAt: Timestamp })
  .meta({ id: 'EmailTemplateVersion' });

const InformationRequest = z
  .object({ id: Id, candidateId: Id, items: z.array(z.object({ key: z.string(), label: z.string(), status: z.enum(['requested', 'received', 'waived']) })), message: z.string().nullable(), status: z.enum(['open', 'received', 'cancelled']), deadlineOn: DateOnly.nullable(), createdAt: Timestamp, resolvedAt: Timestamp.nullable(), version: Version })
  .meta({ id: 'InformationRequest' });

const SAMPLE_VARIABLES: Record<string, string> = {
  'agency.name': 'Auren Households', 'agency.replyTo': 'hello@example.invalid', 'contact.firstName': 'Alex', 'family.displayName': 'Sample family',
  'enquiry.reference': 'E-SAMPLE01', 'enquiry.serviceLabel': 'Nanny placement', 'candidate.firstName': 'Jordan', 'candidate.fullName': 'Jordan Sample',
  'application.reference': 'A-SAMPLE01', 'appointment.when': 'Tuesday, November 3 at 10:00 AM MST', 'appointment.location': 'video call',
  'appointment.title': 'Consultation', 'reference.fullName': 'Pat Reference', 'qualification.label': 'CPR certification', 'qualification.expiresOn': 'November 30, 2026',
  'job.title': 'Full-time nanny', 'presentation.reference': 'R-SAMPLE01', 'placement.startDate': 'December 1, 2026', 'placement.reference': 'P-SAMPLE01',
  'placement.guaranteeEndsOn': 'March 1, 2027', 'request.items': '- Current CPR certificate', 'request.message': 'Thank you!', 'request.deadline': 'November 6, 2026',
  'digest.summary': '3 tasks due today', 'digest.taskCount': '3', 'digest.overdueCount': '0', 'staff.displayName': 'Sam Staff'
};

function variablesForTrigger(event: string) {
  const trigger = TRIGGERS.find(t => t.event === event);
  return trigger ? [...COMMON_VARIABLES, ...SUBJECT_VARIABLES[trigger.subject]] : COMMON_VARIABLES;
}

/** Templates used by a workflow definition must exist and only use variables its trigger provides. */
async function validateDefinitionTemplates(db: Executor, definition: z.infer<typeof WorkflowDefinition>, triggerEvent: string) {
  const errors: Array<{ path: string; code: string; message: string }> = [];
  const allowed = new Set(variablesForTrigger(triggerEvent));
  for (const [index, step] of definition.steps.entries()) {
    if (!('template' in step)) continue;
    const template = await db
      .selectFrom('emailTemplates as t')
      .leftJoin('emailTemplateVersions as v', 'v.id', 't.currentVersionId')
      .select(['t.key', 'v.subject', 'v.bodyText', 't.category'])
      .where('t.key', '=', step.template)
      .executeTakeFirst();
    if (!template?.subject) {
      errors.push({ path: `steps.${index}.template`, code: 'invalid', message: `Template "${step.template}" has no published version` });
      continue;
    }
    const unknown = [...placeholdersIn(template.subject), ...placeholdersIn(template.bodyText ?? '')].filter(name => !allowed.has(name) && !name.startsWith('digest.') && !name.startsWith('links.tasks'));
    if (unknown.length) errors.push({ path: `steps.${index}.template`, code: 'unavailable_variables', message: `This trigger cannot provide: ${unknown.join(', ')}` });
    if (step.action === 'notify_staff' && template.category !== 'staff_notification') errors.push({ path: `steps.${index}.template`, code: 'invalid', message: 'Staff notifications need a staff notification template' });
  }
  if (errors.length) throw validationFailed(errors);
}

export const automationRoutes: AnyRoute[] = [
  // ---------------------------------------------------------------- runner & webhooks
  ...(['GET', 'POST'] as const).map(method =>
    defineRoute({
      method,
      path: '/internal/runner/tick',
      operationId: method === 'GET' ? 'runnerTickGet' : 'runnerTick',
      summary: 'Run one bounded automation pass (scheduler only)',
      description: 'Called every minute by the scheduler with Authorization: Bearer CRON_SECRET. Safe to call concurrently.',
      tags: ['Automation'],
      access: { kind: 'cron' },
      response: z.object({ events: z.int(), steps: z.int(), deliveries: z.record(z.string(), z.int()), scans: z.record(z.string(), z.int()).nullable(), durationMs: z.int() }).meta({ id: 'RunnerTickResult' }),
      async handler({ deps }) {
        return runnerTick(deps);
      }
    })
  ),
  defineRoute({
    method: 'POST',
    path: '/webhooks/resend',
    operationId: 'resendWebhook',
    summary: 'Email provider delivery events (signature-verified)',
    tags: ['Automation'],
    access: { kind: 'webhook' },
    response: z.object({ received: z.int(), duplicates: z.int() }),
    async handler({ deps, req, rawBody, meta }) {
      const events = rawBody && deps.email.parseWebhook ? deps.email.parseWebhook(rawBody, req.headers, deps.clock.now().getTime()) : null;
      if (!events) throw unauthorized('Invalid webhook signature.', 'invalid_signature');
      let received = 0;
      let duplicates = 0;
      for (const event of events) {
        await deps.db.transaction().execute(async trx => {
          const receipt = await trx
            .insertInto('webhookReceipts')
            .values({ provider: deps.email.name, providerEventId: event.providerEventId, eventType: event.rawType, occurredAt: event.occurredAt, status: 'ignored', receivedAt: meta.now.toISOString() })
            .onConflict(oc => oc.columns(['provider', 'providerEventId']).doNothing())
            .returning('id')
            .executeTakeFirst();
          if (!receipt) {
            duplicates++;
            return;
          }
          received++;
          const delivery = event.providerMessageId ? await trx.selectFrom('deliveries').select(['id', 'status', 'toAddress']).where('providerMessageId', '=', event.providerMessageId).forUpdate().executeTakeFirst() : undefined;
          if (!delivery) return;
          const next = { sent: 'provider_accepted', delivered: 'delivered', delayed: 'delayed', bounced: 'bounced', complained: 'complained', failed: 'failed', other: null }[event.type];
          if (next && shouldApplyStatus(delivery.status, next)) {
            await trx
              .updateTable('deliveries')
              .set({ status: next, ...(next === 'delivered' ? { deliveredAt: event.occurredAt ?? meta.now.toISOString() } : {}), ...(['delivered', 'bounced', 'complained', 'failed'].includes(next) ? { finalAt: meta.now.toISOString() } : {}) })
              .where('id', '=', delivery.id)
              .execute();
            await trx.updateTable('communications').set({ status: next }).where('deliveryId', '=', delivery.id).execute();
          }
          if ((event.type === 'bounced' && event.permanentBounce) || event.type === 'complained') {
            await trx
              .insertInto('emailSuppressions')
              .values({ email: delivery.toAddress, scope: 'all', reason: event.type === 'complained' ? 'complaint' : 'hard_bounce', createdAt: meta.now.toISOString() })
              .onConflict(oc => oc.column('email').doNothing())
              .execute();
          }
          await trx.updateTable('webhookReceipts').set({ status: 'processed', deliveryId: delivery.id }).where('id', '=', receipt.id).execute();
        });
      }
      return { received, duplicates };
    }
  }),

  // ---------------------------------------------------------------- status & pause
  defineRoute({
    method: 'GET',
    path: '/automation/status',
    operationId: 'getAutomationStatus',
    summary: 'Automation health: pause state, backlog, runner heartbeat and items needing attention',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.read' },
    response: z
      .object({
        paused: z.boolean(), pausedReason: z.string().nullable(), pausedAt: Timestamp.nullable(),
        oldestPendingEventAt: Timestamp.nullable(), pendingEvents: z.int(), failedEvents: z.int(), overdueSteps: z.int(),
        awaitingApproval: z.int(), actionNeeded: z.int(), failedDeliveries: z.int(), ambiguousDeliveries: z.int(), quarantinedDocuments: z.int(),
        runner: z.object({ lastStartedAt: Timestamp.nullable(), lastFinishedAt: Timestamp.nullable() })
      })
      .meta({ id: 'AutomationStatus' }),
    async handler({ deps }) {
      const now = deps.clock.now().toISOString();
      const [settings, events, steps, deliveries, docs, heartbeat] = await Promise.all([
        deps.db.selectFrom('agencySettings').select(['automationPaused', 'automationPausedReason', 'automationPausedAt']).where('id', '=', 1).executeTakeFirstOrThrow(),
        deps.db.selectFrom('outboxEvents').select([sql<string | null>`min(occurred_at) filter (where status in ('pending','processing'))`.as('oldest'), sql<number>`count(*) filter (where status in ('pending','processing'))::int`.as('pending'), sql<number>`count(*) filter (where status = 'failed')::int`.as('failed')]).executeTakeFirstOrThrow(),
        deps.db.selectFrom('workflowStepExecutions').select([sql<number>`count(*) filter (where status = 'scheduled' and next_attempt_at < ${now}::timestamptz - interval '10 minutes')::int`.as('overdue'), sql<number>`count(*) filter (where status = 'awaiting_approval')::int`.as('approval'), sql<number>`count(*) filter (where status = 'action_needed')::int`.as('attention')]).executeTakeFirstOrThrow(),
        deps.db.selectFrom('deliveries').select([sql<number>`count(*) filter (where status = 'failed')::int`.as('failed'), sql<number>`count(*) filter (where status = 'ambiguous')::int`.as('ambiguous')]).executeTakeFirstOrThrow(),
        deps.db.selectFrom('documents').select(sql<number>`count(*)::int`.as('n')).where('scanStatus', '=', 'quarantined').where('deletedAt', 'is', null).executeTakeFirstOrThrow(),
        deps.db.selectFrom('runnerHeartbeats').select(['lastStartedAt', 'lastFinishedAt']).where('runnerId', '<>', 'scans').orderBy('lastStartedAt', 'desc').executeTakeFirst()
      ]);
      return {
        paused: settings.automationPaused, pausedReason: settings.automationPausedReason, pausedAt: settings.automationPausedAt,
        oldestPendingEventAt: events.oldest ? new Date(events.oldest).toISOString() : null, pendingEvents: events.pending, failedEvents: events.failed,
        overdueSteps: steps.overdue, awaitingApproval: steps.approval, actionNeeded: steps.attention,
        failedDeliveries: deliveries.failed, ambiguousDeliveries: deliveries.ambiguous, quarantinedDocuments: docs.n,
        runner: { lastStartedAt: heartbeat?.lastStartedAt ?? null, lastFinishedAt: heartbeat?.lastFinishedAt ?? null }
      };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/automation/pause',
    operationId: 'setAutomationPaused',
    summary: 'Pause or resume all automation (owner)',
    description: 'While paused, due steps wait. On resume, steps more than the stale-message window overdue are skipped rather than sent late.',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.pause_global' },
    body: z.object({ paused: z.boolean(), reason: z.string().trim().min(3).max(500).optional() }),
    response: Ok,
    async handler({ deps, meta, staff, body }) {
      if (body.paused && !body.reason) throw validationFailed([{ path: 'reason', code: 'required', message: 'Give a reason for pausing' }]);
      await deps.db
        .updateTable('agencySettings')
        .set({ automationPaused: body.paused, automationPausedReason: body.paused ? body.reason! : null, automationPausedAt: body.paused ? meta.now.toISOString() : null, automationPausedBy: body.paused ? staff.staffId : null, version: sql`version + 1` })
        .where('id', '=', 1)
        .execute();
      invalidateSettings(deps.db);
      await audit(deps.db, meta, { action: body.paused ? 'automation.paused' : 'automation.resumed', subjectType: 'agency_settings', subjectId: '1', metadata: { reason: body.reason ?? null } });
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/automation/pauses',
    operationId: 'listRecordPauses',
    summary: 'Active automation pauses for records',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.read' },
    query: z.object({ subjectType: z.enum(['family', 'enquiry', 'candidate', 'job_order', 'placement']).optional(), subjectId: Id.optional() }),
    response: z.object({ items: z.array(z.object({ id: Id, subjectType: z.string(), subjectId: Id, reason: z.string(), pausedBy: Id, pausedAt: Timestamp })) }),
    async handler({ deps, query }) {
      let q = deps.db.selectFrom('automationPauses').select(['id', 'subjectType', 'subjectId', 'reason', 'pausedBy', 'pausedAt']).where('releasedAt', 'is', null);
      if (query.subjectType) q = q.where('subjectType', '=', query.subjectType);
      if (query.subjectId) q = q.where('subjectId', '=', query.subjectId);
      return { items: await q.orderBy('pausedAt', 'desc').execute() };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/automation/pauses',
    operationId: 'pauseRecordAutomation',
    summary: 'Pause automation for one family, enquiry, candidate, job or placement',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.pause_record' },
    body: z.object({ subjectType: z.enum(['family', 'enquiry', 'candidate', 'job_order', 'placement']), subjectId: Id, reason: z.string().trim().min(3).max(500) }),
    response: z.object({ id: Id }),
    status: 201,
    async handler({ deps, meta, staff, body }) {
      const row = await deps.db
        .insertInto('automationPauses')
        .values({ ...body, pausedBy: staff.staffId, pausedAt: meta.now.toISOString() })
        .onConflict(oc => oc.columns(['subjectType', 'subjectId']).where('releasedAt', 'is', null).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) throw conflict('Automation is already paused for this record.', 'already_paused');
      await audit(deps.db, meta, { action: 'automation.record_paused', subjectType: body.subjectType, subjectId: body.subjectId, metadata: { reason: body.reason } });
      return { id: row.id };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/automation/pauses/:id/release',
    operationId: 'releaseRecordPause',
    summary: 'Resume automation for a record',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.pause_record' },
    params: IdParams,
    response: Ok,
    async handler({ deps, meta, staff, params }) {
      const row = await deps.db.updateTable('automationPauses').set({ releasedAt: meta.now.toISOString(), releasedBy: staff.staffId }).where('id', '=', params.id).where('releasedAt', 'is', null).returning(['subjectType', 'subjectId']).executeTakeFirst();
      if (!row) throw notFound('Active pause');
      await audit(deps.db, meta, { action: 'automation.record_resumed', subjectType: row.subjectType, subjectId: row.subjectId });
      return { ok: true as const };
    }
  }),

  // ---------------------------------------------------------------- workflows
  defineRoute({
    method: 'GET',
    path: '/automation/triggers',
    operationId: 'listWorkflowTriggers',
    summary: 'Triggers, condition fields, template variables and actions available to the workflow editor',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.read' },
    response: z.object({ triggers: z.array(z.object({ event: z.string(), subject: z.string(), description: z.string(), variables: z.array(z.string()) })), actions: z.array(z.string()), stopEvents: z.array(z.string()) }).meta({ id: 'WorkflowCatalogue' }),
    async handler() {
      return {
        triggers: TRIGGERS.map(t => ({ ...t, variables: [...COMMON_VARIABLES, ...SUBJECT_VARIABLES[t.subject]] })),
        actions: ['create_task', 'schedule_follow_up', 'notify_staff', 'send_email', 'request_information', 'generate_draft_presentation'],
        stopEvents: [...EVENT_TYPES]
      };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/automation/workflows',
    operationId: 'listWorkflows',
    summary: 'Workflows',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.read' },
    response: z.object({ items: z.array(WorkflowSummary) }),
    async handler({ deps }) {
      const rows = await deps.db
        .selectFrom('workflowDefinitions as w')
        .leftJoin('workflowVersions as v', 'v.id', 'w.currentVersionId')
        .selectAll('w')
        .select(['v.versionNumber as currentVersionNumber', sql<number>`(select count(*)::int from workflow_runs r where r.workflow_id = w.id and r.status = 'active')`.as('activeRuns')])
        .orderBy('w.category')
        .orderBy('w.name')
        .execute();
      return { items: rows };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/automation/workflows/:id',
    operationId: 'getWorkflow',
    summary: 'Workflow with version history',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.read' },
    params: IdParams,
    response: z.object({ workflow: WorkflowSummary, versions: z.array(WorkflowVersion) }),
    async handler({ deps, params }) {
      const workflow = await deps.db
        .selectFrom('workflowDefinitions as w')
        .leftJoin('workflowVersions as v', 'v.id', 'w.currentVersionId')
        .selectAll('w')
        .select(['v.versionNumber as currentVersionNumber', sql<number>`(select count(*)::int from workflow_runs r where r.workflow_id = w.id and r.status = 'active')`.as('activeRuns')])
        .where('w.id', '=', params.id)
        .executeTakeFirst();
      if (!workflow) throw notFound('Workflow');
      const versions = await deps.db.selectFrom('workflowVersions').selectAll().where('workflowId', '=', params.id).orderBy('versionNumber', 'desc').execute();
      return { workflow, versions: versions.map(v => ({ ...v, definition: WorkflowDefinition.parse(v.definition) })) } as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/automation/workflows',
    operationId: 'createWorkflow',
    summary: 'Create a workflow with a draft first version',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.write' },
    body: z.object({
      key: z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(1000).nullable().optional(),
      category: z.enum(['transactional', 'follow_up', 'staff', 'scheduled']),
      triggerEvent: z.enum(TRIGGERS.map(t => t.event) as [string, ...string[]]),
      definition: WorkflowDefinition
    }),
    response: z.object({ workflowId: Id, versionId: Id }),
    status: 201,
    async handler({ deps, meta, staff, body }) {
      return deps.db.transaction().execute(async trx => {
        const workflow = await trx.insertInto('workflowDefinitions').values({ key: body.key, name: body.name, description: body.description ?? null, category: body.category, triggerEvent: body.triggerEvent, changedBy: staff.staffId, changedAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
        const version = await trx.insertInto('workflowVersions').values({ workflowId: workflow.id, versionNumber: 1, definition: JSON.stringify(body.definition), createdBy: staff.staffId, createdAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
        await audit(trx, meta, { action: 'workflow.created', subjectType: 'workflow', subjectId: workflow.id, metadata: { key: body.key, trigger: body.triggerEvent } });
        return { workflowId: workflow.id, versionId: version.id };
      });
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/automation/workflows/:id/versions',
    operationId: 'createWorkflowVersion',
    summary: 'Save a new draft version (published versions are never edited)',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.write' },
    params: IdParams,
    body: z.object({ definition: WorkflowDefinition, changeNote: z.string().max(500).optional() }),
    response: WorkflowVersion,
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      const workflow = await deps.db.selectFrom('workflowDefinitions').select('id').where('id', '=', params.id).executeTakeFirst();
      if (!workflow) throw notFound('Workflow');
      await deps.db.deleteFrom('workflowVersions').where('workflowId', '=', params.id).where('status', '=', 'draft').execute();
      const last = await deps.db.selectFrom('workflowVersions').select(eb => eb.fn.max('versionNumber').as('n')).where('workflowId', '=', params.id).executeTakeFirst();
      const version = await deps.db
        .insertInto('workflowVersions')
        .values({ workflowId: params.id, versionNumber: Number(last?.n ?? 0) + 1, definition: JSON.stringify(body.definition), changeNote: body.changeNote ?? null, createdBy: staff.staffId, createdAt: meta.now.toISOString() })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(deps.db, meta, { action: 'workflow.draft_saved', subjectType: 'workflow', subjectId: params.id, metadata: { version: version.versionNumber } });
      return { ...version, definition: WorkflowDefinition.parse(version.definition) } as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/automation/workflow-versions/:id/publish',
    operationId: 'publishWorkflowVersion',
    summary: 'Publish a version (also used to roll back to an earlier version)',
    description: 'Runs already in progress stay on the version they started with; cancel them separately if needed.',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.publish' },
    params: IdParams,
    response: Ok,
    async handler({ deps, meta, staff, params }) {
      await deps.db.transaction().execute(async trx => {
        const version = await trx.selectFrom('workflowVersions as v').innerJoin('workflowDefinitions as w', 'w.id', 'v.workflowId').select(['v.id', 'v.workflowId', 'v.status', 'v.versionNumber', 'v.definition', 'w.triggerEvent']).where('v.id', '=', params.id).executeTakeFirst();
        if (!version) throw notFound('Workflow version');
        const definition = WorkflowDefinition.parse(version.definition);
        await validateDefinitionTemplates(trx, definition, version.triggerEvent);
        if (version.status === 'draft') {
          await trx.updateTable('workflowVersions').set({ status: 'published', publishedAt: meta.now.toISOString(), publishedBy: staff.staffId }).where('id', '=', params.id).execute();
        } else if (version.status === 'archived') {
          await trx.updateTable('workflowVersions').set({ status: 'published' }).where('id', '=', params.id).execute();
        }
        await trx.updateTable('workflowVersions').set({ status: 'archived' }).where('workflowId', '=', version.workflowId).where('status', '=', 'published').where('id', '<>', params.id).execute();
        await trx.updateTable('workflowDefinitions').set({ currentVersionId: params.id, changedBy: staff.staffId, changedAt: meta.now.toISOString(), version: sql`version + 1` }).where('id', '=', version.workflowId).execute();
        await audit(trx, meta, { action: 'workflow.published', subjectType: 'workflow', subjectId: version.workflowId, metadata: { version: version.versionNumber } });
      });
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/automation/workflows/:id/enabled',
    operationId: 'setWorkflowEnabled',
    summary: 'Turn a workflow on or off',
    description: 'Turning off cancels its active runs (with the reason).',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.publish' },
    params: IdParams,
    body: z.object({ enabled: z.boolean(), reason: z.string().max(500).optional(), version: Version }),
    response: Ok,
    async handler({ deps, meta, staff, params, body }) {
      await deps.db.transaction().execute(async trx => {
        const workflow = await trx.selectFrom('workflowDefinitions').select(['currentVersionId', 'triggerEvent']).where('id', '=', params.id).executeTakeFirst();
        if (!workflow) throw notFound('Workflow');
        if (body.enabled) {
          if (!workflow.currentVersionId) throw unprocessable('Publish a version first.', 'no_published_version');
          const version = await trx.selectFrom('workflowVersions').select('definition').where('id', '=', workflow.currentVersionId).executeTakeFirstOrThrow();
          await validateDefinitionTemplates(trx, WorkflowDefinition.parse(version.definition), workflow.triggerEvent);
        }
        await updateVersioned(trx, 'workflowDefinitions', params.id, body.version, { enabled: body.enabled, statusReason: body.reason ?? null, changedBy: staff.staffId, changedAt: meta.now.toISOString() }, 'Workflow');
        if (!body.enabled) {
          const runs = await trx.selectFrom('workflowRuns').select('id').where('workflowId', '=', params.id).where('status', '=', 'active').execute();
          for (const run of runs) await cancelRun(trx, run.id, `Workflow turned off${body.reason ? `: ${body.reason}` : ''}`, meta.now, staff.staffId);
        }
        await audit(trx, meta, { action: body.enabled ? 'workflow.enabled' : 'workflow.disabled', subjectType: 'workflow', subjectId: params.id, metadata: { reason: body.reason ?? null } });
      });
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/automation/workflows/preview',
    operationId: 'previewWorkflow',
    summary: 'Dry run: would this definition enroll a record now, who would receive what, and when',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.read' },
    body: z.object({ triggerEvent: z.string(), subjectId: Id.nullable(), definition: WorkflowDefinition }),
    response: z.object({ matches: z.boolean(), reason: z.string().nullable(), fields: z.record(z.string(), z.unknown()).optional(), recipients: z.record(z.string(), z.string().nullable()).optional(), steps: z.array(z.object({ key: z.string(), action: z.string(), dueAt: Timestamp.nullable() })) }).meta({ id: 'WorkflowPreview' }),
    async handler({ deps, body }) {
      return previewEnrollment(deps, body.definition, body.triggerEvent, body.subjectId) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/automation/runs',
    operationId: 'listWorkflowRuns',
    summary: 'Workflow runs',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.read' },
    query: z.object({ workflowId: Id.optional(), subjectType: z.string().max(40).optional(), subjectId: Id.optional(), status: queryList(z.enum(['active', 'completed', 'cancelled', 'failed'])).optional(), ...PageQuery }),
    response: pageOf(Run, 'WorkflowRunPage'),
    async handler({ deps, query }) {
      let q = deps.db.selectFrom('workflowRuns as r').innerJoin('workflowDefinitions as w', 'w.id', 'r.workflowId').innerJoin('workflowVersions as v', 'v.id', 'r.workflowVersionId');
      if (query.workflowId) q = q.where('r.workflowId', '=', query.workflowId);
      if (query.subjectType) q = q.where('r.subjectType', '=', query.subjectType);
      if (query.subjectId) q = q.where('r.subjectId', '=', query.subjectId);
      if (query.status?.length) q = q.where('r.status', 'in', query.status);
      const { limit, offset } = pageArgs(query.page, query.pageSize);
      const [items, total] = await Promise.all([
        q.select(['r.id', 'r.workflowId', 'w.key as workflowKey', 'w.name as workflowName', 'v.versionNumber', 'r.subjectType', 'r.subjectId', 'r.status', 'r.cancelReason', 'r.startedAt', 'r.finishedAt']).orderBy('r.startedAt', 'desc').limit(limit).offset(offset).execute(),
        q.select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()
      ]);
      return { items: items as never, page: query.page, pageSize: query.pageSize, total: Number(total.n) };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/automation/runs/:id',
    operationId: 'getWorkflowRun',
    summary: 'A run with every step and its outcome',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.read' },
    params: IdParams,
    response: z.object({ run: Run, steps: z.array(Step) }),
    async handler({ deps, params }) {
      const run = await deps.db.selectFrom('workflowRuns as r').innerJoin('workflowDefinitions as w', 'w.id', 'r.workflowId').innerJoin('workflowVersions as v', 'v.id', 'r.workflowVersionId')
        .select(['r.id', 'r.workflowId', 'w.key as workflowKey', 'w.name as workflowName', 'v.versionNumber', 'r.subjectType', 'r.subjectId', 'r.status', 'r.cancelReason', 'r.startedAt', 'r.finishedAt']).where('r.id', '=', params.id).executeTakeFirst();
      if (!run) throw notFound('Run');
      const steps = await deps.db.selectFrom('workflowStepExecutions').selectAll().where('runId', '=', params.id).orderBy('stepIndex').execute();
      return { run: run as never, steps: steps as never };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/automation/runs/:id/cancel',
    operationId: 'cancelWorkflowRun',
    summary: 'Cancel a run (remaining steps are cancelled with the reason)',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.pause_record' },
    params: IdParams,
    body: z.object({ reason: z.string().trim().min(3).max(500) }),
    response: Ok,
    async handler({ deps, meta, staff, params, body }) {
      await cancelRun(deps.db, params.id, `Cancelled by staff: ${body.reason}`, meta.now, staff.staffId);
      await audit(deps.db, meta, { action: 'workflow.run_cancelled', subjectType: 'workflow_run', subjectId: params.id, metadata: { reason: body.reason } });
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/automation/approvals',
    operationId: 'listPendingApprovals',
    summary: 'Automated messages waiting for staff approval, with a rendered preview',
    tags: ['Automation'],
    access: { kind: 'staff', permission: 'automation.read' },
    response: z.object({ items: z.array(z.object({ stepId: Id, runId: Id, workflowKey: z.string(), workflowName: z.string(), stepKey: z.string(), subjectType: z.string(), subjectId: Id.nullable(), dueAt: Timestamp, recipient: z.string().nullable(), subject: z.string().nullable(), body: z.string().nullable() })) }).meta({ id: 'PendingApprovals' }),
    async handler({ deps }) {
      const rows = await deps.db.selectFrom('workflowStepExecutions as s').innerJoin('workflowRuns as r', 'r.id', 's.runId').innerJoin('workflowDefinitions as w', 'w.id', 'r.workflowId').innerJoin('workflowVersions as v', 'v.id', 'r.workflowVersionId')
        .select(['s.id as stepId', 's.runId', 's.stepKey', 's.dueAt', 'w.key as workflowKey', 'w.name as workflowName', 'r.subjectType', 'r.subjectId', 'v.definition']).where('s.status', '=', 'awaiting_approval').orderBy('s.dueAt').limit(100).execute();
      const items = [];
      for (const row of rows) {
        const step = WorkflowDefinition.parse(row.definition).steps.find(s => s.key === row.stepKey);
        const ctx = await loadSubject(deps, deps.db, row.subjectType, row.subjectId);
        const template = step && 'template' in step ? await publishedTemplate(deps.db, step.template) : undefined;
        const recipientKey = step?.action === 'send_email' ? step.recipient : 'candidate';
        items.push({
          stepId: row.stepId, runId: row.runId, workflowKey: row.workflowKey, workflowName: row.workflowName, stepKey: row.stepKey, subjectType: row.subjectType, subjectId: row.subjectId, dueAt: row.dueAt,
          recipient: ctx?.recipients[recipientKey as 'candidate']?.email ?? null,
          subject: template && ctx ? renderSubject(template.subject, ctx.variables) : null,
          body: template && ctx ? render(template.bodyText, ctx.variables) : null
        });
      }
      return { items };
    }
  }),
  defineRoute({ method: 'POST', path: '/automation/steps/:id/approve', operationId: 'approveWorkflowStep', summary: 'Approve and send an awaiting message', tags: ['Automation'], access: { kind: 'staff', permission: 'communications.write' }, params: IdParams, response: Ok,
    async handler({ deps, meta, staff, params }) {
      if (!(await approveStep(deps, params.id, staff.staffId))) throw notFound('Step awaiting approval');
      await audit(deps.db, meta, { action: 'communication.approved', subjectType: 'workflow_step', subjectId: params.id });
      return { ok: true as const };
    } }),
  defineRoute({ method: 'POST', path: '/automation/steps/:id/reject', operationId: 'rejectWorkflowStep', summary: 'Do not send an awaiting message', tags: ['Automation'], access: { kind: 'staff', permission: 'communications.write' }, params: IdParams,
    body: z.object({ reason: z.string().trim().min(3).max(500) }), response: Ok,
    async handler({ deps, staff, params, body }) { if (!(await rejectStep(deps, params.id, staff.staffId, body.reason))) throw notFound('Step awaiting approval'); return { ok: true as const }; } }),
  defineRoute({ method: 'POST', path: '/automation/steps/:id/retry', operationId: 'retryWorkflowStep', summary: 'Retry a step that needs attention', tags: ['Automation'], access: { kind: 'staff', permission: 'automation.write' }, params: IdParams, response: Ok,
    async handler({ deps, meta, params }) { if (!(await retryStep(deps, params.id))) throw notFound('Step needing attention'); await audit(deps.db, meta, { action: 'workflow.step_retried', subjectType: 'workflow_step', subjectId: params.id }); return { ok: true as const }; } }),
  defineRoute({ method: 'GET', path: '/automation/attention', operationId: 'listAutomationAttention', summary: 'Failed steps and failed or ambiguous deliveries', tags: ['Automation'], access: { kind: 'staff', permission: 'automation.read' },
    response: z.object({ steps: z.array(Step), deliveries: z.array(Delivery) }),
    async handler({ deps }) {
      const [steps, deliveries] = await Promise.all([
        deps.db.selectFrom('workflowStepExecutions').selectAll().where('status', '=', 'action_needed').orderBy('updatedAt', 'desc').limit(100).execute(),
        deps.db.selectFrom('deliveries').selectAll().where('status', 'in', ['failed', 'ambiguous']).orderBy('updatedAt', 'desc').limit(100).execute()
      ]);
      return { steps: steps as never, deliveries: deliveries as never };
    } }),

  // ---------------------------------------------------------------- deliveries & suppressions
  defineRoute({ method: 'GET', path: '/automation/deliveries', operationId: 'listDeliveries', summary: 'Email delivery ledger', tags: ['Automation'], access: { kind: 'staff', permission: 'automation.read' },
    query: z.object({ status: queryList(z.string().max(30)).optional(), to: z.string().max(254).optional(), templateKey: z.string().max(80).optional(), ...PageQuery }),
    response: pageOf(Delivery, 'DeliveryPage'),
    async handler({ deps, query }) {
      let q = deps.db.selectFrom('deliveries');
      if (query.status?.length) q = q.where('status', 'in', query.status);
      if (query.to) q = q.where('toAddress', '=', query.to.toLowerCase());
      if (query.templateKey) q = q.where('templateKey', '=', query.templateKey);
      // Security mail (reset links, codes) is listed without its subject recipient detail beyond the address.
      const { limit, offset } = pageArgs(query.page, query.pageSize);
      const [items, total] = await Promise.all([q.selectAll().orderBy('createdAt', 'desc').limit(limit).offset(offset).execute(), q.select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()]);
      return { items: items as never, page: query.page, pageSize: query.pageSize, total: Number(total.n) };
    } }),
  defineRoute({ method: 'POST', path: '/automation/deliveries/:id/resolve', operationId: 'resolveDelivery', summary: 'Resolve a failed or ambiguous send: retry, mark as sent, or cancel', description: 'Retrying an ambiguous send outside the provider window could duplicate it: check the provider dashboard first.', tags: ['Automation'], access: { kind: 'staff', permission: 'automation.write' }, params: IdParams,
    body: z.object({ action: z.enum(['retry', 'mark_sent', 'cancel']), note: z.string().max(500).optional() }), response: Ok,
    async handler({ deps, meta, params, body }) {
      const delivery = await deps.db.selectFrom('deliveries').select(['id', 'status', 'category']).where('id', '=', params.id).executeTakeFirst();
      if (!delivery) throw notFound('Delivery');
      if (!['failed', 'ambiguous'].includes(delivery.status)) throw unprocessable(`A ${delivery.status} delivery does not need resolving.`, 'delivery_not_failed');
      if (body.action === 'retry') {
        await deps.db.updateTable('deliveries').set({ status: 'pending', attempts: 0, firstAttemptAt: null, nextAttemptAt: meta.now.toISOString(), finalAt: null, lastError: null }).where('id', '=', params.id).execute();
        await dispatchDeliveries(deps, { ids: [params.id] }).catch(() => undefined);
      } else {
        const status = body.action === 'mark_sent' ? 'provider_accepted' : 'cancelled';
        await deps.db.updateTable('deliveries').set({ status, finalAt: meta.now.toISOString(), lastError: body.note ?? null }).where('id', '=', params.id).execute();
        await deps.db.updateTable('communications').set({ status: status === 'cancelled' ? 'cancelled' : 'provider_accepted' }).where('deliveryId', '=', params.id).execute();
      }
      await deps.db.updateTable('tasks').set({ status: 'done', completedAt: meta.now.toISOString(), outcome: body.action }).where('deliveryId', '=', params.id).where('status', 'in', ['open', 'in_progress']).execute();
      await audit(deps.db, meta, { action: `delivery.${body.action}`, subjectType: 'delivery', subjectId: params.id, metadata: { note: body.note ?? null } });
      return { ok: true as const };
    } }),
  defineRoute({ method: 'GET', path: '/automation/suppressions', operationId: 'listSuppressions', summary: 'Suppressed email addresses', tags: ['Automation'], access: { kind: 'staff', permission: 'automation.read' },
    response: z.object({ items: z.array(z.object({ email: z.string(), scope: z.enum(['all', 'outreach']), reason: z.string(), note: z.string().nullable(), createdAt: Timestamp })) }),
    async handler({ deps }) { return { items: (await deps.db.selectFrom('emailSuppressions').selectAll().orderBy('createdAt', 'desc').limit(500).execute()) as never }; } }),
  defineRoute({ method: 'POST', path: '/automation/suppressions', operationId: 'addSuppression', summary: 'Stop email to an address (all mail or optional outreach only)', tags: ['Automation'], access: { kind: 'staff', permission: 'communications.write' },
    body: z.object({ email: Email, scope: z.enum(['all', 'outreach']), reason: z.enum(['unsubscribe', 'manual']), note: z.string().max(500).optional() }), response: Ok, status: 201,
    async handler({ deps, meta, staff, body }) {
      await deps.db.insertInto('emailSuppressions').values({ ...body, note: body.note ?? null, createdBy: staff.staffId, createdAt: meta.now.toISOString() }).onConflict(oc => oc.column('email').doUpdateSet({ scope: body.scope, reason: body.reason, note: body.note ?? null })).execute();
      await audit(deps.db, meta, { action: 'suppression.added', subjectType: 'email_suppression', subjectId: null, metadata: { scope: body.scope, reason: body.reason } });
      return { ok: true as const };
    } }),
  defineRoute({ method: 'DELETE', path: '/automation/suppressions/:email', operationId: 'removeSuppression', summary: 'Remove a suppression (owner; for corrected bounces)', tags: ['Automation'], access: { kind: 'staff', permission: 'automation.write' },
    params: z.object({ email: Email }), response: Ok,
    async handler({ deps, meta, params }) { await deps.db.deleteFrom('emailSuppressions').where('email', '=', params.email).execute(); await audit(deps.db, meta, { action: 'suppression.removed', subjectType: 'email_suppression', subjectId: null }); return { ok: true as const }; } }),

  // ---------------------------------------------------------------- templates
  defineRoute({ method: 'GET', path: '/automation/templates', operationId: 'listEmailTemplates', summary: 'Email templates (current published wording)', tags: ['Automation'], access: { kind: 'staff', permission: 'templates.read' },
    response: z.object({ items: z.array(Template) }),
    async handler({ deps }) {
      const rows = await deps.db.selectFrom('emailTemplates as t').leftJoin('emailTemplateVersions as v', 'v.id', 't.currentVersionId').selectAll('t').select(['v.subject', 'v.bodyText', 'v.versionNumber as currentVersionNumber']).orderBy('t.category').orderBy('t.name').execute();
      return { items: rows as never };
    } }),
  defineRoute({ method: 'GET', path: '/automation/templates/:id/versions', operationId: 'listEmailTemplateVersions', summary: 'Template version history', tags: ['Automation'], access: { kind: 'staff', permission: 'templates.read' }, params: IdParams,
    response: z.object({ items: z.array(TemplateVersion) }),
    async handler({ deps, params }) { return { items: (await deps.db.selectFrom('emailTemplateVersions').selectAll().where('templateId', '=', params.id).orderBy('versionNumber', 'desc').execute()) as never }; } }),
  defineRoute({ method: 'POST', path: '/automation/templates', operationId: 'createEmailTemplate', summary: 'Create a template with a draft first version', tags: ['Automation'], access: { kind: 'staff', permission: 'templates.write' },
    body: z.object({ key: z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/), name: z.string().trim().min(1).max(120), description: z.string().max(500).optional(), category: z.enum(['transactional', 'outreach', 'staff_notification']), triggerEvent: z.string().max(80).meta({ description: 'Determines which variables the template may use.' }), subject: z.string().min(1).max(200), bodyText: z.string().min(1).max(20000) }),
    response: z.object({ templateId: Id, versionId: Id }), status: 201,
    async handler({ deps, meta, staff, body }) {
      const allowed = variablesForTrigger(body.triggerEvent);
      assertTemplateVariables(body.subject, body.bodyText, allowed);
      return deps.db.transaction().execute(async trx => {
        const template = await trx.insertInto('emailTemplates').values({ key: body.key, name: body.name, description: body.description ?? null, category: body.category, allowedVariables: allowed, createdAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
        const version = await trx.insertInto('emailTemplateVersions').values({ templateId: template.id, versionNumber: 1, subject: body.subject, bodyText: body.bodyText, createdBy: staff.staffId, createdAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
        await audit(trx, meta, { action: 'template.created', subjectType: 'email_template', subjectId: template.id, metadata: { key: body.key } });
        return { templateId: template.id, versionId: version.id };
      });
    } }),
  defineRoute({ method: 'POST', path: '/automation/templates/:id/versions', operationId: 'saveEmailTemplateDraft', summary: 'Save draft wording (replaces any existing draft)', tags: ['Automation'], access: { kind: 'staff', permission: 'templates.write' }, params: IdParams,
    body: z.object({ subject: z.string().min(1).max(200), bodyText: z.string().min(1).max(20000) }), response: TemplateVersion, status: 201,
    async handler({ deps, meta, staff, params, body }) {
      const template = await deps.db.selectFrom('emailTemplates').select(['id', 'allowedVariables']).where('id', '=', params.id).executeTakeFirst();
      if (!template) throw notFound('Template');
      assertTemplateVariables(body.subject, body.bodyText, template.allowedVariables);
      await deps.db.deleteFrom('emailTemplateVersions').where('templateId', '=', params.id).where('status', '=', 'draft').execute();
      const last = await deps.db.selectFrom('emailTemplateVersions').select(eb => eb.fn.max('versionNumber').as('n')).where('templateId', '=', params.id).executeTakeFirst();
      const version = await deps.db.insertInto('emailTemplateVersions').values({ templateId: params.id, versionNumber: Number(last?.n ?? 0) + 1, subject: body.subject, bodyText: body.bodyText, createdBy: staff.staffId, createdAt: meta.now.toISOString() }).returningAll().executeTakeFirstOrThrow();
      await audit(deps.db, meta, { action: 'template.draft_saved', subjectType: 'email_template', subjectId: params.id, metadata: { version: version.versionNumber } });
      return version as never;
    } }),
  defineRoute({ method: 'POST', path: '/automation/template-versions/:id/publish', operationId: 'publishEmailTemplateVersion', summary: 'Publish template wording (or roll back to an earlier version)', tags: ['Automation'], access: { kind: 'staff', permission: 'templates.publish' }, params: IdParams, response: Ok,
    async handler({ deps, meta, staff, params }) {
      await deps.db.transaction().execute(async trx => {
        const version = await trx.selectFrom('emailTemplateVersions').select(['id', 'templateId', 'status', 'versionNumber']).where('id', '=', params.id).executeTakeFirst();
        if (!version) throw notFound('Template version');
        if (version.status === 'draft') await trx.updateTable('emailTemplateVersions').set({ status: 'published', publishedAt: meta.now.toISOString(), publishedBy: staff.staffId }).where('id', '=', params.id).execute();
        else if (version.status === 'archived') await trx.updateTable('emailTemplateVersions').set({ status: 'published' }).where('id', '=', params.id).execute();
        await trx.updateTable('emailTemplateVersions').set({ status: 'archived' }).where('templateId', '=', version.templateId).where('status', '=', 'published').where('id', '<>', params.id).execute();
        await trx.updateTable('emailTemplates').set({ currentVersionId: params.id, version: sql`version + 1` }).where('id', '=', version.templateId).execute();
        await audit(trx, meta, { action: 'template.published', subjectType: 'email_template', subjectId: version.templateId, metadata: { version: version.versionNumber } });
      });
      return { ok: true as const };
    } }),
  defineRoute({ method: 'POST', path: '/automation/template-versions/:id/preview', operationId: 'previewEmailTemplate', summary: 'Render a template version with sample values', tags: ['Automation'], access: { kind: 'staff', permission: 'templates.read' }, params: IdParams,
    body: z.object({ variables: z.record(z.string(), z.string()).optional() }), response: z.object({ subject: z.string(), bodyText: z.string() }),
    async handler({ deps, params, body }) {
      const version = await deps.db.selectFrom('emailTemplateVersions').select(['subject', 'bodyText']).where('id', '=', params.id).executeTakeFirst();
      if (!version) throw notFound('Template version');
      const variables = { ...SAMPLE_VARIABLES, ...(body.variables ?? {}) };
      return { subject: renderSubject(version.subject, variables), bodyText: render(version.bodyText, variables) };
    } }),
  defineRoute({ method: 'POST', path: '/automation/template-versions/:id/test-send', operationId: 'testSendEmailTemplate', summary: 'Send a sample to your own email address', tags: ['Automation'], access: { kind: 'staff', permission: 'templates.write' }, params: IdParams,
    response: z.object({ deliveryId: Id }), rateLimits: [{ name: 'template-test', max: 20, windowSeconds: 3600 }],
    async handler({ deps, meta, staff, params }) {
      const version = await deps.db.selectFrom('emailTemplateVersions as v').innerJoin('emailTemplates as t', 't.id', 'v.templateId').select(['v.id', 'v.subject', 'v.bodyText', 't.key']).where('v.id', '=', params.id).executeTakeFirst();
      if (!version) throw notFound('Template version');
      const delivery = await deps.db.insertInto('deliveries').values({
        idempotencyKey: `template_test:${params.id}:${staff.staffId}:${meta.now.getTime()}`, category: 'staff_notification', templateKey: version.key, recipientType: 'staff', recipientId: staff.staffId,
        toAddress: staff.email, subject: `[Test] ${renderSubject(version.subject, SAMPLE_VARIABLES)}`, bodyText: render(version.bodyText, SAMPLE_VARIABLES), nextAttemptAt: meta.now.toISOString(), createdAt: meta.now.toISOString()
      }).returning('id').executeTakeFirstOrThrow();
      await dispatchDeliveries(deps, { ids: [delivery.id] }).catch(() => undefined);
      return { deliveryId: delivery.id };
    } }),

  // ---------------------------------------------------------------- information requests
  defineRoute({ method: 'GET', path: '/candidates/:id/information-requests', operationId: 'listInformationRequests', summary: 'Missing-information requests for a candidate', tags: ['Candidates'], access: { kind: 'staff', permission: 'candidates.read' }, params: IdParams,
    response: z.object({ items: z.array(InformationRequest) }),
    async handler({ deps, params }) { return { items: (await deps.db.selectFrom('informationRequests').selectAll().where('candidateId', '=', params.id).orderBy('createdAt', 'desc').execute()) as never }; } }),
  defineRoute({ method: 'POST', path: '/candidates/:id/information-requests', operationId: 'requestCandidateInformation', summary: 'Ask the candidate for missing items (email + deadline task)', tags: ['Candidates'], access: { kind: 'staff', permission: 'candidates.write' }, params: IdParams,
    body: z.object({ items: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,60}$/), label: z.string().trim().min(1).max(200) })).min(1).max(20), message: z.string().max(2000).nullable().optional(), deadlineOn: DateOnly.nullable().optional() }),
    response: z.object({ id: Id }), status: 201,
    async handler({ deps, meta, staff, params, body }) {
      return deps.db.transaction().execute(async trx => {
        const candidate = await trx.selectFrom('candidates').select('assignedStaffId').where('id', '=', params.id).executeTakeFirst();
        if (!candidate) throw notFound('Candidate');
        await assertInScope(trx, staff, candidate.assignedStaffId);
        const row = await trx.insertInto('informationRequests').values({ candidateId: params.id, items: JSON.stringify(body.items.map(item => ({ ...item, status: 'requested' }))), message: body.message ?? null, deadlineOn: body.deadlineOn ?? null, requestedBy: staff.staffId, createdAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
        await audit(trx, meta, { action: 'candidate.information_requested', subjectType: 'candidate', subjectId: params.id, metadata: { requestId: row.id, items: body.items.map(i => i.key) } });
        await emit(trx, meta, { type: 'candidate.information_requested', subjectType: 'information_request', subjectId: row.id, payload: { related: { candidate: params.id, information_request: row.id } }, dedupeKey: `candidate.information_requested:${row.id}` });
        return { id: row.id };
      });
    } }),
  defineRoute({ method: 'POST', path: '/information-requests/:id/resolve', operationId: 'resolveInformationRequest', summary: 'Record items as received or waived, or cancel the request', description: 'When every item is received or waived the request closes and its reminders stop.', tags: ['Candidates'], access: { kind: 'staff', permission: 'candidates.write' }, params: IdParams,
    body: z.object({ version: Version, cancel: z.boolean().optional(), items: z.array(z.object({ key: z.string(), status: z.enum(['received', 'waived', 'requested']) })).optional() }),
    response: InformationRequest,
    async handler({ deps, meta, staff, params, body }) {
      return deps.db.transaction().execute(async trx => {
        const request = await trx.selectFrom('informationRequests').selectAll().where('id', '=', params.id).forUpdate().executeTakeFirst();
        if (!request) throw notFound('Information request');
        if (request.status !== 'open') throw unprocessable('This request is closed.', 'request_closed');
        const items = (request.items as Array<{ key: string; label: string; status: string }>).map(item => ({ ...item, status: body.items?.find(i => i.key === item.key)?.status ?? item.status }));
        const done = items.every(item => item.status !== 'requested');
        const status = body.cancel ? 'cancelled' : done ? 'received' : 'open';
        const updated = await updateVersioned(trx, 'informationRequests', params.id, body.version, { items: JSON.stringify(items), status, ...(status !== 'open' ? { resolvedAt: meta.now.toISOString(), resolvedBy: staff.staffId } : {}) }, 'Information request');
        if (status === 'received') await emit(trx, meta, { type: 'candidate.information_received', subjectType: 'information_request', subjectId: params.id, payload: { related: { candidate: request.candidateId, information_request: params.id } } });
        await audit(trx, meta, { action: 'candidate.information_request_updated', subjectType: 'candidate', subjectId: request.candidateId, metadata: { requestId: params.id, status } });
        return updated as never;
      });
    } })
];

