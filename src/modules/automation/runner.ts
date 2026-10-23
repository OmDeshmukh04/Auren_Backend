import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { AppDeps } from '../../context.js';
import { systemMeta } from '../../context.js';
import { emit } from '../../domain/outbox.js';
import { calendarOf, getSettings } from '../../domain/settings.js';
import { DAY, HOUR, MINUTE, localDate } from '../../lib/time.js';
import { dispatchDeliveries } from './deliveries.js';
import { executeSteps, processOutbox } from './engine.js';
import { expireChecks } from '../screening/service.js';
import { scanDocument } from '../documents/files.js';
import { processQueuedExports } from '../governance/exports.js';

/**
 * One bounded runner invocation (Vercel Cron every minute, or the long-running worker). Safe to
 * run concurrently: claims use SKIP LOCKED leases and scheduled triggers use outbox dedupe keys.
 */

export interface TickResult {
  events: number;
  steps: number;
  deliveries: { sent: number; retried: number; failed: number; ambiguous: number; skipped: number };
  scans: Record<string, number> | null;
  durationMs: number;
}

const SCAN_INTERVAL_MS = 5 * MINUTE;

export async function runnerTick(deps: AppDeps, options: { runnerId?: string; maxMs?: number; batch?: number; forceScans?: boolean } = {}): Promise<TickResult> {
  const startedReal = Date.now();
  const maxMs = options.maxMs ?? deps.config.RUNNER_MAX_MS;
  const batch = options.batch ?? deps.config.RUNNER_BATCH_SIZE;
  const runnerId = options.runnerId ?? 'cron';
  const now = deps.clock.now();
  const previous = await deps.db.selectFrom('runnerHeartbeats').select(['lastResult']).where('runnerId', '=', 'scans').executeTakeFirst();
  await deps.db
    .insertInto('runnerHeartbeats')
    .values({ runnerId, lastStartedAt: now.toISOString() })
    .onConflict(oc => oc.column('runnerId').doUpdateSet({ lastStartedAt: now.toISOString() }))
    .execute();

  let scans: Record<string, number> | null = null;
  const lastScanAt = (previous?.lastResult as { at?: string } | undefined)?.at;
  if (options.forceScans || !lastScanAt || now.getTime() - new Date(lastScanAt).getTime() >= SCAN_INTERVAL_MS) {
    scans = await scheduledScans(deps);
    const record = JSON.stringify({ at: now.toISOString(), ...scans });
    await deps.db
      .insertInto('runnerHeartbeats')
      .values({ runnerId: 'scans', lastStartedAt: now.toISOString(), lastFinishedAt: now.toISOString(), lastResult: record })
      .onConflict(oc => oc.column('runnerId').doUpdateSet({ lastFinishedAt: now.toISOString(), lastResult: record }))
      .execute();
  }

  const totals: TickResult = { events: 0, steps: 0, deliveries: { sent: 0, retried: 0, failed: 0, ambiguous: 0, skipped: 0 }, scans, durationMs: 0 };
  for (let round = 0; round < 20; round++) {
    const events = await processOutbox(deps, batch);
    const steps = await executeSteps(deps, batch);
    const delivered = await dispatchDeliveries(deps, { limit: batch });
    totals.events += events;
    totals.steps += steps;
    for (const key of Object.keys(totals.deliveries) as Array<keyof TickResult['deliveries']>) totals.deliveries[key] += delivered[key];
    const work = events + steps + delivered.sent + delivered.retried + delivered.failed + delivered.ambiguous + delivered.skipped;
    if (work === 0 || Date.now() - startedReal > maxMs) break;
  }
  totals.durationMs = Date.now() - startedReal;
  await deps.db
    .updateTable('runnerHeartbeats')
    .set({ lastFinishedAt: deps.clock.now().toISOString(), lastResult: JSON.stringify(totals) })
    .where('runnerId', '=', runnerId)
    .execute();
  return totals;
}

