import { z } from 'zod';
import { ChildAgeBand, DateOnly, Email, Id, Phone, ScheduleType, StaffRef, Timestamp, Version } from '../../http/schemas.js';

export const FamilyStatus = z.enum(['prospect', 'consultation', 'active_client', 'past_client', 'inactive']).meta({ id: 'FamilyRelationshipStatus' });
export const EnquiryStage = z
  .enum(['new', 'contacted', 'consultation_scheduled', 'consultation_completed', 'converted', 'closed'])
  .meta({ id: 'EnquiryStage' });
export const ContactRelationship = z.enum(['parent', 'guardian', 'household_manager', 'family_office', 'assistant', 'other']);
export const ContactMethodPreference = z.enum(['email', 'phone', 'text', 'any']);

export const FamilyContact = z
  .object({
    id: Id,
    familyId: Id,
    firstName: z.string(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    relationship: ContactRelationship,
    isPrimary: z.boolean(),
    authorizedRecipient: z.boolean().meta({ description: 'May receive candidate presentations.' }),
    preferredContactMethod: ContactMethodPreference.nullable(),
    archivedAt: Timestamp.nullable(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp
  })
  .meta({ id: 'FamilyContact' });

export const FamilyContactInput = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().max(80).nullable().optional(),
    email: Email.nullable().optional(),
    phone: Phone.nullable().optional(),
    relationship: ContactRelationship.default('parent'),
    isPrimary: z.boolean().default(false),
    authorizedRecipient: z.boolean().default(false),
    preferredContactMethod: ContactMethodPreference.nullable().optional()
  })
  .refine(v => Boolean(v.email || v.phone), { message: 'Add an email address or phone number', path: ['email'] })
  .meta({ id: 'FamilyContactInput' });

export const FamilySummary = z
  .object({
    id: Id,
    reference: z.string(),
    displayName: z.string(),
    relationshipStatus: FamilyStatus,
    city: z.string().nullable(),
    state: z.string().nullable(),
    assignedStaff: StaffRef,
    primaryContact: z
      .object({ id: Id, firstName: z.string(), lastName: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() })
      .nullable(),
    openJobCount: z.int(),
    enquiryCount: z.int(),
    isTest: z.boolean(),
    mergedIntoFamilyId: Id.nullable(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp
  })
  .meta({ id: 'FamilySummary' });

export const FamilyDetail = FamilySummary.extend({
  postalCode: z.string().nullable(),
  serviceArea: z.string().nullable(),
  householdSummary: z.string().nullable(),
  firstSource: z.string().nullable(),
  archivedAt: Timestamp.nullable(),
  contacts: z.array(FamilyContact)
}).meta({ id: 'FamilyDetail' });

export const FamilyCreate = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(40).nullable().optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
    serviceArea: z.string().trim().max(160).nullable().optional(),
    householdSummary: z.string().max(4000).nullable().optional(),
    assignedStaffId: Id.nullable().optional(),
    primaryContact: FamilyContactInput.optional()
  })
  .meta({ id: 'FamilyCreate' });

export const FamilyUpdate = z
  .object({
    version: Version,
    displayName: z.string().trim().min(1).max(160).optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(40).nullable().optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
    serviceArea: z.string().trim().max(160).nullable().optional(),
    householdSummary: z.string().max(4000).nullable().optional(),
    assignedStaffId: Id.nullable().optional()
  })
  .meta({ id: 'FamilyUpdate' });

export const EnquirySummary = z
  .object({
    id: Id,
    reference: z.string(),
    familyId: Id,
    familyName: z.string(),
    contactName: z.string().nullable(),
    contactEmail: z.string().nullable(),
    channel: z.string(),
    stage: EnquiryStage,
    serviceTypeKey: z.string().nullable(),
    locationCity: z.string().nullable(),
    locationState: z.string().nullable(),
    startTiming: z.string().nullable(),
    startDate: DateOnly.nullable(),
    submittedAt: Timestamp,
    firstResponseAt: Timestamp.nullable(),
    assignedStaff: StaffRef,
    possibleDuplicate: z.boolean().meta({ description: 'An open duplicate case involves this family.' }),
    isTest: z.boolean(),
    version: Version,
    updatedAt: Timestamp
  })
  .meta({ id: 'EnquirySummary' });

export const EnquiryDetail = EnquirySummary.extend({
  contactId: Id.nullable(),
  formVersionId: Id.nullable(),
  scheduleTypes: z.array(ScheduleType),
  arrangement: z.string().nullable(),
  childrenCount: z.int().nullable(),
  childrenAgeBands: z.array(ChildAgeBand),
  postalCode: z.string().nullable(),
  budgetNotes: z.string().nullable(),
  details: z.string().nullable(),
  source: z.string().nullable(),
  utm: z.record(z.string(), z.string()),
  closedReason: z.string().nullable(),
  closedAt: Timestamp.nullable(),
  submissionSnapshot: z.unknown().meta({ description: 'The original submission exactly as received (immutable).' }),
  customAnswers: z.array(z.object({ questionKey: z.string(), value: z.unknown() }))
}).meta({ id: 'EnquiryDetail' });

export const EnquiryFields = {
  serviceTypeKey: z.string().max(64).nullable().optional(),
  scheduleTypes: z.array(ScheduleType).max(9).optional(),
  arrangement: z.enum(['live_in', 'live_out', 'either', 'unsure']).nullable().optional(),
  startTiming: z.enum(['asap', 'within_1_month', 'within_3_months', 'flexible', 'specific_date']).nullable().optional(),
  startDate: DateOnly.nullable().optional(),
  childrenCount: z.int().min(0).max(20).nullable().optional(),
  childrenAgeBands: z.array(ChildAgeBand).max(7).optional(),
  locationCity: z.string().trim().max(120).nullable().optional(),
  locationState: z.string().trim().max(40).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  budgetNotes: z.string().max(1000).nullable().optional(),
  details: z.string().max(4000).nullable().optional()
};

export const Transition = z
  .object({ to: z.string().min(1).max(40), reason: z.string().trim().max(1000).optional(), version: Version })
  .meta({ id: 'StageTransitionRequest' });

export const StageHistoryEntry = z
  .object({
    id: z.int(),
    fromKey: z.string().nullable(),
    toKey: z.string(),
    reason: z.string().nullable(),
    actorType: z.string(),
    actorStaffId: Id.nullable(),
    actorName: z.string().nullable(),
    occurredAt: Timestamp
  })
  .meta({ id: 'StageHistoryEntry' });

export const ContactLog = z
  .object({
    channel: z.enum(['email', 'phone', 'text', 'in_person', 'video', 'other']),
    direction: z.enum(['outbound', 'inbound']),
    summary: z.string().trim().min(1).max(4000),
    isReply: z.boolean().default(false).meta({ description: 'True when the family/candidate replied. Stops follow-up sequences.' }),
    occurredAt: Timestamp.optional()
  })
  .meta({ id: 'ContactLogInput' });
