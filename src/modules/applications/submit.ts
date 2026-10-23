import type { AppDeps, RequestMeta } from '../../context.js';
import { audit } from '../../domain/audit.js';
import { emit } from '../../domain/outbox.js';
import { CONSENT_NOTICE, noticeFor } from '../../domain/consents.js';
import { uniqueReference } from '../../domain/records.js';
import { conflict, unprocessable, validationFailed } from '../../http/errors.js';
import { hhmmToMinutes } from '../../http/schemas.js';
import { runIdempotent } from '../../http/security.js';
import { canonicalJson, sha256 } from '../../lib/crypto.js';
import { formVersionById, indexedValues, questionsByKey, validateCustomAnswers } from '../forms/layout.js';
import { insertCandidate, profileToColumns } from '../candidates/service.js';
import { completenessErrors, consentField, type ApplicationDataT } from './sections.js';

/**
 * Final submission. Validates the whole application against its pinned form version, then in one
 * transaction writes the immutable submitted snapshot, the candidate profile and child records,
 * consents, references, document links and the outbox event. Repeated submits with the same
 * Idempotency-Key return the same result; a second key for an already-submitted draft is refused.
 */
export async function submitApplication(deps: AppDeps, meta: RequestMeta, draftId: string, idempotencyKey: string) {
  const now = deps.clock.now();
  return runIdempotent(deps.db, { scope: `application-submit:${draftId}`, key: idempotencyKey, request: { draftId }, now }, async trx => {
    const draft = await trx.selectFrom('applicationDrafts').selectAll().where('id', '=', draftId).forUpdate().executeTakeFirstOrThrow();
    if (draft.status === 'submitted') throw conflict('This application was already submitted.', 'already_submitted');
    if (draft.status !== 'active') throw unprocessable('This draft can no longer be submitted.', 'draft_not_active');
    if (!draft.emailVerifiedAt) throw unprocessable('Confirm your email address before submitting.', 'email_not_verified');
    if (new Date(draft.expiresAt) < now) throw unprocessable('This draft has expired. Please start a new application.', 'draft_expired');
    const form = await formVersionById(trx, draft.formVersionId);
    if (!form) throw unprocessable('This form version is no longer available.', 'form_unavailable');
    const data = draft.data as ApplicationDataT;
    const documents = await trx
      .selectFrom('documents')
      .select(['id', 'documentType', 'scanStatus', 'originalFilename', 'sha256'])
      .where('applicationDraftId', '=', draftId)
      .where('deletedAt', 'is', null)
      .where('scanStatus', '<>', 'awaiting_upload')
      .execute();
    const errors = completenessErrors(data, form.layout, documents);
    const custom = validateCustomAnswers(form.layout, data.custom ?? {}, { partial: false });
    errors.push(...custom.errors);
    const serviceKeys = data.preferences?.desiredServiceTypes ?? [];
    if (serviceKeys.length) {
      const found = await trx.selectFrom('serviceTypes').select('key').where('key', 'in', serviceKeys).execute();
      if (found.length !== new Set(serviceKeys).size) errors.push({ path: 'preferences.desiredServiceTypes', code: 'invalid', message: 'Choose services from the list' });
    }
    const qualificationKeys = (data.qualifications?.certifications ?? []).map(c => c.qualificationKey).filter(Boolean) as string[];
    if (qualificationKeys.length) {
      const found = await trx.selectFrom('qualificationTypes').select('key').where('key', 'in', qualificationKeys).execute();
      if (found.length !== new Set(qualificationKeys).size) errors.push({ path: 'qualifications.certifications', code: 'invalid', message: 'Choose certificate types from the list' });
    }
    const skillKeys = data.qualifications?.skills ?? [];
    if (skillKeys.length) {
      const found = await trx.selectFrom('skills').select('key').where('key', 'in', skillKeys).execute();
      if (found.length !== new Set(skillKeys).size) errors.push({ path: 'qualifications.skills', code: 'invalid', message: 'Choose skills from the list' });
    }
    if (errors.length) throw validationFailed(errors, 'Some answers need attention before you submit.');

    // Notices are resolved before writing so a missing notice fails the whole submission.
    const consentTypes = [...new Set([...form.layout.requiredConsents, ...form.layout.optionalConsents])].filter(type => data.acknowledgements?.[consentField(type)!] === true);
    const notices = new Map<string, Awaited<ReturnType<typeof noticeFor>>>();
    for (const type of consentTypes) notices.set(type, await noticeFor(trx, deps.config, CONSENT_NOTICE[type]!));

    const c = data.contact ?? {};
    const e = data.experience ?? {};
    const q = data.qualifications ?? {};
    const p = data.preferences ?? {};
    const candidate = await insertCandidate(trx, meta, {
      ...(profileToColumns({
        firstName: c.firstName!,
        lastName: c.lastName!,
        preferredName: c.preferredName ?? null,
        email: draft.email,
        phone: c.phone ?? null,
        contactMethods: c.contactMethods ?? ['email'],
        city: c.city ?? null,
        state: c.state ?? null,
        postalCode: c.postalCode ?? null,
        preferredAreas: c.preferredAreas ?? [],
        maxCommuteMiles: c.maxCommuteMiles ?? null,
        openToRelocation: c.openToRelocation ?? null,
        openToTravel: c.openToTravel ?? null,
        childcareYears: e.childcareYears ?? null,
        professionalNannyYears: e.professionalNannyYears ?? null,
        ageGroups: e.ageGroups ?? [],
        maxChildrenCared: e.maxChildrenCared ?? null,
        privateHouseholdExperience: e.privateHouseholdExperience ?? null,
        staffedHouseholdExperience: e.staffedHouseholdExperience ?? null,
        liveInExperience: e.liveInExperience ?? null,
        liveOutExperience: e.liveOutExperience ?? null,
        scheduleExperience: e.scheduleExperience ?? [],
        householdManagementExperience: e.householdManagementExperience ?? null,
        specialNeedsExperience: e.specialNeedsExperience ?? null,
        developmentalSupportExperience: e.developmentalSupportExperience ?? null,
        introduction: e.introduction ?? null,
        educationLevel: q.educationLevel ?? null,
        educationDetails: q.educationDetails ?? null,
        drivingEligible: q.drivingEligible ?? null,
        hasVehicle: q.hasVehicle ?? null,
        travelReady: q.travelReady ?? null,
        desiredServiceTypes: p.desiredServiceTypes ?? [],
        desiredArrangement: p.desiredArrangement ?? null,
        desiredScheduleTypes: p.desiredScheduleTypes ?? [],
        earliestStartDate: p.earliestStartDate ?? null,
        compensation: p.compensation ?? null,
        willingToTravel: p.willingToTravel ?? null,
        preferenceNotes: p.preferenceNotes ?? null
      }) as { email: string; firstName: string; lastName: string }),
      availabilityStatus: p.availabilityStatus ?? 'unknown',
      availableFrom: p.availabilityStatus === 'future_date' ? p.availableFrom ?? null : null,
      availabilityConfirmedAt: now.toISOString(),
      source: draft.source ?? 'website',
      utm: JSON.stringify(draft.utm ?? {}),
      isTest: draft.isTest,
      submittedAt: now.toISOString()
    });

    const snapshot = { formVersionId: form.id, formVersion: form.versionNumber, submittedAt: now.toISOString(), email: draft.email, data, documents: documents.map(d => ({ id: d.id, documentType: d.documentType, filename: d.originalFilename, sha256: d.sha256 })) };
    const application = await trx
      .insertInto('applications')
      .values({
        reference: await uniqueReference(trx, 'applications', 'A'),
        draftId,
        candidateId: candidate.id,
        formVersionId: form.id,
        snapshot: JSON.stringify(snapshot),
        snapshotSha256: sha256(canonicalJson(snapshot)),
        submittedAt: now.toISOString(),
        isTest: draft.isTest
      })
      .returning(['id', 'reference', 'submittedAt'])
      .executeTakeFirstOrThrow();

    const employments = data.employment?.entries ?? [];
    if (employments.length) {
      await trx
        .insertInto('candidateEmployments')
        .values(employments.map((entry, index) => ({
          candidateId: candidate.id,
          employerDescription: entry.employerDescription!,
          roleTitle: entry.roleTitle!,
          employmentType: entry.employmentType ?? 'private_household',
          startDate: entry.startDate!,
          endDate: entry.isCurrent ? null : entry.endDate ?? null,
          isCurrent: entry.isCurrent ?? false,
          hoursPerWeek: entry.hoursPerWeek ?? null,
          liveIn: entry.liveIn ?? null,
          staffedHousehold: entry.staffedHousehold ?? null,
          childrenCount: entry.childrenCount ?? null,
          ageGroups: entry.ageGroups ?? [],
          responsibilities: entry.responsibilities ?? null,
          departureReason: entry.departureReason ?? null,
          sortOrder: index
        })))
        .execute();
    }
    for (const cert of q.certifications ?? []) {
      await trx
        .insertInto('candidateQualifications')
        .values({ candidateId: candidate.id, qualificationKey: cert.qualificationKey!, issuer: cert.issuer ?? null, issuedOn: cert.issuedOn ?? null, expiresOn: cert.expiresOn ?? null, documentId: cert.documentId ?? null, provenance: cert.documentId ? 'document_supplied' : 'self_reported' })
        .execute();
    }
    const languages = [...new Map((q.languages ?? []).map(l => [l.languageCode, l])).values()];
    if (languages.length) await trx.insertInto('candidateLanguages').values(languages.map(l => ({ candidateId: candidate.id, ...l }))).execute();
    const skills = [...new Set(q.skills ?? [])];
    if (skills.length) await trx.insertInto('candidateSkills').values(skills.map(skillKey => ({ candidateId: candidate.id, skillKey }))).execute();
    const windows = p.availabilityWindows ?? [];
    if (windows.length) {
      await trx.insertInto('candidateAvailabilityWindows').values(windows.map(w => ({ candidateId: candidate.id, dayOfWeek: w.dayOfWeek, startMinute: hhmmToMinutes(w.start), endMinute: hhmmToMinutes(w.end) }))).execute();
    }

    const consentIds = new Map<string, string>();
    for (const type of consentTypes) {
      const notice = notices.get(type)!;
      const row = await trx
        .insertInto('consents')
        .values({
          consentType: type,
          candidateId: candidate.id,
          applicationDraftId: draftId,
          legalNoticeId: notice.id,
          noticeVersion: notice.version,
          granted: true,
          recordedByType: 'applicant',
          occurredAt: now.toISOString(),
          evidence: JSON.stringify({ method: 'web_form', formVersionId: form.id, applicationId: application.id, placeholderNotice: notice.placeholder })
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      consentIds.set(type, row.id);
    }
    for (const ref of data.references?.entries ?? []) {
      const permitted = ref.permissionToContact === true && consentIds.has('reference_contact_authorization');
      await trx
        .insertInto('candidateReferences')
        .values({
          candidateId: candidate.id,
          applicationId: application.id,
          fullName: ref.fullName!,
          relationship: ref.relationship!,
          relationshipDetail: ref.relationshipDetail ?? null,
          organizationDescription: ref.organizationDescription ?? null,
          email: ref.email?.toLowerCase() ?? null,
          phone: ref.phone ?? null,
          employmentStart: ref.employmentStart ?? null,
          employmentEnd: ref.employmentEnd ?? null,
          permissionToContact: permitted,
          permissionRecordedAt: permitted ? now.toISOString() : null,
          permissionSource: permitted ? 'application' : null,
          permissionConsentId: permitted ? consentIds.get('reference_contact_authorization')! : null
        })
        .execute();
    }
    const questions = questionsByKey(form.layout);
    for (const [questionKey, value] of Object.entries(custom.accepted)) {
      const question = questions.get(questionKey)!;
      await trx
        .insertInto('candidateCustomAnswers')
        .values({ candidateId: candidate.id, questionKey, formVersionId: form.id, value: JSON.stringify(value), ...(question.filterable ? indexedValues(question, value) : {}) })
        .execute();
    }
    if (documents.length) {
      await trx.updateTable('documents').set({ candidateId: candidate.id }).where('applicationDraftId', '=', draftId).execute();
    }
    if (data.documents?.photoDocumentId) {
      await trx.updateTable('candidates').set({ presentationPhotoDocumentId: data.documents.photoDocumentId }).where('id', '=', candidate.id).execute();
    }
    await trx.updateTable('applicationDrafts').set({ status: 'submitted', submittedAt: now.toISOString() }).where('id', '=', draftId).execute();
    await audit(trx, meta, { action: 'application.submitted', subjectType: 'application', subjectId: application.id, metadata: { candidateId: candidate.id, possibleDuplicates: candidate.duplicates } });
    await emit(trx, meta, {
      type: 'application.submitted',
      subjectType: 'application',
      subjectId: application.id,
      payload: { related: { candidate: candidate.id, application: application.id } },
      dedupeKey: `application.submitted:${application.id}`
    });
    return { status: 201, body: { reference: application.reference, submittedAt: application.submittedAt } };
  });
}