/** Time-based triggers and housekeeping. Each emitted event has a dedupe key, so reruns are harmless. */
export async function scheduledScans(deps: AppDeps): Promise<Record<string, number>> {
  const now = deps.clock.now();
  const settings = await getSettings(deps.db, { fresh: true });
  const tz = settings.timezone;
  const today = localDate(now, tz);
  const meta = systemMeta('scheduler', now);
  const counts: Record<string, number> = {};
  const count = (key: string, n: number) => (counts[key] = (counts[key] ?? 0) + n);

  // Daily digest on agency business days after the configured local time.
  const local = DateTime.fromJSDate(now, { zone: tz });
  const calendar = calendarOf(settings);
  const weekday = (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const)[local.weekday - 1]!;
  const businessDay = Boolean(calendar.businessHours[weekday]?.length) && !calendar.holidays.includes(today);
  if (businessDay && local.toFormat('HH:mm') >= settings.dailyDigestTime.slice(0, 5)) {
    const id = await emit(deps.db, meta, { type: 'schedule.daily_digest', subjectType: 'agency', subjectId: null, dedupeKey: `daily_digest:${today}` });
    count('dailyDigest', id ? 1 : 0);
  }

  const inDays = (days: number) => local.plus({ days }).toISODate()!;
  const expiring = await deps.db
    .selectFrom('candidateQualifications as q')
    .innerJoin('candidates as c', 'c.id', 'q.candidateId')
    .select(['q.id', 'q.candidateId', 'q.expiresOn'])
    .where('q.reviewState', '=', 'verified')
    .where('q.expiresOn', '>=', today)
    .where('q.expiresOn', '<=', inDays(30))
    .where('c.archivedAt', 'is', null)
    .execute();
  for (const q of expiring) {
    const id = await emit(deps.db, meta, { type: 'qualification.expiring', subjectType: 'qualification', subjectId: q.id, payload: { related: { candidate: q.candidateId } }, dedupeKey: `qualification.expiring:${q.id}:${q.expiresOn}` });
    count('qualificationsExpiring', id ? 1 : 0);
  }
  const expired = await deps.db
    .selectFrom('candidateQualifications')
    .select(['id', 'candidateId', 'expiresOn'])
    .where('reviewState', '=', 'verified')
    .where('expiresOn', '<', today)
    .where('expiresOn', '>=', inDays(-30))
    .execute();
  for (const q of expired) {
    const id = await emit(deps.db, meta, { type: 'qualification.expired', subjectType: 'qualification', subjectId: q.id, payload: { related: { candidate: q.candidateId } }, dedupeKey: `qualification.expired:${q.id}:${q.expiresOn}` });
    count('qualificationsExpired', id ? 1 : 0);
  }

  const guarantees = await deps.db
    .selectFrom('placements')
    .select(['id', 'familyId', 'candidateId', 'guaranteeEndsOn'])
    .where('status', 'in', ['booked', 'started'])
    .where('guaranteeEndsOn', '>=', today)
    .where('guaranteeEndsOn', '<=', inDays(14))
    .execute();
  for (const p of guarantees) {
    const id = await emit(deps.db, meta, { type: 'placement.guarantee_ending', subjectType: 'placement', subjectId: p.id, payload: { related: { family: p.familyId, candidate: p.candidateId } }, dedupeKey: `placement.guarantee_ending:${p.id}:${p.guaranteeEndsOn}` });
    count('guaranteesEnding', id ? 1 : 0);
  }

  const checkIns = await deps.db
    .selectFrom('placementCheckIns as ci')
    .innerJoin('placements as p', 'p.id', 'ci.placementId')
    .select(['ci.id', 'ci.placementId', 'p.familyId', 'p.candidateId'])
    .where('ci.status', '=', 'scheduled')
    .where('ci.dueOn', '<=', today)
    .where('p.status', 'in', ['booked', 'started'])
    .execute();
  for (const ci of checkIns) {
    const id = await emit(deps.db, meta, { type: 'placement.check_in_due', subjectType: 'placement', subjectId: ci.placementId, payload: { checkInId: ci.id, related: { family: ci.familyId, candidate: ci.candidateId } }, dedupeKey: `placement.check_in_due:${ci.id}` });
    count('checkInsDue', id ? 1 : 0);
  }

  const quarter = `${local.year}Q${Math.ceil(local.month / 3)}`;
  const stale = await deps.db
    .selectFrom('candidates')
    .select('id')
    .where('archivedAt', 'is', null)
    .where('mergedIntoCandidateId', 'is', null)
    .where('isTest', '=', false)
    .where('recruitmentStage', 'in', ['eligible', 'hold'])
    .where('availabilityStatus', '<>', 'unavailable')
    .where(eb => eb.or([eb('availabilityConfirmedAt', 'is', null), eb('availabilityConfirmedAt', '<', new Date(now.getTime() - 90 * DAY).toISOString())]))
    .limit(200)
    .execute();
  for (const c of stale) {
    const id = await emit(deps.db, meta, { type: 'availability.refresh_due', subjectType: 'candidate', subjectId: c.id, dedupeKey: `availability.refresh_due:${c.id}:${quarter}` });
    count('availabilityRefresh', id ? 1 : 0);
  }

  count('checksExpired', (await expireChecks(deps.db, now, tz)).length);

  const expiredDrafts = await deps.db
    .updateTable('applicationDrafts')
    .set({ status: 'expired' })
    .where('status', '=', 'active')
    .where('expiresAt', '<', now.toISOString())
    .returning('id')
    .execute();
  count('draftsExpired', expiredDrafts.length);
  if (expiredDrafts.length) {
    const ids = expiredDrafts.map(d => d.id);
    const docs = await deps.db.selectFrom('documents').select(['id', 'storageKey']).where('applicationDraftId', 'in', ids).where('candidateId', 'is', null).where('deletedAt', 'is', null).execute();
    for (const doc of docs) {
      await deps.privateStorage.delete(doc.storageKey).catch(() => {});
      await deps.db.updateTable('documents').set({ deletedAt: now.toISOString() }).where('id', '=', doc.id).execute();
    }
    await deps.db.updateTable('draftAccessTokens').set({ revokedAt: now.toISOString() }).where('draftId', 'in', ids).where('revokedAt', 'is', null).execute();
    count('draftUploadsRemoved', docs.length);
  }

  // Abandoned upload slots and scanner retries.
  const abandoned = await deps.db
    .updateTable('documents')
    .set({ deletedAt: now.toISOString() })
    .where('scanStatus', '=', 'awaiting_upload')
    .where('uploadExpiresAt', '<', new Date(now.getTime() - HOUR).toISOString())
    .where('deletedAt', 'is', null)
    .returning('id')
    .execute();
  count('abandonedUploads', abandoned.length);
  const quarantined = await deps.db
    .selectFrom('documents')
    .select('id')
    .where('scanStatus', '=', 'quarantined')
    .where('deletedAt', 'is', null)
    .where('createdAt', '<', new Date(now.getTime() - 5 * MINUTE).toISOString())
    .limit(20)
    .execute();
  for (const doc of quarantined) await scanDocument(deps, meta, doc.id);
  count('rescanned', quarantined.length);

  count('exports', await processQueuedExports(deps));
  await housekeeping(deps, now);
  return counts;
}

