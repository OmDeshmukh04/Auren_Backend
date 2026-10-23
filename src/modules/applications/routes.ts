import { z } from 'zod';
import type { AppDeps } from '../../context.js';
import { defineRoute, WithStatus, type AnyRoute } from '../../http/route.js';
import { Email, Id, Ok, Timestamp } from '../../http/schemas.js';
import { notFound, validationFailed } from '../../http/errors.js';
import { enforceRateLimit } from '../../http/security.js';
import { clientIp } from '../../http/register.js';
import { audit } from '../../domain/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { Utm } from '../families/enquiries.js';
import { completeUpload, createUploadSlot, documentState, storeUploadedBytes } from '../documents/files.js';
import { ApplicationData, SECTION_KEYS, type SectionKey } from './sections.js';
import { assertVerified, draftState, requestResumeLink, resendCode, resumeWithToken, saveSection, signOutDraft, startDraft, verifyCode } from './drafts.js';
import { submitApplication } from './submit.js';

const DraftDocument = z
  .object({ id: Id, documentType: z.string(), originalFilename: z.string(), declaredContentType: z.string(), sizeBytes: z.int().nullable(), scanStatus: z.enum(['awaiting_upload', 'quarantined', 'clean', 'rejected', 'scan_failed']), createdAt: Timestamp })
  .meta({ id: 'DraftDocument' });

export const DraftState = z
  .object({
    id: Id,
    status: z.enum(['active', 'submitted', 'expired', 'withdrawn']),
    email: z.string(),
    emailVerified: z.boolean().meta({ description: 'Uploads and submission require a verified email (code or resume link).' }),
    revision: z.int().meta({ description: 'Send with each section save; a mismatch returns 409 revision_conflict.' }),
    lastSavedAt: Timestamp.nullable(),
    expiresAt: Timestamp,
    formVersionId: Id,
    formVersionNumber: z.int().nullable(),
    newerFormVersionAvailable: z.boolean(),
    formVersionMigrated: z.boolean(),
    data: ApplicationData,
    completedSections: z.array(z.string()),
    documents: z.array(DraftDocument),
    submission: z.object({ reference: z.string(), submittedAt: Timestamp }).nullable()
  })
  .meta({ id: 'ApplicationDraftState' });

const UploadSlot = z
  .object({
    document: z.object({ id: Id, documentType: z.string(), originalFilename: z.string(), scanStatus: z.string() }),
    upload: z.object({ method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: Timestamp })
  })
  .meta({ id: 'UploadSlot', description: 'PUT the raw file bytes to upload.url with upload.headers, then call the complete endpoint.' });

