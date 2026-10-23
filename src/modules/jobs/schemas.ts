import { z } from 'zod';
import {
  Arrangement, ChildAgeBand, CompensationRange, CurrencyCode, CompensationPeriod, DateOnly, Id, ScheduleType, StaffRef, Timestamp, Version, WeeklyWindow
} from '../../http/schemas.js';

export const JobStatus = z.enum(['draft', 'open', 'on_hold', 'filled', 'cancelled', 'closed']).meta({ id: 'JobStatus' });
export const JobCandidateStage = z
  .enum(['shortlisted', 'presentation_approved', 'presented', 'family_interview', 'trial', 'offer', 'accepted', 'declined', 'withdrawn', 'placed'])
  .meta({ id: 'JobCandidateStage' });

export const CriterionKind = z.enum([
  'min_professional_nanny_years', 'min_childcare_years', 'age_group_experience', 'qualification_current', 'language', 'skill',
  'driving_eligible', 'has_vehicle', 'live_in', 'travel', 'schedule_availability', 'education_level', 'service_area',
  'special_needs_experience', 'staffed_household_experience', 'max_children', 'compensation_within_budget'
]);

export const JobCriterion = z
  .object({
    id: Id.optional(),
    importance: z.enum(['required', 'preferred']),
    criterion: CriterionKind,
    params: z.record(z.string(), z.unknown()).default({}).meta({
      description:
        'min_*_years: {years}; age_group_experience: {ageGroups[]}; qualification_current: {qualifications[]} (any of); language: {code, minProficiency}; ' +
        'skill: {skill}; education_level: {minLevel}; service_area: {cities[]}; max_children: {count}; schedule_availability: uses the job schedule windows; ' +
        'compensation_within_budget: uses the job compensation maximum; boolean criteria take no params.'
    }),
    note: z.string().max(500).nullable().optional(),
    sortOrder: z.int().default(0)
  })
  .meta({ id: 'JobCriterion' });

export const JobSummary = z
  .object({
    id: Id,
    reference: z.string(),
    familyId: Id,
    familyName: z.string(),
    title: z.string(),
    serviceTypeKey: z.string().nullable(),
    status: JobStatus,
    arrangement: Arrangement.nullable(),
    scheduleTypes: z.array(ScheduleType),
    startDate: DateOnly.nullable(),
    compensation: CompensationRange.nullable(),
    locationCity: z.string().nullable(),
    locationState: z.string().nullable(),
    assignedStaff: StaffRef,
    candidateCount: z.int(),
    openedAt: Timestamp.nullable(),
    isTest: z.boolean(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp
  })
  .meta({ id: 'JobSummary' });

export const JobDetail = JobSummary.extend({
  enquiryId: Id.nullable(),
  scheduleNotes: z.string().nullable(),
  hoursPerWeek: z.int().nullable(),
  startFlexibility: z.string().nullable(),
  travelRequired: z.boolean().nullable(),
  travelNotes: z.string().nullable(),
  responsibilities: z.string().nullable(),
  childrenCount: z.int().nullable(),
  childrenAgeBands: z.array(ChildAgeBand),
  postalCode: z.string().nullable(),
  replacementForPlacementId: Id.nullable(),
  filledAt: Timestamp.nullable(),
  closedAt: Timestamp.nullable(),
  closeReason: z.string().nullable(),
  criteria: z.array(JobCriterion.extend({ id: Id })),
  scheduleWindows: z.array(WeeklyWindow)
}).meta({ id: 'JobDetail' });

const JobFields = {
  title: z.string().trim().min(1).max(160),
  serviceTypeKey: z.string().max(64).nullable(),
  arrangement: Arrangement.nullable(),
  scheduleTypes: z.array(ScheduleType).max(9),
  scheduleNotes: z.string().max(2000).nullable(),
  hoursPerWeek: z.int().min(1).max(168).nullable(),
  startDate: DateOnly.nullable(),
  startFlexibility: z.string().max(200).nullable(),
  compensation: CompensationRange.nullable(),
  travelRequired: z.boolean().nullable(),
  travelNotes: z.string().max(1000).nullable(),
  responsibilities: z.string().max(5000).nullable(),
  childrenCount: z.int().min(0).max(20).nullable(),
  childrenAgeBands: z.array(ChildAgeBand).max(7),
  locationCity: z.string().max(120).nullable(),
  locationState: z.string().max(40).nullable(),
  postalCode: z.string().max(20).nullable(),
  assignedStaffId: Id.nullable()
};
const optional = <T extends Record<string, z.ZodType>>(shape: T) =>
  Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, schema.optional()])) as { [K in keyof T]: z.ZodOptional<T[K]> };

