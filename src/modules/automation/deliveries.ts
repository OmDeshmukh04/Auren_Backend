import { sql } from 'kysely';
import type { AppDeps } from '../../context.js';
import type { Executor } from '../../db/index.js';
import { publishedTemplate, render, renderSubject } from './templates.js';
import { MINUTE, HOUR } from '../../lib/time.js';

/**
 * The delivery ledger. A delivery is a durable intent to send one logical message, keyed by a
 * permanent idempotency key; creating it twice returns the same row. Sending happens after the
 * creating transaction commits (by `dispatchDeliveries` or the runner), records provider
 * acceptance separately from delivery, retries transient failures with backoff and jitter, and
 * marks unclear outcomes outside the provider's idempotency window as ambiguous for review.
 */

export type DeliveryCategory = 'transactional' | 'outreach' | 'staff_notification' | 'security';

export interface DeliveryRecipient {
  type: 'family_contact' | 'candidate' | 'applicant' | 'reference' | 'staff' | 'other';
  id: string | null;
  email: string;
  name?: string | null;
}

export interface CommunicationLinks {
  familyId?: string | null;
  familyContactId?: string | null;
  enquiryId?: string | null;
  candidateId?: string | null;
  jobOrderId?: string | null;
  referenceId?: string | null;
}

export interface CreateDeliveryInput {
  idempotencyKey: string;
  templateKey: string;
  variables: Record<string, string | number | null | undefined>;
  recipient: DeliveryRecipient;
  /** Overrides the template's category (e.g. security emails). */
  category?: DeliveryCategory;
  attachments?: Array<{ documentId: string; filename: string }>;
  stepExecutionId?: string | null;
  links?: CommunicationLinks;
  /** Record a communication history row (default true, false for security mail). */
  logCommunication?: boolean;
  /** The caller's clock time; the delivery is due from this instant. */
  now: Date;
  /** Send no earlier than this (quiet hours, scheduled steps). */
  notBefore?: Date;
}

export class TemplateMissingError extends Error {
  constructor(readonly templateKey: string) {
    super(`Email template "${templateKey}" has no published version.`);
  }
}

export async function isSuppressed(db: Executor, email: string, category: DeliveryCategory) {
  const row = await db.selectFrom('emailSuppressions').select('scope').where('email', '=', email.toLowerCase()).executeTakeFirst();
  if (!row) return false;
  if (row.scope === 'all') return category !== 'security';
  return category === 'outreach';
}

