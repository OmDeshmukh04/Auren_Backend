import { sql } from 'kysely';
import { z } from 'zod';
import { defineRoute, RawResponse, type AnyRoute } from '../../http/route.js';
import { Id, IdParams, Ok, PageQuery, Timestamp, Version, pageOf, queryList } from '../../http/schemas.js';
import { forbidden, notFound, unauthorized, unprocessable } from '../../http/errors.js';
import { audit } from '../../domain/audit.js';
import { assignedOnly, assertInScope, pageArgs, updateVersioned } from '../../domain/records.js';
import { API_PREFIX } from '../../http/register.js';
import { contentToken, readContentToken } from '../documents/files.js';
import { contentDisposition } from '../../providers/storage.js';
import { CANDIDATE_MERGE_FIELDS, FAMILY_MERGE_FIELDS, mergeCandidates, mergeFamilies } from './merge.js';
import { requestExport } from './exports.js';
import { anonymizeCandidate, anonymizeFamilyContact, assertNoHold } from './retention.js';
import { SearchCriteria } from '../candidates/search.js';

const Duplicate = z
  .object({
    id: Id, entityType: z.enum(['family', 'candidate']), firstRecordId: Id, secondRecordId: Id, matchReasons: z.array(z.string()), status: z.enum(['open', 'dismissed', 'merged']),
    detectedAt: Timestamp, resolvedAt: Timestamp.nullable(), resolutionNote: z.string().nullable(),
    records: z.array(z.object({ id: Id, name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), city: z.string().nullable(), createdAt: Timestamp, version: Version }))
  })
  .meta({ id: 'DuplicateCase' });

const ExportKind = z.enum(['candidates', 'families', 'enquiries', 'job_orders', 'placements', 'invoices', 'subject_access']);
const Export = z
  .object({ id: Id, kind: ExportKind, status: z.enum(['queued', 'running', 'completed', 'failed', 'expired', 'cancelled']), rowCount: z.int().nullable(), error: z.string().nullable(), createdAt: Timestamp, completedAt: Timestamp.nullable(), expiresAt: Timestamp.nullable(), requestedBy: Id })
  .meta({ id: 'Export' });

const RetentionRecordType = z.enum(['application_draft', 'unsuccessful_candidate', 'closed_enquiry', 'delivery_content', 'export_file', 'audit_event', 'rate_limit_bucket', 'idempotency_key']);
const RetentionRequest = z
  .object({ id: Id, kind: z.enum(['correction', 'access_export', 'deletion', 'restriction']), subjectType: z.enum(['candidate', 'family', 'family_contact']), subjectId: Id, receivedVia: z.string(), receivedAt: Timestamp, details: z.string().nullable(), status: z.enum(['open', 'in_review', 'approved', 'rejected', 'completed', 'on_hold']), decisionNote: z.string().nullable(), decidedAt: Timestamp.nullable(), completedAt: Timestamp.nullable(), exportId: Id.nullable(), version: Version, createdAt: Timestamp })
  .meta({ id: 'RetentionRequest' });

const Notice = z
  .object({ id: Id, noticeKey: z.string(), version: z.string(), title: z.string(), bodyMarkdown: z.string(), status: z.enum(['draft', 'published', 'retired']), publishedAt: Timestamp.nullable(), createdAt: Timestamp })
  .meta({ id: 'LegalNotice' });
const NoticeKey = z.enum(['privacy_notice', 'application_terms', 'reference_authorization', 'background_authorization', 'marketing_consent', 'presentation_sharing', 'family_terms']);

const Consent = z
  .object({ id: Id, consentType: z.string(), noticeVersion: z.string().nullable(), granted: z.boolean(), occurredAt: Timestamp, withdrawnAt: Timestamp.nullable(), withdrawnReason: z.string().nullable(), recordedByType: z.string(), evidence: z.unknown(), familyContactId: Id.nullable() })
  .meta({ id: 'Consent' });

