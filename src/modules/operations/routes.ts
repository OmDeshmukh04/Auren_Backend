import { z } from 'zod';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { Id, IdParams, Ok, PageQuery, StaffRef, Timestamp, Version, pageOf, queryBoolean, queryList } from '../../http/schemas.js';
import { notFound } from '../../http/errors.js';
import { assertInScope } from '../../domain/records.js';
import { ContactLog } from '../families/schemas.js';
import { logContact } from '../families/service.js';
import { audit } from '../../domain/audit.js';
import {
  closeAppointment, completeConsultation, createAppointment, getAppointment, listAppointments, listConsultations, rescheduleAppointment, scheduleConsultation
} from './appointments.js';
import { createNote, createTask, getTask, listCommunications, listNotes, listTasks, setTaskStatus, updateNote, updateTask } from './tasks.js';

const AppointmentKind = z.enum(['consultation', 'candidate_interview', 'family_interview', 'trial', 'check_in', 'other']).meta({ id: 'AppointmentKind' });
const LocationType = z.enum(['in_person', 'video', 'phone']);

export const Appointment = z
  .object({
    id: Id,
    kind: AppointmentKind,
    status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']),
    title: z.string(),
    startsAt: Timestamp,
    endsAt: Timestamp,
    locationType: LocationType,
    locationDetail: z.string().nullable(),
    organizer: StaffRef,
    family: z.object({ id: Id, displayName: z.string() }).nullable(),
    candidate: z.object({ id: Id, firstName: z.string(), lastName: z.string() }).nullable(),
    enquiryId: Id.nullable(),
    jobOrderId: Id.nullable(),
    jobCandidateId: Id.nullable(),
    revision: z.int().meta({ description: 'Increments on reschedule/cancel; reminders for older revisions are never sent.' }),
    cancelledReason: z.string().nullable(),
    notes: z.string().nullable(),
    changes: z.array(z.object({ revision: z.int(), change: z.string(), previousStartsAt: Timestamp.nullable(), previousEndsAt: Timestamp.nullable(), reason: z.string().nullable(), actorStaffId: Id.nullable(), occurredAt: Timestamp })),
    version: Version,
    createdAt: Timestamp
  })
  .meta({ id: 'Appointment' });

const AppointmentCreate = z
  .object({
    kind: z.enum(['family_interview', 'trial', 'check_in', 'other']).meta({ description: 'Consultations and candidate interviews have their own endpoints.' }),
    title: z.string().trim().min(1).max(200),
    startsAt: Timestamp,
    endsAt: Timestamp,
    locationType: LocationType.default('video'),
    locationDetail: z.string().max(500).nullable().optional(),
    organizerStaffId: Id.nullable().optional(),
    familyId: Id.nullable().optional(),
    candidateId: Id.nullable().optional(),
    jobOrderId: Id.nullable().optional(),
    jobCandidateId: Id.nullable().optional(),
    notes: z.string().max(4000).nullable().optional()
  })
  .meta({ id: 'AppointmentCreate' });

const TaskKind = z.enum(['general', 'follow_up', 'review', 'action_needed', 'feedback', 'check_in', 'renewal', 'reconcile']);
const TaskStatus = z.enum(['open', 'in_progress', 'done', 'cancelled']);
const TaskPriority = z.enum(['low', 'normal', 'high', 'urgent']);
const TaskLinks = {
  familyId: Id.nullable().optional(),
  enquiryId: Id.nullable().optional(),
  candidateId: Id.nullable().optional(),
  jobOrderId: Id.nullable().optional(),
  jobCandidateId: Id.nullable().optional(),
  placementId: Id.nullable().optional(),
  presentationId: Id.nullable().optional(),
  referenceId: Id.nullable().optional(),
  screeningCheckId: Id.nullable().optional(),
  appointmentId: Id.nullable().optional()
};