const UploadRequest = z
  .object({
    documentType: z.enum(['resume', 'certificate', 'photo', 'introduction', 'reference_letter']),
    fileName: z.string().min(1).max(255),
    contentType: z.enum(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png']),
    sizeBytes: z.int().positive()
  })
  .meta({ id: 'ApplicantUploadRequest' });

const DocumentStateSchema = z
  .object({ id: Id, documentType: z.string(), originalFilename: z.string(), declaredContentType: z.string(), detectedType: z.string().nullable(), sizeBytes: z.int().nullable(), scanStatus: z.string(), scanDetail: z.string().nullable(), scannedAt: Timestamp.nullable(), createdAt: Timestamp })
  .meta({ id: 'DocumentScanState' });

const BASE = '/public/application-drafts';

async function ownDocument(deps: AppDeps, draftId: string, documentId: string) {
  const doc = await deps.db.selectFrom('documents').select(['id']).where('id', '=', documentId).where('applicationDraftId', '=', draftId).where('deletedAt', 'is', null).executeTakeFirst();
  if (!doc) throw notFound('Upload');
}

export const applicationRoutes: AnyRoute[] = [
  defineRoute({
    method: 'POST',
    path: BASE,
    operationId: 'startApplicationDraft',
    summary: 'Start a candidate application',
    description:
      'Creates a draft and sets the applicant session cookie (auren_draft) for this browser. A code and a single-use resume link are emailed; ' +
      'verify with POST …/current/verify or by opening the link. The response is the same whether or not the email was used before.',
    tags: ['Applications'],
    access: { kind: 'public' },
    body: z.object({
      email: Email,
      firstName: z.string().trim().min(1, 'Enter your first name').max(80),
      source: z.string().trim().max(60).regex(/^[\w .:/-]*$/).optional(),
      utm: Utm.optional(),
      captchaToken: z.string().max(4000).optional(),
      website: z.string().max(500).optional()
    }),
    response: DraftState,
    status: 201,
    rateLimits: [{ name: 'draft-start', max: 10, windowSeconds: 60 * 60 }],
    async handler({ deps, meta, reply, req, body }) {
      if (body.website) throw validationFailed([{ path: 'email', code: 'invalid', message: 'Please try again' }]);
      if (deps.captcha.enabled && !(await deps.captcha.verify(body.captchaToken, clientIp(req)))) {
        throw validationFailed([{ path: 'captchaToken', code: 'captcha_failed', message: 'Please complete the verification step.' }]);
      }
      await enforceRateLimit(deps, `draft-start-email:${sha256(body.email)}`, 5, 24 * 60 * 60);
      return startDraft(deps, meta, reply, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: `${BASE}/resume-link`,
    operationId: 'requestApplicationResumeLink',
    summary: 'Email a link to continue an application',
    description: 'Always 202. If the email has an active draft, a new link (and code) is sent to that address.',
    tags: ['Applications'],
    access: { kind: 'public' },
    body: z.object({ email: Email }),
    response: Ok,
    status: 202,
    rateLimits: [{ name: 'draft-resume-request', max: 10, windowSeconds: 60 * 60 }],
    async handler({ deps, meta, body }) {
      await enforceRateLimit(deps, `draft-resume-email:${sha256(body.email)}`, 3, 60 * 60);
      await requestResumeLink(deps, meta, body.email);
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'POST',
    path: `${BASE}/resume`,
    operationId: 'resumeApplicationDraft',
    summary: 'Exchange an emailed resume token for a session',
    description: 'The frontend page /apply/resume?token=… calls this. The token is single-use; the response sets the session cookie.',
    tags: ['Applications'],
    access: { kind: 'public' },
    body: z.object({ token: z.string().min(20).max(200) }),
    response: DraftState,
    rateLimits: [{ name: 'draft-resume', max: 20, windowSeconds: 60 * 60 }],
    async handler({ deps, meta, reply, body }) {
      return resumeWithToken(deps, meta, reply, body.token) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: `${BASE}/current`,
    operationId: 'getCurrentApplicationDraft',
    summary: 'The draft for this applicant session',
    tags: ['Applications'],
    access: { kind: 'applicant' },
    response: DraftState,
    async handler({ deps, applicant }) {
      return draftState(deps, applicant.draftId, { applyPolicy: true }) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: `${BASE}/current/verify`,
    operationId: 'verifyApplicationEmail',
    summary: 'Verify the email with the 6-digit code',
    tags: ['Applications'],
    access: { kind: 'applicant' },
    body: z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
    response: DraftState,
    rateLimits: [{ name: 'draft-verify', max: 20, windowSeconds: 60 * 60 }],
    async handler({ deps, meta, applicant, body }) {
      return verifyCode(deps, meta, applicant.draftId, body.code) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: `${BASE}/current/resend-code`,
    operationId: 'resendApplicationCode',
    summary: 'Send a new verification code',
    tags: ['Applications'],
    access: { kind: 'applicant' },
    response: Ok,
    status: 202,
    rateLimits: [{ name: 'draft-resend', max: 5, windowSeconds: 60 * 60 }],
    async handler({ deps, meta, applicant }) {
      await resendCode(deps, meta, applicant.draftId);
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'PUT',
    path: `${BASE}/current/sections/:section`,
    operationId: 'saveApplicationSection',
    summary: 'Autosave one section',
    description:
      'Section bodies follow the Application*Section schemas (types only; required rules apply at submit). Send the latest `revision`. ' +
      'On 409 revision_conflict another tab saved first: reload with GET …/current.',
    tags: ['Applications'],
    access: { kind: 'applicant' },
    params: z.object({ section: z.enum(SECTION_KEYS as [SectionKey, ...SectionKey[]]) }),
    body: z.object({ revision: z.int().positive(), data: z.unknown() }),
    response: z.object({ revision: z.int(), lastSavedAt: Timestamp.nullable(), completedSections: z.array(z.string()), expiresAt: Timestamp }).meta({ id: 'SectionSaved' }),
    rateLimits: [{ name: 'draft-save', max: 600, windowSeconds: 60 * 60 }],
    async handler({ deps, meta, applicant, params, body }) {
      return saveSection(deps, meta, applicant.draftId, params.section, body);
    }
  }),
  defineRoute({
    method: 'POST',
    path: `${BASE}/current/uploads`,
    operationId: 'createApplicantUpload',
    summary: 'Start a document upload',
    description: 'Requires a verified email. Allowed: resume/introduction (PDF, DOCX), certificate/reference letter (PDF, JPG, PNG), photo (JPG, PNG).',
    tags: ['Applications'],
    access: { kind: 'applicant' },
    body: UploadRequest,
    response: UploadSlot,
    status: 201,
    rateLimits: [{ name: 'draft-upload', max: 40, windowSeconds: 60 * 60 }],
    async handler({ deps, meta, applicant, body }) {
      await assertVerified(deps.db, applicant.draftId);
      const count = await deps.db.selectFrom('documents').select(eb => eb.fn.countAll<number>().as('n')).where('applicationDraftId', '=', applicant.draftId).where('deletedAt', 'is', null).executeTakeFirstOrThrow();
      if (Number(count.n) >= 15) throw validationFailed([{ path: 'documentType', code: 'too_many', message: 'Remove a document before adding another (15 maximum)' }]);
      return createUploadSlot(deps, meta, { applicationDraftId: applicant.draftId, uploadedByType: 'applicant' }, body, id => `${BASE}/current/uploads/${id}/content`);
    }
  }),
  defineRoute({
    method: 'PUT',
    path: `${BASE}/current/uploads/:id/content`,
    operationId: 'uploadApplicantFileContent',
    summary: 'Upload file bytes (when the slot URL points at the API)',
    tags: ['Applications'],
    access: { kind: 'applicant' },
    params: z.object({ id: Id }),
    binaryBodyLimit: 52_428_800,
    response: Ok,
    async handler({ deps, applicant, params, body }) {
      await storeUploadedBytes(deps, params.id, body as Buffer, (_db, id) => ownDocument(deps, applicant.draftId, id));
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'POST',
    path: `${BASE}/current/uploads/:id/complete`,
    operationId: 'completeApplicantUpload',
    summary: 'Finish an upload: validate and scan',
    description: 'Returns scanStatus clean, rejected (with scanDetail) or quarantined (scanner unavailable; retried automatically).',
    tags: ['Applications'],
    access: { kind: 'applicant' },
    params: z.object({ id: Id }),
    response: DocumentStateSchema,
    async handler({ deps, meta, applicant, params }) {
      await ownDocument(deps, applicant.draftId, params.id);
      return completeUpload(deps, meta, params.id) as never;
    }
  }),
  defineRoute({
    method: 'DELETE',
    path: `${BASE}/current/uploads/:id`,
    operationId: 'deleteApplicantUpload',
    summary: 'Remove an uploaded document from the draft',
    tags: ['Applications'],
    access: { kind: 'applicant' },
    params: z.object({ id: Id }),
    response: Ok,
    async handler({ deps, meta, applicant, params }) {
      await assertVerified(deps.db, applicant.draftId);
      await ownDocument(deps, applicant.draftId, params.id);
      const doc = await documentState(deps.db, params.id);
      await deps.db.updateTable('documents').set({ deletedAt: deps.clock.now().toISOString() }).where('id', '=', params.id).execute();
      const key = await deps.db.selectFrom('documents').select('storageKey').where('id', '=', params.id).executeTakeFirstOrThrow();
      await deps.privateStorage.delete(key.storageKey).catch(() => {});
      await audit(deps.db, meta, { action: 'document.deleted', subjectType: 'document', subjectId: params.id, metadata: { documentType: doc.documentType } });
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'POST',
    path: `${BASE}/current/submit`,
    operationId: 'submitApplication',
    summary: 'Submit the application',
    description:
      'Requires an Idempotency-Key (one per submit button press sequence; reuse on retry). Validates every section; 422 lists fieldErrors ' +
      'by section path. Returns 201 only after everything is saved.',
    tags: ['Applications'],
    access: { kind: 'applicant' },
    idempotency: 'required',
    response: z.object({ reference: z.string(), submittedAt: Timestamp }).meta({ id: 'ApplicationReceipt' }),
    status: 201,
    rateLimits: [{ name: 'draft-submit', max: 20, windowSeconds: 60 * 60 }],
    async handler({ deps, meta, applicant, idempotencyKey }) {
      const result = await submitApplication(deps, meta, applicant.draftId, idempotencyKey!);
      return new WithStatus(result.status, result.body, result.replayed ? { 'Idempotent-Replayed': 'true' } : {});
    }
  }),
  defineRoute({
    method: 'POST',
    path: `${BASE}/current/sign-out`,
    operationId: 'signOutApplicationDraft',
    summary: 'End the applicant session on this device',
    tags: ['Applications'],
    access: { kind: 'applicant' },
    response: Ok,
    async handler({ deps, reply, applicant }) {
      await signOutDraft(deps, reply, applicant.sessionTokenId);
      return { ok: true as const };
    }
  })
];
