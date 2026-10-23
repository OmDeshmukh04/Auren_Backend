import { sql } from 'kysely';
import { z } from 'zod';
import type { Executor } from '../../db/index.js';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { CurrencyCode, DateOnly, Id, IdParams, Ok, PageQuery, Timestamp, Version, pageOf, queryList } from '../../http/schemas.js';
import { notFound, unprocessable, validationFailed } from '../../http/errors.js';
import { audit } from '../../domain/audit.js';
import { pageArgs, updateVersioned } from '../../domain/records.js';
import { SearchCriteria } from '../candidates/search.js';
import { localDate } from '../../lib/time.js';
import { getSettings } from '../../domain/settings.js';

/**
 * Operational finance records (not accounting software): agreements, invoices, payments, credits
 * and refunds. Every amount is integer minor units in the invoice's single currency; nothing sums
 * across currencies.
 */

const InvoiceLine = z.object({ description: z.string().trim().min(1).max(300), amountMinor: z.int().min(0) });
const Payment = z
  .object({ id: Id, kind: z.enum(['payment', 'credit', 'refund']), amountMinor: z.int(), currency: z.string(), receivedOn: DateOnly, method: z.string().nullable(), externalReference: z.string().nullable(), notes: z.string().nullable(), voidedAt: Timestamp.nullable(), createdAt: Timestamp })
  .meta({ id: 'Payment' });
const Invoice = z
  .object({
    id: Id, number: z.string(), familyId: Id, familyName: z.string(), placementId: Id.nullable(), status: z.enum(['draft', 'issued', 'void']), currency: z.string(),
    totalMinor: z.int(), paidMinor: z.int(), creditedMinor: z.int(), refundedMinor: z.int(),
    outstandingMinor: z.int().meta({ description: 'total - payments - credits + refunds (issued invoices only; drafts and voids are 0).' }),
    issuedOn: DateOnly.nullable(), dueOn: DateOnly.nullable(), overdue: z.boolean(), voidedAt: Timestamp.nullable(), voidReason: z.string().nullable(), notes: z.string().nullable(),
    lines: z.array(InvoiceLine.extend({ id: Id })), payments: z.array(Payment), version: Version, createdAt: Timestamp, updatedAt: Timestamp
  })
  .meta({ id: 'Invoice' });

async function loadInvoice(db: Executor, id: string, today: string) {
  const invoice = await db.selectFrom('invoices as i').innerJoin('families as f', 'f.id', 'i.familyId').selectAll('i').select('f.displayName as familyName').where('i.id', '=', id).executeTakeFirst();
  if (!invoice) throw notFound('Invoice');
  const [lines, payments] = await Promise.all([
    db.selectFrom('invoiceLines').select(['id', 'description', 'amountMinor']).where('invoiceId', '=', id).orderBy('sortOrder').execute(),
    db.selectFrom('payments').selectAll().where('invoiceId', '=', id).orderBy('receivedOn').execute()
  ]);
  const live = payments.filter(p => !p.voidedAt);
  const sum = (kind: string) => live.filter(p => p.kind === kind).reduce((n, p) => n + p.amountMinor, 0);
  const paid = sum('payment');
  const credited = sum('credit');
  const refunded = sum('refund');
  const outstanding = invoice.status === 'issued' ? invoice.totalMinor - paid - credited + refunded : 0;
  return { ...invoice, lines, payments, paidMinor: paid, creditedMinor: credited, refundedMinor: refunded, outstandingMinor: outstanding, overdue: invoice.status === 'issued' && outstanding > 0 && Boolean(invoice.dueOn && invoice.dueOn < today) };
}

async function today(db: Executor, now: Date) {
  return localDate(now, (await getSettings(db)).timezone);
}

async function replaceLines(db: Executor, invoiceId: string, lines: Array<{ description: string; amountMinor: number }>) {
  await db.deleteFrom('invoiceLines').where('invoiceId', '=', invoiceId).execute();
  if (lines.length) await db.insertInto('invoiceLines').values(lines.map((line, index) => ({ invoiceId, ...line, sortOrder: index }))).execute();
  const total = lines.reduce((n, line) => n + line.amountMinor, 0);
  await db.updateTable('invoices').set({ totalMinor: total }).where('id', '=', invoiceId).execute();
}

