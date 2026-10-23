import type { Executor } from '../db/index.js';
import { actorStaffId, actorType, type RequestMeta } from '../context.js';
import { conflict, unprocessable } from '../http/errors.js';

export type StageDimension =
  | 'candidate_recruitment'
  | 'candidate_availability'
  | 'candidate_job'
  | 'screening_check'
  | 'enquiry'
  | 'family_relationship'
  | 'job_order'
  | 'placement';

/**
 * Checks a transition against the owner-configurable rules. `viaCommand` is set when a domain
 * command (e.g. presentation release) moves the record; such commands may enter stages that
 * staff cannot select directly, but they still must follow a configured transition.
 */
export async function assertTransitionAllowed(
  db: Executor,
  dimension: StageDimension,
  from: string,
  to: string,
  options: { viaCommand?: boolean } = {}
) {
  if (from === to) throw conflict(`The record is already at "${to}".`, 'no_change');
  const target = await db
    .selectFrom('stageDefinitions')
    .select(['active', 'manualEntry', 'label'])
    .where('dimension', '=', dimension)
    .where('key', '=', to)
    .executeTakeFirst();
  if (!target) throw unprocessable(`Unknown stage "${to}".`, 'unknown_stage');
  if (!target.active) throw unprocessable(`The stage "${target.label}" is not in use.`, 'stage_inactive');
  if (!target.manualEntry && !options.viaCommand) {
    throw unprocessable(`"${target.label}" is set by its own action and cannot be chosen directly.`, 'stage_requires_command');
  }
  const rule = await db
    .selectFrom('stageTransitionRules')
    .select('toKey')
    .where('dimension', '=', dimension)
    .where('fromKey', '=', from)
    .where('toKey', '=', to)
    .executeTakeFirst();
  if (!rule) throw unprocessable(`A record cannot move from "${from}" to "${to}".`, 'transition_not_allowed', { from, to });
}

export async function recordTransition(
  db: Executor,
  meta: RequestMeta,
  input: { dimension: StageDimension; subjectId: string; from: string | null; to: string; reason?: string | null; metadata?: Record<string, unknown> }
) {
  await db
    .insertInto('stageTransitions')
    .values({
      dimension: input.dimension,
      subjectId: input.subjectId,
      fromKey: input.from,
      toKey: input.to,
      reason: input.reason ?? null,
      actorType: actorType(meta),
      actorStaffId: actorStaffId(meta),
      metadata: JSON.stringify(input.metadata ?? {}),
      occurredAt: meta.now.toISOString()
    })
    .execute();
}

export async function stageHistory(db: Executor, dimension: StageDimension, subjectId: string) {
  return db
    .selectFrom('stageTransitions as t')
    .leftJoin('staffMembers as s', 's.id', 't.actorStaffId')
    .select(['t.id', 't.fromKey', 't.toKey', 't.reason', 't.actorType', 't.actorStaffId', 's.displayName as actorName', 't.occurredAt'])
    .where('t.dimension', '=', dimension)
    .where('t.subjectId', '=', subjectId)
    .orderBy('t.occurredAt', 'asc')
    .orderBy('t.id', 'asc')
    .execute();
}
