import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AppDeps, RequestMeta } from '../../context.js';
import { audit } from '../../domain/audit.js';
import { getSettings } from '../../domain/settings.js';
import { localDate, DAY } from '../../lib/time.js';
import { sha256 } from '../../lib/crypto.js';
import { criteriaPredicates, currentQualificationKeys, SearchCriteria } from '../candidates/search.js';

/**
 * Exports. Each uses the same filters as its screen, includes a metadata header (kind, filters,
 * generation time and agency timezone), escapes spreadsheet formula prefixes and is stored
 * privately with an expiry. Downloads go through an audited short-lived link.
 */

const FORMULA = /^[=+\-@\t\r]/;
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = Array.isArray(value) ? value.join('; ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(meta: Record<string, string>, columns: string[], rows: Array<Record<string, unknown>>) {
  const header = Object.entries(meta).map(([key, value]) => `# ${key}: ${value.replace(/[\r\n]+/g, ' ')}`);
  return [...header, columns.map(csvCell).join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\r\n') + '\r\n';
}

const MAX_ROWS = 20_000;

async function exportRows(deps: AppDeps, kind: string, params: Record<string, unknown>) {
  const settings = await getSettings(deps.db);
  const today = localDate(deps.clock.now(), settings.timezone);
  switch (kind) {
    case 'candidates': {
      const criteria = SearchCriteria.parse(params.criteria ?? {});
      const rows = await deps.db
        .selectFrom('candidates as c')
        .where(eb => eb.and(criteriaPredicates(criteria, today)))
        .select(['c.id', 'c.reference', 'c.firstName', 'c.lastName', 'c.email', 'c.phone', 'c.city', 'c.state', 'c.recruitmentStage', 'c.availabilityStatus', 'c.availableFrom', 'c.professionalNannyYears', 'c.childcareYears', 'c.ageGroups', 'c.desiredScheduleTypes', 'c.submittedAt'])
        .orderBy('c.lastName')
        .limit(MAX_ROWS)
        .execute();
      const quals = await currentQualificationKeys(deps.db, rows.map(r => r.id), today);
      return { columns: ['reference', 'firstName', 'lastName', 'email', 'phone', 'city', 'state', 'recruitmentStage', 'availabilityStatus', 'availableFrom', 'professionalNannyYears', 'childcareYears', 'ageGroups', 'desiredScheduleTypes', 'currentQualifications', 'submittedAt'], rows: rows.map(r => ({ ...r, currentQualifications: quals.get(r.id) ?? [] })), filters: criteria };
    }
    case 'families': {
      const rows = await deps.db
        .selectFrom('families as f')
        .leftJoinLateral(eb => eb.selectFrom('familyContacts as c').select(['c.firstName', 'c.lastName', 'c.email', 'c.phone']).whereRef('c.familyId', '=', 'f.id').where('c.archivedAt', 'is', null).orderBy('c.isPrimary', 'desc').limit(1).as('pc'), join => join.onTrue())
        .select(['f.reference', 'f.displayName', 'f.relationshipStatus', 'f.city', 'f.state', 'pc.firstName', 'pc.lastName', 'pc.email', 'pc.phone', 'f.firstSource', 'f.createdAt'])
        .where('f.mergedIntoFamilyId', 'is', null)
        .$if(Boolean(params.status), qb => qb.where('f.relationshipStatus', '=', String(params.status)))
        .orderBy('f.displayName')
        .limit(MAX_ROWS)
        .execute();
      return { columns: ['reference', 'displayName', 'relationshipStatus', 'city', 'state', 'firstName', 'lastName', 'email', 'phone', 'firstSource', 'createdAt'], rows, filters: params };
    }
    case 'enquiries': {
      const rows = await deps.db
        .selectFrom('enquiries as e')
        .innerJoin('families as f', 'f.id', 'e.familyId')
        .leftJoin('familyContacts as c', 'c.id', 'e.contactId')
        .select(['e.reference', 'f.displayName as family', 'c.firstName', 'c.lastName', 'c.email', 'e.channel', 'e.stage', 'e.serviceTypeKey', 'e.locationCity', 'e.source', 'e.submittedAt', 'e.firstResponseAt', 'e.closedReason'])
        .where('e.isTest', '=', false)
        .$if(Boolean(params.from), qb => qb.where('e.submittedAt', '>=', String(params.from)))
        .$if(Boolean(params.to), qb => qb.where('e.submittedAt', '<', String(params.to)))
        .orderBy('e.submittedAt', 'desc')
        .limit(MAX_ROWS)
        .execute();
      return { columns: ['reference', 'family', 'firstName', 'lastName', 'email', 'channel', 'stage', 'serviceTypeKey', 'locationCity', 'source', 'submittedAt', 'firstResponseAt', 'closedReason'], rows, filters: params };
    }
    case 'job_orders': {
      const rows = await deps.db
        .selectFrom('jobOrders as j')
        .innerJoin('families as f', 'f.id', 'j.familyId')
        .select(['j.reference', 'f.displayName as family', 'j.title', 'j.status', 'j.serviceTypeKey', 'j.startDate', 'j.compensationMinMinor', 'j.compensationMaxMinor', 'j.compensationCurrency', 'j.compensationPeriod', 'j.openedAt', 'j.filledAt', 'j.closedAt'])
        .where('j.isTest', '=', false)
        .orderBy('j.createdAt', 'desc')
        .limit(MAX_ROWS)
        .execute();
      return { columns: ['reference', 'family', 'title', 'status', 'serviceTypeKey', 'startDate', 'compensationMinMinor', 'compensationMaxMinor', 'compensationCurrency', 'compensationPeriod', 'openedAt', 'filledAt', 'closedAt'], rows, filters: params };
    }
    case 'placements': {
      const rows = await deps.db
        .selectFrom('placements as p')
        .innerJoin('families as f', 'f.id', 'p.familyId')
        .innerJoin('candidates as c', 'c.id', 'p.candidateId')
        .innerJoin('jobOrders as j', 'j.id', 'p.jobOrderId')
        .select(['p.reference', 'f.displayName as family', sql<string>`c.first_name || ' ' || c.last_name`.as('candidate'), 'j.title as job', 'p.status', 'p.agreedStartDate', 'p.actualStartDate', 'p.endDate', 'p.feeAmountMinor', 'p.feeCurrency', 'p.guaranteeEndsOn'])
        .orderBy('p.agreedStartDate', 'desc')
        .limit(MAX_ROWS)
        .execute();
      return { columns: ['reference', 'family', 'candidate', 'job', 'status', 'agreedStartDate', 'actualStartDate', 'endDate', 'feeAmountMinor', 'feeCurrency', 'guaranteeEndsOn'], rows, filters: params };
    }
    case 'invoices': {
      const rows = await deps.db
        .selectFrom('invoices as i')
        .innerJoin('families as f', 'f.id', 'i.familyId')
        .select([
          'i.number', 'f.displayName as family', 'i.status', 'i.currency', 'i.totalMinor', 'i.issuedOn', 'i.dueOn',
          sql<number>`coalesce((select sum(amount_minor) from payments p where p.invoice_id = i.id and p.kind = 'payment' and p.voided_at is null), 0)::int`.as('paidMinor'),
          sql<number>`coalesce((select sum(amount_minor) from payments p where p.invoice_id = i.id and p.kind = 'credit' and p.voided_at is null), 0)::int`.as('creditedMinor'),
          sql<number>`coalesce((select sum(amount_minor) from payments p where p.invoice_id = i.id and p.kind = 'refund' and p.voided_at is null), 0)::int`.as('refundedMinor')
        ])
        .orderBy('i.createdAt', 'desc')
        .limit(MAX_ROWS)
        .execute();
      return { columns: ['number', 'family', 'status', 'currency', 'totalMinor', 'paidMinor', 'creditedMinor', 'refundedMinor', 'issuedOn', 'dueOn'], rows, filters: params };
    }
    default:
      throw new Error(`Unsupported export kind ${kind}`);
  }
}

/** Everything held about one candidate or family contact, for a subject access request. */
async function subjectAccess(deps: AppDeps, params: Record<string, unknown>) {
  const subjectType = String(params.subjectType);
  const id = String(params.subjectId);
  if (subjectType === 'candidate') {
    const db = deps.db;
    const [candidate, applications, employments, qualifications, languages, skills, references, interviews, checks, consents, communications, documents] = await Promise.all([
      db.selectFrom('candidates').selectAll().where('id', '=', id).executeTakeFirst(),
      db.selectFrom('applications').select(['reference', 'submittedAt', 'snapshot']).where('candidateId', '=', id).execute(),
      db.selectFrom('candidateEmployments').selectAll().where('candidateId', '=', id).execute(),
      db.selectFrom('candidateQualifications').selectAll().where('candidateId', '=', id).execute(),
      db.selectFrom('candidateLanguages').selectAll().where('candidateId', '=', id).execute(),
      db.selectFrom('candidateSkills').selectAll().where('candidateId', '=', id).execute(),
      db.selectFrom('candidateReferences').select(['fullName', 'relationship', 'email', 'phone', 'status', 'permissionToContact']).where('candidateId', '=', id).execute(),
      db.selectFrom('interviews').select(['kind', 'status', 'scheduledStart', 'completedAt']).where('candidateId', '=', id).execute(),
      db.selectFrom('screeningChecks').select(['checkTypeKey', 'status', 'requestedAt', 'completedAt', 'reviewOutcome']).where('candidateId', '=', id).execute(),
      db.selectFrom('consents').select(['consentType', 'noticeVersion', 'granted', 'occurredAt', 'withdrawnAt']).where('candidateId', '=', id).execute(),
      db.selectFrom('communications').select(['channel', 'direction', 'subject', 'occurredAt', 'status']).where('candidateId', '=', id).execute(),
      db.selectFrom('documents').select(['documentType', 'originalFilename', 'createdAt']).where('candidateId', '=', id).where('deletedAt', 'is', null).execute()
    ]);
    return { subjectType, candidate, applications, employments, qualifications, languages, skills, references, interviews, screeningChecks: checks, consents, communications, documents, note: 'Internal evaluations and staff notes are withheld pending review; confirm disclosure obligations with counsel.' };
  }
  const contact = await deps.db.selectFrom('familyContacts').selectAll().where('id', '=', id).executeTakeFirst();
  const enquiries = contact ? await deps.db.selectFrom('enquiries').select(['reference', 'submittedAt', 'submissionSnapshot', 'stage']).where('contactId', '=', id).execute() : [];
  const consents = await deps.db.selectFrom('consents').select(['consentType', 'noticeVersion', 'granted', 'occurredAt', 'withdrawnAt']).where('familyContactId', '=', id).execute();
  const communications = await deps.db.selectFrom('communications').select(['channel', 'direction', 'subject', 'occurredAt', 'status']).where('familyContactId', '=', id).execute();
  return { subjectType, contact, enquiries, consents, communications };
}

/** Builds and stores one export. Safe to call again: completed exports are left alone. */
export async function processExport(deps: AppDeps, exportId: string) {
  const claimed = await deps.db.updateTable('exports').set({ status: 'running', startedAt: deps.clock.now().toISOString() }).where('id', '=', exportId).where('status', '=', 'queued').returningAll().executeTakeFirst();
  if (!claimed) return;
  try {
    const settings = await getSettings(deps.db);
    const params = claimed.params as Record<string, unknown>;
    const now = deps.clock.now();
    let body: Buffer;
    let filename: string;
    let contentType: string;
    let rowCount: number;
    if (claimed.kind === 'subject_access') {
      const data = await subjectAccess(deps, params);
      body = Buffer.from(JSON.stringify({ generatedAt: now.toISOString(), timezone: settings.timezone, ...data }, null, 2));
      filename = `subject-access-${now.toISOString().slice(0, 10)}.json`;
      contentType = 'application/json';
      rowCount = 1;
    } else {
      const { columns, rows, filters } = await exportRows(deps, claimed.kind, params);
      body = Buffer.from(toCsv({ export: claimed.kind, generatedAt: now.toISOString(), timezone: settings.timezone, localDate: localDate(now, settings.timezone), filters: JSON.stringify(filters ?? {}), rows: String(rows.length), note: 'Confidential agency records.' }, columns, rows));
      filename = `${claimed.kind}-${now.toISOString().slice(0, 10)}.csv`;
      contentType = 'text/csv';
      rowCount = rows.length;
    }
    const storageKey = `private/exports/${randomUUID()}`;
    await deps.privateStorage.put(storageKey, body, contentType);
    const document = await deps.db
      .insertInto('documents')
      .values({ documentType: 'export', originalFilename: filename, declaredContentType: contentType, detectedType: claimed.kind === 'subject_access' ? 'json' : 'csv', sizeBytes: body.length, storageKey, sha256: sha256(body), scanStatus: 'clean', scanDetail: 'Generated by the system', scannedAt: now.toISOString(), uploadedByType: 'system', createdAt: now.toISOString() })
      .returning('id')
      .executeTakeFirstOrThrow();
    await deps.db.updateTable('exports').set({ status: 'completed', documentId: document.id, rowCount, completedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * DAY).toISOString() }).where('id', '=', exportId).execute();
  } catch (error) {
    await deps.db.updateTable('exports').set({ status: 'failed', error: (error as Error).message.slice(0, 500) }).where('id', '=', exportId).execute();
  }
}

export async function requestExport(deps: AppDeps, meta: RequestMeta, staffId: string, input: { kind: string; params: Record<string, unknown> }) {
  const row = await deps.db.insertInto('exports').values({ kind: input.kind, params: JSON.stringify(input.params ?? {}), requestedBy: staffId, createdAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
  await audit(deps.db, meta, { action: 'export.requested', subjectType: 'export', subjectId: row.id, metadata: { kind: input.kind } });
  await processExport(deps, row.id);
  return row.id;
}

export async function processQueuedExports(deps: AppDeps) {
  const queued = await deps.db.selectFrom('exports').select('id').where('status', '=', 'queued').orderBy('createdAt').limit(5).execute();
  for (const item of queued) await processExport(deps, item.id);
  return queued.length;
}
