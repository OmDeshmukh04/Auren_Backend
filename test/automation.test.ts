import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, createTestContext, expectOk, signedIn, uuid, type TestContext } from './helpers.js';
import { runnerTick } from '../src/modules/automation/runner.js';
import { MemoryEmailProvider, ResendEmailProvider } from '../src/providers/email.js';
import { HOUR, MINUTE, DAY } from '../src/lib/time.js';
import { WorkflowDefinition } from '../src/modules/automation/definition.js';

const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString('base64')}`;
/** Memory provider that also verifies Resend-format webhooks. */
class WebhookMemoryProvider extends MemoryEmailProvider {
  private readonly resend = new ResendEmailProvider('unused', WEBHOOK_SECRET);
  parseWebhook = this.resend.parseWebhook.bind(this.resend);
}

let ctx: TestContext;
let email: WebhookMemoryProvider;
beforeAll(async () => {
  email = new WebhookMemoryProvider();
  ctx = await createTestContext({ email });
});
afterAll(async () => {
  await ctx?.close();
});
beforeEach(() => {
  email.clear();
});

const tick = () => runnerTick(ctx.deps, { maxMs: 10_000 });

async function submitEnquiry(contactEmail: string) {
  const response = await new Client(ctx.app).post(
    '/public/enquiries',
    { contact: { firstName: 'Avery', lastName: 'Auto', email: contactEmail }, household: { city: 'Denver', state: 'CO' }, role: { serviceTypeKey: 'nanny' }, consents: { privacyNotice: true } },
    { 'idempotency-key': uuid() }
  );
  expect(response.status).toBe(202);
  return response.body.reference as string;
}

describe('durable automation', () => {
  it('acknowledges an enquiry exactly once despite repeated ticks and re-delivered events', async () => {
    const to = `auto.${uuid().slice(0, 6)}@example.invalid`;
    await submitEnquiry(to);
    await tick();
    await tick();
    expect(email.to(to)).toHaveLength(1);
    expect(email.to(to)[0]!.subject).toContain('We received your enquiry');
    // Simulate the outbox event being delivered again (e.g. a crash after enrollment).
    await ctx.deps.db.updateTable('outboxEvents').set({ status: 'pending', lockedUntil: null }).where('eventType', '=', 'enquiry.submitted').execute();
    await Promise.all([tick(), tick()]);
    expect(email.to(to)).toHaveLength(1);
    const enquiry = await ctx.deps.db.selectFrom('enquiries as e').innerJoin('familyContacts as c', 'c.id', 'e.contactId').select('e.id').where('c.email', '=', to).executeTakeFirstOrThrow();
    const tasks = await ctx.deps.db.selectFrom('tasks').select('title').where('enquiryId', '=', enquiry.id).execute();
    expect(tasks.map(t => t.title)).toEqual(['Respond to new family enquiry']);
    const runs = await ctx.deps.db.selectFrom('workflowRuns as r').innerJoin('workflowDefinitions as w', 'w.id', 'r.workflowId').select('w.key').where('r.subjectId', '=', enquiry.id).execute();
    expect(runs.map(r => r.key)).toEqual(['family.intake']);
  });

  it('retries a provider timeout with the same idempotency key and sends once', async () => {
    const to = `timeout.${uuid().slice(0, 6)}@example.invalid`;
    email.failNext('unknown_but_accepted');
    await submitEnquiry(to);
    await tick();
    expect(email.to(to)).toHaveLength(1);
    const delivery = await ctx.deps.db.selectFrom('deliveries').select(['status', 'attempts']).where('toAddress', '=', to).executeTakeFirstOrThrow();
    expect(delivery.status).toBe('pending');
    ctx.clock.advance(5 * MINUTE);
    await tick();
    expect(email.to(to)).toHaveLength(1);
    expect((await ctx.deps.db.selectFrom('deliveries').select('status').where('toAddress', '=', to).executeTakeFirstOrThrow()).status).toBe('provider_accepted');
  });

  it('marks permanent failures for attention and ambiguous sends outside the window for review', async () => {
    const to = `fail.${uuid().slice(0, 6)}@example.invalid`;
    email.failNext('permanent_error');
    await submitEnquiry(to);
    await tick();
    const failed = await ctx.deps.db.selectFrom('deliveries').select(['id', 'status']).where('toAddress', '=', to).executeTakeFirstOrThrow();
    expect(failed.status).toBe('failed');
    expect(await ctx.deps.db.selectFrom('tasks').select('kind').where('deliveryId', '=', failed.id).execute()).toEqual([{ kind: 'action_needed' }]);

    const to2 = `ambiguous.${uuid().slice(0, 6)}@example.invalid`;
    email.failNext('unknown');
    await submitEnquiry(to2);
    await tick();
    ctx.clock.advance(25 * HOUR);
    email.failNext('unknown');
    await tick();
    const ambiguous = await ctx.deps.db.selectFrom('deliveries').select(['id', 'status']).where('toAddress', '=', to2).executeTakeFirstOrThrow();
    expect(ambiguous.status).toBe('ambiguous');
    expect(await ctx.deps.db.selectFrom('tasks').select('kind').where('deliveryId', '=', ambiguous.id).execute()).toEqual([{ kind: 'reconcile' }]);
    ctx.clock.advance(-25 * HOUR);
  });

  it('never sends a reminder for an old revision after a reschedule or a cancellation', async () => {
    const { client } = await signedIn(ctx, 'coordinator');
    const to = `consult.${uuid().slice(0, 6)}@example.invalid`;
    await submitEnquiry(to);
    await tick();
    email.clear();
    const enquiry = expectOk(await client.get(`/enquiries?q=${encodeURIComponent(to)}`)).items[0];
    // Booked for Monday 2 November 2026 10:00 Denver (after the DST change on 1 November).
    const booked = expectOk(await client.post(`/enquiries/${enquiry.id}/consultations`, { startsAt: '2026-11-02T17:00:00.000Z', endsAt: '2026-11-02T18:00:00.000Z' }), 201);
    await tick();
    expect(email.to(to).map(m => m.subject)).toEqual(['Your consultation is confirmed']);
    const reminder = await ctx.deps.db.selectFrom('workflowStepExecutions as s').innerJoin('workflowRuns as r', 'r.id', 's.runId').select(['s.dueAt', 's.status']).where('r.subjectId', '=', booked.appointment.id).where('s.stepKey', '=', 'reminder').executeTakeFirstOrThrow();
    // 24 hours before 10:00 MST on 2 Nov is 10:00 MDT on 1 Nov = 16:00Z.
    expect(reminder.dueAt).toBe('2026-11-01T17:00:00.000Z');

    const moved = expectOk(await client.post(`/appointments/${booked.appointment.id}/reschedule`, { startsAt: '2026-11-05T17:00:00.000Z', endsAt: '2026-11-05T18:00:00.000Z', version: booked.appointment.version, reason: 'Family asked to move' }));
    expect(moved.revision).toBe(2);
    await tick();
    const steps = await ctx.deps.db.selectFrom('workflowStepExecutions as s').innerJoin('workflowRuns as r', 'r.id', 's.runId').select(['r.status as runStatus', 's.stepKey', 's.status', 's.dueAt', 's.subjectRevision']).where('r.subjectId', '=', booked.appointment.id).orderBy('s.subjectRevision').execute();
    expect(steps.filter(s => s.subjectRevision === 1).every(s => ['cancelled', 'succeeded'].includes(s.status))).toBe(true);
    const newReminder = steps.find(s => s.subjectRevision === 2 && s.stepKey === 'reminder')!;
    expect(newReminder.status).toBe('scheduled');
    expect(newReminder.dueAt).toBe('2026-11-04T17:00:00.000Z');

    // Even if the old step were somehow still due, the revision check refuses it.
    ctx.clock.set('2026-11-04T17:05:00.000Z');
    email.clear();
    await tick();
    expect(email.to(to).map(m => m.subject)).toEqual(['Reminder: consultation Thursday, November 5 at 10:00 AM MST']);

    const { client: later } = await signedIn(ctx, 'coordinator');
    const latest = expectOk(await later.get(`/appointments/${booked.appointment.id}`));
    expectOk(await later.post(`/appointments/${booked.appointment.id}/close`, { status: 'cancelled', reason: 'Family cancelled', version: latest.version }));
    ctx.clock.set('2026-11-05T19:30:00.000Z');
    email.clear();
    await tick();
    expect(email.to(to)).toHaveLength(0);
    const outcomeTask = await ctx.deps.db.selectFrom('workflowStepExecutions as s').innerJoin('workflowRuns as r', 'r.id', 's.runId').select('s.status').where('r.subjectId', '=', booked.appointment.id).where('s.stepKey', '=', 'outcome_task').where('s.subjectRevision', '=', 2).executeTakeFirstOrThrow();
    expect(outcomeTask.status).toBe('cancelled');
    ctx.clock.set('2026-10-22T16:00:00.000Z');
  });

  it('stops follow-ups when staff record a reply, and holds approval-required outreach', async () => {
    const { client } = await signedIn(ctx, 'owner');
    const workflow = expectOk(await client.get('/automation/workflows')).items.find((w: any) => w.key === 'family.response_follow_up');
    expectOk(await client.post(`/automation/workflows/${workflow.id}/enabled`, { enabled: true, version: workflow.version }));

    const replied = `reply.${uuid().slice(0, 6)}@example.invalid`;
    const silent = `silent.${uuid().slice(0, 6)}@example.invalid`;
    await submitEnquiry(replied);
    await submitEnquiry(silent);
    await tick();
    const repliedEnquiry = expectOk(await client.get(`/enquiries?q=${encodeURIComponent(replied)}`)).items[0];
    expectOk(await client.post(`/enquiries/${repliedEnquiry.id}/contact-log`, { channel: 'email', direction: 'inbound', summary: 'Family replied by email', isReply: true }), 201);
    await tick();

    ctx.clock.advance(6 * DAY);
    email.clear();
    await tick();
    expect(email.to(replied)).toHaveLength(0);
    expect(email.to(silent)).toHaveLength(0); // follow-up awaits approval
    // The fake clock jumped ahead of the auth library's real-time sessions: sign in again.
    const { client: owner } = await signedIn(ctx, 'owner');
    const approvals = expectOk(await owner.get('/automation/approvals')).items;
    const pending = approvals.find((a: any) => a.recipient === silent);
    expect(pending.subject).toBe('Following up on your enquiry');
    expect(approvals.some((a: any) => a.recipient === replied)).toBe(false);
    ctx.clock.set('2026-10-29T17:00:00.000Z'); // a Thursday at 11:00 Denver (outside quiet hours)
    expectOk(await owner.post(`/automation/steps/${pending.stepId}/approve`));
    expect(email.to(silent).map(m => m.subject)).toEqual(['Following up on your enquiry']);
    const fresh = expectOk(await owner.get('/automation/workflows')).items.find((w: any) => w.key === 'family.response_follow_up');
    expectOk(await owner.post(`/automation/workflows/${workflow.id}/enabled`, { enabled: false, reason: 'Back to draft after test', version: fresh.version }));
    ctx.clock.set('2026-10-22T16:00:00.000Z');
  });

  it('holds steps while paused and skips external messages that became stale', async () => {
    const { client } = await signedIn(ctx, 'owner');
    expectOk(await client.post('/automation/pause', { paused: true, reason: 'Testing pause' }));
    const to = `paused.${uuid().slice(0, 6)}@example.invalid`;
    await submitEnquiry(to);
    await tick();
    expect(email.to(to)).toHaveLength(0);
    ctx.clock.advance(3 * DAY);
    const { client: owner } = await signedIn(ctx, 'owner');
    expectOk(await owner.post('/automation/pause', { paused: false }));
    await tick();
    expect(email.to(to)).toHaveLength(0);
    const ack = await ctx.deps.db.selectFrom('workflowStepExecutions as s').innerJoin('deliveries as d', 'd.stepExecutionId', 's.id').select('d.id').where('d.toAddress', '=', to).execute();
    expect(ack).toHaveLength(0);
    const skipped = await ctx.deps.db.selectFrom('workflowStepExecutions').select(['stepKey', 'skipReason']).where('stepKey', '=', 'acknowledge').where('status', '=', 'skipped').where('skipReason', 'like', 'Stale%').execute();
    expect(skipped.length).toBeGreaterThan(0);
    ctx.clock.advance(-3 * DAY);
  });

  it('accepts signed delivery webhooks once, in any order, and suppresses hard bounces', async () => {
    const to = `hook.${uuid().slice(0, 6)}@example.invalid`;
    await submitEnquiry(to);
    await tick();
    const delivery = await ctx.deps.db.selectFrom('deliveries').select(['id', 'providerMessageId']).where('toAddress', '=', to).executeTakeFirstOrThrow();
    const send = (id: string, type: string, extra: Record<string, unknown> = {}, signature = true) => {
      const body = JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: delivery.providerMessageId, to: [to], ...extra } });
      const ts = String(Math.floor(ctx.clock.now().getTime() / 1000));
      const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
      const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
      return ctx.app.inject({ method: 'POST', url: '/api/v1/webhooks/resend', headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': signature ? `v1,${sig}` : 'v1,forged' }, payload: body });
    };
    expect((await send('evt_forged', 'email.delivered', {}, false)).statusCode).toBe(401);
    expect((await send('evt_1', 'email.delivered')).statusCode).toBe(200);
    expect(JSON.parse((await send('evt_1', 'email.delivered')).body).duplicates).toBe(1);
    await send('evt_0', 'email.sent'); // late, out-of-order event
    expect((await ctx.deps.db.selectFrom('deliveries').select('status').where('id', '=', delivery.id).executeTakeFirstOrThrow()).status).toBe('delivered');
    await send('evt_2', 'email.bounced', { bounce: { type: 'Permanent' } });
    expect(await ctx.deps.db.selectFrom('emailSuppressions').select('reason').where('email', '=', to).execute()).toEqual([{ reason: 'hard_bounce' }]);
  });

  it('seeds only valid workflow definitions', async () => {
    const versions = await ctx.deps.db.selectFrom('workflowVersions').select('definition').execute();
    for (const version of versions) expect(() => WorkflowDefinition.parse(version.definition)).not.toThrow();
    const { client } = await signedIn(ctx, 'coordinator');
    expect((await client.post('/automation/pause', { paused: true, reason: 'nope' })).status).toBe(403);
    const status = expectOk(await client.get('/automation/status'));
    expect(status).toHaveProperty('pendingEvents');
  });
});