export const Task = z
  .object({
    id: Id,
    title: z.string(),
    description: z.string().nullable(),
    kind: TaskKind,
    status: TaskStatus,
    priority: TaskPriority,
    dueAt: Timestamp.nullable(),
    isOverdue: z.boolean(),
    assignee: StaffRef,
    automated: z.boolean().meta({ description: 'Created by a workflow step.' }),
    subject: z.object({ family: z.object({ id: Id, displayName: z.string() }).nullable(), candidate: z.object({ id: Id, name: z.string() }).nullable() }),
    familyId: Id.nullable(), enquiryId: Id.nullable(), candidateId: Id.nullable(), jobOrderId: Id.nullable(), jobCandidateId: Id.nullable(),
    placementId: Id.nullable(), presentationId: Id.nullable(), referenceId: Id.nullable(), screeningCheckId: Id.nullable(), appointmentId: Id.nullable(),
    deliveryId: Id.nullable(),
    outcome: z.string().nullable(),
    completedAt: Timestamp.nullable(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp
  })
  .meta({ id: 'Task' });

const Note = z
  .object({ id: Id, body: z.string(), visibility: z.enum(['agency', 'owner_only']), pinned: z.boolean(), author: z.object({ id: Id, displayName: z.string() }), version: Version, createdAt: Timestamp, updatedAt: Timestamp })
  .meta({ id: 'Note' });
const NoteLinks = { familyId: Id.optional(), enquiryId: Id.optional(), candidateId: Id.optional(), jobOrderId: Id.optional(), jobCandidateId: Id.optional(), placementId: Id.optional() };

const Communication = z
  .object({
    id: Id,
    channel: z.string(),
    direction: z.enum(['outbound', 'inbound']),
    status: z.string().meta({ description: 'draft, awaiting_approval, queued, provider_accepted, delivered, bounced, complained, failed, cancelled, logged' }),
    subject: z.string().nullable(),
    summary: z.string().nullable(),
    isReply: z.boolean(),
    toAddress: z.string().nullable(),
    templateKey: z.string().nullable(),
    occurredAt: Timestamp,
    familyId: Id.nullable(),
    candidateId: Id.nullable(),
    enquiryId: Id.nullable(),
    jobOrderId: Id.nullable(),
    loggedBy: StaffRef,
    deliveryStatus: z.string().nullable(),
    acceptedAt: Timestamp.nullable(),
    deliveredAt: Timestamp.nullable(),
    lastError: z.string().nullable()
  })
  .meta({ id: 'Communication', description: 'Provider delivery does not mean the recipient replied; staff record replies with a contact log.' });

const Consultation = z
  .object({
    id: Id, familyId: Id, enquiryId: Id.nullable(), appointmentId: Id.nullable(), status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']),
    outcome: z.enum(['proceed', 'follow_up', 'not_proceeding']).nullable(), summary: z.string().nullable(), completedAt: Timestamp.nullable(),
    startsAt: Timestamp.nullable(), endsAt: Timestamp.nullable(), locationType: z.string().nullable(), locationDetail: z.string().nullable(), revision: z.int().nullable(), version: Version
  })
  .meta({ id: 'Consultation' });

export const operationsRoutes: AnyRoute[] = [
  // ---------------------------------------------------------------- calendar & appointments
  defineRoute({
    method: 'GET',
    path: '/calendar',
    operationId: 'getCalendar',
    summary: 'Appointments and due tasks in a time range',
    tags: ['Calendar'],
    access: { kind: 'staff', permission: 'tasks.read' },
    query: z.object({ from: Timestamp, to: Timestamp, organizerStaffId: Id.optional(), kind: queryList(AppointmentKind).optional(), includeCancelled: queryBoolean.optional() }),
    response: z.object({ appointments: z.array(Appointment), tasks: z.array(Task) }).meta({ id: 'CalendarView' }),
    async handler({ deps, staff, query }) {
      const appointments = await listAppointments(deps, staff, query);
      const tasks = await listTasks(deps, staff, { assignee: query.organizerStaffId ?? undefined, dueBefore: query.to, page: 1, pageSize: 100 });
      return { appointments, tasks: tasks.items.filter(t => { const due = (t as { dueAt?: string | null }).dueAt; return Boolean(due && due >= query.from); }) } as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/appointments',
    operationId: 'createAppointment',
    summary: 'Book a family interview, trial, check-in or other appointment',
    tags: ['Calendar'],
    access: { kind: 'staff', permission: 'tasks.write' },
    body: AppointmentCreate,
    response: Appointment,
    status: 201,
    async handler({ deps, meta, body }) {
      const appointment = await deps.db.transaction().execute(trx => createAppointment(trx, meta, body));
      return getAppointment(deps.db, null, appointment.id) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/appointments/:id',
    operationId: 'getAppointment',
    summary: 'Appointment with change history',
    tags: ['Calendar'],
    access: { kind: 'staff', permission: 'tasks.read' },
    params: IdParams,
    response: Appointment,
    async handler({ deps, staff, params }) {
      return getAppointment(deps.db, staff, params.id) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/appointments/:id/reschedule',
    operationId: 'rescheduleAppointment',
    summary: 'Move an appointment (invalidates earlier reminders)',
    tags: ['Calendar'],
    access: { kind: 'staff', permission: 'tasks.write' },
    params: IdParams,
    body: z.object({ startsAt: Timestamp, endsAt: Timestamp, reason: z.string().max(1000).optional(), version: Version, locationType: LocationType.optional(), locationDetail: z.string().max(500).nullable().optional() }),
    response: Appointment,
    async handler({ deps, meta, staff, params, body }) {
      return rescheduleAppointment(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/appointments/:id/close',
    operationId: 'closeAppointment',
    summary: 'Cancel an appointment or mark it completed / no-show',
    description: 'Cancelling stops its reminders. Use the consultation and interview completion endpoints to record outcomes.',
    tags: ['Calendar'],
    access: { kind: 'staff', permission: 'tasks.write' },
    params: IdParams,
    body: z.object({ status: z.enum(['cancelled', 'completed', 'no_show']), reason: z.string().max(1000).optional(), version: Version }),
    response: Appointment,
    async handler({ deps, meta, staff, params, body }) {
      await getAppointment(deps.db, staff, params.id);
      await deps.db.transaction().execute(trx => closeAppointment(trx, meta, params.id, body));
      return getAppointment(deps.db, null, params.id) as never;
    }
  }),

  // ---------------------------------------------------------------- consultations
  defineRoute({
    method: 'POST',
    path: '/enquiries/:id/consultations',
    operationId: 'scheduleConsultation',
    summary: 'Book a consultation for an enquiry',
    description: 'Moves the enquiry to consultation_scheduled and a prospect family to consultation.',
    tags: ['Enquiries', 'Calendar'],
    access: { kind: 'staff', permission: 'enquiries.write' },
    params: IdParams,
    body: z.object({ startsAt: Timestamp, endsAt: Timestamp, locationType: LocationType.default('video'), locationDetail: z.string().max(500).nullable().optional(), organizerStaffId: Id.nullable().optional(), title: z.string().max(200).optional() }),
    response: z.object({ consultationId: Id, appointment: Appointment }),
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      const result = await scheduleConsultation(deps, meta, staff, params.id, body);
      return { consultationId: result.consultation.id, appointment: (await getAppointment(deps.db, null, result.appointment.id)) as never };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/enquiries/:id/consultations',
    operationId: 'listEnquiryConsultations',
    summary: 'Consultations for an enquiry',
    tags: ['Enquiries'],
    access: { kind: 'staff', permission: 'enquiries.read' },
    params: IdParams,
    response: z.object({ items: z.array(Consultation) }),
    async handler({ deps, params }) {
      return { items: (await listConsultations(deps.db, { enquiryId: params.id })) as never };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/families/:id/consultations',
    operationId: 'listFamilyConsultations',
    summary: 'Consultations for a family',
    tags: ['Families'],
    access: { kind: 'staff', permission: 'families.read' },
    params: IdParams,
    response: z.object({ items: z.array(Consultation) }),
    async handler({ deps, params }) {
      return { items: (await listConsultations(deps.db, { familyId: params.id })) as never };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/consultations/:id/complete',
    operationId: 'completeConsultation',
    summary: 'Record the consultation outcome',
    tags: ['Enquiries'],
    access: { kind: 'staff', permission: 'enquiries.write' },
    params: IdParams,
    body: z.object({ outcome: z.enum(['proceed', 'follow_up', 'not_proceeding']), summary: z.string().max(5000).nullable().optional(), version: Version }),
    response: Ok,
    async handler({ deps, meta, staff, params, body }) {
      await completeConsultation(deps, meta, staff, params.id, body);
      return { ok: true as const };
    }
  }),

  // ---------------------------------------------------------------- tasks
  defineRoute({
    method: 'GET',
    path: '/tasks',
    operationId: 'listTasks',
    summary: 'Tasks (open and in progress by default)',
    tags: ['Tasks'],
    access: { kind: 'staff', permission: 'tasks.read' },
    query: z.object({
      assignee: z.string().max(40).optional().meta({ description: '"me", "unassigned" or a staff id' }),
      status: queryList(TaskStatus).optional(),
      kind: queryList(TaskKind).optional(),
      dueBefore: Timestamp.optional(),
      overdue: queryBoolean.optional(),
      familyId: Id.optional(), enquiryId: Id.optional(), candidateId: Id.optional(), jobOrderId: Id.optional(), placementId: Id.optional(),
      ...PageQuery
    }),
    response: pageOf(Task, 'TaskPage'),
    async handler({ deps, staff, query }) {
      return listTasks(deps, staff, query) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/tasks',
    operationId: 'createTask',
    summary: 'Create a task',
    tags: ['Tasks'],
    access: { kind: 'staff', permission: 'tasks.write' },
    body: z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(4000).nullable().optional(), kind: TaskKind.default('general'), priority: TaskPriority.default('normal'), dueAt: Timestamp.nullable().optional(), assignedStaffId: Id.nullable().optional(), ...TaskLinks }),
    response: Task,
    status: 201,
    async handler({ deps, meta, body }) {
      const { id } = await createTask(deps.db, meta, body);
      return getTask(deps.db, id) as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/tasks/:id',
    operationId: 'updateTask',
    summary: 'Edit, reassign or reschedule a task',
    tags: ['Tasks'],
    access: { kind: 'staff', permission: 'tasks.write' },
    params: IdParams,
    body: z.object({ version: Version, title: z.string().trim().min(1).max(200).optional(), description: z.string().max(4000).nullable().optional(), priority: TaskPriority.optional(), dueAt: Timestamp.nullable().optional(), assignedStaffId: Id.nullable().optional() }),
    response: Task,
    async handler({ deps, meta, staff, params, body }) {
      return updateTask(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/tasks/:id/status',
    operationId: 'setTaskStatus',
    summary: 'Start, complete, cancel or reopen a task',
    tags: ['Tasks'],
    access: { kind: 'staff', permission: 'tasks.write' },
    params: IdParams,
    body: z.object({ status: TaskStatus, outcome: z.string().max(2000).nullable().optional(), version: Version }),
    response: Task,
    async handler({ deps, meta, staff, params, body }) {
      return setTaskStatus(deps, meta, staff, params.id, body) as never;
    }
  }),

  // ---------------------------------------------------------------- notes
  defineRoute({
    method: 'GET',
    path: '/notes',
    operationId: 'listNotes',
    summary: 'Notes on a record (pass one link filter)',
    description: 'Owner-only notes are visible to the owner only.',
    tags: ['Notes'],
    access: { kind: 'staff', permission: 'tasks.read' },
    query: z.object(NoteLinks),
    response: z.object({ items: z.array(Note) }),
    async handler({ deps, staff, query }) {
      return { items: (await listNotes(deps.db, staff, query)) as never };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/notes',
    operationId: 'createNote',
    summary: 'Add an internal note',
    description: 'Internal notes never appear in presentations or family-facing material.',
    tags: ['Notes'],
    access: { kind: 'staff', permission: 'tasks.write' },
    body: z.object({ body: z.string().trim().min(1).max(10000), visibility: z.enum(['agency', 'owner_only']).default('agency'), pinned: z.boolean().optional(), ...NoteLinks })
      .refine(v => Object.keys(NoteLinks).some(key => (v as Record<string, unknown>)[key]), { message: 'Link the note to a record', path: ['familyId'] }),
    response: z.object({ id: Id }),
    status: 201,
    async handler({ deps, meta, staff, body }) {
      return { id: await createNote(deps.db, meta, staff, body) };
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/notes/:id',
    operationId: 'updateNote',
    summary: 'Edit, pin or delete a note',
    tags: ['Notes'],
    access: { kind: 'staff', permission: 'tasks.write' },
    params: IdParams,
    body: z.object({ version: Version, body: z.string().trim().min(1).max(10000).optional(), pinned: z.boolean().optional(), deleted: z.boolean().optional() }),
    response: Ok,
    async handler({ deps, meta, staff, params, body }) {
      await updateNote(deps, meta, staff, params.id, body);
      return { ok: true as const };
    }
  }),

  // ---------------------------------------------------------------- communications
  defineRoute({
    method: 'GET',
    path: '/communications',
    operationId: 'listCommunications',
    summary: 'Communication history for a record',
    tags: ['Communications'],
    access: { kind: 'staff', permission: 'communications.read' },
    query: z.object({ familyId: Id.optional(), candidateId: Id.optional(), enquiryId: Id.optional(), jobOrderId: Id.optional(), ...PageQuery }),
    response: pageOf(Communication, 'CommunicationPage'),
    async handler({ deps, query }) {
      return listCommunications(deps.db, query) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/families/:id/contact-log',
    operationId: 'logFamilyContact',
    summary: 'Log a call, email or meeting with a family',
    description: 'With isReply=true, follow-up sequences for this family stop.',
    tags: ['Families', 'Communications'],
    access: { kind: 'staff', permission: 'communications.write' },
    params: IdParams,
    body: ContactLog,
    response: z.object({ id: Id }),
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      return deps.db.transaction().execute(async trx => {
        const family = await trx.selectFrom('families').select('assignedStaffId').where('id', '=', params.id).executeTakeFirst();
        if (!family) throw notFound('Family');
        await assertInScope(trx, staff, family.assignedStaffId);
        const communication = await logContact(trx, deps, meta, { ...body, familyId: params.id });
        await audit(trx, meta, { action: 'family.contact_logged', subjectType: 'family', subjectId: params.id, metadata: { channel: body.channel, isReply: body.isReply } });
        return { id: communication.id };
      });
    }
  })
];
