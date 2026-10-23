# Operations runbook

For whoever deploys and operates the Auren backend. Recovery targets in this document are proposals to agree with the owner; they are not achieved guarantees until a restore exercise has been timed.

## Environments

| | Development | Staging | Production |
| --- | --- | --- | --- |
| Database | Local PostgreSQL 18 (`npm run dev`) | Neon branch | Neon (PITR enabled) |
| Email | `log` → `.data/mailbox` | Resend, `EMAIL_ALLOWLIST` set | Resend, no allowlist |
| Files | `local` → `.data/storage` | R2 staging buckets | R2 production buckets |
| Scanner | `dev-allow` | `clamd` | `clamd` |

Staging and production refuse dev-only providers at startup (see `src/config.ts`). Preview deployments must use staging credentials, never production data.

## Required configuration (staging/production)

Set these in the Vercel project (encrypted env vars). Never commit them.

| Group | Settings |
| --- | --- |
| Environment | `APP_ENV=production` (or `staging`), `TRUST_PROXY=true` |
| Database | `DATABASE_URL` (Neon pooled), `DATABASE_SSL=true` |
| Secrets | `AUTH_SECRET`, `SIGNING_SECRET`, `CRON_SECRET` (32+ random bytes each) |
| URLs | `API_PUBLIC_URL`, `PUBLIC_SITE_URL`, `STAFF_APP_URL`, `APP_ORIGINS` (exact origins), optional `COOKIE_DOMAIN` |
| Email | `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM` (verified domain), `EMAIL_REPLY_TO` |
| Storage | `STORAGE_PROVIDER=s3`, `S3_ENDPOINT`, `S3_REGION=auto`, `S3_PRIVATE_BUCKET`, `S3_PUBLIC_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `PUBLIC_MEDIA_BASE_URL` |
| Scanner | `SCANNER_PROVIDER=clamd`, `CLAMD_HOST`, `CLAMD_PORT`. The ClamAV daemon runs on a small VM or container that the API can reach. Without it, uploads stay quarantined (safe, but unusable). |
| Optional | `TURNSTILE_SECRET_KEY` |

Buckets: the private bucket has **no public access**, plus CORS allowing `PUT` from the site origins (direct uploads). The public bucket serves website media only.

## Deploy

1. Run the tests against a disposable database: `npm test`.
2. Apply migrations as a release step **before** promoting: `DATABASE_URL=… APP_ENV=production npm run db:migrate`. Migrations are append-only and checksummed; the API never migrates on request. `GET /api/v1/health` returns 503 while migrations are pending.
3. Deploy to Vercel. `vercel.json` routes `/api/*` to `api/index.ts` and schedules `/api/v1/internal/runner/tick` every minute. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Check the plan's cron frequency and concurrency limits. A long-running worker (`npm run worker`, every 15 s) can run alongside or instead; both are safe together.
4. First owner (once, from a trusted machine): `npm run owner:create -- --email … --name …`. Invite everyone else from the workspace.
5. In Resend, add a webhook to `https://<api>/api/v1/webhooks/resend` for the `email.*` events and put its signing secret in `RESEND_WEBHOOK_SECRET`.
6. Smoke test: `/health`, sign in, submit a test enquiry and application to an allowlisted address, run a tick, then check `/automation/status`.

Rollback: redeploy the previous build. Migrations are additive, so the previous build keeps working on the newer schema; never edit or delete an applied migration.

## Before opening forms to the public (owner decisions)

1. Publish counsel-approved notices: privacy notice, application terms, reference and background authorizations, profile sharing (`/legal-notices`). Deployed environments refuse submissions until the privacy notice is published.
2. Publish a screening policy (`/screening-policies`). Without one, nobody is eligible for presentation.
3. Review the email template wording and enabled workflows; the follow-up and outreach sequences ship disabled.
4. Set `notificationEmail`, `replyToEmail`, business hours, quiet hours, holidays and `requireStaffMfa` (recommended) in `/settings`.
5. Approve retention periods (`/retention-policies`). Nothing is deleted automatically until a policy is approved.
6. Confirm service area, services, fees and the guarantee wording on the website content.

## Monitoring

Alert on these from `GET /api/v1/automation/status` (owner session) and `/health`:

| Signal | Alert when |
| --- | --- |
| `/health` | Not 200 (database down or migrations pending) |
| `runner.lastFinishedAt` | More than 5 minutes old (scheduler not running) |
| `oldestPendingEventAt` | More than 10 minutes old |
| `failedEvents` / `overdueSteps` | Above zero |
| `actionNeeded` / `failedDeliveries` | Above zero; owner tasks are also created |
| `ambiguousDeliveries` | Above zero; reconcile them, see below |
| `quarantinedDocuments` | Growing; the scanner is down |

Logs are JSON (pino) with cookies and authorization headers redacted. Applicant details are not written to logs.

## Reconciling an ambiguous email

`ambiguous` means the provider may or may not have accepted the message, and the provider's 24-hour idempotency window has passed.

1. Search the Resend dashboard for the recipient and subject.
2. If the message was sent, use `POST /automation/deliveries/{id}/resolve {"action":"mark_sent"}`.
3. If it was not sent, use `{"action":"retry"}`. If it should no longer go out, use `{"action":"cancel"}`.
4. The linked reconcile task closes automatically.

## Backups and restore

Proposed targets: lose no more than 24 hours of data, and restore within one business day.

- **Database:** Neon point-in-time restore. Set the history retention to at least 7 days. Additionally take a weekly logical dump (`pg_dump -Fc`) to an access-controlled bucket in another account.
- **Private files:** enable R2 bucket replication or a nightly copy to a second bucket with separate credentials. Document keys are random, and metadata lives in Postgres.

**Restore exercise (quarterly, required before launch):**
1. Branch or restore Neon to a timestamp in an isolated project.
2. Copy the private bucket snapshot to an isolated bucket.
3. Point a staging deployment at both, with email set to the allowlist.
4. Verify the row counts of `families`, `candidates`, `applications`, `placements` and `documents`, and download 3 random documents, checking their `sha256` against `documents.sha256`.
5. Record the elapsed time and any gaps.

## Secret rotation

| Secret | Effect of rotating it |
| --- | --- |
| `AUTH_SECRET` | Signs out every staff member. |
| `SIGNING_SECRET` | Invalidates outstanding download, preview and IP-hash links (short-lived anyway). |
| `CRON_SECRET` | Update Vercel and any worker together. |
| Resend key, S3 keys | Rotate at the provider, update the env vars, then redeploy. |

Never put secrets in chat, tickets or this repository.

## Incident checklist

1. Pause automation if messages are going wrong: `POST /automation/pause {"paused":true,"reason":"…"}`. Steps wait. On resume, steps more than `staleMessageHours` overdue are skipped rather than sent late.
2. For a suspected account compromise: suspend the staff member (`PATCH /staff/{id}`, which revokes their sessions), then rotate `AUTH_SECRET` if needed.
3. Review `/audit` filtered by actor or subject.
4. Record what happened and the follow-up actions.
