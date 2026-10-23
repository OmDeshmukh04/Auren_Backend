# Implementation status

As of 23 October 2026. "Verified" means covered by the automated suite (`npm test`: 36 tests against PostgreSQL 18 with provider test doubles) or exercised on the running local server. "Unverified" means implemented but not yet demonstrated, or dependent on real providers or owner decisions.

## Milestones (backend plan §10)

| Milestone | State | Notes |
| --- | --- | --- |
| B0 discovery and foundation | Done (local) | Schema (17 migrations), contract, permission matrix, ADR 0001. **Unverified:** staging deployment and the cost sheet, which needs live quotes. |
| B1 content, identity, intake | Done | CMS with versions, preview and restore; Better Auth sessions, TOTP MFA, invitations and reset; family intake; application draft/resume/submit; form versions; private uploads with scanning. |
| B2 candidate operations | Done | Typed profile and sub-records, combined search, saved searches, interviews, references, checks, the eligibility policy and overrides, audit, and duplicates/merge. |
| B3 client, job, placement | Done | Family CRM and timeline, job orders and criteria, candidate–job stages, comparison, offers, placements, check-ins, replacement search, agreements, invoices and payments, and PDF presentations. |
| B4 automation and reporting | Done (backend) | Durable outbox runner, 20 default workflows, templates, the editor API with preview and rollback, approvals, deliveries, webhooks, tasks and calendar. Reports are the Codex-owned `src/codex`, which is registered. |
| B5 launch and handover | Partly done | Runbook and docs are written. **Not done:** real provider staging tests, the timed restore exercise, owner training and live data migration (none needed: the demo data is synthetic). |

## Launch gates (plan §11)

| # | Gate | Evidence |
| --- | --- | --- |
| 1 | Resume across sessions, multiple employments and references, clean upload, one submission despite repeated clicks, one acknowledgement | `applications.test.ts`, `automation.test.ts` |
| 2 | Spoofed draft ids, expired links, cross-user files, public queries reveal nothing | `applications.test.ts`, `core.test.ts` |
| 3 | Concurrent edits conflict | `core.test.ts` (candidate), `applications.test.ts` (draft revision), `admin.test.ts` (content) |
| 4 | Denver + 5 years + infant + current CPR/First Aid + full time; unknown or expired data excluded | `core.test.ts` |
| 5 | Scheduled or ordered checks don't grant eligibility; expiry and overrides work | `pipeline.test.ts` |
| 6 | Independent candidate–job associations; families with several jobs | `core.test.ts`, `pipeline.test.ts` |
| 7 | PDF release excludes references, notes and contact details, including after later edits | `pipeline.test.ts` |
| 8 | Restart, duplicate event, double cron, webhook replay and provider timeout don't duplicate; ambiguous sends surface | `automation.test.ts` |
| 9 | Rescheduled or cancelled appointments never send old reminders; recorded replies stop follow-ups; Denver DST | `automation.test.ts` |
| 10 | Merge, export and retention respect roles and keep history | `admin.test.ts` |
| 11 | Dashboards reconcile with records | **Codex-owned reports.** Backend exports are tested; report reconciliation is not yet tested here. |
| 12 | Restore into an isolated environment | **Not done**; procedure in RUNBOOK.md |
| 13 | Owner completes the end-to-end tasks independently | **Not done**; needs the frontend and owner training |

## Known limitations and open decisions

- **Email replies aren't detected.** There is no two-way mailbox sync, so a delivery webhook doesn't mean the family replied. Staff must log replies (`isReply: true`) to stop sequences, which is why time-based outreach defaults to staff approval.
- **No distance matching.** Search filters by city and area only; mileage matching would need a geocoding provider.
- **Malware scanning needs a ClamAV daemon in staging and production.** Without one, uploads stay quarantined.
- **Placeholder legal and policy content.** Notices and the screening policy are seeded as drafts with placeholder wording. Counsel must approve them, and the owner must publish them. Retention periods take effect only once approved.
- **MFA is optional.** It's TOTP via Better Auth and becomes mandatory only if the owner sets `requireStaffMfa`.
- **The original brief's 21 status labels haven't been checked.** The brief wasn't available to the backend; map them against `GET /reference-data` stages before launch.
- **Some plan items are out of scope:** portals, SMS, calendar sync, e-signature, accounting integration and AI extraction, as the plan intends.
- **Assigned-records scope is only partly enforced.** The coordinator "assigned records only" setting covers families, enquiries, candidates, jobs, tasks and documents. Reports and exports are owner or permission-gated instead.
