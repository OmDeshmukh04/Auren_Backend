import { z } from 'zod';
import type { AnyRoute } from './route.js';
import { ErrorResponseSchema } from './errors.js';
import { API_PREFIX } from './register.js';

/**
 * Builds the OpenAPI 3.1 contract from the route definitions. Named schemas (`.meta({ id })`)
 * become components; request-side variants that differ from the response shape get an
 * "Input" suffix.
 */

type Json = Record<string, unknown>;

function convert(schema: z.ZodType, io: 'input' | 'output') {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any', reused: 'inline' }) as Json;
  const defs = (json.$defs ?? {}) as Record<string, Json>;
  delete json.$defs;
  delete json.$schema;
  return { json, defs };
}

function rewriteRefs(node: unknown, rename: (name: string) => string): unknown {
  if (Array.isArray(node)) return node.map(item => rewriteRefs(item, rename));
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
      out[key] = `#/components/schemas/${rename(value.slice('#/$defs/'.length))}`;
    } else {
      out[key] = rewriteRefs(value, rename);
    }
  }
  return out;
}

export function buildOpenApi(routes: AnyRoute[], info: { version: string; serverUrl?: string }) {
  const outputDefs = new Map<string, string>();
  const inputDefs = new Map<string, string>();
  const components: Record<string, unknown> = {};

  const register = (defs: Record<string, Json>, io: 'input' | 'output') => {
    for (const [name, def] of Object.entries(defs)) {
      const target = io === 'output' ? outputDefs : inputDefs;
      target.set(name, JSON.stringify(def));
    }
  };
  // First pass: collect every named definition in both directions.
  for (const route of routes) {
    for (const part of [route.params, route.query, route.body]) if (part) register(convert(part, 'input').defs, 'input');
    register(convert(route.response, 'output').defs, 'output');
  }
  register(convert(ErrorResponseSchema, 'output').defs, 'output');
  const inputName = (name: string) => {
    const out = outputDefs.get(name);
    return out !== undefined && out === inputDefs.get(name) ? name : `${name}Input`;
  };
  const outputName = (name: string) => name;
  for (const [name, raw] of outputDefs) components[outputName(name)] = rewriteRefs(JSON.parse(raw), outputName);
  for (const [name, raw] of inputDefs) {
    const finalName = inputName(name);
    if (!(finalName in components)) components[finalName] = rewriteRefs(JSON.parse(raw), inputName);
  }

  const errorRef = { $ref: '#/components/schemas/ErrorResponse' };
  const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: errorRef } } });
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const path = `${API_PREFIX}${route.path}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const parameters: Json[] = [];
    for (const [location, schema] of [['path', route.params], ['query', route.query]] as const) {
      if (!schema) continue;
      const { json } = convert(schema, 'input');
      const properties = (json.properties ?? {}) as Record<string, Json>;
      const required = new Set((json.required ?? []) as string[]);
      for (const [name, property] of Object.entries(properties)) {
        const { description, ...rest } = property as Json & { description?: string };
        parameters.push({
          name,
          in: location,
          required: location === 'path' || required.has(name),
          ...(description ? { description } : {}),
          schema: rewriteRefs(rest, inputName),
          ...(location === 'query' && (rest.type === 'array' || rest.anyOf) ? { style: 'form', explode: true } : {})
        });
      }
    }
    if (route.idempotency) {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: route.idempotency === 'required',
        description: 'Random value (e.g. a UUID) identifying one logical attempt. Retries with the same key and body replay the original response.',
        schema: { type: 'string', minLength: 8, maxLength: 200 }
      });
    }
    const responses: Json = {};
    const status = String(route.status ?? 200);
    if (route.produces) {
      responses[status] = { description: 'Success', content: { [route.produces]: { schema: { type: 'string', format: 'binary' } } } };
    } else if (status === '204') {
      responses[status] = { description: 'Success (no content)' };
    } else {
      const { json } = convert(route.response, 'output');
      responses[status] = { description: 'Success', content: { 'application/json': { schema: rewriteRefs(json, outputName) } } };
    }
    if (route.params || route.query || route.body) responses['422'] = errorResponse('Validation failed (see fieldErrors)');
    if (route.access.kind === 'staff' || route.access.kind === 'applicant' || route.access.kind === 'cron') {
      responses['401'] = errorResponse('Not signed in / session expired');
    }
    if (route.access.kind === 'staff') responses['403'] = errorResponse('Missing permission, suspended account or MFA enrollment required');
    if (route.path.includes(':')) responses['404'] = errorResponse('Not found');
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(route.method)) responses['409'] = errorResponse('Conflict (version_conflict, duplicate, immutable_record, ...)');
    if (route.rateLimits?.length || route.access.kind === 'public') responses['429'] = errorResponse('Rate limited (see Retry-After)');

    const security =
      route.access.kind === 'staff'
        ? [{ staffSession: [] }]
        : route.access.kind === 'applicant'
          ? [{ applicantDraftSession: [] }]
          : route.access.kind === 'cron'
            ? [{ runnerBearer: [] }]
            : [];
    const operation: Json = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      tags: route.tags,
      security,
      'x-access': route.access.kind === 'staff' ? { kind: 'staff', permission: route.access.permission } : { kind: route.access.kind },
      ...(parameters.length ? { parameters } : {}),
      responses
    };
    if (route.body) {
      const { json } = convert(route.body, 'input');
      operation.requestBody = { required: true, content: { 'application/json': { schema: rewriteRefs(json, inputName) } } };
    } else if (route.binaryBodyLimit) {
      operation.requestBody = { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
    }
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Auren Households API',
      version: info.version,
      description:
        'Agency platform API. All instants are UTC ISO-8601; dates are YYYY-MM-DD; money is integer minor units with a currency. ' +
        'Errors use the ErrorResponse envelope. Editable records carry a `version`; send it back on update. ' +
        'Repeatable commands accept an Idempotency-Key header.'
    },
    ...(info.serverUrl ? { servers: [{ url: info.serverUrl }] } : {}),
    tags: [...new Set(routes.flatMap(route => route.tags))].sort().map(name => ({ name })),
    paths,
    components: {
      schemas: components,
      securitySchemes: {
        staffSession: { type: 'apiKey', in: 'cookie', name: 'auren.session_token', description: 'Staff session cookie set by POST /api/v1/auth/sign-in (prefixed __Secure- over HTTPS).' },
        applicantDraftSession: { type: 'apiKey', in: 'cookie', name: 'auren_draft', description: 'Applicant draft session cookie, scoped to one application draft.' },
        runnerBearer: { type: 'http', scheme: 'bearer', description: 'CRON_SECRET for the scheduled runner.' }
      }
    }
  };
}