async function housekeeping(deps: AppDeps, now: Date) {
  await deps.db.deleteFrom('rateLimitBuckets').where('windowStart', '<', new Date(now.getTime() - 2 * DAY).toISOString()).execute();
  await deps.db.deleteFrom('idempotencyKeys').where('expiresAt', '<', now.toISOString()).execute();
  await deps.db.deleteFrom('draftAccessTokens').where('expiresAt', '<', new Date(now.getTime() - 7 * DAY).toISOString()).execute();
  await deps.db.deleteFrom('authVerifications').where('expiresAt', '<', now.toISOString()).execute();
  await deps.db.deleteFrom('authSessions').where('expiresAt', '<', now.toISOString()).execute();
  // Owner-approved retention policies only.
  const policies = await deps.db.selectFrom('retentionPolicies').selectAll().where('active', '=', true).where('approvedAt', 'is not', null).execute();
  for (const policy of policies) {
    const cutoff = new Date(now.getTime() - policy.retentionDays * DAY).toISOString();
    if (policy.recordType === 'delivery_content') {
      await deps.db.updateTable('deliveries').set({ bodyText: null }).where('finalAt', '<', cutoff).where('bodyText', 'is not', null).execute();
      await deps.db.updateTable('deliveries').set({ bodyText: null }).where('status', 'in', ['provider_accepted', 'delivered']).where('acceptedAt', '<', cutoff).where('bodyText', 'is not', null).execute();
    }
    if (policy.recordType === 'application_draft' && policy.action === 'delete') {
      await deps.db.transaction().execute(async trx => {
        await sql`SET LOCAL auren.retention_override = 'on'`.execute(trx);
        const drafts = await trx.selectFrom('applicationDrafts').select('id').where('status', 'in', ['expired', 'withdrawn']).where('updatedAt', '<', cutoff).limit(500).execute();
        if (!drafts.length) return;
        const ids = drafts.map(d => d.id);
        await trx.deleteFrom('documents').where('applicationDraftId', 'in', ids).where('candidateId', 'is', null).execute();
        await trx.deleteFrom('consents').where('applicationDraftId', 'in', ids).where('candidateId', 'is', null).execute();
        await trx.deleteFrom('applicationDrafts').where('id', 'in', ids).execute();
      });
    }
    if (policy.recordType === 'export_file') {
      const files = await deps.db
        .selectFrom('exports as e')
        .innerJoin('documents as d', 'd.id', 'e.documentId')
        .select(['e.id', 'd.id as documentId', 'd.storageKey'])
        .where('e.status', '=', 'completed')
        .where('e.completedAt', '<', cutoff)
        .execute();
      for (const file of files) {
        await deps.privateStorage.delete(file.storageKey).catch(() => {});
        await deps.db.updateTable('documents').set({ deletedAt: now.toISOString() }).where('id', '=', file.documentId).execute();
        await deps.db.updateTable('exports').set({ status: 'expired' }).where('id', '=', file.id).execute();
      }
    }
  }
}