const SavedSearch = z
  .object({ id: Id, name: z.string(), scope: z.enum(['private', 'shared']), criteria: SearchCriteria, criteriaSchemaVersion: z.int(), ownerStaffId: Id, mine: z.boolean(), version: Version, updatedAt: Timestamp })
  .meta({ id: 'SavedSearch' });

export const financeRoutes: AnyRoute[] = [
  // ---------------------------------------------------------------- agreements
  defineRoute({ method: 'GET', path: '/families/:id/agreements', operationId: 'listAgreements', summary: 'Service and fee agreements with a family', tags: ['Finance'], access: { kind: 'staff', permission: 'families.read' }, params: IdParams,
    response: z.object({ items: z.array(z.object({ id: Id, familyId: Id, jobOrderId: Id.nullable(), kind: z.string(), status: z.enum(['draft', 'sent', 'signed', 'void']), feeTerms: z.string().nullable(), guaranteeTerms: z.string().nullable(), sentAt: Timestamp.nullable(), signedAt: Timestamp.nullable(), voidedAt: Timestamp.nullable(), documentId: Id.nullable(), notes: z.string().nullable(), version: Version })) }),
    async handler({ deps, params }) { return { items: (await deps.db.selectFrom('agreements').selectAll().where('familyId', '=', params.id).orderBy('createdAt', 'desc').execute()) as never }; } }),
  defineRoute({ method: 'POST', path: '/families/:id/agreements', operationId: 'createAgreement', summary: 'Record an agreement (terms as agreed; nothing inferred)', tags: ['Finance'], access: { kind: 'staff', permission: 'families.write' }, params: IdParams,
    body: z.object({ kind: z.enum(['service_agreement', 'fee_agreement', 'other']), jobOrderId: Id.nullable().optional(), feeTerms: z.string().max(5000).nullable().optional(), guaranteeTerms: z.string().max(5000).nullable().optional(), documentId: Id.nullable().optional(), notes: z.string().max(2000).nullable().optional() }),
    response: z.object({ id: Id }), status: 201,
    async handler({ deps, meta, params, body }) {
      if (body.jobOrderId) {
        const job = await deps.db.selectFrom('jobOrders').select('familyId').where('id', '=', body.jobOrderId).executeTakeFirst();
        if (job?.familyId !== params.id) throw validationFailed([{ path: 'jobOrderId', code: 'invalid', message: 'The job belongs to another family' }]);
      }
      const row = await deps.db.insertInto('agreements').values({ familyId: params.id, ...body, createdAt: meta.now.toISOString() } as never).returning('id').executeTakeFirstOrThrow();
      await audit(deps.db, meta, { action: 'agreement.created', subjectType: 'family', subjectId: params.id, metadata: { agreementId: row.id, kind: body.kind } });
      return { id: row.id };
    } }),
  defineRoute({ method: 'POST', path: '/agreements/:id/status', operationId: 'setAgreementStatus', summary: 'Mark an agreement sent, signed or void', tags: ['Finance'], access: { kind: 'staff', permission: 'families.write' }, params: IdParams,
    body: z.object({ to: z.enum(['sent', 'signed', 'void']), on: Timestamp.optional(), version: Version }), response: Ok,
    async handler({ deps, meta, params, body }) {
      const at = body.on ?? meta.now.toISOString();
      await updateVersioned(deps.db, 'agreements', params.id, body.version, { status: body.to, ...(body.to === 'sent' ? { sentAt: at } : body.to === 'signed' ? { signedAt: at } : { voidedAt: at }) }, 'Agreement');
      await audit(deps.db, meta, { action: `agreement.${body.to}`, subjectType: 'agreement', subjectId: params.id });
      return { ok: true as const };
    } }),

  // ---------------------------------------------------------------- invoices
  defineRoute({ method: 'GET', path: '/invoices', operationId: 'listInvoices', summary: 'Invoices', tags: ['Finance'], access: { kind: 'staff', permission: 'finance.read' },
    query: z.object({ status: queryList(z.enum(['draft', 'issued', 'void'])).optional(), familyId: Id.optional(), placementId: Id.optional(), currency: CurrencyCode.optional(), ...PageQuery }),
    response: pageOf(Invoice, 'InvoicePage'),
    async handler({ deps, query }) {
      let q = deps.db.selectFrom('invoices');
      if (query.status?.length) q = q.where('status', 'in', query.status);
      if (query.familyId) q = q.where('familyId', '=', query.familyId);
      if (query.placementId) q = q.where('placementId', '=', query.placementId);
      if (query.currency) q = q.where('currency', '=', query.currency);
      const { limit, offset } = pageArgs(query.page, query.pageSize);
      const [ids, total] = await Promise.all([q.select('id').orderBy('createdAt', 'desc').limit(limit).offset(offset).execute(), q.select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()]);
      const day = await today(deps.db, deps.clock.now());
      const items = [];
      for (const { id } of ids) items.push(await loadInvoice(deps.db, id, day));
      return { items: items as never, page: query.page, pageSize: query.pageSize, total: Number(total.n) };
    } }),
  defineRoute({ method: 'POST', path: '/invoices', operationId: 'createInvoice', summary: 'Draft an invoice (owner)', tags: ['Finance'], access: { kind: 'staff', permission: 'finance.write' },
    body: z.object({ familyId: Id, placementId: Id.nullable().optional(), currency: CurrencyCode, lines: z.array(InvoiceLine).min(1).max(50), dueOn: DateOnly.nullable().optional(), notes: z.string().max(2000).nullable().optional() }),
    response: Invoice, status: 201,
    async handler({ deps, meta, body }) {
      const id = await deps.db.transaction().execute(async trx => {
        if (body.placementId) {
          const placement = await trx.selectFrom('placements').select('familyId').where('id', '=', body.placementId).executeTakeFirst();
          if (placement?.familyId !== body.familyId) throw validationFailed([{ path: 'placementId', code: 'invalid', message: 'The placement belongs to another family' }]);
        }
        const seq = await sql<{ n: string }>`select nextval('invoice_number_seq')::text as n`.execute(trx);
        const year = new Date(meta.now).getUTCFullYear();
        const invoice = await trx.insertInto('invoices').values({ number: `INV-${year}-${seq.rows[0]!.n}`, familyId: body.familyId, placementId: body.placementId ?? null, currency: body.currency, dueOn: body.dueOn ?? null, notes: body.notes ?? null, createdAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
        await replaceLines(trx, invoice.id, body.lines);
        await audit(trx, meta, { action: 'invoice.created', subjectType: 'invoice', subjectId: invoice.id });
        return invoice.id;
      });
      return loadInvoice(deps.db, id, await today(deps.db, deps.clock.now())) as never;
    } }),
  defineRoute({ method: 'GET', path: '/invoices/:id', operationId: 'getInvoice', summary: 'Invoice with lines, payments and balance', tags: ['Finance'], access: { kind: 'staff', permission: 'finance.read' }, params: IdParams, response: Invoice,
    async handler({ deps, params }) { return loadInvoice(deps.db, params.id, await today(deps.db, deps.clock.now())) as never; } }),
  defineRoute({ method: 'PATCH', path: '/invoices/:id', operationId: 'updateInvoiceDraft', summary: 'Edit a draft invoice', tags: ['Finance'], access: { kind: 'staff', permission: 'finance.write' }, params: IdParams,
    body: z.object({ version: Version, lines: z.array(InvoiceLine).min(1).max(50).optional(), dueOn: DateOnly.nullable().optional(), notes: z.string().max(2000).nullable().optional() }), response: Invoice,
    async handler({ deps, meta, params, body }) {
      await deps.db.transaction().execute(async trx => {
        const invoice = await trx.selectFrom('invoices').select('status').where('id', '=', params.id).forUpdate().executeTakeFirst();
        if (!invoice) throw notFound('Invoice');
        if (invoice.status !== 'draft') throw unprocessable('Only draft invoices can be edited; void and reissue instead.', 'invoice_not_draft');
        const { version, lines, ...values } = body;
        await updateVersioned(trx, 'invoices', params.id, version, values, 'Invoice');
        if (lines) await replaceLines(trx, params.id, lines);
        await audit(trx, meta, { action: 'invoice.updated', subjectType: 'invoice', subjectId: params.id });
      });
      return loadInvoice(deps.db, params.id, await today(deps.db, deps.clock.now())) as never;
    } }),
  defineRoute({ method: 'POST', path: '/invoices/:id/issue', operationId: 'issueInvoice', summary: 'Issue a draft invoice', tags: ['Finance'], access: { kind: 'staff', permission: 'finance.write' }, params: IdParams,
    body: z.object({ version: Version, issuedOn: DateOnly.optional(), dueOn: DateOnly.nullable().optional() }), response: Invoice,
    async handler({ deps, meta, params, body }) {
      const invoice = await deps.db.selectFrom('invoices').select(['status', 'totalMinor']).where('id', '=', params.id).executeTakeFirst();
      if (!invoice) throw notFound('Invoice');
      if (invoice.status !== 'draft') throw unprocessable('Only a draft can be issued.', 'invoice_not_draft');
      if (invoice.totalMinor <= 0) throw unprocessable('An invoice needs a positive total.', 'invoice_empty');
      await updateVersioned(deps.db, 'invoices', params.id, body.version, { status: 'issued', issuedOn: body.issuedOn ?? (await today(deps.db, meta.now)), ...(body.dueOn !== undefined ? { dueOn: body.dueOn } : {}) }, 'Invoice');
      await audit(deps.db, meta, { action: 'invoice.issued', subjectType: 'invoice', subjectId: params.id });
      return loadInvoice(deps.db, params.id, await today(deps.db, deps.clock.now())) as never;
    } }),
  defineRoute({ method: 'POST', path: '/invoices/:id/void', operationId: 'voidInvoice', summary: 'Void an invoice (kept for history)', tags: ['Finance'], access: { kind: 'staff', permission: 'finance.write' }, params: IdParams,
    body: z.object({ version: Version, reason: z.string().trim().min(3).max(500) }), response: Invoice,
    async handler({ deps, meta, params, body }) {
      await updateVersioned(deps.db, 'invoices', params.id, body.version, { status: 'void', voidedAt: meta.now.toISOString(), voidReason: body.reason }, 'Invoice');
      await audit(deps.db, meta, { action: 'invoice.voided', subjectType: 'invoice', subjectId: params.id, metadata: { reason: body.reason } });
      return loadInvoice(deps.db, params.id, await today(deps.db, deps.clock.now())) as never;
    } }),
  defineRoute({ method: 'POST', path: '/invoices/:id/payments', operationId: 'recordPayment', summary: 'Record a payment, credit or refund', description: 'Currency must match the invoice. Overpayment is refused.', tags: ['Finance'], access: { kind: 'staff', permission: 'finance.write' }, params: IdParams,
    body: z.object({ kind: z.enum(['payment', 'credit', 'refund']), amountMinor: z.int().positive(), currency: CurrencyCode, receivedOn: DateOnly, method: z.enum(['bank_transfer', 'check', 'card', 'cash', 'other']).nullable().optional(), externalReference: z.string().max(200).nullable().optional(), notes: z.string().max(1000).nullable().optional() }),
    response: Invoice, status: 201,
    async handler({ deps, meta, staff, params, body }) {
      await deps.db.transaction().execute(async trx => {
        await trx.selectFrom('invoices').select('id').where('id', '=', params.id).forUpdate().executeTakeFirst();
        const invoice = await loadInvoice(trx, params.id, await today(trx, meta.now));
        if (invoice.status !== 'issued') throw unprocessable('Payments can only be recorded on an issued invoice.', 'invoice_not_issued');
        if (body.currency !== invoice.currency) throw validationFailed([{ path: 'currency', code: 'currency_mismatch', message: `This invoice is in ${invoice.currency}` }]);
        if (body.kind !== 'refund' && body.amountMinor > invoice.outstandingMinor) throw validationFailed([{ path: 'amountMinor', code: 'too_big', message: 'This is more than the outstanding balance' }]);
        if (body.kind === 'refund' && body.amountMinor > invoice.paidMinor - invoice.refundedMinor) throw validationFailed([{ path: 'amountMinor', code: 'too_big', message: 'A refund cannot exceed the amount paid' }]);
        await trx.insertInto('payments').values({ invoiceId: params.id, ...body, method: body.method ?? null, externalReference: body.externalReference ?? null, notes: body.notes ?? null, recordedBy: staff.staffId, createdAt: meta.now.toISOString() }).execute();
        await audit(trx, meta, { action: `invoice.${body.kind}_recorded`, subjectType: 'invoice', subjectId: params.id, metadata: { amountMinor: body.amountMinor, currency: body.currency } });
      });
      return loadInvoice(deps.db, params.id, await today(deps.db, deps.clock.now())) as never;
    } }),
  defineRoute({ method: 'POST', path: '/payments/:id/void', operationId: 'voidPayment', summary: 'Void a mistaken payment entry', tags: ['Finance'], access: { kind: 'staff', permission: 'finance.write' }, params: IdParams,
    body: z.object({ reason: z.string().trim().min(3).max(500) }), response: Ok,
    async handler({ deps, meta, params, body }) {
      const row = await deps.db.updateTable('payments').set({ voidedAt: meta.now.toISOString(), voidReason: body.reason }).where('id', '=', params.id).where('voidedAt', 'is', null).returning('invoiceId').executeTakeFirst();
      if (!row) throw notFound('Payment');
      await audit(deps.db, meta, { action: 'payment.voided', subjectType: 'invoice', subjectId: row.invoiceId, metadata: { paymentId: params.id } });
      return { ok: true as const };
    } }),

  // ---------------------------------------------------------------- saved searches
  defineRoute({ method: 'GET', path: '/saved-searches', operationId: 'listSavedSearches', summary: 'My saved candidate searches and shared ones', tags: ['Candidates'], access: { kind: 'staff', permission: 'candidates.read' },
    response: z.object({ items: z.array(SavedSearch) }),
    async handler({ deps, staff }) {
      const rows = await deps.db.selectFrom('savedSearches').selectAll().where(eb => eb.or([eb('ownerStaffId', '=', staff.staffId), eb('scope', '=', 'shared')])).orderBy('name').execute();
      return { items: rows.map(row => ({ ...row, criteria: SearchCriteria.parse(row.criteria), mine: row.ownerStaffId === staff.staffId })) as never };
    } }),
  defineRoute({ method: 'POST', path: '/saved-searches', operationId: 'createSavedSearch', summary: 'Save search criteria', tags: ['Candidates'], access: { kind: 'staff', permission: 'candidates.read' },
    body: z.object({ name: z.string().trim().min(1).max(120), scope: z.enum(['private', 'shared']).default('private'), criteria: SearchCriteria }),
    response: z.object({ id: Id }), status: 201,
    async handler({ deps, meta, staff, body }) {
      const row = await deps.db.insertInto('savedSearches').values({ name: body.name, scope: body.scope, criteria: JSON.stringify(body.criteria), ownerStaffId: staff.staffId, createdAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
      return { id: row.id };
    } }),
  defineRoute({ method: 'PATCH', path: '/saved-searches/:id', operationId: 'updateSavedSearch', summary: 'Rename, share or change criteria (owner of the search)', tags: ['Candidates'], access: { kind: 'staff', permission: 'candidates.read' }, params: IdParams,
    body: z.object({ version: Version, name: z.string().trim().min(1).max(120).optional(), scope: z.enum(['private', 'shared']).optional(), criteria: SearchCriteria.optional() }), response: Ok,
    async handler({ deps, staff, params, body }) {
      const search = await deps.db.selectFrom('savedSearches').select('ownerStaffId').where('id', '=', params.id).executeTakeFirst();
      if (!search || search.ownerStaffId !== staff.staffId) throw notFound('Saved search');
      const { version, criteria, ...values } = body;
      await updateVersioned(deps.db, 'savedSearches', params.id, version, { ...values, ...(criteria ? { criteria: JSON.stringify(criteria), criteriaSchemaVersion: 1 } : {}) }, 'Saved search');
      return { ok: true as const };
    } }),
  defineRoute({ method: 'DELETE', path: '/saved-searches/:id', operationId: 'deleteSavedSearch', summary: 'Delete a saved search', tags: ['Candidates'], access: { kind: 'staff', permission: 'candidates.read' }, params: IdParams, response: Ok,
    async handler({ deps, staff, params }) {
      const result = await deps.db.deleteFrom('savedSearches').where('id', '=', params.id).where('ownerStaffId', '=', staff.staffId).executeTakeFirst();
      if (!result.numDeletedRows) throw notFound('Saved search');
      return { ok: true as const };
    } })
];
