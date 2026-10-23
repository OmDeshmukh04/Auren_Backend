import { z } from 'zod';
import type { FieldError } from '../../http/errors.js';
import { AgeGroup, Arrangement, CompensationRange, DateOnly, Phone, ScheduleType, WeeklyWindow } from '../../http/schemas.js';
import { EducationLevel, LanguageCode, Proficiency } from '../candidates/schemas.js';
import type { FormLayoutT } from '../forms/layout.js';

/**
 * Application sections (brief sections A–G). Each section is saved independently while the
 * applicant works: these schemas check types and limits only, so incomplete answers can be
 * autosaved. `completenessErrors` applies the required rules at final submission.
 */

const opt = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const text = (max: number) => z.string().trim().max(max);

export const ContactSection = z
  .object({
    firstName: opt(text(80)),
    lastName: opt(text(80)),
    preferredName: opt(text(80)),
    phone: opt(Phone),
    contactMethods: z.array(z.enum(['email', 'phone', 'text'])).max(3).optional(),
    city: opt(text(120)),
    state: opt(text(40)),
    postalCode: opt(text(20)),
    preferredAreas: z.array(text(80).min(1)).max(30).optional(),
    maxCommuteMiles: opt(z.int().min(0).max(500)),
    openToRelocation: opt(z.boolean()),
    openToTravel: opt(z.boolean())
  })
  .meta({ id: 'ApplicationContactSection', description: 'A. Contact and work location. The email is the verified draft email.' });

export const ExperienceSection = z
  .object({
    childcareYears: opt(z.number().min(0).max(70)),
    professionalNannyYears: opt(z.number().min(0).max(70)),
    ageGroups: z.array(AgeGroup).max(6).optional(),
    maxChildrenCared: opt(z.int().min(1).max(20)),
    privateHouseholdExperience: opt(z.boolean()),
    staffedHouseholdExperience: opt(z.boolean()),
    liveInExperience: opt(z.boolean()),
    liveOutExperience: opt(z.boolean()),
    scheduleExperience: z.array(ScheduleType).max(9).optional(),
    householdManagementExperience: opt(z.boolean()),
    specialNeedsExperience: opt(z.boolean()),
    developmentalSupportExperience: opt(z.boolean()),
    introduction: opt(text(3000)).meta({ description: 'The applicant\'s own introduction.' })
  })
  .meta({ id: 'ApplicationExperienceSection', description: 'B. Experience.' });

export const EmploymentEntry = z
  .object({
    employerDescription: opt(text(200)),
    roleTitle: opt(text(120)),
    employmentType: opt(z.enum(['private_household', 'agency', 'childcare_center', 'school', 'hospitality', 'other'])),
    startDate: opt(DateOnly),
    endDate: opt(DateOnly),
    isCurrent: opt(z.boolean()),
    hoursPerWeek: opt(z.int().min(1).max(168)),
    liveIn: opt(z.boolean()),
    staffedHousehold: opt(z.boolean()),
    childrenCount: opt(z.int().min(0).max(20)),
    ageGroups: z.array(AgeGroup).max(6).optional(),
    responsibilities: opt(text(3000)),
    departureReason: opt(text(1000))
  })
  .meta({ id: 'ApplicationEmploymentEntry' });

export const EmploymentSection = z.object({ entries: z.array(EmploymentEntry).max(30).default([]) }).meta({ id: 'ApplicationEmploymentSection', description: 'B. Employment history.' });

export const CertificationEntry = z
  .object({
    qualificationKey: opt(z.string().max(64)),
    issuer: opt(text(160)),
    issuedOn: opt(DateOnly),
    expiresOn: opt(DateOnly),
    documentId: opt(z.uuid()).meta({ description: 'An uploaded certificate in this draft.' })
  })
  .meta({ id: 'ApplicationCertificationEntry' });

export const QualificationsSection = z
  .object({
    educationLevel: opt(EducationLevel),
    educationDetails: opt(text(2000)),
    drivingEligible: opt(z.boolean()),
    hasVehicle: opt(z.boolean()),
    travelReady: opt(z.boolean()),
    certifications: z.array(CertificationEntry).max(30).optional(),
    languages: z.array(z.object({ languageCode: LanguageCode, proficiency: Proficiency })).max(20).optional(),
    skills: z.array(z.string().max(64)).max(60).optional()
  })
  .meta({ id: 'ApplicationQualificationsSection', description: 'C. Qualifications, training, languages and skills.' });