export const governanceRoutes: AnyRoute[] = [
  // ---------------------------------------------------------------- duplicates
  defineRoute({ method: 'GET', path: '/duplicates', operationId: 'listDuplicateCases', summary: 'Possible duplicate families or candidates', tags: ['Governance'], access: { kind: 'staff', permission: 'duplicates.read' },
    query: z.object({ entityType: z.enum(['family', 'candidate']).optional(), status: z.enum(['open', 'dismissed', 'merged']).default('open'), ...PageQuery }),
    response: pageOf(Duplicate, 'DuplicateCasePage'),
    async handler({ deps, staff, query }) {
      let q = deps.db.selectFrom('duplicateCases').where('status', '=', query.status);
      if (query.entityType) q = q.where('entityType', '=', query.entityType);
      if (await assignedOnly(deps.db, staff)) q = q.where(sql<boolean>`(
        (entity_type = 'family' AND NOT EXISTS (SELECT 1 FROM families f WHERE f.id IN (first_record_id, second_record_id) AND f.assigned_staff_id IS NOT NULL AND f.assigned_staff_id <> ${staff.staffId}))
        OR (entity_type = 'candidate' AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.id IN (first_record_id, second_record_id) AND c.assigned_staff_id IS NOT NULL AND c.assigned_staff_id <> ${staff.staffId}))
      )`);
      const { limit, offset } = pageArgs(query.page, query.pageSize);
      const [rows, total] = await Promise.all([q.selectAll().orderBy('detectedAt', 'desc').limit(limit).offset(offset).execute(), q.select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()]);
      const items = [];
      for (const row of rows) {
        const ids = [row.firstRecordId, row.secondRecordId];
        const records = row.entityType === 'family'
          ? await deps.db.selectFrom('families as f').leftJoinLateral(eb => eb.selectFrom('familyContacts as c').select(['c.email', 'c.phone']).whereRef('c.familyId', '=', 'f.id').orderBy('c.isPrimary', 'desc').limit(1).as('pc'), join => join.onTrue()).select(['f.id', 'f.displayName as name', 'pc.email', 'pc.phone', 'f.city', 'f.createdAt', 'f.version']).where('f.id', 'in', ids).execute()
          : await deps.db.selectFrom('candidates').select(['id', sql<string>`first_name || ' ' || last_name`.as('name'), 'email', 'phone', 'city', 'createdAt', 'version']).where('id', 'in', ids).execute();
        items.push({ ...row, records });
      }
      return { items: items as never, page: query.page, pageSize: query.pageSize, total: Number(total.n) };
    } }),
  defineRoute({ method: 'POST', path: '/duplicates/:id/dismiss', operationId: 'dismissDuplicateCase', summary: 'Mark a suggestion as not a duplicate', tags: ['Governance'], access: { kind: 'staff', permission: 'duplicates.read' }, params: IdParams,
    body: z.object({ note: z.string().max(500).optional() }), response: Ok,
    async handler({ deps, meta, staff, params, body }) {
      const current = await deps.db.selectFrom('duplicateCases').selectAll().where('id', '=', params.id).executeTakeFirst();
      if (!current) throw notFound('Duplicate case');
      const parentRecords = current.entityType === 'family'
        ? await deps.db.selectFrom('families').select('assignedStaffId').where('id', 'in', [current.firstRecordId, current.secondRecordId]).execute()
        : await deps.db.selectFrom('candidates').select('assignedStaffId').where('id', 'in', [current.firstRecordId, current.secondRecordId]).execute();
      for (const parent of parentRecords) await assertInScope(deps.db, staff, parent.assignedStaffId);
      const row = await deps.db.updateTable('duplicateCases').set({ status: 'dismissed', resolvedAt: meta.now.toISOString(), resolvedBy: staff.staffId, resolutionNote: body.note ?? null }).where('id', '=', params.id).where('status', '=', 'open').returning('id').executeTakeFirst();
      if (!row) throw notFound('Open duplicate case');
      await audit(deps.db, meta, { action: 'duplicate.dismissed', subjectType: 'duplicate_case', subjectId: params.id });
      return { ok: true as const };
    } }),
  defineRoute({ method: 'POST', path: '/duplicates/:id/merge', operationId: 'mergeDuplicates', summary: 'Merge two records (owner)', description: 'Send both current versions; fieldChoices picks which record\'s value to keep per field (default survivor). The original submissions and a merge record are kept.', tags: ['Governance'], access: { kind: 'staff', permission: 'duplicates.merge' }, params: IdParams,
    body: z.object({ survivorId: Id, survivorVersion: Version, mergedVersion: Version, fieldChoices: z.record(z.string(), z.enum(['survivor', 'merged'])).default({}) }),
    response: z.object({ mergeRecordId: Id, reparented: z.record(z.string(), z.int()) }),
    async handler({ deps, meta, staff, params, body }) {
      const duplicate = await deps.db.selectFrom('duplicateCases').selectAll().where('id', '=', params.id).executeTakeFirst();
      if (!duplicate || duplicate.status !== 'open') throw notFound('Open duplicate case');
      if (![duplicate.firstRecordId, duplicate.secondRecordId].includes(body.survivorId)) throw unprocessable('The survivor must be one of the two records.', 'invalid_survivor');
      const mergedId = duplicate.firstRecordId === body.survivorId ? duplicate.secondRecordId : duplicate.firstRecordId;
      const allowed = new Set<string>(duplicate.entityType === 'family' ? FAMILY_MERGE_FIELDS : CANDIDATE_MERGE_FIELDS);
      const unknown = Object.keys(body.fieldChoices).filter(key => !allowed.has(key));
      if (unknown.length) throw unprocessable(`These fields cannot be chosen: ${unknown.join(', ')}`, 'invalid_field');
      const input = { survivorId: body.survivorId, mergedId, survivorVersion: body.survivorVersion, mergedVersion: body.mergedVersion, fieldChoices: body.fieldChoices as never, duplicateCaseId: params.id, staffId: staff.staffId };
      return duplicate.entityType === 'family' ? mergeFamilies(deps, meta, input) : mergeCandidates(deps, meta, input);
    } }),

  // ---------------------------------------------------------------- exports
  defineRoute({ method: 'GET', path: '/exports', operationId: 'listExports', summary: 'My exports (owner sees all)', tags: ['Governance'], access: { kind: 'staff', permission: 'exports.create' }, response: z.object({ items: z.array(Export) }),
    async handler({ deps, staff }) {
      let q = deps.db.selectFrom('exports').select(['id', 'kind', 'status', 'rowCount', 'error', 'createdAt', 'completedAt', 'expiresAt', 'requestedBy']);
      if (staff.role !== 'owner') q = q.where('requestedBy', '=', staff.staffId);
      return { items: (await q.orderBy('createdAt', 'desc').limit(100).execute()) as never };
    } }),
  defineRoute({ method: 'POST', path: '/exports', operationId: 'createExport', summary: 'Export records as CSV (or a subject access JSON file)', description: 'candidates takes params.criteria (the same CandidateSearchCriteria as search). subject_access takes params.subjectType (candidate|family_contact) and params.subjectId.', tags: ['Governance'], access: { kind: 'staff', permission: 'exports.create' },
    body: z.object({ kind: ExportKind, params: z.record(z.string(), z.unknown()).default({}) }).superRefine((v, ctx) => {
      if (v.kind === 'candidates' && v.params.criteria && !SearchCriteria.safeParse(v.params.criteria).success) ctx.addIssue({ code: 'custom', path: ['params', 'criteria'], message: 'Invalid search criteria' });
      if (v.kind === 'subject_access' && (!['candidate', 'family_contact'].includes(String(v.params.subjectType)) || typeof v.params.subjectId !== 'string')) ctx.addIssue({ code: 'custom', path: ['params'], message: 'subjectType and subjectId are required' });
    }),
    response: Export, status: 201,
    async handler({ deps, meta, staff, body }) {
      if (['invoices', 'placements'].includes(body.kind) && !staff.permissions.has('finance.read')) throw forbidden('Financial exports need finance access.');
      const id = await requestExport(deps, meta, staff.staffId, body);
      return (await deps.db.selectFrom('exports').select(['id', 'kind', 'status', 'rowCount', 'error', 'createdAt', 'completedAt', 'expiresAt', 'requestedBy']).where('id', '=', id).executeTakeFirstOrThrow()) as never;
    } }),
  defineRoute({ method: 'POST', path: '/exports/:id/download-link', operationId: 'createExportDownloadLink', summary: 'Short-lived download link (audited)', tags: ['Governance'], access: { kind: 'staff', permission: 'exports.create' }, params: IdParams,
    response: z.object({ url: z.string(), expiresAt: Timestamp }),
    async handler({ deps, meta, staff, params }) {
      const item = await deps.db.selectFrom('exports').select(['documentId', 'status', 'requestedBy', 'expiresAt']).where('id', '=', params.id).executeTakeFirst();
      if (!item || (item.requestedBy !== staff.staffId && staff.role !== 'owner')) throw notFound('Export');
      if (item.status !== 'completed' || !item.documentId || (item.expiresAt && new Date(item.expiresAt) < meta.now)) throw unprocessable('This export is not available.', 'export_unavailable');
      await audit(deps.db, meta, { action: 'export.download_link_issued', subjectType: 'export', subjectId: params.id });
      const { token, expiresAt } = contentToken(deps, { documentId: item.documentId, staffId: staff.staffId });
      return { url: `${deps.config.API_PUBLIC_URL.replace(/\/$/, '')}${API_PREFIX}/exports/${params.id}/content?token=${encodeURIComponent(token)}`, expiresAt };
    } }),
  defineRoute({ method: 'GET', path: '/exports/:id/content', operationId: 'downloadExport', summary: 'Download an export with a signed link', tags: ['Governance'], access: { kind: 'public' }, params: IdParams, query: z.object({ token: z.string().min(10).max(1000) }), produces: 'text/csv', response: z.unknown(),
    async handler({ deps, meta, params, query }) {
      const payload = readContentToken(deps, query.token);
      const item = await deps.db.selectFrom('exports as e').innerJoin('documents as d', 'd.id', 'e.documentId').select(['d.id as documentId', 'd.storageKey', 'd.originalFilename', 'd.declaredContentType']).where('e.id', '=', params.id).executeTakeFirst();
      if (!payload || !item || payload.d !== item.documentId) throw unauthorized('This download link has expired.', 'download_link_invalid');
      const bytes = await deps.privateStorage.get(item.storageKey);
      if (!bytes) throw notFound('Export');
      await audit(deps.db, { ...meta, actor: { type: 'system', component: 'download' } }, { action: 'export.downloaded', subjectType: 'export', subjectId: params.id, metadata: { staffId: payload.s } });
      return new RawResponse(200, bytes, { 'Content-Type': `${item.declaredContentType}; charset=utf-8`, 'Content-Disposition': contentDisposition(item.originalFilename), 'Cache-Control': 'private, no-store' });
    } }),

  // ---------------------------------------------------------------- retention, requests, holds
  defineRoute({ method: 'GET', path: '/retention-policies', operationId: 'listRetentionPolicies', summary: 'Retention policies (only approved, active policies run)', tags: ['Governance'], access: { kind: 'staff', permission: 'governance.read' },
    response: z.object({ items: z.array(z.object({ id: Id, recordType: RetentionRecordType, retentionDays: z.int(), action: z.string(), active: z.boolean(), approvedAt: Timestamp.nullable(), approvedBy: Id.nullable(), notes: z.string().nullable(), version: Version })) }),
    async handler({ deps }) { return { items: (await deps.db.selectFrom('retentionPolicies').selectAll().orderBy('recordType').execute()) as never }; } }),
  defineRoute({ method: 'PUT', path: '/retention-policies/:recordType', operationId: 'setRetentionPolicy', summary: 'Set and approve a retention policy (owner)', description: 'Activating records the owner\'s approval. Review periods with counsel first.', tags: ['Governance'], access: { kind: 'staff', permission: 'governance.write' },
    params: z.object({ recordType: RetentionRecordType }),
    body: z.object({ retentionDays: z.int().min(1).max(3650), action: z.enum(['delete', 'review_for_deletion', 'clear_content']), active: z.boolean(), notes: z.string().max(1000).optional() }),
    response: Ok,
    async handler({ deps, meta, staff, params, body }) {
      const values = { retentionDays: body.retentionDays, action: body.action, active: body.active, notes: body.notes ?? null, approvedBy: body.active ? staff.staffId : null, approvedAt: body.active ? meta.now.toISOString() : null };
      await deps.db.insertInto('retentionPolicies').values({ recordType: params.recordType, ...values, createdAt: meta.now.toISOString() }).onConflict(oc => oc.column('recordType').doUpdateSet(values)).execute();
      await audit(deps.db, meta, { action: 'retention.policy_set', subjectType: 'retention_policy', subjectId: params.recordType, metadata: { retentionDays: body.retentionDays, action: body.action, active: body.active } });
      return { ok: true as const };
    } }),
  defineRoute({ method: 'GET', path: '/retention-requests', operationId: 'listRetentionRequests', summary: 'Correction, access, deletion and restriction requests', tags: ['Governance'], access: { kind: 'staff', permission: 'governance.read' },
    query: z.object({ status: queryList(z.enum(['open', 'in_review', 'approved', 'rejected', 'completed', 'on_hold'])).optional() }),
    response: z.object({ items: z.array(RetentionRequest) }),
    async handler({ deps, query }) {
      let q = deps.db.selectFrom('retentionRequests').selectAll();
      if (query.status?.length) q = q.where('status', 'in', query.status);
      return { items: (await q.orderBy('receivedAt', 'desc').limit(200).execute()) as never };
    } }),
  defineRoute({ method: 'POST', path: '/retention-requests', operationId: 'createRetentionRequest', summary: 'Log a request from a candidate or family', tags: ['Governance'], access: { kind: 'staff', permission: 'governance.read' },
    body: z.object({ kind: z.enum(['correction', 'access_export', 'deletion', 'restriction']), subjectType: z.enum(['candidate', 'family', 'family_contact']), subjectId: Id, receivedVia: z.enum(['email', 'phone', 'letter', 'in_person', 'other']), receivedAt: Timestamp.optional(), details: z.string().max(4000).optional() }),
    response: z.object({ id: Id }), status: 201,
    async handler({ deps, meta, staff, body }) {
      const row = await deps.db.insertInto('retentionRequests').values({ ...body, receivedAt: body.receivedAt ?? meta.now.toISOString(), details: body.details ?? null, createdBy: staff.staffId, createdAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
      await audit(deps.db, meta, { action: 'retention.request_logged', subjectType: body.subjectType, subjectId: body.subjectId, metadata: { requestId: row.id, kind: body.kind } });
      return { id: row.id };
    } }),
  defineRoute({ method: 'POST', path: '/retention-requests/:id/decide', operationId: 'decideRetentionRequest', summary: 'Review, approve, reject or hold a request (owner)', tags: ['Governance'], access: { kind: 'staff', permission: 'governance.write' }, params: IdParams,
    body: z.object({ status: z.enum(['in_review', 'approved', 'rejected', 'on_hold']), note: z.string().max(2000).optional(), version: Version }), response: Ok,
    async handler({ deps, meta, staff, params, body }) {
      await updateVersioned(deps.db, 'retentionRequests', params.id, body.version, { status: body.status, decisionNote: body.note ?? null, decidedBy: staff.staffId, decidedAt: meta.now.toISOString() }, 'Request');
      await audit(deps.db, meta, { action: `retention.request_${body.status}`, subjectType: 'retention_request', subjectId: params.id });
      return { ok: true as const };
    } }),
  defineRoute({ method: 'POST', path: '/retention-requests/:id/complete', operationId: 'completeRetentionRequest', summary: 'Carry out an approved request', description: 'access_export creates a subject access export; deletion anonymizes personal data (refused under a legal hold); correction and restriction are completed after the staff edits.', tags: ['Governance'], access: { kind: 'staff', permission: 'governance.write' }, params: IdParams,
    body: z.object({ version: Version, note: z.string().max(2000).optional() }), response: RetentionRequest,
    async handler({ deps, meta, staff, params, body }) {
      const request = await deps.db.selectFrom('retentionRequests').selectAll().where('id', '=', params.id).executeTakeFirst();
      if (!request) throw notFound('Request');
      if (request.status !== 'approved') throw unprocessable('Approve the request first.', 'request_not_approved');
      let exportId: string | null = null;
      if (request.kind === 'access_export') {
        if (request.subjectType === 'family') throw unprocessable('Choose the family contact the request is about.', 'subject_contact_required');
        exportId = await requestExport(deps, meta, staff.staffId, { kind: 'subject_access', params: { subjectType: request.subjectType, subjectId: request.subjectId } });
      } else if (request.kind === 'deletion') {
        if (request.subjectType === 'candidate') await anonymizeCandidate(deps, meta, request.subjectId);
        else if (request.subjectType === 'family_contact') await anonymizeFamilyContact(deps, meta, request.subjectId);
        else {
          await assertNoHold(deps.db, 'family', request.subjectId);
          const contacts = await deps.db.selectFrom('familyContacts').select('id').where('familyId', '=', request.subjectId).execute();
          for (const contact of contacts) await anonymizeFamilyContact(deps, meta, contact.id);
          await deps.db.updateTable('families').set({ displayName: 'Deleted family', householdSummary: null, firstSourceDetail: JSON.stringify({}), archivedAt: meta.now.toISOString() }).where('id', '=', request.subjectId).execute();
        }
      }
      const updated = await updateVersioned(deps.db, 'retentionRequests', params.id, body.version, { status: 'completed', completedAt: meta.now.toISOString(), exportId, decisionNote: body.note ?? request.decisionNote }, 'Request');
      await audit(deps.db, meta, { action: 'retention.request_completed', subjectType: 'retention_request', subjectId: params.id, metadata: { kind: request.kind } });
      return updated as never;
    } }),
  defineRoute({ method: 'GET', path: '/legal-holds', operationId: 'listLegalHolds', summary: 'Active legal holds', tags: ['Governance'], access: { kind: 'staff', permission: 'governance.read' },
    response: z.object({ items: z.array(z.object({ id: Id, subjectType: z.string(), subjectId: Id, reason: z.string(), createdBy: Id, createdAt: Timestamp })) }),
    async handler({ deps }) { return { items: await deps.db.selectFrom('legalHolds').select(['id', 'subjectType', 'subjectId', 'reason', 'createdBy', 'createdAt']).where('releasedAt', 'is', null).orderBy('createdAt', 'desc').execute() }; } }),
  defineRoute({ method: 'POST', path: '/legal-holds', operationId: 'createLegalHold', summary: 'Place a legal hold (blocks deletion)', tags: ['Governance'], access: { kind: 'staff', permission: 'governance.write' },
    body: z.object({ subjectType: z.enum(['candidate', 'family', 'placement']), subjectId: Id, reason: z.string().trim().min(10).max(1000) }), response: z.object({ id: Id }), status: 201,
    async handler({ deps, meta, staff, body }) {
      const row = await deps.db.insertInto('legalHolds').values({ ...body, createdBy: staff.staffId, createdAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
      await audit(deps.db, meta, { action: 'legal_hold.created', subjectType: body.subjectType, subjectId: body.subjectId });
      return { id: row.id };
    } }),
  defineRoute({ method: 'POST', path: '/legal-holds/:id/release', operationId: 'releaseLegalHold', summary: 'Release a legal hold', tags: ['Governance'], access: { kind: 'staff', permission: 'governance.write' }, params: IdParams, response: Ok,
    async handler({ deps, meta, staff, params }) {
      const row = await deps.db.updateTable('legalHolds').set({ releasedAt: meta.now.toISOString(), releasedBy: staff.staffId }).where('id', '=', params.id).where('releasedAt', 'is', null).returning(['subjectType', 'subjectId']).executeTakeFirst();
      if (!row) throw notFound('Active hold');
      await audit(deps.db, meta, { action: 'legal_hold.released', subjectType: row.subjectType, subjectId: row.subjectId });
      return { ok: true as const };
    } }),

  // ---------------------------------------------------------------- audit
  defineRoute({ method: 'GET', path: '/audit', operationId: 'listAuditEvents', summary: 'Audit trail (owner)', tags: ['Governance'], access: { kind: 'staff', permission: 'audit.read' },
    query: z.object({ subjectType: z.string().max(60).optional(), subjectId: z.string().max(80).optional(), actorStaffId: Id.optional(), action: z.string().max(80).optional(), from: Timestamp.optional(), to: Timestamp.optional(), ...PageQuery }),
    response: pageOf(z.object({ id: z.int(), occurredAt: Timestamp, actorType: z.string(), actorStaffId: Id.nullable(), actorName: z.string().nullable(), action: z.string(), subjectType: z.string(), subjectId: z.string().nullable(), requestId: z.string().nullable(), metadata: z.unknown() }), 'AuditEventPage'),
    async handler({ deps, query }) {
      let q = deps.db.selectFrom('auditEvents as a').leftJoin('staffMembers as s', 's.id', 'a.actorStaffId');
      if (query.subjectType) q = q.where('a.subjectType', '=', query.subjectType);
      if (query.subjectId) q = q.where('a.subjectId', '=', query.subjectId);
      if (query.actorStaffId) q = q.where('a.actorStaffId', '=', query.actorStaffId);
      if (query.action) q = q.where('a.action', 'like', `${query.action.replace(/[%_]/g, '')}%`);
      if (query.from) q = q.where('a.occurredAt', '>=', query.from);
      if (query.to) q = q.where('a.occurredAt', '<', query.to);
      const { limit, offset } = pageArgs(query.page, query.pageSize);
      const [items, total] = await Promise.all([
        q.select(['a.id', 'a.occurredAt', 'a.actorType', 'a.actorStaffId', 's.displayName as actorName', 'a.action', 'a.subjectType', 'a.subjectId', 'a.requestId', 'a.metadata']).orderBy('a.id', 'desc').limit(limit).offset(offset).execute(),
        q.select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()
      ]);
      return { items: items as never, page: query.page, pageSize: query.pageSize, total: Number(total.n) };
    } }),

  // ---------------------------------------------------------------- legal notices & consents
  defineRoute({ method: 'GET', path: '/public/legal-notices/:noticeKey', operationId: 'getPublishedNotice', summary: 'The published version of a notice (privacy notice, authorizations)', tags: ['Public'], access: { kind: 'public' }, params: z.object({ noticeKey: NoticeKey }),
    response: z.object({ noticeKey: z.string(), version: z.string(), title: z.string(), bodyMarkdown: z.string(), publishedAt: Timestamp.nullable() }).meta({ id: 'PublishedNotice' }),
    async handler({ deps, params }) {
      const row = await deps.db.selectFrom('legalNotices').select(['noticeKey', 'version', 'title', 'bodyMarkdown', 'publishedAt']).where('noticeKey', '=', params.noticeKey).where('status', '=', 'published').executeTakeFirst();
      if (!row) throw notFound('Published notice');
      return row;
    } }),
  defineRoute({ method: 'GET', path: '/legal-notices', operationId: 'listLegalNotices', summary: 'Legal notice versions', tags: ['Governance'], access: { kind: 'staff', permission: 'settings.read' }, response: z.object({ items: z.array(Notice) }),
    async handler({ deps }) { return { items: (await deps.db.selectFrom('legalNotices').selectAll().orderBy('noticeKey').orderBy('createdAt', 'desc').execute()) as never }; } }),
  defineRoute({ method: 'POST', path: '/legal-notices', operationId: 'createLegalNotice', summary: 'Draft a new notice version (counsel-approved wording)', tags: ['Governance'], access: { kind: 'staff', permission: 'settings.write' },
    body: z.object({ noticeKey: NoticeKey, version: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/), title: z.string().trim().min(1).max(200), bodyMarkdown: z.string().min(1).max(100_000) }), response: Notice, status: 201,
    async handler({ deps, meta, staff, body }) {
      const row = await deps.db.insertInto('legalNotices').values({ ...body, createdBy: staff.staffId, createdAt: meta.now.toISOString() }).returningAll().executeTakeFirstOrThrow();
      await audit(deps.db, meta, { action: 'legal_notice.drafted', subjectType: 'legal_notice', subjectId: row.id, metadata: { noticeKey: body.noticeKey, version: body.version } });
      return row as never;
    } }),
  defineRoute({ method: 'PATCH', path: '/legal-notices/:id', operationId: 'updateLegalNoticeDraft', summary: 'Edit a draft notice', tags: ['Governance'], access: { kind: 'staff', permission: 'settings.write' }, params: IdParams,
    body: z.object({ title: z.string().trim().min(1).max(200).optional(), bodyMarkdown: z.string().min(1).max(100_000).optional() }), response: Notice,
    async handler({ deps, meta, params, body }) {
      const row = await deps.db.updateTable('legalNotices').set(body).where('id', '=', params.id).where('status', '=', 'draft').returningAll().executeTakeFirst();
      if (!row) throw notFound('Draft notice');
      await audit(deps.db, meta, { action: 'legal_notice.updated', subjectType: 'legal_notice', subjectId: params.id });
      return row as never;
    } }),
  defineRoute({ method: 'POST', path: '/legal-notices/:id/publish', operationId: 'publishLegalNotice', summary: 'Publish a notice version (replaces the previous one for new consents)', tags: ['Governance'], access: { kind: 'staff', permission: 'settings.write' }, params: IdParams, response: Notice,
    async handler({ deps, meta, staff, params }) {
      return deps.db.transaction().execute(async trx => {
        const notice = await trx.selectFrom('legalNotices').select(['noticeKey', 'status']).where('id', '=', params.id).executeTakeFirst();
        if (!notice || notice.status !== 'draft') throw notFound('Draft notice');
        await trx.updateTable('legalNotices').set({ status: 'retired' }).where('noticeKey', '=', notice.noticeKey).where('status', '=', 'published').execute();
        const row = await trx.updateTable('legalNotices').set({ status: 'published', publishedAt: meta.now.toISOString(), publishedBy: staff.staffId }).where('id', '=', params.id).returningAll().executeTakeFirstOrThrow();
        await audit(trx, meta, { action: 'legal_notice.published', subjectType: 'legal_notice', subjectId: params.id, metadata: { noticeKey: notice.noticeKey, version: row.version } });
        return row as never;
      });
    } }),
  defineRoute({ method: 'GET', path: '/candidates/:id/consents', operationId: 'listCandidateConsents', summary: 'Consents and acknowledgements recorded for a candidate', tags: ['Governance', 'Candidates'], access: { kind: 'staff', permission: 'candidates.read' }, params: IdParams, response: z.object({ items: z.array(Consent) }),
    async handler({ deps, params }) { return { items: (await deps.db.selectFrom('consents').selectAll().where('candidateId', '=', params.id).orderBy('occurredAt', 'desc').execute()) as never }; } }),
  defineRoute({ method: 'GET', path: '/families/:id/consents', operationId: 'listFamilyConsents', summary: 'Consents recorded for a family\'s contacts', tags: ['Governance', 'Families'], access: { kind: 'staff', permission: 'families.read' }, params: IdParams, response: z.object({ items: z.array(Consent) }),
    async handler({ deps, params }) {
      return { items: (await deps.db.selectFrom('consents as c').innerJoin('familyContacts as f', 'f.id', 'c.familyContactId').selectAll('c').where('f.familyId', '=', params.id).orderBy('c.occurredAt', 'desc').execute()) as never };
    } }),
  defineRoute({ method: 'POST', path: '/consents/:id/withdraw', operationId: 'withdrawConsent', summary: 'Record that a consent was withdrawn', description: 'Withdrawing reference authorization revokes contact permission; withdrawing profile sharing blocks future presentation releases.', tags: ['Governance'], access: { kind: 'staff', permission: 'communications.write' }, params: IdParams,
    body: z.object({ reason: z.string().trim().min(3).max(1000) }), response: Ok,
    async handler({ deps, meta, params, body }) {
      await deps.db.transaction().execute(async trx => {
        const consent = await trx.updateTable('consents').set({ withdrawnAt: meta.now.toISOString(), withdrawnReason: body.reason }).where('id', '=', params.id).where('withdrawnAt', 'is', null).returning(['consentType', 'candidateId', 'familyContactId']).executeTakeFirst();
        if (!consent) throw notFound('Active consent');
        if (consent.consentType === 'reference_contact_authorization') await trx.updateTable('candidateReferences').set({ permissionRevokedAt: meta.now.toISOString() }).where('permissionConsentId', '=', params.id).where('permissionRevokedAt', 'is', null).execute();
        if (consent.consentType === 'marketing_email' && consent.familyContactId) {
          const contact = await trx.selectFrom('familyContacts').select('email').where('id', '=', consent.familyContactId).executeTakeFirst();
          if (contact?.email) await trx.insertInto('emailSuppressions').values({ email: contact.email, scope: 'outreach', reason: 'unsubscribe', createdAt: meta.now.toISOString() }).onConflict(oc => oc.column('email').doNothing()).execute();
        }
        await audit(trx, meta, { action: 'consent.withdrawn', subjectType: consent.candidateId ? 'candidate' : 'family_contact', subjectId: consent.candidateId ?? consent.familyContactId, metadata: { consentId: params.id, consentType: consent.consentType } });
      });
      return { ok: true as const };
    } })
];
