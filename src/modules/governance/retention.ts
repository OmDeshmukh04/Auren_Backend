import { sql } from 'kysely';
import type { AppDeps, RequestMeta } from '../../context.js';
import type { Tx } from '../../db/index.js';
import { audit } from '../../domain/audit.js';
import { unprocessable } from '../../http/errors.js';

/**
 * Approved deletion requests. Personal data is removed or replaced while business records
 * (placements, invoices, stage history, audit) remain, so reports stay reproducible. Legal holds
 * block deletion. Runs with the retention override so append-only tables allow the removal.
 */

export async function assertNoHold(db: Tx | AppDeps['db'], subjectType: string, subjectId: string) {
  const hold = await db.selectFrom('legalHolds').select('id').where('subjectType', '=', subjectType).where('subjectId', '=', subjectId).where('releasedAt', 'is', null).executeTakeFirst();
  if (hold) throw unprocessable('A legal hold prevents deleting this record.', 'legal_hold');
}

export async function anonymizeCandidate(deps: AppDeps, meta: RequestMeta, candidateId: string) {
  const storageKeys: string[] = [];
  await deps.db.transaction().execute(async trx => {
    await sql`SET LOCAL auren.retention_override = 'on'`.execute(trx);
    await assertNoHold(trx, 'candidate', candidateId);
    const documents = await trx.selectFrom('documents').select(['id', 'storageKey']).where('candidateId', '=', candidateId).execute();
    storageKeys.push(...documents.map(d => d.storageKey));
    await trx.updateTable('candidates').set({ presentationPhotoDocumentId: null }).where('id', '=', candidateId).execute();
    await trx.updateTable('candidateQualifications').set({ documentId: null }).where('candidateId', '=', candidateId).execute();
    await trx.updateTable('candidateFieldVerifications').set({ evidenceDocumentId: null }).where('candidateId', '=', candidateId).execute();
    const drafts = await trx.selectFrom('applications').select('draftId').where('candidateId', '=', candidateId).execute();
    const draftIds = drafts.map(d => d.draftId);
    if (draftIds.length) {
      await trx.updateTable('consents').set({ applicationDraftId: null }).where('applicationDraftId', 'in', draftIds).execute();
      const draftDocs = await trx.selectFrom('documents').select('storageKey').where('applicationDraftId', 'in', draftIds).execute();
      storageKeys.push(...draftDocs.map(d => d.storageKey));
      await trx.deleteFrom('documents').where('applicationDraftId', 'in', draftIds).execute();
    }
    if (documents.length) {
      await trx.updateTable('agreements').set({ documentId: null }).where('documentId', 'in', documents.map(d => d.id)).execute();
      await trx.deleteFrom('documents').where('id', 'in', documents.map(d => d.id)).execute();
    }
    await trx.deleteFrom('applications').where('candidateId', '=', candidateId).execute();
    if (draftIds.length) await trx.deleteFrom('applicationDrafts').where('id', 'in', draftIds).execute();
    for (const table of ['candidateEmployments', 'candidateQualifications', 'candidateLanguages', 'candidateSkills', 'candidateAvailabilityWindows', 'candidateFieldVerifications', 'candidateCustomAnswers'] as const) {
      await trx.deleteFrom(table).where('candidateId', '=', candidateId).execute();
    }
    const refs = await trx.selectFrom('candidateReferences').select('id').where('candidateId', '=', candidateId).execute();
    if (refs.length) {
      const ids = refs.map(r => r.id);
      await trx.updateTable('communications').set({ referenceId: null }).where('referenceId', 'in', ids).execute();
      await trx.updateTable('tasks').set({ referenceId: null }).where('referenceId', 'in', ids).execute();
      await trx.deleteFrom('referenceEvaluations').where('referenceId', 'in', ids).execute();
      await trx.deleteFrom('referenceContactAttempts').where('referenceId', 'in', ids).execute();
      await trx.deleteFrom('candidateReferences').where('id', 'in', ids).execute();
    }
    const interviews = await trx.selectFrom('interviews').select('id').where('candidateId', '=', candidateId).execute();
    if (interviews.length) await trx.deleteFrom('interviewEvaluations').where('interviewId', 'in', interviews.map(i => i.id)).execute();
    await trx.updateTable('screeningChecks').set({ providerReference: null, reviewNote: null, authorizationReference: null }).where('candidateId', '=', candidateId).execute();
    await trx.deleteFrom('notes').where('candidateId', '=', candidateId).execute();
    await trx.updateTable('communications').set({ subject: null, summary: '[removed]', toAddress: null }).where('candidateId', '=', candidateId).execute();
    await trx.updateTable('deliveries').set({ bodyText: null, subject: '[removed]' }).where('recipientType', 'in', ['candidate', 'applicant']).where('recipientId', '=', candidateId).execute();
    await trx.updateTable('informationRequests').set({ message: null }).where('candidateId', '=', candidateId).execute();
    await trx
      .updateTable('candidates')
      .set({
        firstName: 'Deleted', lastName: 'Candidate', preferredName: null, email: `deleted+${candidateId}@deleted.invalid`, phone: null, phoneNormalized: null,
        city: null, state: null, postalCode: null, preferredAreas: [], latitude: null, longitude: null, introduction: null, preferenceNotes: null,
        educationDetails: null, utm: JSON.stringify({}), recruitmentStage: 'archived', archivedAt: meta.now.toISOString(), version: sql`version + 1`
      })
      .where('id', '=', candidateId)
      .execute();
    await audit(trx, meta, { action: 'retention.candidate_anonymized', subjectType: 'candidate', subjectId: candidateId, metadata: { documents: storageKeys.length } });
  });
  for (const key of storageKeys) await deps.privateStorage.delete(key).catch(() => {});
}

export async function anonymizeFamilyContact(deps: AppDeps, meta: RequestMeta, contactId: string) {
  await deps.db.transaction().execute(async trx => {
    await sql`SET LOCAL auren.retention_override = 'on'`.execute(trx);
    const contact = await trx.selectFrom('familyContacts').select(['familyId']).where('id', '=', contactId).executeTakeFirstOrThrow();
    await assertNoHold(trx, 'family', contact.familyId);
    await trx.updateTable('enquiries').set({ submissionSnapshot: null, details: null, budgetNotes: null }).where('contactId', '=', contactId).execute();
    await trx.deleteFrom('enquiryCustomAnswers').where('enquiryId', 'in', trx.selectFrom('enquiries').select('id').where('contactId', '=', contactId)).execute();
    await trx.updateTable('communications').set({ subject: null, summary: '[removed]', toAddress: null }).where('familyContactId', '=', contactId).execute();
    await trx.updateTable('deliveries').set({ bodyText: null, subject: '[removed]' }).where('recipientType', '=', 'family_contact').where('recipientId', '=', contactId).execute();
    await trx
      .updateTable('familyContacts')
      .set({ firstName: 'Deleted', lastName: 'Contact', email: `deleted+${contactId}@deleted.invalid`, phone: null, phoneNormalized: null, authorizedRecipient: false, isPrimary: false, archivedAt: meta.now.toISOString(), version: sql`version + 1` })
      .where('id', '=', contactId)
      .execute();
    await audit(trx, meta, { action: 'retention.family_contact_anonymized', subjectType: 'family_contact', subjectId: contactId });
  });
}
