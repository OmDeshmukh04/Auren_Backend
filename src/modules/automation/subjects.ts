import { DateTime } from 'luxon';
import type { AppDeps } from '../../context.js';
import type { Executor } from '../../db/index.js';
import type { SubjectType } from './definition.js';
import type { CommunicationLinks, DeliveryRecipient } from './deliveries.js';

/**
 * Loads the current state of a workflow subject at execution time: condition fields, template
 * variables, recipients, assignee and related records. Steps always use this fresh view, never
 * values captured at enrollment.
 */

export type RecipientKey =
  | 'enquiry_contact' | 'family_primary_contact' | 'presentation_recipient' | 'candidate' | 'applicant' | 'reference' | 'staff_user';

export interface TaskLinks {
  familyId?: string | null;
  enquiryId?: string | null;
  candidateId?: string | null;
  jobOrderId?: string | null;
  jobCandidateId?: string | null;
  placementId?: string | null;
  presentationId?: string | null;
  referenceId?: string | null;
  screeningCheckId?: string | null;
  appointmentId?: string | null;
}

export interface SubjectContext {
  fields: Record<string, unknown>;
  variables: Record<string, string | number | null>;
  recipients: Partial<Record<RecipientKey, DeliveryRecipient | null>>;
  assigneeStaffId: string | null;
  related: Array<{ type: string; id: string }>;
  /** Revision of the subject that reminders are bound to (appointments). */
  revision: number | null;
  dates: Record<string, string | null>;
  taskLinks: TaskLinks;
  commLinks: CommunicationLinks;
  isTest: boolean;
}

/** Variables every template may use. */
export const COMMON_VARIABLES = ['agency.name', 'agency.replyTo'];

export const SUBJECT_VARIABLES: Record<SubjectType, string[]> = {
  enquiry: ['contact.firstName', 'family.displayName', 'enquiry.reference', 'enquiry.serviceLabel', 'links.enquiry'],
  family: ['contact.firstName', 'family.displayName', 'family.reference', 'links.family'],
  application: ['candidate.firstName', 'candidate.reference', 'application.reference', 'links.candidate'],
  candidate: ['candidate.firstName', 'candidate.reference', 'links.candidate'],
  information_request: ['candidate.firstName', 'request.items', 'request.message', 'request.deadline', 'links.candidate'],
  appointment: ['appointment.title', 'appointment.when', 'appointment.location', 'contact.firstName', 'candidate.firstName', 'family.displayName', 'links.appointment'],
  reference: ['reference.fullName', 'candidate.fullName', 'candidate.firstName', 'links.candidate'],
  screening_check: ['candidate.firstName', 'check.label', 'links.candidate'],
  qualification: ['candidate.firstName', 'qualification.label', 'qualification.expiresOn', 'links.candidate'],
  job_candidate: ['candidate.firstName', 'job.title', 'job.reference', 'family.displayName', 'links.job'],
  presentation: ['contact.firstName', 'family.displayName', 'job.title', 'presentation.reference', 'links.presentation'],
  offer: ['candidate.firstName', 'job.title', 'family.displayName', 'offer.reviewDate', 'links.job'],
  placement: ['candidate.firstName', 'contact.firstName', 'family.displayName', 'job.title', 'placement.reference', 'placement.startDate', 'placement.guaranteeEndsOn', 'links.placement'],
  staff: ['staff.displayName'],
  agency: ['digest.summary', 'digest.taskCount', 'digest.overdueCount', 'links.tasks']
};

export function formatInstant(isoValue: string | null | undefined, timezone: string) {
  if (!isoValue) return null;
  return DateTime.fromISO(isoValue, { zone: timezone }).toFormat("cccc, LLLL d 'at' h:mm a ZZZZ");
}

export function formatDate(isoDate: string | null | undefined) {
  if (!isoDate) return null;
  return DateTime.fromISO(isoDate).toFormat('LLLL d, yyyy');
}

const name = (first?: string | null, last?: string | null) => [first, last].filter(Boolean).join(' ');

function empty(): SubjectContext {
  return { fields: {}, variables: {}, recipients: {}, assigneeStaffId: null, related: [], revision: null, dates: {}, taskLinks: {}, commLinks: {}, isTest: false };
}

