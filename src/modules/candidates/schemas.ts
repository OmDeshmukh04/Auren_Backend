import { z } from 'zod';
import {
  AgeGroup, Arrangement, CompensationRange, DateOnly, Email, Id, Phone, Provenance, ScheduleType, StaffRef, Timestamp, Version, WeeklyWindow
} from '../../http/schemas.js';

export const RecruitmentStage = z
  .enum(['received', 'review', 'screening', 'interview', 'information_requested', 'references', 'background_review', 'eligible', 'hold', 'not_selected', 'archived'])
  .meta({ id: 'RecruitmentStage' });
export const AvailabilityStatus = z.enum(['available', 'future_date', 'unavailable', 'unknown']).meta({ id: 'AvailabilityStatus' });
export const EducationLevel = z.enum(['none', 'high_school', 'some_college', 'associate', 'bachelor', 'master', 'doctorate', 'other']).meta({ id: 'EducationLevel' });
export const EmploymentType = z.enum(['private_household', 'agency', 'childcare_center', 'school', 'hospitality', 'other']);
export const Proficiency = z.enum(['basic', 'conversational', 'fluent', 'native']);
export const LanguageCode = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Use a language code such as en, es or pt-BR');

export const Employment = z
  .object({
    id: Id,
    employerDescription: z.string(),
    roleTitle: z.string(),
    employmentType: EmploymentType,
    startDate: DateOnly,
    endDate: DateOnly.nullable(),
    isCurrent: z.boolean(),
    hoursPerWeek: z.int().nullable(),
    liveIn: z.boolean().nullable(),
    staffedHousehold: z.boolean().nullable(),
    childrenCount: z.int().nullable(),
    ageGroups: z.array(AgeGroup),
    responsibilities: z.string().nullable(),
    departureReason: z.string().nullable(),
    provenance: Provenance,
    verifiedAt: Timestamp.nullable(),
    sortOrder: z.int()
  })
  .meta({ id: 'Employment' });

export const EmploymentInput = z
  .object({
    employerDescription: z.string().trim().min(1).max(200).meta({ description: 'e.g. "Private family, Cherry Creek". Avoid children\'s names.' }),
    roleTitle: z.string().trim().min(1).max(120),
    employmentType: EmploymentType.default('private_household'),
    startDate: DateOnly,
    endDate: DateOnly.nullable().optional(),
    isCurrent: z.boolean().default(false),
    hoursPerWeek: z.int().min(1).max(168).nullable().optional(),
    liveIn: z.boolean().nullable().optional(),
    staffedHousehold: z.boolean().nullable().optional(),
    childrenCount: z.int().min(0).max(20).nullable().optional(),
    ageGroups: z.array(AgeGroup).default([]),
    responsibilities: z.string().max(3000).nullable().optional(),
    departureReason: z.string().max(1000).nullable().optional(),
    sortOrder: z.int().default(0)
  })
  .refine(v => !v.endDate || v.endDate >= v.startDate, { message: 'End date must be after the start date', path: ['endDate'] })
  .refine(v => !(v.isCurrent && v.endDate), { message: 'A current role has no end date', path: ['endDate'] })
  .meta({ id: 'EmploymentInput' });

export const Qualification = z
  .object({
    id: Id,
    qualificationKey: z.string(),
    label: z.string(),
    issuer: z.string().nullable(),
    issuedOn: DateOnly.nullable(),
    expiresOn: DateOnly.nullable(),
    hasExpiry: z.boolean(),
    documentId: Id.nullable(),
    reviewState: z.enum(['pending_review', 'verified', 'rejected']),
    provenance: Provenance,
    reviewedAt: Timestamp.nullable(),
    reviewNote: z.string().nullable(),
    current: z.boolean().meta({ description: 'Verified and, when the type expires, with a recorded expiry on or after today (agency time). Missing expiry is never current.' }),
    version: Version
  })
  .meta({ id: 'Qualification' });

