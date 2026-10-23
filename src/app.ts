import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { AppDeps } from './context.js';
import { AppError, fromDatabaseError } from './http/errors.js';
import { API_PREFIX, registerRoutes } from './http/register.js';
import { originAllowed } from './http/security.js';
import { allRoutes } from './routes.js';

/** Builds the HTTP application. The same instance serves Node, serverless handlers and tests. */
export async function buildApp(deps: AppDeps, options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 512 * 1024,
    requestIdHeader: false,
    genReqId: () => `req_${randomBytes(9).toString('base64url')}`,
    routerOptions: { ignoreTrailingSlash: true }
  });
  const selfOrigin = new URL(config.API_PUBLIC_URL).origin;

  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || config.APP_ORIGINS.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'Accept'],
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Retry-After', 'Content-Disposition'],
    maxAge: 600
  });
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: config.isDeployed ? { maxAge: 31536000, includeSubDomains: true } : false
  });

  // JSON bodies keep their raw text for webhook signature checks. Only JSON and (on routes that
  // opt in) binary uploads are accepted; text/plain, a CORS "simple" type, is not parsed.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, 'invalid_json', 'Send a valid JSON body.'), undefined);
    }
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
    reply.header('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.url.startsWith(`${API_PREFIX}/webhooks/`)) {
      if (!originAllowed(req.headers.origin, config.APP_ORIGINS, selfOrigin)) {
        throw new AppError(403, 'origin_not_allowed', 'Requests from this origin are not allowed.');
      }
    }
  });

  app.setErrorHandler((error, req, reply) => {
    const mapped =
      error instanceof AppError
        ? error
        : fromDatabaseError(error) ??
          ((error as { statusCode?: number }).statusCode && (error as { statusCode: number }).statusCode < 500
            ? new AppError((error as { statusCode: number }).statusCode, (error as { code?: string }).code?.toLowerCase() ?? 'bad_request', (error as Error).message)
            : undefined);
    if (!mapped || mapped.status >= 500) req.log.error({ err: error }, 'Request failed');
    const appError = mapped ?? new AppError(500, 'internal_error', 'The request could not be completed.');
    if (appError.extra.headers) reply.headers(appError.extra.headers);
    reply.status(appError.status).send({
      error: {
        code: appError.code,
        message: appError.message,
        requestId: req.id,
        ...(appError.extra.fieldErrors ? { fieldErrors: appError.extra.fieldErrors } : {}),
        ...(appError.extra.details ? { details: appError.extra.details } : {})
      }
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'No such endpoint.', requestId: req.id } });
  });

  registerRoutes(app, deps, allRoutes());
  return app;
}
