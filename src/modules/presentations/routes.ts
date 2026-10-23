import { z } from 'zod';
import { defineRoute, RawResponse, WithStatus, type AnyRoute } from '../../http/route.js';
import { Id, IdParams, Ok, Timestamp, Version } from '../../http/schemas.js';
import { notFound, unprocessable } from '../../http/errors.js';
import { audit } from '../../domain/audit.js';
import { getJob } from '../jobs/service.js';
import { API_PREFIX } from '../../http/register.js';
import { contentToken, readContentToken } from '../documents/files.js';
import { EligibilityResult } from '../candidates/schemas.js';
import { PRESENTATION_FIELDS } from './content.js';
import {
  approvePresentation, cancelPresentation, createPresentation, getPresentation, listPresentations, previewPresentation, recordFamilyFeedback,
  releasePresentation, updatePresentation
} from './service.js';

const Field = z.enum(PRESENTATION_FIELDS).meta({ id: 'PresentationField', description: 'Default-deny catalogue. Contact details, references, notes and screening details are not available.' });
const Overrides = z
  .object({
    introduction: z.string().max(3000).optional(),
    rationale: z.string().max(3000).optional(),
    availabilityText: z.string().max(500).optional(),
    compensationText: z.string().max(200).optional(),
    employmentIds: z.array(Id).max(30).optional()
  })
  .meta({ id: 'PresentationOverrides', description: 'Staff-written wording for this family.' });
const CandidateSelection = z
  .object({ jobCandidateId: Id, includedFields: z.array(Field).max(PRESENTATION_FIELDS.length).optional(), overrides: Overrides.optional(), sortOrder: z.int().optional() })
  .meta({ id: 'PresentationCandidateSelection' });

const Presentation = z
  .object({
    id: Id,
    reference: z.string(),
    jobOrderId: Id,
    jobTitle: z.string(),
    familyId: Id,
    familyName: z.string(),
    status: z.enum(['draft', 'approved', 'released', 'cancelled']),
    title: z.string(),
    coverNote: z.string().nullable(),
    recipient: z.object({ id: Id, name: z.string(), email: z.string().nullable(), authorizedRecipient: z.boolean() }).nullable(),
    latestSnapshotId: Id.nullable(),
    candidates: z.array(z.object({ id: Id, jobCandidateId: Id, candidateId: Id, name: z.string(), reference: z.string(), stage: z.string(), includedFields: z.array(z.string()), overrides: Overrides, sortOrder: z.int(), sharingPermissionConsentId: Id.nullable() })),
    snapshots: z.array(z.object({ id: Id, versionNumber: z.int(), contentSha256: z.string(), pdfDocumentId: Id.nullable(), pdfSha256: z.string().nullable(), approvedBy: Id, approvedAt: Timestamp, fieldSelection: z.unknown() })),
    releases: z.array(z.object({ id: Id, snapshotId: Id, recipientEmail: z.string(), releasedBy: Id, releasedAt: Timestamp, deliveryStatus: z.string().nullable() })),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp
  })
  .meta({ id: 'Presentation' });

const Preview = z
  .object({
    presentationId: Id,
    asOfDate: z.string(),
    ready: z.boolean(),
    issues: z.array(z.object({ candidateId: Id.nullable(), code: z.string(), message: z.string() })),
    candidates: z.array(z.object({ candidateId: Id, jobCandidateId: Id, includedFields: z.array(z.string()), content: z.record(z.string(), z.unknown()), eligibility: EligibilityResult, sharingPermissionConsentId: Id.nullable() }))
  })
  .meta({ id: 'PresentationPreview', description: 'Exactly what an approval would snapshot now.' });

