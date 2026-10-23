import type { Executor } from '../db/index.js';
import { actorStaffId, actorType, type RequestMeta } from '../context.js';

/**
 * Append-only audit trail for material changes and sensitive reads. Metadata records which
 * fields changed and related ids, never the sensitive values themselves.
 */
export interface AuditInput {
  action: string;
  subjectType: string;
  subjectId: string | null;
  metadata?: Record<string, unknown>;
}

export async function audit(db: Executor, meta: RequestMeta, input: AuditInput) {
  await db
    .insertInto('auditEvents')
    .values({
      actorType: meta.actor.type === 'system' ? 'system' : actorType(meta),
      actorStaffId: actorStaffId(meta),
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      requestId: meta.requestId,
      ipHash: meta.ipHash ?? null,
      metadata: JSON.stringify(redact(input.metadata ?? {})),
      occurredAt: meta.now.toISOString()
    })
    .execute();
}

const SENSITIVE_KEYS = /password|token|secret|ssn|social|dob|birth|health|medical|code|authorization/i;

function redact(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key)) out[key] = '[redacted]';
    else if (item && typeof item === 'object' && !Array.isArray(item)) out[key] = redact(item as Record<string, unknown>);
    else out[key] = item;
  }
  return out;
}

/** Names of fields whose values differ, for audit metadata. */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
