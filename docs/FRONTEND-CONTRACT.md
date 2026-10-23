# Frontend contract (/api/v1)

For the frontend implementer. The transport source of truth is [`contract/openapi.json`](../contract/openapi.json) (OpenAPI 3.1, 279 operations), with generated types in [`contract/api-types.d.ts`](../contract/api-types.d.ts). Regenerate both with `npm run contract`; the running API serves the same document at `GET /api/v1/openapi.json`. Every DTO, enum and field rule is in the OpenAPI file. This page covers conventions, flows and the pages the frontend must provide.

All areas listed here are implemented and covered by the automated suite (36 tests against PostgreSQL) unless marked otherwise.

## Connecting

- Local API: `http://127.0.0.1:5181` (`npm run dev`). Frontend: `http://127.0.0.1:5180`.
- Proxy `/api/*` from the Next app to `AUREN_API_ORIGIN=http://127.0.0.1:5181` so cookies are first-party. Direct cross-origin calls also work from `APP_ORIGINS` with `credentials: 'include'`.
- Every response carries `X-Request-Id`; show it in error UIs.
- Local login: `.data/dev-owner.env`. Synthetic data: `npm run db:seed`. Emails land in `.data/mailbox/*.txt`; open the links from there.

## Sessions and security

- **Staff:** the HttpOnly cookie `auren.session_token` (SameSite=Lax, 12 h).
  - `GET /auth/session` returns `SessionState` and never 401s.
  - Sign in with `POST /auth/sign-in`. If it returns `two_factor_required`, follow with `POST /auth/two-factor/verify`.
  - When the agency requires MFA, other routes return `403 mfa_enrollment_required` until the user enrolls via `POST /auth/two-factor/enable` and `/confirm`.
- **Applicant:** the HttpOnly cookie `auren_draft` (path `/api/v1/public/application-drafts`), scoped to one draft. Never store application answers or tokens in localStorage.
- **No CSRF token.** Protection is SameSite cookies, a server Origin check on every mutation (`403 origin_not_allowed`) and JSON-only bodies. Always send `Content-Type: application/json`, except raw file uploads, which use `application/octet-stream`.

## Conventions

| Topic | Rule |
| --- | --- |
| Errors | `{ error: { code, message, requestId, fieldErrors?, details? } }`. Branch on `code`; `message` is safe to show. |
| Validation | `422 validation_failed` with `fieldErrors[{ path, code, message }]`, using dot paths into your body. |
| Concurrency | Records carry `version`; send it back. A stale value returns `409 version_conflict` with `details.currentVersion`. Child edits (employments, qualifications, …) take the parent `version`. Drafts use `revision` (`409 revision_conflict`). Content uses `baseRevisionId`. |
| Idempotency | Header `Idempotency-Key` (a UUID per logical attempt; reuse it on retry). **Required** for `POST /public/enquiries`, `POST /public/application-drafts/current/submit` and `POST /presentations/{id}/release`. A replay returns the original response with `Idempotent-Replayed: true`. |
| Pagination | `?page=&pageSize=` (max 100) returns `{ items, page, pageSize, total }`. Repeat array params: `?stage=a&stage=b`. |
| Time / money | Instants are UTC ISO; dates are `YYYY-MM-DD`; the agency timezone is America/Denver. Money is integer minor units plus currency; never add up different currencies. |
| Unknown | `null` means not recorded. It never counts as a match. |
| Stages | Labels, order and `allowedNext` come from `GET /reference-data`. Stages with `manualEntry: false` are set only by their command, otherwise `422 stage_requires_command`. |
| Rate limits | `429 rate_limited` with `Retry-After`. |
| Files | Upload flow: request a slot, `PUT` the bytes to `upload.url` with `upload.headers`, then call `…/complete`. Downloads: request a short-lived link (`…/download-link`) and open its `url`. |

## Pages the frontend must provide (emailed links)

| Path | Calls |
| --- | --- |
| `STAFF_APP_URL/reset-password?token=` | `POST /auth/password/reset` |
| `STAFF_APP_URL/accept-invitation?token=` | `GET /auth/invitations/{token}`, then `POST /auth/invitations/accept` |
| `PUBLIC_SITE_URL/apply/resume?token=` | `POST /public/application-drafts/resume` (sets the draft cookie), then continue the form |

## Key flows

**Family enquiry (public).**
1. `GET /public/forms/family_enquiry`, and render custom questions from `layout.sections[].questions[].definition`.
2. `GET /public/reference-data` and `GET /public/legal-notices/privacy_notice` to show the notice.
3. `POST /public/enquiries`, which returns `202` with a `reference`.

