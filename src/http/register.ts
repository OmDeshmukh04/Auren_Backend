import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps, RequestMeta } from '../context.js';
import { AppError, forbidden, unauthorized, validationFailed, zodFieldErrors } from './errors.js';
import { resolveApplicant, resolveStaff } from './actors.js';
import { enforceRateLimit } from './security.js';
import { RawResponse, WithStatus, type AnyRoute, type RouteContext } from './route.js';
import { hashIp, safeEqual } from '../lib/crypto.js';
import { getSettings } from '../domain/settings.js';

export const API_PREFIX = '/api/v1';

function parsePart(schema: z.ZodType | undefined, value: unknown, part: string) {
  if (!schema) return undefined;
  const result = schema.safeParse(value ?? (part === 'body' ? undefined : {}));
  if (!result.success) {
    throw validationFailed(zodFieldErrors(result.error, part === 'body' ? undefined : part));
  }
  return result.data;
}

export function clientIp(req: FastifyRequest) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps, routes: AnyRoute[]) {
  const seen = new Set<string>();
  for (const def of routes) {
    const signature = `${def.method} ${def.path}`;
    if (seen.has(signature)) throw new Error(`Duplicate route ${signature}`);
    if (seen.has(def.operationId)) throw new Error(`Duplicate operationId ${def.operationId}`);
    seen.add(signature);
    seen.add(def.operationId);

    app.route({
      method: def.method,
      url: `${API_PREFIX}${def.path}`,
      ...(def.binaryBodyLimit ? { bodyLimit: def.binaryBodyLimit } : {}),
      handler: async (req, reply) => {
        const ip = clientIp(req);
        const meta: RequestMeta = {
          actor: { type: 'public' },
          requestId: req.id,
          ipHash: hashIp(deps.config.SIGNING_SECRET, ip),
          now: deps.clock.now()
        };
        const ctx = {
          req,
          reply,
          deps,
          meta,
          idempotencyKey: null as string | null,
          rawBody: (req as FastifyRequest & { rawBody?: string }).rawBody
        } as RouteContext<unknown, unknown, unknown>;

        switch (def.access.kind) {
          case 'staff': {
            const staff = await resolveStaff(deps, req);
            if (!staff) throw unauthorized('Sign in to continue.');
            if (!def.access.allowWithoutMfa && !staff.mfaEnabled) {
              const settings = await getSettings(deps.db);
              if (settings.requireStaffMfa) {
                throw forbidden('Set up two-factor authentication to continue.', 'mfa_enrollment_required');
              }
            }
            if (def.access.permission && !staff.permissions.has(def.access.permission)) throw forbidden();
            meta.actor = staff;
            Object.defineProperty(ctx, 'staff', { value: staff });
            break;
          }
          case 'applicant': {
            const applicant = await resolveApplicant(deps, req);
            meta.actor = applicant;
            Object.defineProperty(ctx, 'applicant', { value: applicant });
            break;
          }
          case 'cron': {
            const header = req.headers.authorization ?? '';
            const secret = deps.config.CRON_SECRET;
            if (!secret || !safeEqual(header, `Bearer ${secret}`)) throw unauthorized('Runner authentication failed.', 'runner_unauthorized');
            meta.actor = { type: 'system', component: 'runner' };
            break;
          }
          default:
            break;
        }
        for (const getter of ['staff', 'applicant'] as const) {
          if (!Object.getOwnPropertyDescriptor(ctx, getter)) {
            Object.defineProperty(ctx, getter, {
              get() {
                throw new Error(`Route ${def.operationId} has no ${getter} actor`);
              }
            });
          }
        }

        for (const rule of def.rateLimits ?? []) {
          await enforceRateLimit(deps, `${rule.name}:${meta.ipHash}`, rule.max, rule.windowSeconds);
        }

        ctx.params = parsePart(def.params, req.params, 'params');
        ctx.query = parsePart(def.query, req.query, 'query');
        ctx.body = def.binaryBodyLimit ? req.body : parsePart(def.body, req.body, 'body');

        if (def.idempotency) {
          const key = req.headers['idempotency-key'];
          const value = Array.isArray(key) ? key[0] : key;
          if (!value && def.idempotency === 'required') {
            throw new AppError(400, 'idempotency_key_required', 'Send an Idempotency-Key header (a random UUID per logical attempt).');
          }
          ctx.idempotencyKey = value ?? null;
        }

        const result = await def.handler(ctx as never);
        if (result instanceof RawResponse) {
          reply.status(result.status).headers(result.headers);
          return reply.send(result.body);
        }
        const status = result instanceof WithStatus ? result.status : (def.status ?? 200);
        if (result instanceof WithStatus) reply.headers(result.headers);
        if (status === 204) return reply.status(204).send();
        const parsed = def.response.safeParse(result instanceof WithStatus ? result.body : result);
        if (!parsed.success) {
          req.log.error({ operationId: def.operationId, issues: parsed.error.issues.slice(0, 5) }, 'Response did not match its schema');
          throw new AppError(500, 'internal_error', 'The request could not be completed.');
        }
        return reply.status(status).send(parsed.data);
      }
    });
  }
}
