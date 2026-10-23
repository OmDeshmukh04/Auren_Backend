import { z } from 'zod';
import type { AppDeps, StaffActor } from '../../context.js';
import { defineRoute, RawResponse, type AnyRoute } from '../../http/route.js';
import { DateOnly, Id, IdParams, Ok, Timestamp, StaffRef } from '../../http/schemas.js';
import { forbidden, notFound, unauthorized, unprocessable } from '../../http/errors.js';
import { audit } from '../../domain/audit.js';
import { assertInScope } from '../../domain/records.js';
import { API_PREFIX } from '../../http/register.js';
import { ROLE_PERMISSIONS, type StaffRole } from '../../auth/permissions.js';
import { completeUpload, contentToken, createUploadSlot, documentState, readContentToken, scanDocument, storeUploadedBytes } from './files.js';
import { contentDisposition } from '../../providers/storage.js';

export const StaffDocument = z
  .object({
    id: Id,
    documentType: z.string(),
    originalFilename: z.string(),
    declaredContentType: z.string(),
    detectedType: z.string().nullable(),
    sizeBytes: z.int().nullable(),
    scanStatus: z.string(),
    scanDetail: z.string().nullable(),
    scannedAt: Timestamp.nullable(),
    expiresOn: DateOnly.nullable(),
    uploadedByType: z.string(),
    uploadedBy: StaffRef,
    createdAt: Timestamp
  })
  .meta({ id: 'Document' });