export const JobCreate = z
  .object({ familyId: Id, enquiryId: Id.nullable().optional(), ...optional(JobFields), title: JobFields.title, criteria: z.array(JobCriterion).max(30).default([]), scheduleWindows: z.array(WeeklyWindow).max(28).default([]) })
  .meta({ id: 'JobCreate' });
export const JobUpdate = z.object({ version: Version, ...optional(JobFields) }).meta({ id: 'JobUpdate' });

export const JobCandidate = z
  .object({
    id: Id,
    jobOrderId: Id,
    candidateId: Id,
    candidate: z.object({ reference: z.string(), firstName: z.string(), lastName: z.string(), recruitmentStage: z.string(), availabilityStatus: z.string() }),
    job: z.object({ reference: z.string(), title: z.string(), status: z.string(), familyId: Id, familyName: z.string() }),
    stage: JobCandidateStage,
    rationale: z.string().nullable(),
    closedReason: z.string().nullable(),
    addedBy: StaffRef,
    openOffer: z.object({ id: Id, status: z.string(), reviewDate: DateOnly.nullable() }).nullable(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp
  })
  .meta({ id: 'JobCandidate' });

export const ComparisonRow = z
  .object({
    criterionId: Id.nullable(),
    criterion: z.string(),
    importance: z.enum(['required', 'preferred']),
    label: z.string(),
    result: z.enum(['meets', 'does_not_meet', 'not_recorded']),
    evidence: z.string(),
    provenance: z.string().nullable(),
    lastVerifiedAt: z.string().nullable()
  })
  .meta({ id: 'ComparisonRow' });

export const Comparison = z
  .object({
    jobOrderId: Id,
    candidateId: Id,
    asOfDate: DateOnly,
    rows: z.array(ComparisonRow),
    summary: z.object({ requiredMet: z.int(), requiredTotal: z.int(), preferredMet: z.int(), preferredTotal: z.int(), notRecorded: z.int() })
  })
  .meta({ id: 'CandidateJobComparison', description: 'Explicit criteria comparison. Never rejects automatically; staff decide.' });

export const Offer = z
  .object({
    id: Id,
    jobCandidateId: Id,
    status: z.enum(['draft', 'extended', 'accepted', 'declined', 'withdrawn', 'superseded']),
    compensationAmountMinor: z.int().nullable(),
    compensationCurrency: z.string().nullable(),
    compensationPeriod: z.string().nullable(),
    proposedStartDate: DateOnly.nullable(),
    reviewDate: DateOnly.nullable(),
    termsSummary: z.string().nullable(),
    extendedAt: Timestamp.nullable(),
    respondedAt: Timestamp.nullable(),
    version: Version,
    createdAt: Timestamp
  })
  .meta({ id: 'Offer' });

export const OfferCreate = z
  .object({
    compensation: z.object({ amountMinor: z.int().min(0), currency: CurrencyCode, period: CompensationPeriod }).nullable().optional(),
    proposedStartDate: DateOnly.nullable().optional(),
    reviewDate: DateOnly.nullable().optional().meta({ description: 'Follow-up date; creates a coordinator task through the offer workflow.' }),
    termsSummary: z.string().max(2000).nullable().optional(),
    version: Version.meta({ description: 'Current version of the job-candidate association.' })
  })
  .meta({ id: 'OfferCreate' });