export const PreferencesSection = z
  .object({
    desiredServiceTypes: z.array(z.string().max(64)).max(20).optional(),
    desiredArrangement: opt(Arrangement),
    desiredScheduleTypes: z.array(ScheduleType).max(9).optional(),
    availabilityWindows: z.array(WeeklyWindow).max(28).optional(),
    availabilityStatus: opt(z.enum(['available', 'future_date'])),
    availableFrom: opt(DateOnly),
    earliestStartDate: opt(DateOnly),
    compensation: opt(CompensationRange),
    willingToTravel: opt(z.boolean()),
    preferenceNotes: opt(text(2000))
  })
  .meta({ id: 'ApplicationPreferencesSection', description: 'D. Availability and preferences.' });

export const ReferenceEntry = z
  .object({
    fullName: opt(text(160)),
    relationship: opt(z.enum(['employer_family', 'agency_supervisor', 'workplace_supervisor', 'colleague', 'teacher', 'other'])),
    relationshipDetail: opt(text(200)),
    organizationDescription: opt(text(200)),
    email: opt(z.email().max(254)),
    phone: opt(Phone),
    employmentStart: opt(DateOnly),
    employmentEnd: opt(DateOnly),
    permissionToContact: opt(z.boolean())
  })
  .meta({ id: 'ApplicationReferenceEntry', description: 'E. A reference. Contact details stay confidential and are never shown to families.' });

export const ReferencesSection = z.object({ entries: z.array(ReferenceEntry).max(10).default([]) }).meta({ id: 'ApplicationReferencesSection' });

export const DocumentsSection = z
  .object({ photoDocumentId: opt(z.uuid()).meta({ description: 'Optional professional photograph (an uploaded photo in this draft).' }) })
  .meta({ id: 'ApplicationDocumentsSection', description: 'F. Documents are uploaded separately; this section records the chosen photo.' });

export const AcknowledgementsSection = z
  .object({
    accuracyAttestation: opt(z.boolean()),
    privacyNotice: opt(z.boolean()),
    referenceContactAuthorization: opt(z.boolean()),
    presentationSharing: opt(z.boolean()),
    marketingEmail: opt(z.boolean())
  })
  .meta({ id: 'ApplicationAcknowledgementsSection', description: 'G. Acknowledgements. Background screening authorization is collected separately, not here.' });

export const CustomSection = z.record(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/), z.unknown()).meta({ id: 'ApplicationCustomAnswers', description: 'Answers to owner-defined questions, by question key.' });

export const SECTION_SCHEMAS = {
  contact: ContactSection,
  experience: ExperienceSection,
  employment: EmploymentSection,
  qualifications: QualificationsSection,
  preferences: PreferencesSection,
  references: ReferencesSection,
  documents: DocumentsSection,
  acknowledgements: AcknowledgementsSection,
  custom: CustomSection
} as const;
export type SectionKey = keyof typeof SECTION_SCHEMAS;
export const SECTION_KEYS = Object.keys(SECTION_SCHEMAS) as SectionKey[];

export const ApplicationData = z
  .object({
    contact: ContactSection.optional(),
    experience: ExperienceSection.optional(),
    employment: EmploymentSection.optional(),
    qualifications: QualificationsSection.optional(),
    preferences: PreferencesSection.optional(),
    references: ReferencesSection.optional(),
    documents: DocumentsSection.optional(),
    acknowledgements: AcknowledgementsSection.optional(),
    custom: CustomSection.optional()
  })
  .meta({ id: 'ApplicationDraftData' });
export type ApplicationDataT = z.infer<typeof ApplicationData>;

const CONSENT_FIELD: Record<string, keyof z.infer<typeof AcknowledgementsSection>> = {
  accuracy_attestation: 'accuracyAttestation',
  privacy_notice: 'privacyNotice',
  reference_contact_authorization: 'referenceContactAuthorization',
  presentation_sharing: 'presentationSharing',
  marketing_email: 'marketingEmail'
};
export const consentField = (consentType: string) => CONSENT_FIELD[consentType];

