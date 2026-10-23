import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { ApplicantActor, AppDeps, RequestMeta, StaffActor } from '../context.js';
import type { Permission } from '../auth/permissions.js';

/**
 * Route definitions. Each route declares its access rule, permission, schemas, idempotency and
 * rate limits in one place; the registrar enforces them and the OpenAPI contract and permission
 * matrix are generated from the same definitions.
 */

export type Access =
  /** Anyone. Use for published content and public forms only. */
  | { kind: 'public' }
  /** A signed-in, active staff member with the permission (null = any staff role). */
  | { kind: 'staff'; permission: Permission | null; allowWithoutMfa?: boolean }
  /** An applicant holding a draft session cookie; scoped to that one draft. */
  | { kind: 'applicant' }
  /** The scheduled runner (Authorization: Bearer CRON_SECRET). */
  | { kind: 'cron' }
  /** Provider webhooks; the handler verifies the signature against the raw body. */
  | { kind: 'webhook' };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RateLimitRule {
  /** Bucket name; the client IP hash is appended. */
  name: string;
  max: number;
  windowSeconds: number;
}

export interface RouteContext<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  req: FastifyRequest;
  reply: FastifyReply;
  deps: AppDeps;
  meta: RequestMeta;
  /** The signed-in staff member (staff routes only). */
  staff: StaffActor;
  /** The applicant's draft session (applicant routes only). */
  applicant: ApplicantActor;
  /** The Idempotency-Key header, when the route accepts one. */
  idempotencyKey: string | null;
  /** Raw request body as received (JSON routes). */
  rawBody: string | undefined;
}

/** A response that bypasses JSON serialization (files, CSV, redirects). */
export class RawResponse {
  constructor(
    readonly status: number,
    readonly body: Buffer | string | null,
    readonly headers: Record<string, string> = {}
  ) {}
}

/** A schema-validated JSON body with an explicit status and headers (e.g. idempotent replays). */
export class WithStatus<T = unknown> {
  constructor(
    readonly status: number,
    readonly body: T,
    readonly headers: Record<string, string> = {}
  ) {}
}

type ZodAny = z.ZodType;
type Out<S> = S extends ZodAny ? z.output<S> : undefined;
type In<S> = S extends ZodAny ? z.input<S> : undefined;

export interface RouteDef<
  P extends ZodAny | undefined = ZodAny | undefined,
  Q extends ZodAny | undefined = ZodAny | undefined,
  B extends ZodAny | undefined = ZodAny | undefined,
  R extends ZodAny = ZodAny
> {
  method: HttpMethod;
  /** Path below /api/v1, Fastify style (`/candidates/:id`). */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  access: Access;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  /** Success status (default 200). Use 204 with `response: NoContent`. */
  status?: 200 | 201 | 202 | 204;
  /** Idempotency-Key header: required for repeatable commands, optional where helpful. */
  idempotency?: 'required' | 'optional';
  rateLimits?: RateLimitRule[];
  /** Non-JSON response documented in OpenAPI (e.g. application/pdf). */
  produces?: string;
  /** Accept a raw binary body (application/octet-stream) up to this many bytes. */
  binaryBodyLimit?: number;
  handler(ctx: RouteContext<Out<P>, Out<Q>, Out<B>>): Promise<In<R> | RawResponse | WithStatus<In<R>>>;
}

// Route lists hold routes with different schema types; variance requires an erased type here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = RouteDef<any, any, any, any>;

export function defineRoute<
  P extends ZodAny | undefined = undefined,
  Q extends ZodAny | undefined = undefined,
  B extends ZodAny | undefined = undefined,
  R extends ZodAny = ZodAny
>(def: RouteDef<P, Q, B, R>): RouteDef<P, Q, B, R> {
  return def;
}
