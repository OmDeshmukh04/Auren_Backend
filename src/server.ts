import { getConfig } from './config.js';
import { buildApp } from './app.js';
import { closeDeps, createDeps } from './deps.js';
import { pendingMigrations } from './db/migrate.js';

/** Long-running Node server (local development, or a container/VM deployment). */
const config = getConfig();
const deps = createDeps(config);
const pending = await pendingMigrations(deps.pool);
if (pending.length) {
  deps.log.warn({ pending }, 'Database has pending migrations; run `npm run db:migrate`.');
}
const app = await buildApp(deps);
await app.listen({ host: config.HOST, port: config.PORT });

const shutdown = async () => {
  await app.close();
  await closeDeps(deps);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