/** Required rules applied at final submission. */
export function completenessErrors(data: ApplicationDataT, layout: FormLayoutT, uploaded: Array<{ id: string; documentType: string; scanStatus: string }>): FieldError[] {
  const errors: FieldError[] = [];
  const need = (path: string, ok: unknown, message: string) => {
    const missing = ok === undefined || ok === null || ok === '' || (Array.isArray(ok) && ok.length === 0);
    if (missing) errors.push({ path, code: 'required', message });
  };
  const c = data.contact ?? {};
  need('contact.firstName', c.firstName, 'Enter your first name');
  need('contact.lastName', c.lastName, 'Enter your last name');
  need('contact.phone', c.phone, 'Enter a phone number');
  need('contact.city', c.city, 'Enter your city');
  need('contact.state', c.state, 'Enter your state');

  const e = data.experience ?? {};
  need('experience.childcareYears', e.childcareYears, 'Enter your total years of childcare experience');
  need('experience.professionalNannyYears', e.professionalNannyYears, 'Enter your years as a professional nanny (0 if none)');
  need('experience.ageGroups', e.ageGroups, 'Choose the age groups you have cared for');
  if (typeof e.childcareYears === 'number' && typeof e.professionalNannyYears === 'number' && e.professionalNannyYears > e.childcareYears) {
    errors.push({ path: 'experience.professionalNannyYears', code: 'invalid', message: 'Professional nanny years cannot exceed total childcare years' });
  }

  const employments = data.employment?.entries ?? [];
  if (employments.length < (layout.minimumEmployments ?? 0)) {
    errors.push({ path: 'employment.entries', code: 'too_small', message: `Add at least ${layout.minimumEmployments} employment entries` });
  }
  employments.forEach((entry, index) => {
    const base = `employment.entries.${index}`;
    need(`${base}.employerDescription`, entry.employerDescription, 'Describe the employer');
    need(`${base}.roleTitle`, entry.roleTitle, 'Enter your role');
    need(`${base}.startDate`, entry.startDate, 'Enter the start date');
    if (!entry.isCurrent) need(`${base}.endDate`, entry.endDate, 'Enter the end date or mark the role as current');
    if (entry.isCurrent && entry.endDate) errors.push({ path: `${base}.endDate`, code: 'invalid', message: 'A current role has no end date' });
    if (entry.startDate && entry.endDate && entry.endDate < entry.startDate) errors.push({ path: `${base}.endDate`, code: 'invalid', message: 'End date must be after the start date' });
  });

  (data.qualifications?.certifications ?? []).forEach((cert, index) => {
    need(`qualifications.certifications.${index}.qualificationKey`, cert.qualificationKey, 'Choose the certificate type');
    if (cert.documentId && !uploaded.some(doc => doc.id === cert.documentId)) {
      errors.push({ path: `qualifications.certifications.${index}.documentId`, code: 'invalid', message: 'This upload is not part of your application' });
    }
  });

  const p = data.preferences ?? {};
  need('preferences.desiredScheduleTypes', p.desiredScheduleTypes, 'Choose the schedules you are looking for');
  need('preferences.availabilityStatus', p.availabilityStatus, 'Tell us when you are available');
  if (p.availabilityStatus === 'future_date') need('preferences.availableFrom', p.availableFrom, 'Enter the date you become available');

  const references = data.references?.entries ?? [];
  if (references.length < (layout.minimumReferences ?? 0)) {
    errors.push({ path: 'references.entries', code: 'too_small', message: `Add at least ${layout.minimumReferences} references` });
  }
  references.forEach((ref, index) => {
    const base = `references.entries.${index}`;
    need(`${base}.fullName`, ref.fullName, 'Enter the reference\'s name');
    need(`${base}.relationship`, ref.relationship, 'Choose how you know this reference');
    if (!ref.email && !ref.phone) errors.push({ path: `${base}.email`, code: 'required', message: 'Add an email address or phone number' });
    need(`${base}.permissionToContact`, ref.permissionToContact === undefined || ref.permissionToContact === null ? null : true, 'Tell us whether we may contact this reference');
  });

  const clean = uploaded.filter(doc => doc.scanStatus === 'clean');
  for (const type of layout.documents?.requiredTypes ?? []) {
    if (!clean.some(doc => doc.documentType === type)) errors.push({ path: `documents.${type}`, code: 'required', message: `Upload your ${type.replace('_', ' ')}` });
  }
  const pending = uploaded.filter(doc => doc.scanStatus === 'quarantined' || doc.scanStatus === 'awaiting_upload');
  if (pending.length) errors.push({ path: 'documents', code: 'pending', message: 'Some uploads are still being checked. Wait a moment or remove them.' });
  const photo = data.documents?.photoDocumentId;
  if (photo && !clean.some(doc => doc.id === photo && doc.documentType === 'photo')) {
    errors.push({ path: 'documents.photoDocumentId', code: 'invalid', message: 'Choose an uploaded photo' });
  }

  for (const consent of layout.requiredConsents) {
    const field = consentField(consent);
    if (field && data.acknowledgements?.[field] !== true) {
      errors.push({ path: `acknowledgements.${field}`, code: 'required', message: 'Please confirm to submit your application' });
    }
  }
  const anyPermission = references.some(ref => ref.permissionToContact === true);
  if (anyPermission && data.acknowledgements?.referenceContactAuthorization !== true) {
    errors.push({ path: 'acknowledgements.referenceContactAuthorization', code: 'required', message: 'Confirm the reference contact authorization, or mark references as not to be contacted' });
  }
  return errors;
}

/** Which sections have any saved content (for progress display). */
export function filledSections(data: ApplicationDataT): SectionKey[] {
  return SECTION_KEYS.filter(key => {
    const value = data[key];
    if (!value) return false;
    return Object.values(value as Record<string, unknown>).some(v => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0));
  });
}