export const QualificationInput = z
  .object({
    qualificationKey: z.string().max(64),
    issuer: z.string().trim().max(160).nullable().optional(),
    issuedOn: DateOnly.nullable().optional(),
    expiresOn: DateOnly.nullable().optional(),
    documentId: Id.nullable().optional()
  })
  .meta({ id: 'QualificationInput' });

export const ProfileFields = {
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  preferredName: z.string().trim().max(80).nullable(),
  email: Email,
  phone: Phone.nullable(),
  contactMethods: z.array(z.enum(['email', 'phone', 'text'])),
  city: z.string().trim().max(120).nullable(),
  state: z.string().trim().max(40).nullable(),
  postalCode: z.string().trim().max(20).nullable(),
  preferredAreas: z.array(z.string().trim().min(1).max(80)).max(30),
  maxCommuteMiles: z.int().min(0).max(500).nullable(),
  openToRelocation: z.boolean().nullable(),
  openToTravel: z.boolean().nullable(),
  childcareYears: z.number().min(0).max(70).nullable(),
  professionalNannyYears: z.number().min(0).max(70).nullable(),
  ageGroups: z.array(AgeGroup),
  maxChildrenCared: z.int().min(1).max(20).nullable(),
  privateHouseholdExperience: z.boolean().nullable(),
  staffedHouseholdExperience: z.boolean().nullable(),
  liveInExperience: z.boolean().nullable(),
  liveOutExperience: z.boolean().nullable(),
  scheduleExperience: z.array(ScheduleType),
  householdManagementExperience: z.boolean().nullable(),
  specialNeedsExperience: z.boolean().nullable(),
  developmentalSupportExperience: z.boolean().nullable(),
  educationLevel: EducationLevel.nullable(),
  educationDetails: z.string().max(2000).nullable(),
  drivingEligible: z.boolean().nullable(),
  hasVehicle: z.boolean().nullable(),
  travelReady: z.boolean().nullable(),
  desiredServiceTypes: z.array(z.string().max(64)),
  desiredArrangement: Arrangement.nullable(),
  desiredScheduleTypes: z.array(ScheduleType),
  earliestStartDate: DateOnly.nullable(),
  compensation: CompensationRange.nullable(),
  willingToTravel: z.boolean().nullable(),
  preferenceNotes: z.string().max(2000).nullable(),
  introduction: z.string().max(3000).nullable()
};

export const CandidateSummary = z
  .object({
    id: Id,
    reference: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    preferredName: z.string().nullable(),
    email: z.string(),
    phone: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    recruitmentStage: RecruitmentStage,
    availabilityStatus: AvailabilityStatus,
    availableFrom: DateOnly.nullable(),
    professionalNannyYears: z.number().nullable(),
    childcareYears: z.number().nullable(),
    ageGroups: z.array(AgeGroup),
    desiredScheduleTypes: z.array(ScheduleType),
    desiredArrangement: Arrangement.nullable(),
    drivingEligible: z.boolean().nullable(),
    currentQualifications: z.array(z.string()).meta({ description: 'Keys of verified, unexpired qualifications.' }),
    assignedStaff: StaffRef,
    isTest: z.boolean(),
    submittedAt: Timestamp.nullable(),
    updatedAt: Timestamp,
    version: Version
  })
  .meta({ id: 'CandidateSummary' });