**Candidate application (public).**
1. `POST /public/application-drafts {email, firstName}` sets the cookie and emails a code and link.
2. `POST …/current/verify {code}` (or the emailed link) verifies the email, which uploads and submit require.
3. `GET …/current` returns state (`revision`, `data`, `documents`, `completedSections`).
4. Autosave per section with `PUT …/current/sections/{contact|experience|employment|qualifications|preferences|references|documents|acknowledgements|custom} {revision, data}`. Sections accept partial data; the required rules apply only at submit, which returns `fieldErrors` by path.
5. Uploads: `POST …/current/uploads`, then `PUT` the bytes, then `POST …/current/uploads/{id}/complete`. `scanStatus` comes back clean, rejected or quarantined.
6. `POST …/current/submit` with an Idempotency-Key returns `201 {reference}`.
7. To continue on another device: `POST …/resume-link {email}` (always 202).

**Staff candidate work.**
- List with `GET /candidates`, or `POST /candidates/search` (`CandidateSearchCriteria`; `qualificationGroups` expresses "current CPR **and** current First Aid").
- Profile and sub-records live under `/candidates/{id}/…`.
- Screening records: `/candidates/{id}/references|interviews|checks`, plus `/references/{id}/…`, `/interviews/{id}/…` and `/checks/{id}/…`.
- Eligibility: `GET /candidates/{id}/eligibility?jobOrderId=`.
- Owner overrides: `POST /candidates/{id}/eligibility-overrides`.
- Missing information: `POST /candidates/{id}/information-requests`.

**Jobs to placement.**
1. `POST /jobs`, then `POST /jobs/{id}/candidates`.
2. Compare a candidate: `GET /jobs/{id}/candidates/{candidateId}/comparison`.
3. Presentation:
   - `POST /jobs/{id}/presentations`
   - `GET /presentations/{id}/preview` (issues list what blocks approval)
   - `POST …/approve` (snapshot + PDF)
   - `POST …/release` with `recipientConfirmed` and `noRevocationAcknowledged` plus an Idempotency-Key
4. Offer and outcome: `POST /job-candidates/{id}/offers`, then `POST /offers/{id}/respond`.
5. `POST /placements` (needs an accepted offer).

**Calendar and tasks.**
- `GET /calendar?from&to`.
- Consultations: `POST /enquiries/{id}/consultations`. Interviews: `POST /candidates/{id}/interviews`. Family interviews, trials and check-ins: `POST /appointments`.
- Change or cancel any appointment with `POST /appointments/{id}/reschedule|close`. Rescheduling or cancelling stops the old reminders.
- Tasks: `/tasks`; notes: `/notes`.
- History: `GET /communications`. Log a reply with `…/contact-log` and `isReply: true`; this stops follow-up sequences.

**Automation (owner screens).**
- `GET /automation/status` (health).
- `GET /automation/triggers` (editor catalogue).
- Workflows: `GET|POST /automation/workflows`, save a draft with `POST /automation/workflows/{id}/versions`, publish or roll back with `POST /automation/workflow-versions/{id}/publish`, turn on or off with `POST /automation/workflows/{id}/enabled`, dry run with `POST /automation/workflows/preview`.
- Runs: `/automation/runs`.
- Approval queue: `GET /automation/approvals`, then `POST /automation/steps/{id}/approve|reject`.
- Attention: `GET /automation/attention`, and resolve failed or ambiguous sends with `POST /automation/deliveries/{id}/resolve`.
- Templates: `/automation/templates…`, with preview and test-send.
- Suppressions and pauses: `/automation/suppressions`, `/automation/pause` (global) and `/automation/pauses` (per record).

**Website content.**
- Staff:
  - `POST /content/entries` creates an entry (collection = page, service, faq, resource or global).
  - `POST /content/entries/{id}/revisions` saves edits (send `baseRevisionId`).
  - `POST …/publish`, `…/unpublish` and `…/restore` manage what's live.
  - `POST …/preview-link` returns a token for `GET /public/content/{collection}/by-slug?slug=&preview=`.
- Public: `GET /public/content/{collection}` and `GET /public/content/{collection}/by-slug?slug=`. Only published content is returned, cached for 60 s.
- Media: `POST /media` (slot), then `PUT …/content`, then `POST /media/{id}/complete`. Images only; SVG is refused.

**Settings, forms, governance and finance.**
- Settings: `/settings`, `/settings/stages/…`, `/settings/taxonomies/…`, `/staff…`.
- Forms: `/questions`, `PUT /forms/{key}/draft`, `GET /forms/versions/{id}/impact`, `POST /forms/versions/{id}/publish`.
- Governance: `/duplicates` (dismiss/merge), `/exports`, `/retention-policies`, `/retention-requests`, `/legal-holds`, `/audit`, `/legal-notices`, `/candidates/{id}/consents`, `/consents/{id}/withdraw`.
- Finance: `/invoices…`, `/payments/{id}/void`, `/families/{id}/agreements`, `/agreements/{id}/status`.
- Saved searches: `/saved-searches`.
- Reports (Codex-owned): `/reports/recruitment|sources|placements|financials`.

Permissions for every route are in [PERMISSIONS.md](PERMISSIONS.md). Existing DTO keys will not be renamed. Any unavoidable breaking change will be recorded in `AUREN-WORK-SPLIT.md` first.