async function primaryContact(db: Executor, familyId: string): Promise<DeliveryRecipient | null> {
  const contact = await db
    .selectFrom('familyContacts')
    .select(['id', 'firstName', 'lastName', 'email'])
    .where('familyId', '=', familyId)
    .where('archivedAt', 'is', null)
    .orderBy('isPrimary', 'desc')
    .orderBy('createdAt')
    .executeTakeFirst();
  return contact?.email ? { type: 'family_contact', id: contact.id, email: contact.email, name: name(contact.firstName, contact.lastName) } : null;
}

async function candidateRecipient(db: Executor, candidateId: string): Promise<{ recipient: DeliveryRecipient | null; row: { firstName: string; lastName: string; reference: string; isTest: boolean; assignedStaffId: string | null; recruitmentStage: string; availabilityStatus: string; archivedAt: string | null } | undefined }> {
  const row = await db
    .selectFrom('candidates')
    .select(['id', 'firstName', 'lastName', 'email', 'reference', 'isTest', 'assignedStaffId', 'recruitmentStage', 'availabilityStatus', 'archivedAt'])
    .where('id', '=', candidateId)
    .executeTakeFirst();
  return {
    row,
    recipient: row ? { type: 'candidate', id: row.id, email: row.email, name: name(row.firstName, row.lastName) } : null
  };
}