/** Creates (or returns the existing) delivery for this idempotency key. */
export async function createDelivery(db: Executor, input: CreateDeliveryInput): Promise<{ id: string; created: boolean; status: string }> {
  const existing = await db.selectFrom('deliveries').select(['id', 'status']).where('idempotencyKey', '=', input.idempotencyKey).executeTakeFirst();
  if (existing) return { id: existing.id, created: false, status: existing.status };
  const template = await publishedTemplate(db, input.templateKey);
  if (!template) throw new TemplateMissingError(input.templateKey);
  const category = input.category ?? (template.category as DeliveryCategory);
  const to = input.recipient.email.trim().toLowerCase();
  const suppressed = await isSuppressed(db, to, category);
  const subject = renderSubject(template.subject, input.variables);
  const inserted = await db
    .insertInto('deliveries')
    .values({
      idempotencyKey: input.idempotencyKey,
      category,
      templateKey: template.key,
      templateVersionId: template.versionId,
      recipientType: input.recipient.type,
      recipientId: input.recipient.id,
      toAddress: to,
      subject,
      bodyText: suppressed ? null : render(template.bodyText, input.variables),
      attachments: JSON.stringify(input.attachments ?? []),
      status: suppressed ? 'suppressed' : 'pending',
      stepExecutionId: input.stepExecutionId ?? null,
      nextAttemptAt: (input.notBefore ?? input.now).toISOString(),
      createdAt: input.now.toISOString(),
      ...(suppressed ? { finalAt: input.now.toISOString() } : {})
    })
    .onConflict(oc => oc.column('idempotencyKey').doNothing())
    .returning(['id', 'status'])
    .executeTakeFirst();
  if (!inserted) {
    const row = await db.selectFrom('deliveries').select(['id', 'status']).where('idempotencyKey', '=', input.idempotencyKey).executeTakeFirstOrThrow();
    return { id: row.id, created: false, status: row.status };
  }
  if (input.logCommunication !== false && category !== 'security') {
    const communication = await db
      .insertInto('communications')
      .values({
        channel: 'email',
        direction: 'outbound',
        status: suppressed ? 'cancelled' : 'queued',
        subject,
        summary: suppressed ? 'Not sent: address is suppressed' : null,
        toAddress: to,
        templateKey: template.key,
        deliveryId: inserted.id,
        familyId: input.links?.familyId ?? null,
        familyContactId: input.links?.familyContactId ?? null,
        enquiryId: input.links?.enquiryId ?? null,
        candidateId: input.links?.candidateId ?? null,
        jobOrderId: input.links?.jobOrderId ?? null,
        referenceId: input.links?.referenceId ?? null,
        occurredAt: input.now.toISOString()
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.updateTable('deliveries').set({ communicationId: communication.id }).where('id', '=', inserted.id).execute();
  }
  return { id: inserted.id, created: true, status: inserted.status };
}

const MAX_ATTEMPTS = 8;
const SEND_LEASE_MS = 2 * MINUTE;

function backoff(attempt: number) {
  const base = Math.min(30_000 * 2 ** (attempt - 1), HOUR);
  return base + Math.floor(Math.random() * base * 0.25);
}

function allowlisted(deps: AppDeps, address: string) {
  if (deps.config.isProduction || !deps.email.deliversExternally) return true;
  const list = deps.config.EMAIL_ALLOWLIST;
  return list.some(entry => (entry.startsWith('@') ? address.endsWith(entry.toLowerCase()) : address === entry.toLowerCase()));
}

async function setCommunicationStatus(db: Executor, deliveryId: string, status: string) {
  await db.updateTable('communications').set({ status }).where('deliveryId', '=', deliveryId).execute();
}

export interface DispatchResult {
  sent: number;
  retried: number;
  failed: number;
  ambiguous: number;
  skipped: number;
}

/**
 * Sends due deliveries. Rows are leased with SKIP LOCKED so concurrent runners never send the
 * same row at once; a lease that expires mid-send (crash) is treated as an unknown outcome.
 */
export async function dispatchDeliveries(deps: AppDeps, options: { ids?: string[]; limit?: number } = {}): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, retried: 0, failed: 0, ambiguous: 0, skipped: 0 };
  const now = deps.clock.now();
  const leaseUntil = new Date(now.getTime() + SEND_LEASE_MS).toISOString();
  const claimed = await deps.db.transaction().execute(async trx => {
    let query = trx
      .selectFrom('deliveries')
      .select(['id', 'status'])
      .where(eb =>
        eb.or([
          eb.and([eb('status', '=', 'pending'), eb('nextAttemptAt', '<=', now.toISOString())]),
          eb.and([eb('status', '=', 'sending'), eb('lockedUntil', '<', now.toISOString())])
        ])
      )
      .orderBy('nextAttemptAt')
      .limit(options.limit ?? 25)
      .forUpdate()
      .skipLocked();
    if (options.ids?.length) query = query.where('id', 'in', options.ids);
    const rows = await query.execute();
    if (rows.length) {
      await trx
        .updateTable('deliveries')
        .set({ status: 'sending', lockedUntil: leaseUntil, attempts: sql`attempts + 1`, firstAttemptAt: sql`coalesce(first_attempt_at, ${now.toISOString()}::timestamptz)` })
        .where('id', 'in', rows.map(row => row.id))
        .execute();
    }
    return rows;
  });

  for (const claim of claimed) {
    const delivery = await deps.db.selectFrom('deliveries').selectAll().where('id', '=', claim.id).executeTakeFirstOrThrow();
    const reclaimedAfterCrash = claim.status === 'sending';
    const windowMs = deps.email.idempotencyWindowHours * HOUR;
    const firstAttempt = delivery.firstAttemptAt ? new Date(delivery.firstAttemptAt) : now;
    const insideProviderWindow = now.getTime() - firstAttempt.getTime() < windowMs - 30 * MINUTE;

    if (reclaimedAfterCrash && !insideProviderWindow) {
      await markAmbiguous(deps, delivery.id, 'Send outcome unknown after a runner interruption, outside the provider idempotency window.');
      result.ambiguous++;
      continue;
    }
    if (await isSuppressed(deps.db, delivery.toAddress, delivery.category as DeliveryCategory)) {
      await finish(deps, delivery.id, { status: 'suppressed', bodyText: null }, 'cancelled');
      result.skipped++;
      continue;
    }
    if (!allowlisted(deps, delivery.toAddress)) {
      await finish(deps, delivery.id, { status: 'blocked_by_allowlist', lastError: 'Recipient not on the non-production EMAIL_ALLOWLIST' }, 'cancelled');
      result.skipped++;
      continue;
    }

    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
    let attachmentError: string | null = null;
    for (const item of delivery.attachments as Array<{ documentId: string; filename: string }>) {
      const document = await deps.db.selectFrom('documents').select(['storageKey', 'declaredContentType', 'scanStatus']).where('id', '=', item.documentId).executeTakeFirst();
      const bytes = document && document.scanStatus === 'clean' ? await deps.privateStorage.get(document.storageKey) : null;
      if (!document || !bytes) {
        attachmentError = `Attachment ${item.documentId} is unavailable`;
        break;
      }
      attachments.push({ filename: item.filename, content: bytes, contentType: document.declaredContentType });
    }
    if (attachmentError) {
      await failPermanently(deps, delivery.id, attachmentError);
      result.failed++;
      continue;
    }

    const settings = await deps.db.selectFrom('agencySettings').select(['replyToEmail']).where('id', '=', 1).executeTakeFirstOrThrow();
    const outcome = await deps.email
      .send({
        to: delivery.toAddress,
        from: deps.config.EMAIL_FROM,
        replyTo: settings.replyToEmail ?? deps.config.EMAIL_REPLY_TO,
        subject: delivery.subject,
        text: delivery.bodyText ?? '',
        attachments,
        idempotencyKey: delivery.idempotencyKey
      })
      .catch(error => ({ outcome: 'unknown' as const, error: (error as Error).message }));

    if (outcome.outcome === 'accepted') {
      await deps.db
        .updateTable('deliveries')
        .set({
          status: 'provider_accepted',
          provider: deps.email.name,
          providerMessageId: outcome.providerMessageId,
          acceptedAt: deps.clock.now().toISOString(),
          lockedUntil: null,
          lastError: null,
          // Security mail contains one-time links; do not keep it after acceptance.
          ...(delivery.category === 'security' ? { bodyText: null } : {})
        })
        .where('id', '=', delivery.id)
        .where('status', '=', 'sending')
        .execute();
      await setCommunicationStatus(deps.db, delivery.id, 'provider_accepted');
      result.sent++;
    } else if (outcome.outcome === 'permanent_error') {
      await failPermanently(deps, delivery.id, outcome.error);
      result.failed++;
    } else if (delivery.attempts >= MAX_ATTEMPTS || (outcome.outcome === 'unknown' && !insideProviderWindow)) {
      if (outcome.outcome === 'unknown') {
        await markAmbiguous(deps, delivery.id, outcome.error);
        result.ambiguous++;
      } else {
        await failPermanently(deps, delivery.id, `Gave up after ${delivery.attempts} attempts: ${outcome.error}`);
        result.failed++;
      }
    } else {
      // Transient failure, or unknown inside the window: retrying with the same key is safe.
      await deps.db
        .updateTable('deliveries')
        .set({ status: 'pending', lockedUntil: null, lastError: outcome.error, nextAttemptAt: new Date(deps.clock.now().getTime() + backoff(delivery.attempts)).toISOString() })
        .where('id', '=', delivery.id)
        .execute();
      result.retried++;
    }
  }
  return result;
}

