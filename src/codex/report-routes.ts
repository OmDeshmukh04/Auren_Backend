/** Codex-owned contribution. Register reportRoutes in the main route list; do not duplicate these paths. */
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { getSettings } from '../domain/settings.js';
import { AppError } from '../http/errors.js';
import { defineRoute, type AnyRoute } from '../http/route.js';

export const ReportQuery = z.object({
  days: z.coerce.number().int().min(1).max(730).default(30),
  from: z.iso.date().optional(),
  to: z.iso.date().optional()
}).refine(q => Boolean(q.from) === Boolean(q.to), { message: 'Provide both from and to dates.' });
type Query = z.infer<typeof ReportQuery>;
export type Range = { from: string; toExclusive: string; fromDate: string; toDate: string; timezone: string; asOf: string };
export function reportRange(query: Query, now: Date, timezone: string): Range {
  const localNow = DateTime.fromJSDate(now, { zone: timezone });
  const start = query.from ? DateTime.fromISO(query.from, { zone: timezone }).startOf('day') : localNow.startOf('day').minus({ days: query.days - 1 });
  const endDay = query.to ? DateTime.fromISO(query.to, { zone: timezone }).startOf('day') : localNow.startOf('day');
  if (!start.isValid || !endDay.isValid || start > endDay || endDay > localNow.startOf('day') || endDay.diff(start, 'days').days >= 730) {
    throw new AppError(400, 'invalid_report_range', 'Choose an ordered date range of at most 730 days ending no later than today.');
  }
  const requestedEnd = endDay.plus({ days: 1 });
  const end = requestedEnd > localNow ? localNow : requestedEnd;
  return { from: start.toUTC().toISO()!, toExclusive: end.toUTC().toISO()!, fromDate: start.toISODate()!, toDate: endDay.toISODate()!, timezone, asOf: now.toISOString() };
}
const Count = z.number().int().nonnegative();
const Series = z.array(z.object({ name: z.string(), value: z.number() }));
const CurrencyTotals = z.array(z.object({ currency: z.string(), invoicedMinor: z.number(), paymentsMinor: z.number(), creditsMinor: z.number(), refundsMinor: z.number(), outstandingMinor: z.number() }));
export const ReportResponse = z.object({
  data: z.object({
    metrics: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
    series: Series,
    range: z.object({ from: z.string(), toExclusive: z.string(), fromDate: z.string(), toDate: z.string(), timezone: z.string(), asOf: z.string() }),
    definitions: z.array(z.string()),
    sampleSize: Count.optional(), missingDataCount: Count.optional(),
    currencyTotals: CurrencyTotals.optional()
  })
});
type Report = z.infer<typeof ReportResponse>['data'];
export function formatMoney(minor: number, currency: string) {
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  const decimals = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(minor / 10 ** decimals);
}
async function rangeFor(deps: AppDeps, query: Query) { return reportRange(query, deps.clock.now(), (await getSettings(deps.db)).timezone); }

