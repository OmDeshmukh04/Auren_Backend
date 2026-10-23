import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { getConfig } from '../src/config.js';
import { createDeps } from '../src/deps.js';
import { buildApp } from '../src/app.js';

/**
 * Vercel Node.js Function entry. The app (and its database pool) is built once per warm
 * instance and every /api request is passed to it. Migrations are not run here; run
 * `npm run db:migrate` as a release step before promoting a deployment.
 */
let ready: Promise<FastifyInstance> | undefined;

function app() {
  ready ??= (async () => {
    const instance = await buildApp(createDeps(getConfig()));
    await instance.ready();
    return instance;
  })();
  return ready;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const instance = await app();
  instance.server.emit('request', req, res);
}

export const config = { api: { bodyParser: false } };