export const CandidateDetail = CandidateSummary.extend({
  contactMethods: z.array(z.string()),
  postalCode: z.string().nullable(),
  preferredAreas: z.array(z.string()),
  maxCommuteMiles: z.int().nullable(),
  openToRelocation: z.boolean().nullable(),
  openToTravel: z.boolean().nullable(),
  availabilityConfirmedAt: Timestamp.nullable(),
  maxChildrenCared: z.int().nullable(),
  privateHouseholdExperience: z.boolean().nullable(),
  staffedHouseholdExperience: z.boolean().nullable(),
  liveInExperience: z.boolean().nullable(),
  liveOutExperience: z.boolean().nullable(),
  scheduleExperience: z.array(z.string()),
  householdManagementExperience: z.boolean().nullable(),
  specialNeedsExperience: z.boolean().nullable(),
  developmentalSupportExperience: z.boolean().nullable(),
  educationLevel: EducationLevel.nullable(),
  educationDetails: z.string().nullable(),
  hasVehicle: z.boolean().nullable(),
  travelReady: z.boolean().nullable(),
  desiredServiceTypes: z.array(z.string()),
  earliestStartDate: DateOnly.nullable(),
  compensation: CompensationRange.nullable(),
  willingToTravel: z.boolean().nullable(),
  preferenceNotes: z.string().nullable(),
  introduction: z.string().nullable(),
  source: z.string().nullable(),
  mergedIntoCandidateId: Id.nullable(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  employments: z.array(Employment),
  qualifications: z.array(Qualification),
  languages: z.array(z.object({ languageCode: z.string(), proficiency: Proficiency })),
  skills: z.array(z.object({ skillKey: z.string(), label: z.string(), provenance: Provenance })),
  availabilityWindows: z.array(WeeklyWindow),
  fieldVerifications: z.array(
    z.object({ fieldKey: z.string(), provenance: Provenance, verifiedAt: Timestamp, verifiedBy: StaffRef, evidenceDocumentId: Id.nullable(), note: z.string().nullable() })
  ),
  customAnswers: z.array(z.object({ questionKey: z.string(), value: z.unknown(), formVersionId: Id.nullable() })),
  applications: z.array(z.object({ id: Id, reference: z.string(), submittedAt: Timestamp, formVersionId: Id }))
}).meta({ id: 'CandidateDetail' });

export const CandidateCreate = z
  .object({
    ...Object.fromEntries(Object.entries(ProfileFields).map(([key, schema]) => [key, (schema as z.ZodType).optional()])),
    firstName: ProfileFields.firstName,
    lastName: ProfileFields.lastName,
    email: ProfileFields.email,
    assignedStaffId: Id.nullable().optional(),
    source: z.string().max(60).optional()
  })
  .meta({ id: 'CandidateCreate' }) as z.ZodType<Partial<CandidateProfileT> & { firstName: string; lastName: string; email: string; assignedStaffId?: string | null; source?: string }>;

export const CandidateUpdate = z
  .object({
    version: Version,
    ...Object.fromEntries(Object.entries(ProfileFields).map(([key, schema]) => [key, (schema as z.ZodType).optional()])),
    assignedStaffId: Id.nullable().optional()
  })
  .meta({ id: 'CandidateUpdate' }) as z.ZodType<Partial<CandidateProfileT> & { version: number; assignedStaffId?: string | null }>;

export type CandidateProfileT = { [K in keyof typeof ProfileFields]: z.infer<(typeof ProfileFields)[K]> };

export const AvailabilityChange = z
  .object({ status: AvailabilityStatus, availableFrom: DateOnly.nullable().optional(), version: Version, reason: z.string().max(500).optional() })
  .refine(v => v.status !== 'future_date' || Boolean(v.availableFrom), { message: 'Add the date the candidate becomes available', path: ['availableFrom'] })
  .meta({ id: 'AvailabilityChange' });

export const EligibilityRequirement = z
  .object({
    key: z.string(),
    label: z.string(),
    kind: z.string(),
    status: z.enum(['met', 'not_met', 'overridden']),
    detail: z.string(),
    evidence: z.record(z.string(), z.unknown()),
    lastVerifiedAt: z.string().nullable(),
    override: z.object({ id: Id, reason: z.string(), actorStaffId: Id, createdAt: Timestamp, expiresAt: Timestamp.nullable(), jobOrderId: Id.nullable() }).nullable()
  })
  .meta({ id: 'EligibilityRequirement' });

export const EligibilityResult = z
  .object({
    eligible: z.boolean(),
    policyId: Id.nullable(),
    policyVersion: z.int().nullable(),
    asOfDate: DateOnly,
    evaluatedAt: Timestamp,
    jobOrderId: Id.nullable(),
    requirements: z.array(EligibilityRequirement),
    blockers: z.array(z.string())
  })
  .meta({ id: 'EligibilityResult', description: 'Server-calculated presentation eligibility under the active screening policy.' });