export async function recruitmentReport(deps: AppDeps, query: Query): Promise<Report> {
  const range = await rangeFor(deps, query);
  const [stats, stages] = await Promise.all([
    sql<{ applications: number; interviews: number; reviewed: number; active: number }>`
      SELECT
        (SELECT count(*)::int FROM applications a JOIN candidates c ON c.id = a.candidate_id
          WHERE NOT a.is_test AND NOT c.is_test AND c.merged_into_candidate_id IS NULL
          AND a.submitted_at >= ${range.from}::timestamptz AND a.submitted_at < ${range.toExclusive}::timestamptz) AS applications,
        (SELECT count(*)::int FROM interviews i JOIN candidates c ON c.id = i.candidate_id
          WHERE NOT c.is_test AND c.merged_into_candidate_id IS NULL AND i.status = 'completed'
          AND i.completed_at >= ${range.from}::timestamptz AND i.completed_at < ${range.toExclusive}::timestamptz) AS interviews,
        (SELECT count(*)::int FROM candidates c WHERE NOT c.is_test AND c.merged_into_candidate_id IS NULL
          AND c.archived_at IS NULL AND c.recruitment_stage = 'eligible') AS reviewed,
        (SELECT count(*)::int FROM candidates c WHERE NOT c.is_test AND c.merged_into_candidate_id IS NULL
          AND c.archived_at IS NULL AND c.recruitment_stage NOT IN ('archived', 'not_selected')) AS active
    `.execute(deps.db),
    sql<{ name: string; value: number }>`
      SELECT COALESCE(s.label, c.recruitment_stage) AS name, count(*)::int AS value
      FROM candidates c LEFT JOIN stage_definitions s ON s.dimension = 'candidate_recruitment' AND s.key = c.recruitment_stage
      WHERE NOT c.is_test AND c.merged_into_candidate_id IS NULL AND c.archived_at IS NULL
      GROUP BY s.label, c.recruitment_stage, s.sort_order ORDER BY s.sort_order NULLS LAST, c.recruitment_stage
    `.execute(deps.db)
  ]);
  const s = stats.rows[0]!;
  return { metrics: { 'Applications received': s.applications, 'Agency reviewed': s.reviewed, 'Interviews completed': s.interviews, 'Active candidates': s.active }, series: stages.rows, range,
    definitions: ['Applications and completed interviews are events in the selected date range. Drafts and test records are excluded.', 'Stage counts are the current snapshot, not historical stage counts for the selected period.', 'Agency reviewed counts the current eligible stage. It is not a substitute for the live presentation eligibility gate.'] };
}

export async function sourceReport(deps: AppDeps, query: Query): Promise<Report> {
  const range = await rangeFor(deps, query);
  const [stats, sources] = await Promise.all([
    sql<{ enquiries: number; converted: number; repeats: number }>`
      WITH cohort AS (
        SELECT e.id, e.family_id, e.submitted_at FROM enquiries e JOIN families f ON f.id = e.family_id
        WHERE NOT e.is_test AND NOT f.is_test AND f.merged_into_family_id IS NULL
          AND e.submitted_at >= ${range.from}::timestamptz AND e.submitted_at < ${range.toExclusive}::timestamptz
      ) SELECT count(*)::int AS enquiries,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM consultations c WHERE c.enquiry_id = cohort.id
          AND c.status = 'completed' AND c.completed_at >= cohort.submitted_at AND c.completed_at < ${range.toExclusive}::timestamptz))::int AS converted,
        count(DISTINCT family_id) FILTER (WHERE EXISTS (SELECT 1 FROM placements p WHERE p.family_id = cohort.family_id
          AND p.status IN ('booked', 'started', 'ended') AND p.created_at < cohort.submitted_at))::int AS repeats
      FROM cohort
    `.execute(deps.db),
    sql<{ name: string; value: number }>`
      SELECT COALESCE(NULLIF(trim(e.source), ''), 'Unknown') AS name, count(*)::int AS value
      FROM enquiries e JOIN families f ON f.id = e.family_id
      WHERE NOT e.is_test AND NOT f.is_test AND f.merged_into_family_id IS NULL
        AND e.submitted_at >= ${range.from}::timestamptz AND e.submitted_at < ${range.toExclusive}::timestamptz
      GROUP BY COALESCE(NULLIF(trim(e.source), ''), 'Unknown') ORDER BY value DESC, name
    `.execute(deps.db)
  ]);
  const s = stats.rows[0]!;
  return { metrics: { 'New enquiries': s.enquiries, 'Consultations completed': s.converted, 'Cohort conversion': s.enquiries ? `${(s.converted / s.enquiries * 100).toFixed(1)}%` : null, 'Repeat clients': s.repeats }, series: sources.rows, range, sampleSize: s.enquiries,
    definitions: ['Enquiry cohort: enquiries submitted in the selected date range, excluding test/merged families.', 'Conversion: distinct cohort enquiries with a completed consultation by the observation cutoff. Multiple consultations cannot inflate the numerator.', 'Repeat clients: distinct cohort families with a prior confirmed placement. Unknown sources remain visible.'] };
}

