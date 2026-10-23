import { z } from 'zod';
import { defineRoute, WithStatus, type AnyRoute } from '../../http/route.js';
import { Email, Id, IdParams, PageQuery, Phone, pageOf, queryBoolean, queryList, Timestamp, Version } from '../../http/schemas.js';
import { stageHistory } from '../../domain/stages.js';
import { clientIp } from '../../http/register.js';
import { currentFormVersion, FormLayout } from '../forms/layout.js';
import {
  ContactLog, EnquiryDetail, EnquiryFields, EnquiryStage, EnquirySummary, FamilyContact, FamilyContactInput, FamilyCreate,
  FamilyDetail, FamilyStatus, FamilySummary, FamilyUpdate, StageHistoryEntry, Transition
} from './schemas.js';
import { addContact, createFamily, familyTimeline, getFamily, listFamilies, transitionFamily, updateContact, updateFamily } from './service.js';
import {
  createStaffEnquiry, getEnquiry, listEnquiries, logEnquiryContact, PublicEnquiryInput, PublicEnquiryReceipt,
  submitPublicEnquiry, transitionEnquiry, updateEnquiry
} from './enquiries.js';

const Communication = z
  .object({ id: Id, channel: z.string(), direction: z.string(), status: z.string(), summary: z.string().nullable(), isReply: z.boolean(), occurredAt: Timestamp })
  .meta({ id: 'CommunicationLogged' });

const PublicForm = z
  .object({ id: Id, formKey: z.string(), versionNumber: z.int(), publishedAt: Timestamp.nullable(), layout: FormLayout })
  .meta({ id: 'PublicFormVersion' });

