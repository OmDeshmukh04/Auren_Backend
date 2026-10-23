import { getConfig } from './config.js';
import { closeDeps, createDeps } from './deps.js';
import { runnerTick } from './modules/automation/runner.js';

/**
 * Optional long-running worker (a VM, container or `npm run worker` locally). It runs the same
 * bounded tick as the scheduled endpoint, every 15 seconds. Running it alongside the cron
 * endpoint is safe: work is claimed with SKIP LOCKED leases.
 */
const config = getConfig();
const deps = createDeps(config);
let stopping = false;
const stop = () => {
  stopping = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
deps.log.info('Automation worker started');
while (!stopping) {
  try {
    const result = await runnerTick(deps, { runnerId: `worker:${process.pid}` });
    if (result.events || result.steps || result.deliveries.sent) deps.log.info(result, 'Runner tick');
  } catch (error) {
    deps.log.error({ err: error }, 'Runner tick failed');
  }
  for (let waited = 0; waited < 15_000 && !stopping; waited += 500) await new Promise(resolve => setTimeout(resolve, 500));
}
await closeDeps(deps);
deps.log.info('Automation worker stopped');