export async function placementReport(deps: AppDeps, query: Query): Promise<Report> {
  const range = await rangeFor(deps, query);
  const [stats, series] = await Promise.all([
    sql<{ confirmed: number; started: number; sample: number; missing: number; median: number | null; due: number }>`
      WITH cohort AS (
        SELECT p.*, j.opened_at FROM placements p JOIN families f ON f.id = p.family_id
          JOIN candidates c ON c.id = p.candidate_id JOIN job_orders j ON j.id = p.job_order_id
        WHERE NOT f.is_test AND NOT c.is_test AND NOT j.is_test
          AND f.merged_into_family_id IS NULL AND c.merged_into_candidate_id IS NULL
          AND p.status <> 'cancelled' AND p.created_at >= ${range.from}::timestamptz AND p.created_at < ${range.toExclusive}::timestamptz
      ) SELECT count(*)::int AS confirmed,
        (SELECT count(*)::int FROM placements p JOIN families f ON f.id=p.family_id JOIN candidates c ON c.id=p.candidate_id
          JOIN job_orders j ON j.id=p.job_order_id WHERE NOT f.is_test AND NOT c.is_test AND NOT j.is_test
          AND f.merged_into_family_id IS NULL AND c.merged_into_candidate_id IS NULL AND p.status IN ('started','ended')
          AND p.actual_start_date >= ${range.fromDate}::date AND p.actual_start_date <= ${range.toDate}::date) AS started,
        count(*) FILTER (WHERE opened_at IS NOT NULL AND created_at >= opened_at)::int AS sample,
        count(*) FILTER (WHERE opened_at IS NULL OR created_at < opened_at)::int AS missing,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (created_at - opened_at))/86400.0)
          FILTER (WHERE opened_at IS NOT NULL AND created_at >= opened_at) AS median,
        (SELECT count(*)::int FROM placement_check_ins k JOIN placements p ON p.id=k.placement_id
          JOIN families f ON f.id=p.family_id JOIN candidates c ON c.id=p.candidate_id JOIN job_orders j ON j.id=p.job_order_id
          WHERE NOT f.is_test AND NOT c.is_test AND NOT j.is_test AND p.status <> 'cancelled'
          AND f.merged_into_family_id IS NULL AND c.merged_into_candidate_id IS NULL
          AND k.status='scheduled' AND k.due_on <= ${range.toDate}::date) AS due
      FROM cohort
    `.execute(deps.db),
    sql<{ name: string; value: number }>`
      SELECT to_char(p.created_at AT TIME ZONE ${range.timezone}, 'YYYY-MM') AS name, count(*)::int AS value
      FROM placements p JOIN families f ON f.id=p.family_id JOIN candidates c ON c.id=p.candidate_id JOIN job_orders j ON j.id=p.job_order_id
      WHERE NOT f.is_test AND NOT c.is_test AND NOT j.is_test AND p.status <> 'cancelled'
        AND f.merged_into_family_id IS NULL AND c.merged_into_candidate_id IS NULL
        AND p.created_at >= ${range.from}::timestamptz AND p.created_at < ${range.toExclusive}::timestamptz
      GROUP BY name ORDER BY name
    `.execute(deps.db)
  ]);
  const s = stats.rows[0]!;
  return { metrics: { 'Confirmed placements': s.confirmed, 'Placements started': s.started, 'Median time to placement': s.median === null ? null : `${Number(s.median).toFixed(1)} days`, 'Check-ins due': s.due }, series: series.rows, range, sampleSize: s.sample, missingDataCount: s.missing,
    definitions: ['Confirmed placements are non-cancelled placement records created during the selected period.', 'Time to placement uses job opened_at to placement creation (confirmation); accepted offer dates require a separate metric.', 'Median excludes missing or invalid opening dates. Check-ins due are a current snapshot.'] };
}

