import { randomUUID } from 'node:crypto';
import type { AppDeps, RequestMeta } from '../../context.js';
import type { Executor } from '../../db/index.js';
import { audit } from '../../domain/audit.js';
import { getSettings } from '../../domain/settings.js';
import { notFound, unprocessable, validationFailed } from '../../http/errors.js';
import { sha256, signPayload, verifySignedPayload } from '../../lib/crypto.js';
import { API_PREFIX } from '../../http/register.js';

/**
 * Private uploads: scoped slot -> bytes under a random key -> size/type/signature validation ->
 * quarantine -> malware scan -> clean or rejected. Only clean files can be downloaded or
 * attached, and only after an authorization check. HTML, SVG, executables and archives other
 * than DOCX are refused.
 */

export type DetectedType = 'pdf' | 'docx' | 'jpg' | 'png';

export const MIME: Record<DetectedType, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg',
  png: 'image/png'
};
const MIME_TO_TYPE = Object.fromEntries(Object.entries(MIME).map(([type, mime]) => [mime, type as DetectedType]));

/** Identifies a file from its bytes; returns null for anything not allowed. */
export function detectFileType(bytes: Buffer): DetectedType | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    // A DOCX is a ZIP with a [Content_Types].xml and a word/ part. Macro-enabled documents are refused.
    const listing = bytes.toString('latin1');
    if (listing.includes('[Content_Types].xml') && listing.includes('word/') && !listing.includes('vbaProject.bin')) return 'docx';
  }
  return null;
}

const DOCUMENT_TYPE_FORMATS: Record<string, DetectedType[]> = {
  resume: ['pdf', 'docx'],
  certificate: ['pdf', 'jpg', 'png'],
  photo: ['jpg', 'png'],
  introduction: ['pdf', 'docx'],
  reference_letter: ['pdf', 'docx', 'jpg', 'png'],
  agreement: ['pdf', 'docx'],
  other: ['pdf', 'docx', 'jpg', 'png']
};

export const sanitizeFilename = (name: string) =>
  name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200) || 'document';

