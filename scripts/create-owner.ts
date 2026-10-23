import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { closeDeps, createDeps } from '../src/deps.js';
import { createStaffUser } from '../src/modules/staff/service.js';
import { audit } from '../src/domain/audit.js';

/**
 * Creates the first owner account (there is no public sign-up). Everyone else is invited from
 * the workspace. The password comes from OWNER_PASSWORD, or a random one is generated and printed
 * once; it is never written to a file.
 *
 *   npm run owner:create -- --email owner@example.com --name "Owner Name"
 */
const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email || !values.name) {
  console.error('Usage: npm run owner:create -- --email <email> --name "<display name>"');
  process.exit(1);
}
const config = getConfig();
const deps = createDeps(config);
try {
  const generated = !process.env.OWNER_PASSWORD;
  const password = process.env.OWNER_PASSWORD ?? randomBytes(18).toString('base64url');
  const created = await createStaffUser(deps, { email: values.email, displayName: values.name, password, role: 'owner' });
  await audit(deps.db, { actor: { type: 'system', component: 'cli' }, requestId: 'cli:owner-create', now: new Date() }, {
    action: 'staff.owner_created', subjectType: 'staff_member', subjectId: created.staffId
  });
  console.log(`Owner created: ${values.email.toLowerCase()}`);
  if (generated) console.log(`Temporary password (shown once; change it after signing in): ${password}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await closeDeps(deps);
}