export async function financialReport(deps: AppDeps, query: Query): Promise<Report> {
  const range = await rangeFor(deps, query);
  const result = await sql<{ currency: string; invoicedMinor: number; paymentsMinor: number; creditsMinor: number; refundsMinor: number; outstandingMinor: number }>`
    WITH valid_invoices AS (
      SELECT i.* FROM invoices i JOIN families f ON f.id=i.family_id
      WHERE i.status='issued' AND i.voided_at IS NULL AND NOT f.is_test AND f.merged_into_family_id IS NULL
        AND i.issued_on <= ${range.toDate}::date
    ), balances AS (
      SELECT i.id,i.currency,i.total_minor,i.issued_on,
        COALESCE(sum(CASE WHEN p.kind IN ('payment','credit') THEN p.amount_minor ELSE -p.amount_minor END),0) AS applied
      FROM valid_invoices i LEFT JOIN payments p ON p.invoice_id=i.id AND p.voided_at IS NULL AND p.received_on <= ${range.toDate}::date
      GROUP BY i.id,i.currency,i.total_minor,i.issued_on
    ), invoice_totals AS (
      SELECT currency,COALESCE(sum(total_minor) FILTER (WHERE issued_on >= ${range.fromDate}::date),0)::bigint AS invoiced,
        sum(GREATEST(total_minor-applied,0))::bigint AS outstanding FROM balances GROUP BY currency
    ), cash_totals AS (
      SELECT p.currency,
        COALESCE(sum(p.amount_minor) FILTER (WHERE p.kind='payment'),0)::bigint AS payments,
        COALESCE(sum(p.amount_minor) FILTER (WHERE p.kind='credit'),0)::bigint AS credits,
        COALESCE(sum(p.amount_minor) FILTER (WHERE p.kind='refund'),0)::bigint AS refunds
      FROM payments p JOIN valid_invoices i ON i.id=p.invoice_id WHERE p.voided_at IS NULL
        AND p.received_on >= ${range.fromDate}::date AND p.received_on <= ${range.toDate}::date GROUP BY p.currency
    ) SELECT i.currency, i.invoiced AS "invoicedMinor", COALESCE(c.payments,0)::bigint AS "paymentsMinor",
      COALESCE(c.credits,0)::bigint AS "creditsMinor", COALESCE(c.refunds,0)::bigint AS "refundsMinor", i.outstanding AS "outstandingMinor"
      FROM invoice_totals i LEFT JOIN cash_totals c ON c.currency=i.currency ORDER BY i.currency
  `.execute(deps.db);
  const totals = result.rows;
  const one = totals.length === 1 ? totals[0]! : null;
  const money = (minor: number) => formatMoney(minor, one!.currency);
  const mixed = totals.length > 1 ? 'See currency breakdown' : null;
  return { metrics: { 'Fees invoiced': one ? money(one.invoicedMinor) : mixed, 'Payments received': one ? money(one.paymentsMinor) : mixed, 'Outstanding balance': one ? money(one.outstandingMinor) : mixed, 'Credits / refunds': one ? `${money(one.creditsMinor)} / ${money(one.refundsMinor)}` : mixed }, series: [], range, currencyTotals: totals,
    definitions: ['Fees invoiced and payments/credits/refunds use the selected local date period; outstanding is the balance of issued invoices at the period end.', 'Voided invoices/payments and test/merged families are excluded. Different currencies are never summed.', 'Balances reflect currently stored records. This is operational reporting, not a historical general ledger or an accounting replacement. Amounts are minor units.'] };
}

export const reportRoutes: AnyRoute[] = [
  defineRoute({ method: 'GET', path: '/reports/recruitment', operationId: 'codexRecruitmentReport', summary: 'Recruitment events and current stage snapshot', tags: ['Reports'], access: { kind: 'staff', permission: 'reports.operational' }, query: ReportQuery, response: ReportResponse, handler: async ({deps,query}) => ({data:await recruitmentReport(deps,query)}) }),
  defineRoute({ method: 'GET', path: '/reports/sources', operationId: 'codexSourceReport', summary: 'Enquiry cohort conversion and lead sources', tags: ['Reports'], access: { kind: 'staff', permission: 'reports.operational' }, query: ReportQuery, response: ReportResponse, handler: async ({deps,query}) => ({data:await sourceReport(deps,query)}) }),
  defineRoute({ method: 'GET', path: '/reports/placements', operationId: 'codexPlacementReport', summary: 'Placements and observed time to placement', tags: ['Reports'], access: { kind: 'staff', permission: 'reports.operational' }, query: ReportQuery, response: ReportResponse, handler: async ({deps,query}) => ({data:await placementReport(deps,query)}) }),
  defineRoute({ method: 'GET', path: '/reports/financials', operationId: 'codexFinancialReport', summary: 'Agency invoice and payment totals grouped by currency', tags: ['Reports'], access: { kind: 'staff', permission: 'reports.financial' }, query: ReportQuery, response: ReportResponse, handler: async ({deps,query}) => ({data:await financialReport(deps,query)}) })
];