export const familyRoutes: AnyRoute[] = [
  // ------------------------------------------------------------------ public
  defineRoute({
    method: 'GET',
    path: '/public/forms/:formKey',
    operationId: 'getPublicForm',
    summary: 'Current published form version (sections, custom questions, consents)',
    description: 'Core section fields are fixed by the request schemas; render custom questions from `layout.sections[].questions[].definition`.',
    tags: ['Public'],
    access: { kind: 'public' },
    params: z.object({ formKey: z.enum(['family_enquiry', 'candidate_application']) }),
    response: PublicForm,
    async handler({ deps, params }) {
      return currentFormVersion(deps.db, params.formKey);
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/public/enquiries',
    operationId: 'submitFamilyEnquiry',
    summary: 'Submit a family enquiry',
    description:
      'Requires an Idempotency-Key (generate one per form fill; reuse it when retrying). Returns 202 only after the enquiry is saved. ' +
      'The response never reveals whether the email already exists.',
    tags: ['Public'],
    access: { kind: 'public' },
    body: PublicEnquiryInput,
    response: PublicEnquiryReceipt,
    status: 202,
    idempotency: 'required',
    rateLimits: [{ name: 'public-enquiry', max: 8, windowSeconds: 60 * 60 }],
    async handler({ deps, meta, body, idempotencyKey, req }) {
      const result = await submitPublicEnquiry(deps, meta, body, idempotencyKey!, clientIp(req));
      return new WithStatus(result.status, result.body, result.replayed ? { 'Idempotent-Replayed': 'true' } : {});
    }
  }),

  // ------------------------------------------------------------------ families
  defineRoute({
    method: 'GET',
    path: '/families',
    operationId: 'listFamilies',
    summary: 'List families',
    tags: ['Families'],
    access: { kind: 'staff', permission: 'families.read' },
    query: z.object({
      q: z.string().max(120).optional(),
      status: queryList(FamilyStatus).optional(),
      assignedStaffId: Id.optional(),
      includeTest: queryBoolean.optional(),
      includeMerged: queryBoolean.optional(),
      sort: z.enum(['updated_desc', 'created_desc', 'name_asc']).default('updated_desc'),
      ...PageQuery
    }),
    response: pageOf(FamilySummary, 'FamilyPage'),
    async handler({ deps, staff, query }) {
      return listFamilies(deps, staff, query);
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/families',
    operationId: 'createFamily',
    summary: 'Create a family',
    tags: ['Families'],
    access: { kind: 'staff', permission: 'families.write' },
    body: FamilyCreate,
    response: FamilyDetail,
    status: 201,
    async handler({ deps, meta, body }) {
      return createFamily(deps, meta, body);
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/families/:id',
    operationId: 'getFamily',
    summary: 'Family detail with contacts',
    tags: ['Families'],
    access: { kind: 'staff', permission: 'families.read' },
    params: IdParams,
    response: FamilyDetail,
    async handler({ deps, staff, params }) {
      return getFamily(deps, deps.db, staff, params.id);
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/families/:id',
    operationId: 'updateFamily',
    summary: 'Update a family',
    tags: ['Families'],
    access: { kind: 'staff', permission: 'families.write' },
    params: IdParams,
    body: FamilyUpdate,
    response: FamilyDetail,
    async handler({ deps, meta, staff, params, body }) {
      return updateFamily(deps, meta, staff, params.id, body);
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/families/:id/transition',
    operationId: 'transitionFamily',
    summary: 'Change family relationship status',
    tags: ['Families'],
    access: { kind: 'staff', permission: 'families.write' },
    params: IdParams,
    body: Transition,
    response: FamilyDetail,
    async handler({ deps, meta, staff, params, body }) {
      return transitionFamily(deps, meta, staff, params.id, body);
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/families/:id/timeline',
    operationId: 'getFamilyTimeline',
    summary: 'Family activity history (newest first)',
    tags: ['Families'],
    access: { kind: 'staff', permission: 'families.read' },
    params: IdParams,
    response: z.object({
      items: z.array(z.object({ type: z.string(), at: Timestamp, id: z.string(), title: z.string(), detail: z.string().nullable() }))
    }).meta({ id: 'Timeline' }),
    async handler({ deps, staff, params }) {
      return familyTimeline(deps, staff, params.id);
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/families/:id/contacts',
    operationId: 'addFamilyContact',
    summary: 'Add a family contact',
    tags: ['Families'],
    access: { kind: 'staff', permission: 'families.write' },
    params: IdParams,
    body: FamilyContactInput,
    response: FamilyContact,
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      const contact = await addContact(deps, meta, staff, params.id, body);
      return { ...contact, relationship: contact.relationship as 'parent', preferredContactMethod: contact.preferredContactMethod as 'email' | null };
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/families/:id/contacts/:contactId',
    operationId: 'updateFamilyContact',
    summary: 'Update or archive a family contact',
    tags: ['Families'],
    access: { kind: 'staff', permission: 'families.write' },
    params: z.object({ id: Id, contactId: Id }),
    body: z.object({
      version: Version,
      firstName: z.string().trim().min(1).max(80).optional(),
      lastName: z.string().trim().max(80).nullable().optional(),
      email: Email.nullable().optional(),
      phone: Phone.nullable().optional(),
      relationship: z.enum(['parent', 'guardian', 'household_manager', 'family_office', 'assistant', 'other']).optional(),
      isPrimary: z.boolean().optional(),
      authorizedRecipient: z.boolean().optional(),
      preferredContactMethod: z.enum(['email', 'phone', 'text', 'any']).nullable().optional(),
      archived: z.boolean().optional()
    }),
    response: FamilyContact,
    async handler({ deps, meta, staff, params, body }) {
      return (await updateContact(deps, meta, staff, params.id, params.contactId, body)) as never;
    }
  }),

  // ------------------------------------------------------------------ enquiries
  defineRoute({
    method: 'GET',
    path: '/enquiries',
    operationId: 'listEnquiries',
    summary: 'List enquiries',
    tags: ['Enquiries'],
    access: { kind: 'staff', permission: 'enquiries.read' },
    query: z.object({
      q: z.string().max(120).optional(),
      stage: queryList(EnquiryStage).optional(),
      familyId: Id.optional(),
      assignedStaffId: Id.optional(),
      submittedFrom: Timestamp.optional(),
      submittedTo: Timestamp.optional(),
      includeTest: queryBoolean.optional(),
      sort: z.enum(['submitted_desc', 'submitted_asc', 'updated_desc']).default('submitted_desc'),
      ...PageQuery
    }),
    response: pageOf(EnquirySummary, 'EnquiryPage'),
    async handler({ deps, staff, query }) {
      return listEnquiries(deps, staff, query) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/enquiries',
    operationId: 'createEnquiry',
    summary: 'Record an enquiry received by phone, email or referral',
    tags: ['Enquiries'],
    access: { kind: 'staff', permission: 'enquiries.write' },
    body: z
      .object({
        familyId: Id.optional(),
        newFamily: z.object({ displayName: z.string().trim().min(1).max(160), city: z.string().max(120).nullable().optional(), state: z.string().max(40).nullable().optional() }).optional(),
        contactId: Id.optional(),
        newContact: z.object({ firstName: z.string().trim().min(1).max(80), lastName: z.string().max(80).nullable().optional(), email: Email.nullable().optional(), phone: Phone.nullable().optional() }).optional(),
        channel: z.enum(['phone', 'email', 'referral', 'staff_entry', 'other']),
        assignedStaffId: Id.nullable().optional(),
        ...EnquiryFields
      })
      .refine(v => Boolean(v.familyId) !== Boolean(v.newFamily), { message: 'Provide either familyId or newFamily', path: ['familyId'] }),
    response: EnquiryDetail,
    status: 201,
    async handler({ deps, meta, body }) {
      return createStaffEnquiry(deps, meta, body) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/enquiries/:id',
    operationId: 'getEnquiry',
    summary: 'Enquiry detail including the original submission',
    tags: ['Enquiries'],
    access: { kind: 'staff', permission: 'enquiries.read' },
    params: IdParams,
    response: EnquiryDetail,
    async handler({ deps, staff, params }) {
      return getEnquiry(deps, deps.db, staff, params.id) as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/enquiries/:id',
    operationId: 'updateEnquiry',
    summary: 'Update enquiry working fields (the original submission is unchanged)',
    tags: ['Enquiries'],
    access: { kind: 'staff', permission: 'enquiries.write' },
    params: IdParams,
    body: z.object({ version: Version, assignedStaffId: Id.nullable().optional(), ...EnquiryFields }),
    response: EnquiryDetail,
    async handler({ deps, meta, staff, params, body }) {
      return updateEnquiry(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/enquiries/:id/transition',
    operationId: 'transitionEnquiry',
    summary: 'Move an enquiry to another stage',
    description: 'Consultation stages are set by booking/completing a consultation, not directly (422 stage_requires_command).',
    tags: ['Enquiries'],
    access: { kind: 'staff', permission: 'enquiries.write' },
    params: IdParams,
    body: Transition,
    response: EnquiryDetail,
    async handler({ deps, meta, staff, params, body }) {
      return transitionEnquiry(deps, meta, staff, params.id, body) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/enquiries/:id/history',
    operationId: 'getEnquiryHistory',
    summary: 'Enquiry stage history',
    tags: ['Enquiries'],
    access: { kind: 'staff', permission: 'enquiries.read' },
    params: IdParams,
    response: z.object({ items: z.array(StageHistoryEntry) }),
    async handler({ deps, staff, params }) {
      await getEnquiry(deps, deps.db, staff, params.id);
      return { items: await stageHistory(deps.db, 'enquiry', params.id) };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/enquiries/:id/contact-log',
    operationId: 'logEnquiryContact',
    summary: 'Log a call, email or meeting with the family',
    description: 'Sets the first-response time. With isReply=true, follow-up sequences for this family stop.',
    tags: ['Enquiries'],
    access: { kind: 'staff', permission: 'communications.write' },
    params: IdParams,
    body: ContactLog,
    response: Communication,
    status: 201,
    async handler({ deps, meta, staff, params, body }) {
      return logEnquiryContact(deps, meta, staff, params.id, body);
    }
  })
];
