# Codex reporting contribution — ready to register

Files in this folder are owned by Codex under `../../../../AUREN-WORK-SPLIT.md`. No existing backend source, migrations or provider code were edited by Codex.

`report-routes.ts` exports `reportRoutes`, `ReportResponse`, `ReportQuery` and the four report services. Spread `...reportRoutes` into the backend's central `AnyRoute[]` list before registration and OpenAPI export. The paths are:

- `GET /api/v1/reports/recruitment` — `reports.operational`
- `GET /api/v1/reports/sources` — `reports.operational`
- `GET /api/v1/reports/placements` — `reports.operational`
- `GET /api/v1/reports/financials` — `reports.financial`

These routes reuse the existing server access framework, Kysely/Postgres, agency settings and injected clock. They return `{data:{metrics,series,range,definitions,...}}` matching the frontend reporting UI. They do not expose candidate/reference/contact records.

Query: `days=30` (1–730) or explicit `from=YYYY-MM-DD&to=YYYY-MM-DD`. Dates are agency-local, the observation cutoff is explicit, and future/reversed/oversized ranges are refused. Recruitment stage counts are a labeled current snapshot. Enquiry conversion counts distinct cohort enquiries with completed consultations, so multiple consultations do not inflate conversion. Unknown sources remain visible. Test and merged records are excluded.

Financial output has `currencyTotals` in minor units; different currencies are never added. Fees invoiced, payments received, credits, refunds and outstanding balance have separate definitions. Operational records are not presented as a general ledger.

## Executed verification

`npx tsx src/codex/reporting.integration.ts` **passed** against real isolated Postgres on port 54331, applying the 11 current migrations. It checked:

- zero records and zero conversion denominator;
- duplicate consultation exclusion in conversion;
- test-record exclusion from candidates, enquiries and invoices;
- unknown source visibility;
- USD/EUR separation, payment, credit, refund and balance arithmetic;
- 25-hour Denver daylight-saving day;
- output schema validation and financial permission declaration.

The test creates a uniquely named `codex_reports_<timestamp>` database on its isolated cluster and drops only that generated database in `finally`. It does not use `auren_dev`, real data or provider credentials. No public email is sent.

HTTP authentication and registrar integration still need to be exercised after Claude registers these routes. The complete backend typecheck currently includes work-in-progress errors in other modules; the contribution produced no TypeScript diagnostics in the observed run.