/** Returns null when the subject no longer exists. */
export async function loadSubject(deps: AppDeps, db: Executor, subjectType: string, subjectId: string | null): Promise<SubjectContext | null> {
  const settings = await db.selectFrom('agencySettings').select(['agencyName', 'timezone', 'replyToEmail']).where('id', '=', 1).executeTakeFirstOrThrow();
  const staffUrl = deps.config.STAFF_APP_URL.replace(/\/$/, '');
  const ctx = empty();
  ctx.variables['agency.name'] = settings.agencyName;
  ctx.variables['agency.replyTo'] = settings.replyToEmail ?? deps.config.EMAIL_REPLY_TO ?? null;
  const tz = settings.timezone;

  if (subjectType === 'agency') return ctx;
  if (!subjectId) return null;

  switch (subjectType) {
    case 'enquiry': {
      const row = await db
        .selectFrom('enquiries as e')
        .innerJoin('families as f', 'f.id', 'e.familyId')
        .leftJoin('familyContacts as c', 'c.id', 'e.contactId')
        .leftJoin('serviceTypes as s', 's.key', 'e.serviceTypeKey')
        .select([
          'e.id', 'e.reference', 'e.stage', 'e.channel', 'e.serviceTypeKey', 'e.isTest', 'e.firstResponseAt', 'e.assignedStaffId',
          'f.id as familyId', 'f.displayName', 'f.relationshipStatus', 'f.assignedStaffId as familyAssignee', 'f.mergedIntoFamilyId',
          'c.id as contactId', 'c.firstName', 'c.lastName', 'c.email', 's.label as serviceLabel'
        ])
        .where('e.id', '=', subjectId)
        .executeTakeFirst();
      if (!row) return null;
      Object.assign(ctx.fields, {
        'enquiry.stage': row.stage,
        'enquiry.channel': row.channel,
        'enquiry.serviceType': row.serviceTypeKey,
        'enquiry.firstResponseAt': row.firstResponseAt,
        'family.relationshipStatus': row.relationshipStatus
      });
      Object.assign(ctx.variables, {
        'contact.firstName': row.firstName,
        'family.displayName': row.displayName,
        'enquiry.reference': row.reference,
        'enquiry.serviceLabel': row.serviceLabel ?? 'household support',
        'links.enquiry': `${staffUrl}/enquiries/${row.id}`
      });
      ctx.recipients.enquiry_contact = row.email ? { type: 'family_contact', id: row.contactId, email: row.email, name: name(row.firstName, row.lastName) } : null;
      ctx.recipients.family_primary_contact = await primaryContact(db, row.familyId);
      ctx.assigneeStaffId = row.assignedStaffId ?? row.familyAssignee;
      ctx.related = [{ type: 'enquiry', id: row.id }, { type: 'family', id: row.familyId }];
      ctx.taskLinks = { enquiryId: row.id, familyId: row.familyId };
      ctx.commLinks = { enquiryId: row.id, familyId: row.familyId, familyContactId: row.contactId };
      ctx.isTest = row.isTest;
      return ctx;
    }
    case 'family': {
      const row = await db.selectFrom('families').select(['id', 'reference', 'displayName', 'relationshipStatus', 'assignedStaffId', 'isTest']).where('id', '=', subjectId).executeTakeFirst();
      if (!row) return null;
      const contact = await primaryContact(db, row.id);
      ctx.fields['family.relationshipStatus'] = row.relationshipStatus;
      Object.assign(ctx.variables, {
        'contact.firstName': contact?.name?.split(' ')[0] ?? null,
        'family.displayName': row.displayName,
        'family.reference': row.reference,
        'links.family': `${staffUrl}/families/${row.id}`
      });
      ctx.recipients.family_primary_contact = contact;
      ctx.assigneeStaffId = row.assignedStaffId;
      ctx.related = [{ type: 'family', id: row.id }];
      ctx.taskLinks = { familyId: row.id };
      ctx.commLinks = { familyId: row.id, familyContactId: contact?.id ?? null };
      ctx.isTest = row.isTest;
      return ctx;
    }
    case 'application':
    case 'candidate': {
      let candidateId = subjectId;
      let applicationReference: string | null = null;
      if (subjectType === 'application') {
        const app = await db.selectFrom('applications').select(['candidateId', 'reference']).where('id', '=', subjectId).executeTakeFirst();
        if (!app) return null;
        candidateId = app.candidateId;
        applicationReference = app.reference;
      }
      const { row, recipient } = await candidateRecipient(db, candidateId);
      if (!row) return null;
      Object.assign(ctx.fields, {
        'candidate.recruitmentStage': row.recruitmentStage,
        'candidate.availabilityStatus': row.availabilityStatus,
        'candidate.archived': Boolean(row.archivedAt)
      });
      Object.assign(ctx.variables, {
        'candidate.firstName': row.firstName,
        'candidate.reference': row.reference,
        'application.reference': applicationReference,
        'links.candidate': `${staffUrl}/candidates/${candidateId}`
      });
      ctx.recipients.candidate = recipient;
      ctx.recipients.applicant = recipient ? { ...recipient, type: 'applicant' } : null;
      ctx.assigneeStaffId = row.assignedStaffId;
      ctx.related = [{ type: 'candidate', id: candidateId }];
      ctx.taskLinks = { candidateId };
      ctx.commLinks = { candidateId };
      ctx.isTest = row.isTest;
      return ctx;
    }
    case 'information_request': {
      const request = await db.selectFrom('informationRequests').selectAll().where('id', '=', subjectId).executeTakeFirst();
      if (!request) return null;
      const { row, recipient } = await candidateRecipient(db, request.candidateId);
      if (!row) return null;
      const items = (request.items as Array<{ label: string; status: string }>).filter(item => item.status === 'requested');
      ctx.fields['request.status'] = request.status;
      ctx.fields['candidate.recruitmentStage'] = row.recruitmentStage;
      Object.assign(ctx.variables, {
        'candidate.firstName': row.firstName,
        'request.items': items.map(item => `- ${item.label}`).join('\n'),
        'request.message': request.message,
        'request.deadline': formatDate(request.deadlineOn),
        'links.candidate': `${staffUrl}/candidates/${request.candidateId}`
      });
      ctx.dates['request.deadlineOn'] = request.deadlineOn;
      ctx.recipients.candidate = recipient;
      ctx.assigneeStaffId = row.assignedStaffId;
      ctx.related = [{ type: 'information_request', id: request.id }, { type: 'candidate', id: request.candidateId }];
      ctx.taskLinks = { candidateId: request.candidateId };
      ctx.commLinks = { candidateId: request.candidateId };
      ctx.isTest = row.isTest;
      return ctx;
    }
    case 'appointment': {
      const row = await db.selectFrom('appointments').selectAll().where('id', '=', subjectId).executeTakeFirst();
      if (!row) return null;
      ctx.revision = row.revision;
      Object.assign(ctx.fields, { 'appointment.kind': row.kind, 'appointment.status': row.status });
      ctx.dates['appointment.startsAt'] = row.startsAt;
      Object.assign(ctx.variables, {
        'appointment.title': row.title,
        'appointment.when': formatInstant(row.startsAt, tz),
        'appointment.location': row.locationDetail ?? row.locationType.replace('_', ' '),
        'links.appointment': `${staffUrl}/calendar/${row.id}`
      });
      if (row.familyId) {
        const family = await db.selectFrom('families').select(['displayName', 'assignedStaffId', 'isTest']).where('id', '=', row.familyId).executeTakeFirst();
        const contact = await primaryContact(db, row.familyId);
        ctx.recipients.family_primary_contact = contact;
        ctx.variables['family.displayName'] = family?.displayName ?? null;
        ctx.variables['contact.firstName'] = contact?.name?.split(' ')[0] ?? null;
        ctx.related.push({ type: 'family', id: row.familyId });
        ctx.isTest ||= Boolean(family?.isTest);
        ctx.assigneeStaffId = family?.assignedStaffId ?? null;
      }
      if (row.candidateId) {
        const { row: candidate, recipient } = await candidateRecipient(db, row.candidateId);
        ctx.recipients.candidate = recipient;
        ctx.variables['candidate.firstName'] = candidate?.firstName ?? null;
        ctx.related.push({ type: 'candidate', id: row.candidateId });
        ctx.isTest ||= Boolean(candidate?.isTest);
        ctx.assigneeStaffId ??= candidate?.assignedStaffId ?? null;
      }
      if (row.enquiryId) ctx.related.push({ type: 'enquiry', id: row.enquiryId });
      if (row.jobOrderId) ctx.related.push({ type: 'job_order', id: row.jobOrderId });
      ctx.related.unshift({ type: 'appointment', id: row.id });
      ctx.assigneeStaffId = row.organizerStaffId ?? ctx.assigneeStaffId;
      ctx.taskLinks = { appointmentId: row.id, familyId: row.familyId, candidateId: row.candidateId, enquiryId: row.enquiryId, jobOrderId: row.jobOrderId, jobCandidateId: row.jobCandidateId };
      ctx.commLinks = { familyId: row.familyId, candidateId: row.candidateId, enquiryId: row.enquiryId, jobOrderId: row.jobOrderId };
      return ctx;
    }
    case 'reference': {
      const row = await db
        .selectFrom('candidateReferences as r')
        .innerJoin('candidates as c', 'c.id', 'r.candidateId')
        .select(['r.id', 'r.fullName', 'r.email', 'r.status', 'r.permissionToContact', 'r.permissionRevokedAt', 'r.assignedStaffId', 'c.id as candidateId', 'c.firstName', 'c.lastName', 'c.isTest', 'c.assignedStaffId as candidateAssignee'])
        .where('r.id', '=', subjectId)
        .executeTakeFirst();
      if (!row) return null;
      Object.assign(ctx.fields, {
        'reference.status': row.status,
        'reference.permissionToContact': row.permissionToContact && !row.permissionRevokedAt
      });
      Object.assign(ctx.variables, {
        'reference.fullName': row.fullName,
        'candidate.fullName': name(row.firstName, row.lastName),
        'candidate.firstName': row.firstName,
        'links.candidate': `${staffUrl}/candidates/${row.candidateId}`
      });
      ctx.recipients.reference = row.email ? { type: 'reference', id: row.id, email: row.email, name: row.fullName } : null;
      ctx.assigneeStaffId = row.assignedStaffId ?? row.candidateAssignee;
      ctx.related = [{ type: 'reference', id: row.id }, { type: 'candidate', id: row.candidateId }];
      ctx.taskLinks = { referenceId: row.id, candidateId: row.candidateId };
      ctx.commLinks = { referenceId: row.id, candidateId: row.candidateId };
      ctx.isTest = row.isTest;
      return ctx;
    }
    case 'screening_check': {
      const row = await db
        .selectFrom('screeningChecks as s')
        .innerJoin('screeningCheckTypes as t', 't.key', 's.checkTypeKey')
        .select(['s.id', 's.candidateId', 's.status', 's.checkTypeKey', 's.assignedStaffId', 't.label'])
        .where('s.id', '=', subjectId)
        .executeTakeFirst();
      if (!row) return null;
      const { row: candidate, recipient } = await candidateRecipient(db, row.candidateId);
      Object.assign(ctx.fields, { 'check.status': row.status, 'check.type': row.checkTypeKey });
      Object.assign(ctx.variables, { 'candidate.firstName': candidate?.firstName ?? null, 'check.label': row.label, 'links.candidate': `${staffUrl}/candidates/${row.candidateId}` });
      ctx.recipients.candidate = recipient;
      ctx.assigneeStaffId = row.assignedStaffId ?? candidate?.assignedStaffId ?? null;
      ctx.related = [{ type: 'screening_check', id: row.id }, { type: 'candidate', id: row.candidateId }];
      ctx.taskLinks = { screeningCheckId: row.id, candidateId: row.candidateId };
      ctx.commLinks = { candidateId: row.candidateId };
      ctx.isTest = Boolean(candidate?.isTest);
      return ctx;
    }
    case 'qualification': {
      const row = await db
        .selectFrom('candidateQualifications as q')
        .innerJoin('qualificationTypes as t', 't.key', 'q.qualificationKey')
        .select(['q.id', 'q.candidateId', 'q.expiresOn', 'q.reviewState', 'q.qualificationKey', 't.label'])
        .where('q.id', '=', subjectId)
        .executeTakeFirst();
      if (!row) return null;
      const { row: candidate, recipient } = await candidateRecipient(db, row.candidateId);
      Object.assign(ctx.fields, {
        'qualification.reviewState': row.reviewState,
        'qualification.key': row.qualificationKey,
        'candidate.recruitmentStage': candidate?.recruitmentStage,
        'candidate.archived': Boolean(candidate?.archivedAt)
      });
      ctx.dates['qualification.expiresOn'] = row.expiresOn;
      Object.assign(ctx.variables, {
        'candidate.firstName': candidate?.firstName ?? null,
        'qualification.label': row.label,
        'qualification.expiresOn': formatDate(row.expiresOn),
        'links.candidate': `${staffUrl}/candidates/${row.candidateId}`
      });
      ctx.recipients.candidate = recipient;
      ctx.assigneeStaffId = candidate?.assignedStaffId ?? null;
      ctx.related = [{ type: 'qualification', id: row.id }, { type: 'candidate', id: row.candidateId }];
      ctx.taskLinks = { candidateId: row.candidateId };
      ctx.commLinks = { candidateId: row.candidateId };
      ctx.isTest = Boolean(candidate?.isTest);
      return ctx;
    }
    case 'job_candidate':
    case 'offer': {
      let jobCandidateId = subjectId;
      if (subjectType === 'offer') {
        const offer = await db.selectFrom('offers').select(['jobCandidateId', 'status', 'reviewDate']).where('id', '=', subjectId).executeTakeFirst();
        if (!offer) return null;
        jobCandidateId = offer.jobCandidateId;
        ctx.fields['offer.status'] = offer.status;
        ctx.fields['offer.reviewDate'] = offer.reviewDate;
        ctx.dates['offer.reviewDate'] = offer.reviewDate;
        ctx.variables['offer.reviewDate'] = formatDate(offer.reviewDate);
        ctx.related.push({ type: 'offer', id: subjectId });
      }
      const row = await db
        .selectFrom('jobCandidates as jc')
        .innerJoin('jobOrders as j', 'j.id', 'jc.jobOrderId')
        .innerJoin('families as f', 'f.id', 'j.familyId')
        .select(['jc.id', 'jc.stage', 'jc.candidateId', 'j.id as jobOrderId', 'j.title', 'j.reference', 'j.status as jobStatus', 'j.assignedStaffId', 'j.isTest', 'f.id as familyId', 'f.displayName'])
        .where('jc.id', '=', jobCandidateId)
        .executeTakeFirst();
      if (!row) return null;
      const { row: candidate, recipient } = await candidateRecipient(db, row.candidateId);
      Object.assign(ctx.fields, { 'jobCandidate.stage': row.stage, 'job.status': row.jobStatus });
      Object.assign(ctx.variables, {
        'candidate.firstName': candidate?.firstName ?? null,
        'job.title': row.title,
        'job.reference': row.reference,
        'family.displayName': row.displayName,
        'links.job': `${staffUrl}/jobs/${row.jobOrderId}`
      });
      ctx.recipients.candidate = recipient;
      ctx.recipients.family_primary_contact = await primaryContact(db, row.familyId);
      ctx.assigneeStaffId = row.assignedStaffId;
      ctx.related.push({ type: 'job_candidate', id: row.id }, { type: 'job_order', id: row.jobOrderId }, { type: 'candidate', id: row.candidateId }, { type: 'family', id: row.familyId });
      ctx.taskLinks = { jobCandidateId: row.id, jobOrderId: row.jobOrderId, candidateId: row.candidateId, familyId: row.familyId };
      ctx.commLinks = { jobOrderId: row.jobOrderId, candidateId: row.candidateId, familyId: row.familyId };
      ctx.isTest = row.isTest;
      return ctx;
    }
    case 'presentation': {
      const row = await db
        .selectFrom('presentations as p')
        .innerJoin('jobOrders as j', 'j.id', 'p.jobOrderId')
        .innerJoin('families as f', 'f.id', 'p.familyId')
        .leftJoin('familyContacts as c', 'c.id', 'p.recipientContactId')
        .select(['p.id', 'p.reference', 'p.status', 'p.jobOrderId', 'p.familyId', 'j.title', 'j.assignedStaffId', 'j.isTest', 'f.displayName', 'c.id as contactId', 'c.firstName', 'c.lastName', 'c.email', 'c.authorizedRecipient'])
        .where('p.id', '=', subjectId)
        .executeTakeFirst();
      if (!row) return null;
      ctx.fields['presentation.status'] = row.status;
      Object.assign(ctx.variables, {
        'contact.firstName': row.firstName,
        'family.displayName': row.displayName,
        'job.title': row.title,
        'presentation.reference': row.reference,
        'links.presentation': `${staffUrl}/presentations/${row.id}`
      });
      ctx.recipients.presentation_recipient =
        row.email && row.authorizedRecipient ? { type: 'family_contact', id: row.contactId, email: row.email, name: name(row.firstName, row.lastName) } : null;
      ctx.assigneeStaffId = row.assignedStaffId;
      ctx.related = [{ type: 'presentation', id: row.id }, { type: 'job_order', id: row.jobOrderId }, { type: 'family', id: row.familyId }];
      ctx.taskLinks = { presentationId: row.id, jobOrderId: row.jobOrderId, familyId: row.familyId };
      ctx.commLinks = { jobOrderId: row.jobOrderId, familyId: row.familyId, familyContactId: row.contactId };
      ctx.isTest = row.isTest;
      return ctx;
    }
    case 'placement': {
      const row = await db
        .selectFrom('placements as p')
        .innerJoin('jobOrders as j', 'j.id', 'p.jobOrderId')
        .innerJoin('families as f', 'f.id', 'p.familyId')
        .select(['p.id', 'p.reference', 'p.status', 'p.agreedStartDate', 'p.actualStartDate', 'p.guaranteeEndsOn', 'p.candidateId', 'p.familyId', 'p.jobOrderId', 'p.jobCandidateId', 'j.title', 'j.assignedStaffId', 'j.isTest', 'f.displayName'])
        .where('p.id', '=', subjectId)
        .executeTakeFirst();
      if (!row) return null;
      const { row: candidate, recipient } = await candidateRecipient(db, row.candidateId);
      const contact = await primaryContact(db, row.familyId);
      ctx.fields['placement.status'] = row.status;
      ctx.dates['placement.startDate'] = row.actualStartDate ?? row.agreedStartDate;
      ctx.dates['placement.guaranteeEndsOn'] = row.guaranteeEndsOn;
      Object.assign(ctx.variables, {
        'candidate.firstName': candidate?.firstName ?? null,
        'contact.firstName': contact?.name?.split(' ')[0] ?? null,
        'family.displayName': row.displayName,
        'job.title': row.title,
        'placement.reference': row.reference,
        'placement.startDate': formatDate(row.actualStartDate ?? row.agreedStartDate),
        'placement.guaranteeEndsOn': formatDate(row.guaranteeEndsOn),
        'links.placement': `${staffUrl}/placements/${row.id}`
      });
      ctx.recipients.candidate = recipient;
      ctx.recipients.family_primary_contact = contact;
      ctx.assigneeStaffId = row.assignedStaffId;
      ctx.related = [{ type: 'placement', id: row.id }, { type: 'family', id: row.familyId }, { type: 'candidate', id: row.candidateId }, { type: 'job_order', id: row.jobOrderId }];
      ctx.taskLinks = { placementId: row.id, familyId: row.familyId, candidateId: row.candidateId, jobOrderId: row.jobOrderId, jobCandidateId: row.jobCandidateId };
      ctx.commLinks = { familyId: row.familyId, candidateId: row.candidateId, jobOrderId: row.jobOrderId };
      ctx.isTest = row.isTest;
      return ctx;
    }
    case 'staff': {
      const row = await db.selectFrom('staffMembers').select(['id', 'displayName', 'email']).where('id', '=', subjectId).executeTakeFirst();
      if (!row) return null;
      ctx.variables['staff.displayName'] = row.displayName;
      ctx.recipients.staff_user = { type: 'staff', id: row.id, email: row.email, name: row.displayName };
      return ctx;
    }
    default:
      return null;
  }
}
