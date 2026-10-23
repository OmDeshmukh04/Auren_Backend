# Auren Households backend

The `/api/v1` service behind the Auren Households website and staff workspace. It covers staff auth, the family CRM, the candidate database and search, screening gates, jobs and placements, and, as they land, applications, presentations, automation, content and reporting. The frontend lives in a separate codebase and consumes the contract in [`contract/openapi.json`](contract/openapi.json). Conventions and flows are in [docs/FRONTEND-CONTRACT.md](docs/FRONTEND-CONTRACT.md); the architecture decision is in [docs/adr/0001-headless-api-architecture.md](docs/adr/0001-headless-api-architecture.md).

## Run locally (no Docker)

Requires Node 22.12+.

```powershell
npm install
copy .env.example .env      # then fill AUTH_SECRET, SIGNING_SECRET, CRON_SECRET
npm run dev                 # starts local PostgreSQL 18, applies migrations, serves http://127.0.0.1:5181
npm run owner:create -- --email owner@example.com --name "Owner Name"   # in a second terminal, once
```

`npm run dev` keeps PostgreSQL data in `.data/postgres`. Emails are written to `.data/mailbox/` and uploads to `.data/storage/`, all git-ignored. `owner:create` prints a one-time password unless `OWNER_PASSWORD` is set.

Check it: `GET http://127.0.0.1:5181/api/v1/health`. The contract is at `GET /api/v1/openapi.json`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Local PostgreSQL + migrations + API with reload |
| `npm run db:start` | Local PostgreSQL only (for scripts against the dev database) |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` (release step) |
| `npm run db:codegen` | Regenerate `src/db/schema.ts` from the migrations |
| `npm run owner:create` | Create the first owner account |
| `npm run contract` | Write `contract/openapi.json`, `contract/api-types.d.ts`, `docs/PERMISSIONS.md` |
| `npm run typecheck` | TypeScript check |
| `npm test` | 36 tests against a real local PostgreSQL (no Docker) |
| `npm run db:seed` | Synthetic local families, candidates and jobs (development only) |
| `npm run worker` | Optional long-running automation worker |

## Rules that matter

- Migrations are append-only and checksummed. Never edit an applied file; add a new one. The API never migrates on request.
- Schema changes: add a migration, run `npm run db:codegen`, then `npm run contract` when DTOs change.
- `src/codex/` is owned by the frontend implementer; it is registered in `src/routes.ts` and is not edited here.
- No secrets in the repository. Staging and production refuse dev-only providers (log email, local storage, the allow-all scanner).

## Status

All backend modules in the plan are implemented: auth and staff, settings, CMS and media, forms, family CRM and intake, candidate applications, profiles, search, screening and eligibility, jobs, offers, placements, presentations (PDF), operations (calendar, tasks, notes, communications), durable automation, finance, governance and exports. The contract has 279 operations and the suite has 36 PostgreSQL tests. What is verified and what is not (staging providers, restore exercise, owner decisions) is listed in [docs/STATUS.md](docs/STATUS.md); deployment and operations are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Deploy

Merges to `main` run CI; when it passes, GitHub Actions fast-forwards the `deploy` branch, which Render builds. Setup and environment values: [docs/DEPLOY.md](docs/DEPLOY.md).