async function finish(deps: AppDeps, id: string, values: Record<string, unknown>, communicationStatus: string) {
  await deps.db
    .updateTable('deliveries')
    .set({ ...values, lockedUntil: null, finalAt: deps.clock.now().toISOString() })
    .where('id', '=', id)
    .execute();
  await setCommunicationStatus(deps.db, id, communicationStatus);
}

async function failPermanently(deps: AppDeps, id: string, error: string) {
  await finish(deps, id, { status: 'failed', lastError: error.slice(0, 1000) }, 'failed');
  await attentionTask(deps, id, 'Email could not be sent', 'action_needed');
}

async function markAmbiguous(deps: AppDeps, id: string, error: string) {
  await finish(deps, id, { status: 'ambiguous', lastError: error.slice(0, 1000) }, 'failed');
  await attentionTask(deps, id, 'Check whether an email was sent', 'reconcile');
}

/** One owner task per delivery problem; the subject line names the template, not personal data. */
async function attentionTask(deps: AppDeps, deliveryId: string, title: string, kind: 'action_needed' | 'reconcile') {
  const delivery = await deps.db
    .selectFrom('deliveries as d')
    .leftJoin('communications as c', 'c.id', 'd.communicationId')
    .select(['d.templateKey', 'd.lastError', 'c.familyId', 'c.candidateId', 'c.enquiryId'])
    .where('d.id', '=', deliveryId)
    .executeTakeFirstOrThrow();
  const owner = await deps.db.selectFrom('staffMembers').select('id').where('role', '=', 'owner').where('status', '=', 'active').orderBy('createdAt').executeTakeFirst();
  await deps.db
    .insertInto('tasks')
    .values({
      title: `${title} (${delivery.templateKey ?? 'email'})`,
      description: `${kind === 'reconcile' ? 'The provider did not confirm whether this message was accepted. Check the provider dashboard, then mark it sent or retry it from the deliveries view.' : 'Review the error, correct the address or template, then retry from the deliveries view.'}`,
      deliveryId,
      kind,
      priority: 'high',
      assignedStaffId: owner?.id ?? null,
      familyId: delivery.familyId,
      candidateId: delivery.candidateId,
      enquiryId: delivery.enquiryId,
      dueAt: deps.clock.now().toISOString()
    })
    .onConflict(oc => oc.column('deliveryId').doNothing())
    .execute();
}

/** Status precedence for webhook updates: a late "sent" never downgrades "delivered". */
const RANK: Record<string, number> = {
  pending: 0, sending: 1, provider_accepted: 2, delayed: 3, delivered: 4, bounced: 5, complained: 6, failed: 5
};

export function shouldApplyStatus(current: string, next: string) {
  if (['cancelled', 'suppressed', 'blocked_by_allowlist'].includes(current)) return false;
  return (RANK[next] ?? 0) > (RANK[current] ?? 0) || (current === 'delayed' && next === 'delivered');
}
