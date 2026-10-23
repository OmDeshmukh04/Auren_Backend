import type { AppDeps } from '../../context.js';
import { createDelivery, dispatchDeliveries } from '../automation/deliveries.js';
import { sha256 } from '../../lib/crypto.js';

/**
 * Called by the auth library when a reset is requested for an existing staff user. The email is a
 * security message: the link is kept only until the provider accepts the message.
 */
export async function queuePasswordResetEmail(deps: AppDeps, input: { userId: string; email: string; token: string }) {
  const staff = await deps.db.selectFrom('staffMembers').select(['id', 'displayName', 'status']).where('userId', '=', input.userId).executeTakeFirst();
  if (!staff || staff.status !== 'active') return;
  const link = `${deps.config.STAFF_APP_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(input.token)}`;
  const delivery = await createDelivery(deps.db, {
    idempotencyKey: `password_reset:${sha256(input.token)}`,
    templateKey: 'staff.password_reset',
    category: 'security',
    recipient: { type: 'staff', id: staff.id, email: input.email },
    variables: { 'staff.displayName': staff.displayName, 'links.resetPassword': link, 'agency.name': 'Auren Households' },
    logCommunication: false,
    now: deps.clock.now()
  });
  await dispatchDeliveries(deps, { ids: [delivery.id] }).catch(error => deps.log.warn({ err: error }, 'Password reset email will be retried by the runner'));
}