export interface SlotInput {
  documentType: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface SlotOwner {
  candidateId?: string | null;
  applicationDraftId?: string | null;
  familyId?: string | null;
  uploadedByType: 'applicant' | 'staff';
  uploadedByStaffId?: string | null;
}

/** Creates the document row (awaiting upload) and returns where the client should PUT the bytes. */
export async function createUploadSlot(deps: AppDeps, meta: RequestMeta, owner: SlotOwner, input: SlotInput, contentPath: (documentId: string) => string) {
  const settings = await getSettings(deps.db);
  const detected = MIME_TO_TYPE[input.contentType];
  const allowedFormats = (DOCUMENT_TYPE_FORMATS[input.documentType] ?? []).filter(format => settings.allowedUploadTypes.includes(format));
  if (!detected || !allowedFormats.includes(detected)) {
    throw validationFailed([{ path: 'contentType', code: 'unsupported_type', message: `Upload ${allowedFormats.map(f => f.toUpperCase()).join(', ') || 'a supported file'} for this document` }]);
  }
  if (input.sizeBytes > settings.uploadMaxBytes) {
    throw validationFailed([{ path: 'sizeBytes', code: 'too_big', message: `Files must be ${Math.floor(settings.uploadMaxBytes / 1048576)} MB or smaller` }]);
  }
  const now = deps.clock.now();
  const storageKey = `private/${now.toISOString().slice(0, 7).replace('-', '/')}/${randomUUID()}`;
  const expires = new Date(now.getTime() + 15 * 60_000);
  const document = await deps.db
    .insertInto('documents')
    .values({
      documentType: input.documentType,
      candidateId: owner.candidateId ?? null,
      applicationDraftId: owner.applicationDraftId ?? null,
      familyId: owner.familyId ?? null,
      originalFilename: sanitizeFilename(input.fileName),
      declaredContentType: input.contentType,
      sizeBytes: input.sizeBytes,
      storageKey,
      scanStatus: 'awaiting_upload',
      uploadExpiresAt: expires.toISOString(),
      uploadedByType: owner.uploadedByType,
      uploadedByStaffId: owner.uploadedByStaffId ?? null,
      createdAt: now.toISOString()
    })
    .returning(['id', 'documentType', 'originalFilename', 'scanStatus'])
    .executeTakeFirstOrThrow();
  const direct = await deps.privateStorage.createUploadUrl(storageKey, { contentType: input.contentType, expiresInSeconds: 15 * 60 });
  const upload = direct ?? {
    method: 'PUT' as const,
    url: `${deps.config.API_PUBLIC_URL.replace(/\/$/, '')}${API_PREFIX}${contentPath(document.id)}`,
    headers: { 'Content-Type': 'application/octet-stream' },
    expiresAt: expires.toISOString()
  };
  await audit(deps.db, meta, { action: 'document.upload_started', subjectType: 'document', subjectId: document.id, metadata: { documentType: input.documentType } });
  return { document, upload };
}

/** Stores bytes for API-mediated uploads (local/memory storage). */
export async function storeUploadedBytes(deps: AppDeps, documentId: string, bytes: Buffer, scope: (db: Executor, id: string) => Promise<void>) {
  await scope(deps.db, documentId);
  const document = await deps.db.selectFrom('documents').select(['storageKey', 'scanStatus', 'uploadExpiresAt', 'declaredContentType']).where('id', '=', documentId).executeTakeFirst();
  if (!document) throw notFound('Upload');
  if (document.scanStatus !== 'awaiting_upload') throw unprocessable('This upload was already received.', 'upload_complete');
  if (document.uploadExpiresAt && new Date(document.uploadExpiresAt) < deps.clock.now()) throw unprocessable('This upload link has expired. Start the upload again.', 'upload_expired');
  const settings = await getSettings(deps.db);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw validationFailed([{ path: 'body', code: 'required', message: 'Send the file bytes' }]);
  if (bytes.length > settings.uploadMaxBytes) throw validationFailed([{ path: 'body', code: 'too_big', message: 'The file is too large' }]);
  await deps.privateStorage.put(document.storageKey, bytes, document.declaredContentType);
}

/**
 * Finalizes an upload: verifies size and signature, records the hash, quarantines, then scans.
 * A scanner failure leaves the file quarantined (retry with rescan); an infected or invalid file
 * is rejected and its bytes deleted.
 */
export async function completeUpload(deps: AppDeps, meta: RequestMeta, documentId: string) {
  const document = await deps.db.selectFrom('documents').selectAll().where('id', '=', documentId).executeTakeFirst();
  if (!document || document.deletedAt) throw notFound('Upload');
  if (document.scanStatus === 'clean' || document.scanStatus === 'rejected') return documentState(deps.db, documentId);
  const bytes = await deps.privateStorage.get(document.storageKey);
  if (!bytes) throw unprocessable('The file has not been uploaded yet.', 'upload_missing');
  const settings = await getSettings(deps.db);
  const detected = detectFileType(bytes);
  const reject = async (detail: string) => {
    await deps.privateStorage.delete(document.storageKey);
    await deps.db.updateTable('documents').set({ scanStatus: 'rejected', scanDetail: detail, scannedAt: deps.clock.now().toISOString() }).where('id', '=', documentId).execute();
    await audit(deps.db, meta, { action: 'document.rejected', subjectType: 'document', subjectId: documentId, metadata: { reason: detail } });
  };
  if (bytes.length > settings.uploadMaxBytes) {
    await reject('File exceeds the size limit');
  } else if (!detected || MIME[detected] !== document.declaredContentType || !(DOCUMENT_TYPE_FORMATS[document.documentType] ?? []).includes(detected)) {
    await reject('File contents do not match an allowed type');
  } else {
    await deps.db
      .updateTable('documents')
      .set({ scanStatus: 'quarantined', detectedType: detected, sizeBytes: bytes.length, sha256: sha256(bytes) })
      .where('id', '=', documentId)
      .execute();
    await scanDocument(deps, meta, documentId, bytes);
  }
  return documentState(deps.db, documentId);
}

export async function scanDocument(deps: AppDeps, meta: RequestMeta, documentId: string, bytes?: Buffer) {
  const document = await deps.db.selectFrom('documents').select(['storageKey', 'scanStatus']).where('id', '=', documentId).executeTakeFirstOrThrow();
  if (document.scanStatus !== 'quarantined' && document.scanStatus !== 'scan_failed') return;
  const content = bytes ?? (await deps.privateStorage.get(document.storageKey));
  if (!content) return;
  const verdict = await deps.scanner.scan(content).catch(error => ({ verdict: 'error' as const, detail: (error as Error).message }));
  const now = deps.clock.now().toISOString();
  if (verdict.verdict === 'clean') {
    await deps.db.updateTable('documents').set({ scanStatus: 'clean', scanDetail: null, scannedAt: now }).where('id', '=', documentId).execute();
  } else if (verdict.verdict === 'infected') {
    await deps.privateStorage.delete(document.storageKey);
    await deps.db.updateTable('documents').set({ scanStatus: 'rejected', scanDetail: `Malware detected: ${verdict.detail}`, scannedAt: now }).where('id', '=', documentId).execute();
    await audit(deps.db, meta, { action: 'document.malware_rejected', subjectType: 'document', subjectId: documentId });
  } else {
    await deps.db.updateTable('documents').set({ scanStatus: 'quarantined', scanDetail: verdict.detail.slice(0, 500) }).where('id', '=', documentId).execute();
  }
}

export async function documentState(db: Executor, documentId: string) {
  return db
    .selectFrom('documents')
    .select(['id', 'documentType', 'originalFilename', 'declaredContentType', 'detectedType', 'sizeBytes', 'scanStatus', 'scanDetail', 'scannedAt', 'createdAt', 'expiresOn', 'candidateId'])
    .where('id', '=', documentId)
    .executeTakeFirstOrThrow();
}

/** A short-lived signed link to the content endpoint (works for <a href> and new tabs). */
export function contentToken(deps: AppDeps, input: { documentId: string; staffId: string; ttlSeconds?: number }) {
  const exp = Math.floor(deps.clock.now().getTime() / 1000) + (input.ttlSeconds ?? 120);
  return { token: signPayload(deps.config.SIGNING_SECRET, { d: input.documentId, s: input.staffId, exp }), expiresAt: new Date(exp * 1000).toISOString() };
}

export function readContentToken(deps: AppDeps, token: string) {
  return verifySignedPayload<{ d: string; s: string; exp: number }>(deps.config.SIGNING_SECRET, token, deps.clock.now().getTime());
}
