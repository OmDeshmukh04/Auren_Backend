import { sql } from 'kysely';
import type { FastifyReply } from 'fastify';
import type { AppDeps, RequestMeta } from '../../context.js';
import type { Executor } from '../../db/index.js';
import { audit } from '../../domain/audit.js';
import { getSettings } from '../../domain/settings.js';
import { AppError, conflict, notFound, unauthorized, unavailable, unprocessable, validationFailed, zodFieldErrors } from '../../http/errors.js';
import { DRAFT_COOKIE } from '../../http/actors.js';
import { hashToken, makeNumericCode, randomToken, safeEqual } from '../../lib/crypto.js';
import { DAY, HOUR, MINUTE } from '../../lib/time.js';
import { createDelivery, dispatchDeliveries } from '../automation/deliveries.js';
import { currentFormVersion, formVersionById, questionsByKey, validateCustomAnswers } from '../forms/layout.js';
import { formatDate } from '../automation/subjects.js';
import { filledSections, SECTION_SCHEMAS, type ApplicationDataT, type SectionKey } from './sections.js';

/**
 * Application drafts. Starting a draft gives this browser a scoped session at once; the email
 * proves ownership (resume link or code) before uploads or submission. Resume links are
 * single-use, hashed at rest and exchanged for a short-lived session cookie. Nothing personal is
 * kept in browser storage, and no response reveals whether an email already has a draft.
 */

const SESSION_TTL = 12 * HOUR;
const RESUME_LINK_TTL = 24 * HOUR;
const CODE_TTL = 30 * MINUTE;
const MAX_CODE_ATTEMPTS = 5;

export function setDraftCookie(deps: AppDeps, reply: FastifyReply, token: string | null) {
  const secure = new URL(deps.config.API_PUBLIC_URL).protocol === 'https:';
  reply.setCookie(DRAFT_COOKIE, token ?? '', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/api/v1/public/application-drafts',
    maxAge: token ? SESSION_TTL / 1000 : 0,
    ...(deps.config.COOKIE_DOMAIN ? { domain: deps.config.COOKIE_DOMAIN } : {})
  });
}

async function newSession(db: Executor, draftId: string, now: Date) {
  const token = randomToken();
  await db
    .insertInto('draftAccessTokens')
    .values({ draftId, kind: 'session', tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + SESSION_TTL).toISOString(), createdAt: now.toISOString() })
    .execute();
  return token;
}

/** Issues a fresh single-use resume link and verification code, and emails them. */
async function sendResumeEmail(deps: AppDeps, meta: RequestMeta, draft: { id: string; email: string; expiresAt: string; data: unknown }, reason: string) {
  const now = deps.clock.now();
  const link = randomToken();
  const code = makeNumericCode();
  await deps.db.transaction().execute(async trx => {
    await trx.updateTable('draftAccessTokens').set({ revokedAt: now.toISOString() }).where('draftId', '=', draft.id).where('kind', '=', 'resume_link').where('usedAt', 'is', null).where('revokedAt', 'is', null).execute();
    await trx
      .insertInto('draftAccessTokens')
      .values({ draftId: draft.id, kind: 'resume_link', tokenHash: hashToken(link), expiresAt: new Date(now.getTime() + RESUME_LINK_TTL).toISOString(), createdAt: now.toISOString() })
      .execute();
    await trx
      .updateTable('applicationDrafts')
      .set({ verificationCodeHash: hashToken(`${draft.id}:${code}`), verificationCodeExpiresAt: new Date(now.getTime() + CODE_TTL).toISOString(), verificationAttempts: 0 })
      .where('id', '=', draft.id)
      .execute();
  });
  const firstName = ((draft.data as ApplicationDataT).contact?.firstName as string | undefined) ?? 'there';
  const delivery = await createDelivery(deps.db, {
    idempotencyKey: `draft_resume:${draft.id}:${hashToken(link).slice(0, 16)}`,
    templateKey: 'applicant.resume_link',
    category: 'security',
    recipient: { type: 'applicant', id: draft.id, email: draft.email },
    variables: {
      'applicant.firstName': firstName,
      'links.resume': `${deps.config.PUBLIC_SITE_URL.replace(/\/$/, '')}/apply/resume?token=${encodeURIComponent(link)}`,
      'verification.code': code,
      'draft.expiresOn': formatDate(draft.expiresAt.slice(0, 10)),
      'agency.name': (await getSettings(deps.db)).agencyName
    },
    logCommunication: false,
    now
  });
  await audit(deps.db, meta, { action: 'application.resume_link_sent', subjectType: 'application_draft', subjectId: draft.id, metadata: { reason } });
  await dispatchDeliveries(deps, { ids: [delivery.id] }).catch(error => deps.log.warn({ err: error }, 'Resume email will be retried'));
}