const StaffUploadRequest = z
  .object({
    documentType: z.enum(['resume', 'certificate', 'photo', 'introduction', 'reference_letter', 'other']),
    fileName: z.string().min(1).max(255),
    contentType: z.enum(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png']),
    sizeBytes: z.int().positive(),
    expiresOn: DateOnly.optional()
  })
  .meta({ id: 'StaffUploadRequest' });

/** Loads a document and checks the caller may access its candidate or family. */
async function authorizedDocument(deps: AppDeps, staff: StaffActor, id: string) {
  const document = await deps.db
    .selectFrom('documents as d')
    .leftJoin('candidates as c', 'c.id', 'd.candidateId')
    .leftJoin('families as f', 'f.id', 'd.familyId')
    .selectAll('d')
    .select(['c.assignedStaffId as candidateAssignee', 'f.assignedStaffId as familyAssignee'])
    .where('d.id', '=', id)
    .where('d.deletedAt', 'is', null)
    .executeTakeFirst();
  if (!document) throw notFound('Document');
  // Exports and presentation PDFs have their own endpoints; drafts are reachable only after submission.
  if (!document.candidateId && !document.familyId) throw notFound('Document');
  await assertInScope(deps.db, staff, document.candidateAssignee ?? document.familyAssignee);
  return document;
}

export const documentRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/candidates/:id/documents',
    operationId: 'listCandidateDocuments',
    summary: 'Documents on a candidate record',
    tags: ['Documents'],
    access: { kind: 'staff', permission: 'documents.read' },
    params: IdParams,
    response: z.object({ items: z.array(StaffDocument) }),
    async handler({ deps, staff, params }) {
      const candidate = await deps.db.selectFrom('candidates').select('assignedStaffId').where('id', '=', params.id).executeTakeFirst();
      if (!candidate) throw notFound('Candidate');
      await assertInScope(deps.db, staff, candidate.assignedStaffId);
      const rows = await deps.db
        .selectFrom('documents as d')
        .leftJoin('staffMembers as s', 's.id', 'd.uploadedByStaffId')
        .select(['d.id', 'd.documentType', 'd.originalFilename', 'd.declaredContentType', 'd.detectedType', 'd.sizeBytes', 'd.scanStatus', 'd.scanDetail', 'd.scannedAt', 'd.expiresOn', 'd.uploadedByType', 'd.uploadedByStaffId', 's.displayName', 'd.createdAt'])
        .where('d.candidateId', '=', params.id)
        .where('d.deletedAt', 'is', null)
        .where('d.scanStatus', '<>', 'awaiting_upload')
        .where('d.documentType', 'not in', ['presentation_pdf', 'export'])
        .orderBy('d.createdAt', 'desc')
        .execute();
      return { items: rows.map(row => ({ ...row, uploadedBy: row.uploadedByStaffId ? { id: row.uploadedByStaffId, displayName: row.displayName ?? '' } : null })) };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/candidates/:id/documents',
    operationId: 'createCandidateDocumentUpload',
    summary: 'Start a staff upload to a candidate record',
    tags: ['Documents'],
    access: { kind: 'staff', permission: 'documents.write' },
    params: IdParams,
    body: StaffUploadRequest,
    response: z.object({
      document: z.object({ id: Id, documentType: z.string(), originalFilename: z.string(), scanStatus: z.string() }),
      upload: z.object({ method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: Timestamp })
    }),
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      const candidate = await deps.db.selectFrom('candidates').select('assignedStaffId').where('id', '=', params.id).executeTakeFirst();
      if (!candidate) throw notFound('Candidate');
      await assertInScope(deps.db, staff, candidate.assignedStaffId);
      const slot = await createUploadSlot(deps, meta, { candidateId: params.id, uploadedByType: 'staff', uploadedByStaffId: staff.staffId }, body, id => `/documents/${id}/content`);
      if (body.expiresOn) await deps.db.updateTable('documents').set({ expiresOn: body.expiresOn }).where('id', '=', slot.document.id).execute();
      return slot;
    }
  }),
  defineRoute({
    method: 'PUT',
    path: '/documents/:id/content',
    operationId: 'uploadStaffFileContent',
    summary: 'Upload file bytes for a staff upload slot',
    tags: ['Documents'],
    access: { kind: 'staff', permission: 'documents.write' },
    params: IdParams,
    binaryBodyLimit: 52_428_800,
    response: Ok,
    async handler({ deps, staff, params, body }) {
      await storeUploadedBytes(deps, params.id, body as Buffer, async (db, id) => {
        const doc = await db.selectFrom('documents').select(['uploadedByStaffId']).where('id', '=', id).executeTakeFirst();
        if (!doc || doc.uploadedByStaffId !== staff.staffId) throw notFound('Upload');
      });
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/documents/:id/complete',
    operationId: 'completeStaffUpload',
    summary: 'Finish a staff upload: validate and scan',
    tags: ['Documents'],
    access: { kind: 'staff', permission: 'documents.write' },
    params: IdParams,
    response: StaffDocument,
    async handler({ deps, meta, staff, params }) {
      await authorizedDocument(deps, staff, params.id);
      await completeUpload(deps, meta, params.id);
      const doc = await documentState(deps.db, params.id);
      return { ...doc, uploadedByType: 'staff', uploadedBy: { id: staff.staffId, displayName: staff.displayName } } as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/documents/:id/download-link',
    operationId: 'createDocumentDownloadLink',
    summary: 'Get a short-lived download link (audited)',
    description: 'Only clean files. The link expires in about two minutes and serves the file as an attachment.',
    tags: ['Documents'],
    access: { kind: 'staff', permission: 'documents.read' },
    params: IdParams,
    response: z.object({ url: z.string(), expiresAt: Timestamp }).meta({ id: 'DownloadLink' }),
    async handler({ deps, meta, staff, params }) {
      const document = await authorizedDocument(deps, staff, params.id);
      if (document.scanStatus !== 'clean') throw unprocessable('This file is not available (not scanned clean).', 'document_unavailable');
      await audit(deps.db, meta, { action: 'document.download_link_issued', subjectType: 'document', subjectId: params.id, metadata: { documentType: document.documentType, candidateId: document.candidateId } });
      const direct = await deps.privateStorage.createDownloadUrl(document.storageKey, { filename: document.originalFilename, contentType: document.declaredContentType, expiresInSeconds: 120 });
      if (direct) return { url: direct, expiresAt: new Date(deps.clock.now().getTime() + 120_000).toISOString() };
      const { token, expiresAt } = contentToken(deps, { documentId: params.id, staffId: staff.staffId });
      return { url: `${deps.config.API_PUBLIC_URL.replace(/\/$/, '')}${API_PREFIX}/documents/${params.id}/content?token=${encodeURIComponent(token)}`, expiresAt };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/documents/:id/content',
    operationId: 'downloadDocumentContent',
    summary: 'Download file bytes with a signed link',
    tags: ['Documents'],
    access: { kind: 'public' },
    params: IdParams,
    query: z.object({ token: z.string().min(10).max(1000) }),
    produces: 'application/octet-stream',
    response: z.unknown(),
    async handler({ deps, meta, params, query }) {
      const payload = readContentToken(deps, query.token);
      if (!payload || payload.d !== params.id) throw unauthorized('This download link has expired.', 'download_link_invalid');
      const staff = await deps.db.selectFrom('staffMembers').select(['status', 'role']).where('id', '=', payload.s).executeTakeFirst();
      if (!staff || staff.status !== 'active' || !ROLE_PERMISSIONS[staff.role as StaffRole].has('documents.read')) throw forbidden();
      const document = await deps.db.selectFrom('documents').selectAll().where('id', '=', params.id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!document || document.scanStatus !== 'clean') throw notFound('Document');
      const bytes = await deps.privateStorage.get(document.storageKey);
      if (!bytes) throw notFound('Document');
      await audit(deps.db, { ...meta, actor: { type: 'system', component: 'download' } }, { action: 'document.downloaded', subjectType: 'document', subjectId: params.id, metadata: { staffId: payload.s } });
      return new RawResponse(200, bytes, {
        'Content-Type': document.declaredContentType,
        'Content-Disposition': contentDisposition(document.originalFilename),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/documents/:id',
    operationId: 'updateDocument',
    summary: 'Set a document expiry date or type',
    tags: ['Documents'],
    access: { kind: 'staff', permission: 'documents.write' },
    params: IdParams,
    body: z.object({ expiresOn: DateOnly.nullable().optional(), documentType: z.enum(['resume', 'certificate', 'photo', 'introduction', 'reference_letter', 'other']).optional() }),
    response: Ok,
    async handler({ deps, meta, staff, params, body }) {
      await authorizedDocument(deps, staff, params.id);
      await deps.db.updateTable('documents').set(body).where('id', '=', params.id).execute();
      await audit(deps.db, meta, { action: 'document.updated', subjectType: 'document', subjectId: params.id, metadata: { fields: Object.keys(body) } });
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/documents/:id/rescan',
    operationId: 'rescanDocument',
    summary: 'Retry the malware scan for a quarantined file',
    tags: ['Documents'],
    access: { kind: 'staff', permission: 'documents.write' },
    params: IdParams,
    response: z.object({ scanStatus: z.string(), scanDetail: z.string().nullable() }),
    async handler({ deps, meta, staff, params }) {
      await authorizedDocument(deps, staff, params.id);
      await scanDocument(deps, meta, params.id);
      const doc = await documentState(deps.db, params.id);
      return { scanStatus: doc.scanStatus, scanDetail: doc.scanDetail };
    }
  }),
  defineRoute({
    method: 'DELETE',
    path: '/documents/:id',
    operationId: 'deleteDocument',
    summary: 'Delete a document (bytes removed; record kept for audit)',
    tags: ['Documents'],
    access: { kind: 'staff', permission: 'documents.write' },
    params: IdParams,
    response: Ok,
    async handler({ deps, meta, staff, params }) {
      const document = await authorizedDocument(deps, staff, params.id);
      await deps.db.updateTable('documents').set({ deletedAt: deps.clock.now().toISOString() }).where('id', '=', params.id).execute();
      await deps.privateStorage.delete(document.storageKey).catch(() => {});
      await audit(deps.db, meta, { action: 'document.deleted', subjectType: 'document', subjectId: params.id, metadata: { documentType: document.documentType } });
      return { ok: true as const };
    }
  })
];
