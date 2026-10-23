import { sql } from 'kysely';
import type { AppDeps, RequestMeta, StaffActor } from '../../context.js';
import type { Executor } from '../../db/index.js';
import { audit, changedFields } from '../../domain/audit.js';
import { emit } from '../../domain/outbox.js';
import { assignedOnly, pageArgs, updateVersioned } from '../../domain/records.js';
import { forbidden, notFound, unprocessable } from '../../http/errors.js';

/** Staff tasks and notes. Workflow-created tasks are unique per step execution. */

export const TASK_LINKS = ['familyId', 'enquiryId', 'candidateId', 'jobOrderId', 'jobCandidateId', 'placementId', 'presentationId', 'referenceId', 'screeningCheckId', 'appointmentId'] as const;
type TaskLinkKey = (typeof TASK_LINKS)[number];

function taskQuery(db: Executor) {
  return db
    .selectFrom('tasks as t')
    .leftJoin('staffMembers as s', 's.id', 't.assignedStaffId')
    .leftJoin('families as f', 'f.id', 't.familyId')
    .leftJoin('candidates as c', 'c.id', 't.candidateId')
    .selectAll('t')
    .select(['s.displayName as assigneeName', 'f.displayName as familyName', 'c.firstName as candidateFirstName', 'c.lastName as candidateLastName']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDto(row: Record<string, any>) {
  return {
    ...row,
    assignee: row.assignedStaffId ? { id: row.assignedStaffId, displayName: row.assigneeName ?? '' } : null,
    subject: {
      family: row.familyId ? { id: row.familyId, displayName: row.familyName ?? '' } : null,
      candidate: row.candidateId ? { id: row.candidateId, name: [row.candidateFirstName, row.candidateLastName].filter(Boolean).join(' ') } : null
    },
    automated: Boolean(row.sourceStepExecutionId),
    isOverdue: Boolean(row.dueAt && ['open', 'in_progress'].includes(row.status) && new Date(row.dueAt) < new Date())
  };
}

export async function getTask(db: Executor, id: string) {
  const row = await taskQuery(db).where('t.id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Task');
  return toDto(row);
}

export async function listTasks(
  deps: AppDeps,
  staff: StaffActor,
  query: { assignee?: string; status?: string[]; kind?: string[]; dueBefore?: string; overdue?: boolean; page: number; pageSize: number } & Partial<Record<TaskLinkKey, string>>
) {
  let q = taskQuery(deps.db);
  const status = query.status?.length ? query.status : ['open', 'in_progress'];
  q = q.where('t.status', 'in', status);
  if (query.assignee === 'me') q = q.where('t.assignedStaffId', '=', staff.staffId);
  else if (query.assignee === 'unassigned') q = q.where('t.assignedStaffId', 'is', null);
  else if (query.assignee) q = q.where('t.assignedStaffId', '=', query.assignee);
  if (query.kind?.length) q = q.where('t.kind', 'in', query.kind);
  if (query.dueBefore) q = q.where('t.dueAt', '<=', query.dueBefore);
  if (query.overdue) q = q.where('t.dueAt', '<', deps.clock.now().toISOString());
  for (const key of TASK_LINKS) {
    const value = query[key];
    if (value) q = q.where(`t.${key}` as 't.familyId', '=', value);
  }
  // Finance viewers and content editors have no task access (route permission); coordinators in
  // "assigned" scope see their own and unassigned tasks only.
  if (await assignedOnly(deps.db, staff)) q = q.where(eb => eb.or([eb('t.assignedStaffId', '=', staff.staffId), eb('t.assignedStaffId', 'is', null)]));
  const total = await q.clearSelect().select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const { limit, offset } = pageArgs(query.page, query.pageSize);
  const rows = await q.orderBy(sql`t.due_at asc nulls last`).orderBy('t.createdAt').limit(limit).offset(offset).execute();
  return { items: rows.map(toDto), page: query.page, pageSize: query.pageSize, total: Number(total.n) };
}

export async function createTask(
  db: Executor,
  meta: RequestMeta,
  input: { title: string; description?: string | null; kind?: string; priority?: string; dueAt?: string | null; assignedStaffId?: string | null; sourceStepExecutionId?: string | null } & Partial<Record<TaskLinkKey, string | null>>
) {
  const values: Record<string, unknown> = {
    title: input.title,
    description: input.description ?? null,
    kind: input.kind ?? 'general',
    priority: input.priority ?? 'normal',
    dueAt: input.dueAt ?? null,
    assignedStaffId: input.assignedStaffId ?? null,
    sourceStepExecutionId: input.sourceStepExecutionId ?? null,
    createdByStaffId: meta.actor.type === 'staff' ? meta.actor.staffId : null,
    createdAt: meta.now.toISOString()
  };
  for (const key of TASK_LINKS) if (input[key]) values[key] = input[key];
  const query = db.insertInto('tasks').values(values as never).returning('id');
  const row = input.sourceStepExecutionId
    ? await query.onConflict(oc => oc.column('sourceStepExecutionId').doNothing()).executeTakeFirst()
    : await query.executeTakeFirst();
  if (!row) {
    const existing = await db.selectFrom('tasks').select('id').where('sourceStepExecutionId', '=', input.sourceStepExecutionId!).executeTakeFirstOrThrow();
    return { id: existing.id, created: false };
  }
  await audit(db, meta, { action: 'task.created', subjectType: 'task', subjectId: row.id, metadata: { kind: values.kind, automated: Boolean(input.sourceStepExecutionId) } });
  if (input.assignedStaffId && input.assignedStaffId !== (meta.actor.type === 'staff' ? meta.actor.staffId : null)) {
    await emit(db, meta, { type: 'task.assigned', subjectType: 'task', subjectId: row.id, payload: { assignee: input.assignedStaffId } });
  }
  return { id: row.id, created: true };
}

export async function updateTask(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: Record<string, unknown> & { version: number }) {
  const { version, ...values } = input;
  const before = await deps.db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw notFound('Task');
  await assertTaskAccess(deps, staff, before.assignedStaffId);
  await updateVersioned(deps.db, 'tasks', id, version, values, 'Task');
  await audit(deps.db, meta, { action: 'task.updated', subjectType: 'task', subjectId: id, metadata: { fields: changedFields(before as never, values) } });
  if (values.assignedStaffId && values.assignedStaffId !== before.assignedStaffId && values.assignedStaffId !== staff.staffId) {
    await emit(deps.db, meta, { type: 'task.assigned', subjectType: 'task', subjectId: id, payload: { assignee: values.assignedStaffId } });
  }
  return getTask(deps.db, id);
}

async function assertTaskAccess(deps: AppDeps, staff: StaffActor, assignedStaffId: string | null) {
  if ((await assignedOnly(deps.db, staff)) && assignedStaffId && assignedStaffId !== staff.staffId) throw forbidden('This task is assigned to someone else.', 'out_of_scope');
}

export async function setTaskStatus(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { status: 'open' | 'in_progress' | 'done' | 'cancelled'; outcome?: string | null; version: number }) {
  const before = await deps.db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw notFound('Task');
  await assertTaskAccess(deps, staff, before.assignedStaffId);
  if (before.status === input.status) throw unprocessable(`The task is already ${input.status}.`, 'no_change');
  const done = input.status === 'done';
  await updateVersioned(deps.db, 'tasks', id, input.version, {
    status: input.status,
    outcome: input.outcome ?? before.outcome,
    completedAt: done ? meta.now.toISOString() : null,
    completedBy: done ? staff.staffId : null
  }, 'Task');
  await audit(deps.db, meta, { action: `task.${input.status}`, subjectType: 'task', subjectId: id });
  return getTask(deps.db, id);
}

// ------------------------------------------------------------------------------------- notes

export const NOTE_LINKS = ['familyId', 'enquiryId', 'candidateId', 'jobOrderId', 'jobCandidateId', 'placementId'] as const;

export async function listNotes(db: Executor, staff: StaffActor, filter: Partial<Record<(typeof NOTE_LINKS)[number], string>>) {
  let q = db.selectFrom('notes as n').innerJoin('staffMembers as s', 's.id', 'n.authorStaffId').selectAll('n').select('s.displayName as authorName').where('n.deletedAt', 'is', null);
  let filtered = false;
  for (const key of NOTE_LINKS) {
    const value = filter[key];
    if (value) {
      q = q.where(`n.${key}` as 'n.familyId', '=', value);
      filtered = true;
    }
  }
  if (!filtered) return [];
  if (!staff.permissions.has('notes.owner_only')) q = q.where('n.visibility', '=', 'agency');
  const rows = await q.orderBy('n.pinned', 'desc').orderBy('n.createdAt', 'desc').limit(200).execute();
  return rows.map(row => ({ ...row, author: { id: row.authorStaffId, displayName: row.authorName } }));
}

export async function createNote(db: Executor, meta: RequestMeta, staff: StaffActor, input: { body: string; visibility: 'agency' | 'owner_only'; pinned?: boolean } & Partial<Record<(typeof NOTE_LINKS)[number], string>>) {
  if (input.visibility === 'owner_only' && !staff.permissions.has('notes.owner_only')) throw forbidden('Only the owner can write owner-only notes.');
  const values: Record<string, unknown> = { body: input.body, visibility: input.visibility, pinned: input.pinned ?? false, authorStaffId: staff.staffId, createdAt: meta.now.toISOString() };
  for (const key of NOTE_LINKS) if (input[key]) values[key] = input[key];
  const row = await db.insertInto('notes').values(values as never).returning('id').executeTakeFirstOrThrow();
  await audit(db, meta, { action: 'note.created', subjectType: 'note', subjectId: row.id, metadata: { visibility: input.visibility } });
  return row.id;
}

export async function updateNote(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { version: number; body?: string; pinned?: boolean; deleted?: boolean }) {
  const note = await deps.db.selectFrom('notes').selectAll().where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst();
  if (!note) throw notFound('Note');
  if (note.visibility === 'owner_only' && !staff.permissions.has('notes.owner_only')) throw notFound('Note');
  if (note.authorStaffId !== staff.staffId && staff.role !== 'owner') throw forbidden('Only the author or the owner can change this note.');
  const values: Record<string, unknown> = {};
  if (input.body !== undefined) values.body = input.body;
  if (input.pinned !== undefined) values.pinned = input.pinned;
  if (input.deleted) values.deletedAt = meta.now.toISOString();
  await updateVersioned(deps.db, 'notes', id, input.version, values, 'Note');
  await audit(deps.db, meta, { action: input.deleted ? 'note.deleted' : 'note.updated', subjectType: 'note', subjectId: id });
}

// ------------------------------------------------------------------------------------- communications

export async function listCommunications(db: Executor, filter: { familyId?: string; candidateId?: string; enquiryId?: string; jobOrderId?: string; page: number; pageSize: number }) {
  let q = db
    .selectFrom('communications as c')
    .leftJoin('deliveries as d', 'd.id', 'c.deliveryId')
    .leftJoin('staffMembers as s', 's.id', 'c.loggedBy')
    .select([
      'c.id', 'c.channel', 'c.direction', 'c.status', 'c.subject', 'c.summary', 'c.isReply', 'c.toAddress', 'c.templateKey', 'c.occurredAt',
      'c.familyId', 'c.candidateId', 'c.enquiryId', 'c.jobOrderId', 'c.loggedBy', 's.displayName as loggedByName',
      'd.status as deliveryStatus', 'd.acceptedAt', 'd.deliveredAt', 'd.lastError'
    ]);
  if (filter.familyId) q = q.where('c.familyId', '=', filter.familyId);
  if (filter.candidateId) q = q.where('c.candidateId', '=', filter.candidateId);
  if (filter.enquiryId) q = q.where('c.enquiryId', '=', filter.enquiryId);
  if (filter.jobOrderId) q = q.where('c.jobOrderId', '=', filter.jobOrderId);
  const { limit, offset } = pageArgs(filter.page, filter.pageSize);
  const [rows, total] = await Promise.all([
    q.orderBy('c.occurredAt', 'desc').limit(limit).offset(offset).execute(),
    q.clearSelect().select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()
  ]);
  return {
    items: rows.map(row => ({ ...row, loggedBy: row.loggedBy ? { id: row.loggedBy, displayName: row.loggedByName ?? '' } : null })),
    page: filter.page,
    pageSize: filter.pageSize,
    total: Number(total.n)
  };
}