export async function startDraft(
  deps: AppDeps,
  meta: RequestMeta,
  reply: FastifyReply,
  input: { email: string; firstName: string; source?: string; utm?: Record<string, string> }
) {
  const settings = await getSettings(deps.db);
  if (!settings.acceptingSubmissions) throw unavailable('We are not accepting applications online right now.', 'submissions_closed');
  const form = await currentFormVersion(deps.db, 'candidate_application');
  const now = deps.clock.now();
  const { draft, token } = await deps.db.transaction().execute(async trx => {
    const draft = await trx
      .insertInto('applicationDrafts')
      .values({
        formVersionId: form.id,
        email: input.email,
        data: JSON.stringify({ contact: { firstName: input.firstName } }),
        expiresAt: new Date(now.getTime() + settings.draftExpiryDays * DAY).toISOString(),
        lastSavedAt: now.toISOString(),
        source: input.source ?? null,
        utm: JSON.stringify(input.utm ?? {}),
        createdAt: now.toISOString()
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const token = await newSession(trx, draft.id, now);
    await audit(trx, { ...meta, actor: { type: 'applicant', draftId: draft.id, sessionTokenId: '' } }, { action: 'application.draft_started', subjectType: 'application_draft', subjectId: draft.id });
    return { draft, token };
  });
  setDraftCookie(deps, reply, token);
  await sendResumeEmail(deps, meta, draft, 'started');
  return draftState(deps, draft.id);
}

/** Always 202. If the email has active drafts, a fresh link for the most recent one is sent. */
export async function requestResumeLink(deps: AppDeps, meta: RequestMeta, email: string) {
  const draft = await deps.db
    .selectFrom('applicationDrafts')
    .select(['id', 'email', 'expiresAt', 'data'])
    .where('email', '=', email)
    .where('status', '=', 'active')
    .where('expiresAt', '>', deps.clock.now().toISOString())
    .orderBy('lastSavedAt', 'desc')
    .executeTakeFirst();
  if (draft) await sendResumeEmail(deps, meta, draft, 'requested');
}

export async function resumeWithToken(deps: AppDeps, meta: RequestMeta, reply: FastifyReply, token: string) {
  const now = deps.clock.now();
  const draftId = await deps.db.transaction().execute(async trx => {
    const row = await trx
      .selectFrom('draftAccessTokens as t')
      .innerJoin('applicationDrafts as d', 'd.id', 't.draftId')
      .select(['t.id', 't.draftId', 't.usedAt', 't.revokedAt', 't.expiresAt', 'd.status', 'd.expiresAt as draftExpiresAt'])
      .where('t.tokenHash', '=', hashToken(token))
      .where('t.kind', '=', 'resume_link')
      .forUpdate()
      .executeTakeFirst();
    const invalid = !row || row.usedAt || row.revokedAt || new Date(row.expiresAt) < now || row.status !== 'active' || new Date(row.draftExpiresAt) < now;
    if (invalid) throw unauthorized('This link has expired or was already used. Request a new link with your email address.', 'resume_link_invalid');
    await trx.updateTable('draftAccessTokens').set({ usedAt: now.toISOString() }).where('id', '=', row.id).execute();
    await trx.updateTable('applicationDrafts').set({ emailVerifiedAt: sql`coalesce(email_verified_at, ${now.toISOString()}::timestamptz)` }).where('id', '=', row.draftId).execute();
    return row.draftId;
  });
  const session = await newSession(deps.db, draftId, now);
  setDraftCookie(deps, reply, session);
  await audit(deps.db, { ...meta, actor: { type: 'applicant', draftId, sessionTokenId: '' } }, { action: 'application.resumed', subjectType: 'application_draft', subjectId: draftId });
  return draftState(deps, draftId);
}

export async function verifyCode(deps: AppDeps, meta: RequestMeta, draftId: string, code: string) {
  const now = deps.clock.now();
  const draft = await deps.db.selectFrom('applicationDrafts').select(['verificationCodeHash', 'verificationCodeExpiresAt', 'verificationAttempts', 'emailVerifiedAt']).where('id', '=', draftId).executeTakeFirstOrThrow();
  if (draft.emailVerifiedAt) return draftState(deps, draftId);
  if (!draft.verificationCodeHash || !draft.verificationCodeExpiresAt || new Date(draft.verificationCodeExpiresAt) < now || draft.verificationAttempts >= MAX_CODE_ATTEMPTS) {
    throw unprocessable('This code has expired. Request a new email.', 'code_expired');
  }
  if (!safeEqual(hashToken(`${draftId}:${code.trim()}`), draft.verificationCodeHash)) {
    await deps.db.updateTable('applicationDrafts').set({ verificationAttempts: sql`verification_attempts + 1` }).where('id', '=', draftId).execute();
    throw validationFailed([{ path: 'code', code: 'invalid', message: 'That code is not correct' }]);
  }
  await deps.db.updateTable('applicationDrafts').set({ emailVerifiedAt: now.toISOString(), verificationCodeHash: null }).where('id', '=', draftId).execute();
  await audit(deps.db, meta, { action: 'application.email_verified', subjectType: 'application_draft', subjectId: draftId });
  return draftState(deps, draftId);
}

export async function resendCode(deps: AppDeps, meta: RequestMeta, draftId: string) {
  const draft = await deps.db.selectFrom('applicationDrafts').select(['id', 'email', 'expiresAt', 'data', 'emailVerifiedAt']).where('id', '=', draftId).executeTakeFirstOrThrow();
  if (!draft.emailVerifiedAt) await sendResumeEmail(deps, meta, draft, 'resend');
}

/** Applies the agency's policy when a newer form version was published after the draft began. */
async function applyFormChangePolicy(deps: AppDeps, draftId: string) {
  const draft = await deps.db.selectFrom('applicationDrafts').select(['formVersionId', 'data', 'status']).where('id', '=', draftId).executeTakeFirstOrThrow();
  if (draft.status !== 'active') return false;
  const settings = await getSettings(deps.db);
  const form = await currentFormVersion(deps.db, 'candidate_application');
  if (form.id === draft.formVersionId || settings.draftFormChangePolicy !== 'migrate_on_resume') return false;
  const data = draft.data as ApplicationDataT;
  const known = questionsByKey(form.layout);
  const custom = Object.fromEntries(Object.entries(data.custom ?? {}).filter(([key]) => known.has(key)));
  await deps.db
    .updateTable('applicationDrafts')
    .set({ formVersionId: form.id, data: JSON.stringify({ ...data, custom }), revision: sql`revision + 1` })
    .where('id', '=', draftId)
    .execute();
  return true;
}

export async function draftState(deps: AppDeps, draftId: string, options: { applyPolicy?: boolean } = {}) {
  const migrated = options.applyPolicy ? await applyFormChangePolicy(deps, draftId) : false;
  const draft = await deps.db.selectFrom('applicationDrafts').selectAll().where('id', '=', draftId).executeTakeFirst();
  if (!draft) throw notFound('Application');
  const [form, documents, application] = await Promise.all([
    formVersionById(deps.db, draft.formVersionId),
    deps.db
      .selectFrom('documents')
      .select(['id', 'documentType', 'originalFilename', 'declaredContentType', 'sizeBytes', 'scanStatus', 'createdAt'])
      .where('applicationDraftId', '=', draftId)
      .where('deletedAt', 'is', null)
      .where('scanStatus', '<>', 'awaiting_upload')
      .orderBy('createdAt')
      .execute(),
    deps.db.selectFrom('applications').select(['reference', 'submittedAt']).where('draftId', '=', draftId).executeTakeFirst()
  ]);
  const current = await currentFormVersion(deps.db, 'candidate_application').catch(() => null);
  return {
    id: draft.id,
    status: draft.status,
    email: draft.email,
    emailVerified: Boolean(draft.emailVerifiedAt),
    revision: draft.revision,
    lastSavedAt: draft.lastSavedAt,
    expiresAt: draft.expiresAt,
    formVersionId: draft.formVersionId,
    formVersionNumber: form?.versionNumber ?? null,
    newerFormVersionAvailable: Boolean(current && current.id !== draft.formVersionId),
    formVersionMigrated: migrated,
    data: draft.data as ApplicationDataT,
    completedSections: filledSections(draft.data as ApplicationDataT),
    documents,
    submission: application ? { reference: application.reference, submittedAt: application.submittedAt } : null
  };
}

export async function saveSection(deps: AppDeps, meta: RequestMeta, draftId: string, section: SectionKey, input: { revision: number; data: unknown }) {
  const parsed = SECTION_SCHEMAS[section].safeParse(input.data);
  if (!parsed.success) throw validationFailed(zodFieldErrors(parsed.error, `${section}`));
  const now = deps.clock.now();
  const settings = await getSettings(deps.db);
  return deps.db.transaction().execute(async trx => {
    const draft = await trx.selectFrom('applicationDrafts').select(['status', 'revision', 'data', 'formVersionId', 'expiresAt']).where('id', '=', draftId).forUpdate().executeTakeFirstOrThrow();
    if (draft.status !== 'active') throw conflict('This application has already been submitted.', 'draft_not_active');
    if (new Date(draft.expiresAt) < now) throw new AppError(410, 'draft_expired', 'This draft has expired. Please start a new application.');
    if (draft.revision !== input.revision) {
      throw conflict('Your application was saved from another tab or device. Reload to continue.', 'revision_conflict', { currentRevision: draft.revision, lastSection: section });
    }
    let value: unknown = parsed.data;
    if (section === 'custom') {
      const form = await formVersionById(trx, draft.formVersionId);
      const result = validateCustomAnswers(form!.layout, parsed.data as Record<string, unknown>, { partial: true });
      if (result.errors.length) throw validationFailed(result.errors);
      value = parsed.data;
    }
    const data = { ...(draft.data as ApplicationDataT), [section]: value };
    const updated = await trx
      .updateTable('applicationDrafts')
      .set({
        data: JSON.stringify(data),
        revision: draft.revision + 1,
        lastSavedAt: now.toISOString(),
        completedSections: filledSections(data),
        // Sliding expiry: an active applicant keeps the draft alive.
        expiresAt: new Date(now.getTime() + settings.draftExpiryDays * DAY).toISOString()
      })
      .where('id', '=', draftId)
      .returning(['revision', 'lastSavedAt', 'completedSections', 'expiresAt'])
      .executeTakeFirstOrThrow();
    if (meta.actor.type === 'applicant') {
      // Saves are frequent; record only the first save of each section in the audit trail.
      const prior = (draft.data as Record<string, unknown>)[section];
      if (prior === undefined) await audit(trx, meta, { action: 'application.section_started', subjectType: 'application_draft', subjectId: draftId, metadata: { section } });
    }
    return updated;
  });
}

export async function signOutDraft(deps: AppDeps, reply: FastifyReply, sessionTokenId: string) {
  await deps.db.updateTable('draftAccessTokens').set({ revokedAt: deps.clock.now().toISOString() }).where('id', '=', sessionTokenId).execute();
  setDraftCookie(deps, reply, null);
}

export async function assertVerified(db: Executor, draftId: string) {
  const draft = await db.selectFrom('applicationDrafts').select(['emailVerifiedAt', 'status']).where('id', '=', draftId).executeTakeFirstOrThrow();
  if (!draft.emailVerifiedAt) throw new AppError(403, 'email_not_verified', 'Confirm your email address first (use the code or link we sent).');
  if (draft.status !== 'active') throw conflict('This application has already been submitted.', 'draft_not_active');
}