export const presentationRoutes: AnyRoute[] = [
  defineRoute({ method: 'GET', path: '/jobs/:id/presentations', operationId: 'listJobPresentations', summary: 'Presentations for a job', tags: ['Presentations'], access: { kind: 'staff', permission: 'presentations.read' }, params: IdParams,
    response: z.object({ items: z.array(z.object({ id: Id, reference: z.string(), title: z.string(), status: z.string(), latestSnapshotId: Id.nullable(), createdAt: Timestamp, updatedAt: Timestamp, version: Version })) }),
    async handler({ deps, staff, params }) { await getJob(deps, deps.db, staff, params.id); return { items: await listPresentations(deps.db, params.id) }; } }),
  defineRoute({ method: 'POST', path: '/jobs/:id/presentations', operationId: 'createPresentation', summary: 'Draft a candidate presentation for a family', tags: ['Presentations'], access: { kind: 'staff', permission: 'presentations.write' }, params: IdParams,
    body: z.object({ title: z.string().trim().min(1).max(200).optional(), coverNote: z.string().max(3000).nullable().optional(), recipientContactId: Id.nullable().optional(), candidates: z.array(CandidateSelection).min(1).max(10) }),
    response: Presentation, status: 201, async handler({ deps, meta, staff, params, body }) { return (await createPresentation(deps, meta, staff, params.id, body)) as never; } }),
  defineRoute({ method: 'GET', path: '/presentations/:id', operationId: 'getPresentation', summary: 'Presentation with candidates, snapshots and releases', tags: ['Presentations'], access: { kind: 'staff', permission: 'presentations.read' }, params: IdParams, response: Presentation,
    async handler({ deps, staff, params }) { return (await getPresentation(deps, deps.db, staff, params.id)) as never; } }),
  defineRoute({ method: 'PATCH', path: '/presentations/:id', operationId: 'updatePresentation', summary: 'Edit a presentation (returns it to draft)', description: 'An approved presentation needs a new approval after any edit; the earlier snapshot is kept.', tags: ['Presentations'], access: { kind: 'staff', permission: 'presentations.write' }, params: IdParams,
    body: z.object({ version: Version, title: z.string().trim().min(1).max(200).optional(), coverNote: z.string().max(3000).nullable().optional(), recipientContactId: Id.nullable().optional(), candidates: z.array(CandidateSelection).min(1).max(10).optional() }),
    response: Presentation, async handler({ deps, meta, staff, params, body }) { return (await updatePresentation(deps, meta, staff, params.id, body)) as never; } }),
  defineRoute({ method: 'GET', path: '/presentations/:id/preview', operationId: 'previewPresentation', summary: 'Preview content, eligibility and blocking issues', tags: ['Presentations'], access: { kind: 'staff', permission: 'presentations.read' }, params: IdParams, response: Preview,
    async handler({ deps, staff, params }) { await getPresentation(deps, deps.db, staff, params.id); return (await previewPresentation(deps, deps.db, params.id)) as never; } }),
  defineRoute({ method: 'POST', path: '/presentations/:id/approve', operationId: 'approvePresentation', summary: 'Approve: freeze an immutable snapshot and generate the PDF', description: 'Fails with 422 presentation_not_ready (details.issues) when a candidate is not eligible, lacks sharing permission, or the recipient is not authorized.', tags: ['Presentations'], access: { kind: 'staff', permission: 'presentations.approve' }, params: IdParams,
    body: z.object({ version: Version }), response: z.object({ snapshotId: Id, presentation: Presentation }),
    async handler({ deps, meta, staff, params, body }) { return (await approvePresentation(deps, meta, staff, params.id, body)) as never; } }),
  defineRoute({ method: 'POST', path: '/presentations/:id/release', operationId: 'releasePresentation', summary: 'Send the approved snapshot to the family', description: 'Requires Idempotency-Key, recipientConfirmed and noRevocationAcknowledged (a downloaded PDF cannot be recalled). Eligibility and sharing permission are re-checked first.', tags: ['Presentations'], access: { kind: 'staff', permission: 'presentations.release' }, params: IdParams,
    body: z.object({ snapshotId: Id, recipientConfirmed: z.boolean(), noRevocationAcknowledged: z.boolean() }), idempotency: 'required',
    response: z.object({ releaseId: Id, deliveryId: Id }), status: 201,
    async handler({ deps, meta, staff, params, body, idempotencyKey }) {
      const result = await releasePresentation(deps, meta, staff, params.id, body, idempotencyKey!);
      return new WithStatus(result.status, result.body, result.replayed ? { 'Idempotent-Replayed': 'true' } : {});
    } }),
  defineRoute({ method: 'POST', path: '/presentations/:id/cancel', operationId: 'cancelPresentation', summary: 'Cancel a draft or approved presentation', tags: ['Presentations'], access: { kind: 'staff', permission: 'presentations.write' }, params: IdParams,
    body: z.object({ version: Version, reason: z.string().max(1000).optional() }), response: Ok, async handler({ deps, meta, staff, params, body }) { await cancelPresentation(deps, meta, staff, params.id, body); return { ok: true as const }; } }),
  defineRoute({ method: 'POST', path: '/presentations/:id/snapshots/:snapshotId/download-link', operationId: 'presentationPdfDownloadLink', summary: 'Short-lived link to an approved snapshot PDF (audited)', tags: ['Presentations'], access: { kind: 'staff', permission: 'presentations.read' },
    params: z.object({ id: Id, snapshotId: Id }), response: z.object({ url: z.string(), expiresAt: Timestamp }),
    async handler({ deps, meta, staff, params }) {
      await getPresentation(deps, deps.db, staff, params.id);
      const snapshot = await deps.db.selectFrom('presentationSnapshots').select(['pdfDocumentId']).where('id', '=', params.snapshotId).where('presentationId', '=', params.id).executeTakeFirst();
      if (!snapshot?.pdfDocumentId) throw notFound('Snapshot');
      await audit(deps.db, meta, { action: 'presentation.pdf_link_issued', subjectType: 'presentation', subjectId: params.id, metadata: { snapshotId: params.snapshotId } });
      const { token, expiresAt } = contentToken(deps, { documentId: snapshot.pdfDocumentId, staffId: staff.staffId });
      return { url: `${deps.config.API_PUBLIC_URL.replace(/\/$/, '')}${API_PREFIX}/presentations/${params.id}/snapshots/${params.snapshotId}/pdf?token=${encodeURIComponent(token)}`, expiresAt };
    } }),
  defineRoute({ method: 'GET', path: '/presentations/:id/snapshots/:snapshotId/pdf', operationId: 'downloadPresentationPdf', summary: 'Download an approved snapshot PDF with a signed link', tags: ['Presentations'], access: { kind: 'public' },
    params: z.object({ id: Id, snapshotId: Id }), query: z.object({ token: z.string().min(10).max(1000) }), produces: 'application/pdf', response: z.unknown(),
    async handler({ deps, meta, params, query }) {
      const payload = readContentToken(deps, query.token);
      const snapshot = await deps.db.selectFrom('presentationSnapshots').select(['pdfDocumentId']).where('id', '=', params.snapshotId).where('presentationId', '=', params.id).executeTakeFirst();
      if (!payload || !snapshot || payload.d !== snapshot.pdfDocumentId) throw unprocessable('This download link has expired.', 'download_link_invalid');
      const document = await deps.db.selectFrom('documents').select(['storageKey', 'originalFilename']).where('id', '=', snapshot.pdfDocumentId!).executeTakeFirstOrThrow();
      const bytes = await deps.privateStorage.get(document.storageKey);
      if (!bytes) throw notFound('PDF');
      await audit(deps.db, { ...meta, actor: { type: 'system', component: 'download' } }, { action: 'presentation.pdf_downloaded', subjectType: 'presentation', subjectId: params.id, metadata: { staffId: payload.s } });
      return new RawResponse(200, bytes, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${document.originalFilename}"`, 'Cache-Control': 'private, no-store' });
    } }),
  defineRoute({ method: 'POST', path: '/job-candidates/:id/feedback', operationId: 'recordFamilyFeedback', summary: 'Record family feedback on a presented candidate', tags: ['Presentations', 'Jobs'], access: { kind: 'staff', permission: 'jobs.write' }, params: IdParams,
    body: z.object({ sentiment: z.enum(['positive', 'neutral', 'negative']).nullable().optional(), summary: z.string().trim().min(1).max(4000), familyContactId: Id.nullable().optional(), receivedAt: Timestamp.optional() }),
    response: z.object({ id: Id }), status: 201, async handler({ deps, meta, staff, params, body }) { const row = await recordFamilyFeedback(deps, meta, staff, params.id, body); return { id: row.id }; } }),
  defineRoute({ method: 'GET', path: '/job-candidates/:id/feedback', operationId: 'listFamilyFeedback', summary: 'Family feedback for a candidate on a job', tags: ['Presentations', 'Jobs'], access: { kind: 'staff', permission: 'jobs.read' }, params: IdParams,
    response: z.object({ items: z.array(z.object({ id: Id, sentiment: z.string().nullable(), summary: z.string(), familyContactId: Id.nullable(), receivedAt: Timestamp, recordedBy: Id.nullable() })) }),
    async handler({ deps, params }) { return { items: await deps.db.selectFrom('familyFeedback').select(['id', 'sentiment', 'summary', 'familyContactId', 'receivedAt', 'recordedBy']).where('jobCandidateId', '=', params.id).orderBy('receivedAt', 'desc').execute() }; } })
];
