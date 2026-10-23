# ADR 0001: Headless TypeScript API on Postgres instead of Payload

Date: 22 October 2026. Status: accepted (implementation in progress).

## Context

The backend plan recommends Next.js + Payload + Postgres in one application, "unless a documented architecture spike proves a better lower-cost option". The owner then split delivery into two codebases: this backend repository and a separately implemented frontend (Codex, `auren-households-demo/platform/`). The frontend team builds every public page and staff screen, including the content editor.

## Decision

A headless API service:

- TypeScript, Fastify 5, Zod 4 schemas.
- Kysely on PostgreSQL. Hand-written SQL migrations are the single schema history; Kysely types are generated from them.
- Better Auth for staff authentication (maintained library: sessions, password reset, TOTP MFA). Its HTTP router is not mounted; our `/api/v1/auth` routes call it.
- Transactional outbox, workflow runs and a delivery ledger in our own tables, executed by an authenticated scheduled runner (and an optional long-running worker).
- Provider adapters: Resend (email), S3-compatible private bucket such as Cloudflare R2 (files), ClamAV (malware scanning), Turnstile (optional bot check).
- One OpenAPI 3.1 contract generated from the route definitions, which the frontend consumes.

## Why

- With separate repositories and a frontend team building all screens, Payload's main value (its admin UI co-located with Next.js) would either go unused or create a second staff UI competing with the frontend's.
- Most of the plan is custom domain logic (screening gates, presentation release, durable workflows) that Payload does not provide. The plan itself says so.
- Owning the schema in SQL gives foreign keys, composite integrity (a placement's family, job and candidate must agree), check constraints, partial unique indexes and immutability triggers directly.
- There is one Postgres implementation for local, test, staging and production. Local and test use real PostgreSQL 18 binaries via `embedded-postgres` (no Docker); production uses Neon.

## Consequences

- We build content versioning (draft/publish/restore) and the content API ourselves. The frontend builds the editor screens.
- Better Auth tables (`auth_*`) follow the library's schema. `scripts/auth-schema.ts` re-derives them after library upgrades.
- The plan's Payload Jobs Queue is replaced by our runner over domain tables. Its behavioral requirements (durable, idempotent, retry with backoff, catch-up with stale-message policy) still apply and are tested.
- MFA is the library's TOTP plugin. Whether to enforce it is an agency setting (`requireStaffMfa`).
