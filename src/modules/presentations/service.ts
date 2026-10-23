import type { AppDeps, RequestMeta, StaffActor } from '../../context.js';
import type { Executor, Tx } from '../../db/index.js';
import { audit } from '../../domain/audit.js';
import { emit } from '../../domain/outbox.js';
import { assertInScope, uniqueReference, updateVersioned } from '../../domain/records.js';
import { getSettings } from '../../domain/settings.js';
import { notFound, unprocessable, validationFailed } from '../../http/errors.js';
import { runIdempotent } from '../../http/security.js';
import { canonicalJson, randomToken, sha256 } from '../../lib/crypto.js';
import { localDate } from '../../lib/time.js';
import { evaluateEligibility } from '../screening/eligibility.js';
import { transitionJobCandidate } from '../jobs/service.js';
import { createDelivery, dispatchDeliveries } from '../automation/deliveries.js';
import { buildCandidateContent, DEFAULT_FIELDS, PRESENTATION_FIELDS, renderPresentationPdf, stripJpegMetadata, type CandidateOverrides } from './content.js';

/**
 * Presentation pipeline: draft -> preview -> approve (eligibility + sharing permission checked,
 * immutable snapshot and PDF created) -> release to an authorized family recipient (eligibility
 * re-checked, recipient confirmed, only the snapshot is delivered). Editing an approved draft
 * returns it to draft; a new approval creates a new snapshot version.
 */

type CandidateSelection = { jobCandidateId: string; includedFields?: string[]; overrides?: CandidateOverrides; sortOrder?: number };

async function jobInScope(db: Executor, staff: StaffActor, jobOrderId: string) {
  const job = await db.selectFrom('jobOrders').select(['id', 'familyId', 'assignedStaffId', 'title']).where('id', '=', jobOrderId).executeTakeFirst();
  if (!job) throw notFound('Job');
  await assertInScope(db, staff, job.assignedStaffId);
  return job;
}

async function replaceCandidates(trx: Tx, presentationId: string, jobOrderId: string, candidates: CandidateSelection[]) {
  if (!candidates.length) throw validationFailed([{ path: 'candidates', code: 'required', message: 'Choose at least one candidate' }]);
  const unknownFields = candidates.flatMap(c => (c.includedFields ?? []).filter(f => !(PRESENTATION_FIELDS as readonly string[]).includes(f)));
  if (unknownFields.length) throw validationFailed([{ path: 'candidates.includedFields', code: 'invalid', message: `Fields cannot be shared: ${[...new Set(unknownFields)].join(', ')}` }]);
  const rows = await trx.selectFrom('jobCandidates').select(['id', 'candidateId', 'stage']).where('jobOrderId', '=', jobOrderId).where('id', 'in', candidates.map(c => c.jobCandidateId)).execute();
  for (const [index, selection] of candidates.entries()) {
    const jc = rows.find(row => row.id === selection.jobCandidateId);
    if (!jc) throw validationFailed([{ path: `candidates.${index}.jobCandidateId`, code: 'invalid', message: 'This candidate is not on the job shortlist' }]);
    if (['declined', 'withdrawn', 'placed'].includes(jc.stage)) throw validationFailed([{ path: `candidates.${index}.jobCandidateId`, code: 'invalid', message: `The candidate is ${jc.stage} for this job` }]);
  }
  await trx.deleteFrom('presentationCandidates').where('presentationId', '=', presentationId).execute();
  await trx
    .insertInto('presentationCandidates')
    .values(candidates.map((selection, index) => ({
      presentationId,
      jobOrderId,
      jobCandidateId: selection.jobCandidateId,
      candidateId: rows.find(row => row.id === selection.jobCandidateId)!.candidateId,
      includedFields: [...new Set(selection.includedFields ?? DEFAULT_FIELDS)],
      overrides: JSON.stringify(selection.overrides ?? {}),
      sortOrder: selection.sortOrder ?? index
    })))
    .execute();
}

export async function createPresentation(deps: AppDeps, meta: RequestMeta, staff: StaffActor, jobOrderId: string, input: { title?: string; coverNote?: string | null; recipientContactId?: string | null; candidates: CandidateSelection[] }) {
  const id = await deps.db.transaction().execute(async trx => {
    const job = await jobInScope(trx, staff, jobOrderId);
    if (input.recipientContactId) await assertRecipient(trx, job.familyId, input.recipientContactId, false);
    const presentation = await trx
      .insertInto('presentations')
      .values({
        reference: await uniqueReference(trx, 'presentations', 'R'),
        jobOrderId,
        familyId: job.familyId,
        title: input.title ?? `Candidates for ${job.title}`,
        coverNote: input.coverNote ?? null,
        recipientContactId: input.recipientContactId ?? null,
        createdBy: staff.staffId,
        createdAt: meta.now.toISOString()
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await replaceCandidates(trx, presentation.id, jobOrderId, input.candidates);
    await audit(trx, meta, { action: 'presentation.created', subjectType: 'presentation', subjectId: presentation.id, metadata: { jobOrderId, candidates: input.candidates.length } });
    return presentation.id;
  });
  return getPresentation(deps, deps.db, null, id);
}

async function assertRecipient(db: Executor, familyId: string, contactId: string, requireAuthorized: boolean) {
  const contact = await db.selectFrom('familyContacts').select(['id', 'email', 'authorizedRecipient', 'archivedAt']).where('id', '=', contactId).where('familyId', '=', familyId).executeTakeFirst();
  if (!contact || contact.archivedAt) throw validationFailed([{ path: 'recipientContactId', code: 'invalid', message: 'Choose a current contact of this family' }]);
  if (requireAuthorized && !contact.authorizedRecipient) throw unprocessable('Mark this contact as an authorized recipient before releasing candidate profiles.', 'recipient_not_authorized');
  if (requireAuthorized && !contact.email) throw unprocessable('The recipient has no email address.', 'recipient_no_email');
  return contact;
}

export async function getPresentation(deps: AppDeps, db: Executor, staff: StaffActor | null, id: string) {
  const presentation = await db
    .selectFrom('presentations as p')
    .innerJoin('jobOrders as j', 'j.id', 'p.jobOrderId')
    .innerJoin('families as f', 'f.id', 'p.familyId')
    .leftJoin('familyContacts as c', 'c.id', 'p.recipientContactId')
    .selectAll('p')
    .select(['j.title as jobTitle', 'j.reference as jobReference', 'j.assignedStaffId', 'f.displayName as familyName', 'c.firstName as recipientFirstName', 'c.lastName as recipientLastName', 'c.email as recipientEmail', 'c.authorizedRecipient'])
    .where('p.id', '=', id)
    .executeTakeFirst();
  if (!presentation) throw notFound('Presentation');
  if (staff) await assertInScope(db, staff, presentation.assignedStaffId);
  const [candidates, snapshots, releases] = await Promise.all([
    db
      .selectFrom('presentationCandidates as pc')
      .innerJoin('candidates as c', 'c.id', 'pc.candidateId')
      .innerJoin('jobCandidates as jc', 'jc.id', 'pc.jobCandidateId')
      .select(['pc.id', 'pc.jobCandidateId', 'pc.candidateId', 'pc.includedFields', 'pc.overrides', 'pc.sortOrder', 'pc.sharingPermissionConsentId', 'c.firstName', 'c.lastName', 'c.reference', 'jc.stage'])
      .where('pc.presentationId', '=', id)
      .orderBy('pc.sortOrder')
      .execute(),
    db.selectFrom('presentationSnapshots').select(['id', 'versionNumber', 'contentSha256', 'pdfDocumentId', 'pdfSha256', 'approvedBy', 'approvedAt', 'fieldSelection']).where('presentationId', '=', id).orderBy('versionNumber', 'desc').execute(),
    db.selectFrom('presentationReleases as r').leftJoin('deliveries as d', 'd.id', 'r.deliveryId').select(['r.id', 'r.snapshotId', 'r.recipientEmail', 'r.releasedBy', 'r.releasedAt', 'd.status as deliveryStatus']).where('r.presentationId', '=', id).orderBy('r.releasedAt', 'desc').execute()
  ]);
  return {
    ...presentation,
    recipient: presentation.recipientContactId
      ? { id: presentation.recipientContactId, name: [presentation.recipientFirstName, presentation.recipientLastName].filter(Boolean).join(' '), email: presentation.recipientEmail, authorizedRecipient: Boolean(presentation.authorizedRecipient) }
      : null,
    candidates: candidates.map(c => ({ ...c, name: `${c.firstName} ${c.lastName}`, overrides: c.overrides as CandidateOverrides })),
    snapshots,
    releases
  };
}

export async function listPresentations(db: Executor, jobOrderId: string) {
  return db.selectFrom('presentations').select(['id', 'reference', 'title', 'status', 'latestSnapshotId', 'createdAt', 'updatedAt', 'version']).where('jobOrderId', '=', jobOrderId).orderBy('createdAt', 'desc').execute();
}

export async function updatePresentation(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { version: number; title?: string; coverNote?: string | null; recipientContactId?: string | null; candidates?: CandidateSelection[] }) {
  await deps.db.transaction().execute(async trx => {
    const current = await trx.selectFrom('presentations').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw notFound('Presentation');
    await jobInScope(trx, staff, current.jobOrderId);
    if (current.status === 'cancelled') throw unprocessable('This presentation was cancelled.', 'presentation_cancelled');
    if (input.recipientContactId) await assertRecipient(trx, current.familyId, input.recipientContactId, false);
    const { version, candidates, ...fields } = input;
    // Any edit to an approved or released presentation needs a fresh approval before sending again.
    await updateVersioned(trx, 'presentations', id, version, { ...fields, status: 'draft' }, 'Presentation');
    if (candidates) await replaceCandidates(trx, id, current.jobOrderId, candidates);
    await audit(trx, meta, { action: 'presentation.updated', subjectType: 'presentation', subjectId: id, metadata: { fields: Object.keys(fields), candidates: candidates?.length ?? null } });
  });
  return getPresentation(deps, deps.db, null, id);
}

async function sharingPermission(db: Executor, candidateId: string) {
  return db
    .selectFrom('consents')
    .select('id')
    .where('candidateId', '=', candidateId)
    .where('consentType', '=', 'presentation_sharing')
    .where('granted', '=', true)
    .where('withdrawnAt', 'is', null)
    .orderBy('occurredAt', 'desc')
    .executeTakeFirst();
}

/** What the snapshot would contain right now, with eligibility and blocking issues. */
export async function previewPresentation(deps: AppDeps, db: Executor, id: string) {
  const presentation = await getPresentation(deps, db, null, id);
  const settings = await getSettings(db);
  const now = deps.clock.now();
  const today = localDate(now, settings.timezone);
  const issues: Array<{ candidateId: string | null; code: string; message: string }> = [];
  if (!presentation.recipient) issues.push({ candidateId: null, code: 'recipient_missing', message: 'Choose the family contact who will receive the presentation.' });
  else if (!presentation.recipient.authorizedRecipient) issues.push({ candidateId: null, code: 'recipient_not_authorized', message: 'The chosen contact is not an authorized recipient.' });
  const candidates = [];
  for (const pc of presentation.candidates) {
    const content = await buildCandidateContent(db, { candidateId: pc.candidateId, jobCandidateId: pc.jobCandidateId, includedFields: pc.includedFields, overrides: pc.overrides, today });
    const eligibility = await evaluateEligibility(db, pc.candidateId, { now, timezone: settings.timezone, jobOrderId: presentation.jobOrderId });
    const consent = await sharingPermission(db, pc.candidateId);
    if (!eligibility.eligible) issues.push({ candidateId: pc.candidateId, code: 'eligibility_not_met', message: `${pc.name} does not meet the screening policy.` });
    if (!consent) issues.push({ candidateId: pc.candidateId, code: 'sharing_permission_missing', message: `${pc.name} has not given permission to share their profile.` });
    candidates.push({ presentationCandidateId: pc.id, candidateId: pc.candidateId, jobCandidateId: pc.jobCandidateId, includedFields: pc.includedFields, content, eligibility, sharingPermissionConsentId: consent?.id ?? null });
  }
  return { presentationId: id, asOfDate: today, ready: issues.length === 0, issues, candidates };
}

export async function approvePresentation(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { version: number }) {
  const presentation = await getPresentation(deps, deps.db, staff, id);
  if (presentation.status === 'cancelled') throw unprocessable('This presentation was cancelled.', 'presentation_cancelled');
  if (presentation.status === 'approved') throw unprocessable('Already approved. Edit it to create a new version.', 'already_approved');
  const preview = await previewPresentation(deps, deps.db, id);
  if (!preview.ready) throw unprocessable('The presentation cannot be approved yet.', 'presentation_not_ready', { issues: preview.issues });
  const settings = await getSettings(deps.db);

  // Render outside the transaction; the snapshot stores exactly what was rendered.
  const pdfCandidates = [];
  for (const candidate of preview.candidates) {
    let photo: Buffer | null = null;
    const photoId = candidate.content.photoDocumentId as string | null | undefined;
    if (photoId) {
      const document = await deps.db.selectFrom('documents').select(['storageKey', 'detectedType']).where('id', '=', photoId).executeTakeFirst();
      const bytes = document ? await deps.privateStorage.get(document.storageKey) : null;
      photo = bytes ? (document!.detectedType === 'jpg' ? stripJpegMetadata(bytes) : bytes) : null;
    }
    const { photoDocumentId: _photo, ...printable } = candidate.content;
    pdfCandidates.push({ content: printable, photo });
  }
  const approvedAt = meta.now.toISOString();
  const pdf = await renderPresentationPdf({
    agencyName: settings.agencyName,
    title: presentation.title,
    familyName: presentation.familyName,
    coverNote: presentation.coverNote,
    reference: presentation.reference,
    approvedAt,
    candidates: pdfCandidates
  });
  const storageKey = `private/presentations/${presentation.id}/${randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  await deps.privateStorage.put(storageKey, pdf, 'application/pdf');

  const snapshotId = await deps.db.transaction().execute(async trx => {
    const current = await trx.selectFrom('presentations').select(['version', 'status']).where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
    if (current.version !== input.version) {
      await deps.privateStorage.delete(storageKey).catch(() => {});
      await updateVersioned(trx, 'presentations', id, input.version, {}, 'Presentation');
    }
    const document = await trx
      .insertInto('documents')
      .values({
        documentType: 'presentation_pdf',
        originalFilename: `${presentation.reference}.pdf`,
        declaredContentType: 'application/pdf',
        detectedType: 'pdf',
        sizeBytes: pdf.length,
        storageKey,
        sha256: sha256(pdf),
        scanStatus: 'clean',
        scanDetail: 'Generated by the system',
        scannedAt: approvedAt,
        uploadedByType: 'system',
        createdAt: approvedAt
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const last = await trx.selectFrom('presentationSnapshots').select(eb => eb.fn.max('versionNumber').as('n')).where('presentationId', '=', id).executeTakeFirst();
    const content = { title: presentation.title, coverNote: presentation.coverNote, familyName: presentation.familyName, candidates: preview.candidates.map(c => ({ candidateId: c.candidateId, jobCandidateId: c.jobCandidateId, content: c.content })) };
    const snapshot = await trx
      .insertInto('presentationSnapshots')
      .values({
        presentationId: id,
        versionNumber: Number(last?.n ?? 0) + 1,
        content: JSON.stringify(content),
        contentSha256: sha256(canonicalJson(content)),
        fieldSelection: JSON.stringify(preview.candidates.map(c => ({ candidateId: c.candidateId, fields: c.includedFields }))),
        eligibility: JSON.stringify(preview.candidates.map(c => ({ candidateId: c.candidateId, eligible: c.eligibility.eligible, policyVersion: c.eligibility.policyVersion, overridden: c.eligibility.requirements.filter(r => r.status === 'overridden').map(r => r.key) }))),
        pdfDocumentId: document.id,
        pdfSha256: sha256(pdf),
        approvedBy: staff.staffId,
        approvedAt
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await updateVersioned(trx, 'presentations', id, input.version, { status: 'approved', latestSnapshotId: snapshot.id }, 'Presentation');
    for (const candidate of preview.candidates) {
      await trx.updateTable('presentationCandidates').set({ sharingPermissionConsentId: candidate.sharingPermissionConsentId }).where('id', '=', candidate.presentationCandidateId).execute();
      const jc = await trx.selectFrom('jobCandidates').select('stage').where('id', '=', candidate.jobCandidateId).executeTakeFirstOrThrow();
      if (jc.stage === 'shortlisted') await transitionJobCandidate(deps, meta, staff, candidate.jobCandidateId, { to: 'presentation_approved', reason: `Presentation ${presentation.reference} approved` }, { viaCommand: true, trx });
    }
    await audit(trx, meta, { action: 'presentation.approved', subjectType: 'presentation', subjectId: id, metadata: { snapshotId: snapshot.id, candidates: preview.candidates.length } });
    return snapshot.id;
  });
  return { snapshotId, presentation: await getPresentation(deps, deps.db, null, id) };
}

/** Releases the approved snapshot to the authorized recipient. Idempotent per key. */
export async function releasePresentation(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { snapshotId: string; recipientConfirmed: boolean; noRevocationAcknowledged: boolean }, idempotencyKey: string) {
  if (!input.recipientConfirmed || !input.noRevocationAcknowledged) {
    throw validationFailed([
      ...(input.recipientConfirmed ? [] : [{ path: 'recipientConfirmed', code: 'required', message: 'Confirm the recipient' }]),
      ...(input.noRevocationAcknowledged ? [] : [{ path: 'noRevocationAcknowledged', code: 'required', message: 'Acknowledge that a sent PDF cannot be recalled' }])
    ]);
  }
  const presentation = await getPresentation(deps, deps.db, staff, id);
  const settings = await getSettings(deps.db);
  const result = await runIdempotent(deps.db, { scope: `presentation-release:${id}`, key: idempotencyKey, request: input, now: meta.now }, async trx => {
    const current = await trx.selectFrom('presentations').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
    if (current.status !== 'approved' || current.latestSnapshotId !== input.snapshotId) {
      throw unprocessable('Only the latest approved version can be released. Approve the presentation again after any edit.', 'snapshot_not_releasable');
    }
    if (!current.recipientContactId) throw unprocessable('Choose the family contact who will receive the presentation.', 'recipient_missing');
    const contact = await assertRecipient(trx, current.familyId, current.recipientContactId, true);
    const snapshot = await trx.selectFrom('presentationSnapshots').selectAll().where('id', '=', input.snapshotId).executeTakeFirstOrThrow();
    const content = snapshot.content as { candidates: Array<{ candidateId: string; jobCandidateId: string }> };
    // Evidence can change or expire between approval and release: check again now.
    const eligibility = [];
    for (const candidate of content.candidates) {
      const result = await evaluateEligibility(trx, candidate.candidateId, { now: meta.now, timezone: settings.timezone, jobOrderId: current.jobOrderId });
      const consent = await sharingPermission(trx, candidate.candidateId);
      if (!result.eligible || !consent) {
        throw unprocessable('A candidate no longer meets the requirements for release.', 'eligibility_changed', { candidateId: candidate.candidateId, eligibility: result, sharingPermission: Boolean(consent) });
      }
      eligibility.push({ candidateId: candidate.candidateId, policyVersion: result.policyVersion, overridden: result.requirements.filter(r => r.status === 'overridden').map(r => r.key) });
    }
    const delivery = await createDelivery(trx, {
      idempotencyKey: `presentation_release:${id}:${input.snapshotId}:${contact.id}`,
      templateKey: 'family.presentation_delivery',
      recipient: { type: 'family_contact', id: contact.id, email: contact.email! },
      variables: {
        'contact.firstName': presentation.recipient?.name.split(' ')[0] ?? null,
        'family.displayName': presentation.familyName,
        'job.title': presentation.jobTitle,
        'presentation.reference': presentation.reference,
        'agency.name': settings.agencyName
      },
      attachments: [{ documentId: snapshot.pdfDocumentId!, filename: `${presentation.reference}.pdf` }],
      links: { familyId: current.familyId, familyContactId: contact.id, jobOrderId: current.jobOrderId },
      now: meta.now
    });
    const release = await trx
      .insertInto('presentationReleases')
      .values({
        presentationId: id,
        snapshotId: input.snapshotId,
        recipientContactId: contact.id,
        recipientEmail: contact.email!,
        releasedBy: staff.staffId,
        releasedAt: meta.now.toISOString(),
        recipientConfirmed: true,
        noRevocationAcknowledged: true,
        eligibility: JSON.stringify(eligibility),
        deliveryId: delivery.id
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await updateVersioned(trx, 'presentations', id, current.version, { status: 'released' }, 'Presentation');
    for (const candidate of content.candidates) {
      const jc = await trx.selectFrom('jobCandidates').select('stage').where('id', '=', candidate.jobCandidateId).executeTakeFirstOrThrow();
      if (jc.stage === 'presentation_approved') await transitionJobCandidate(deps, meta, staff, candidate.jobCandidateId, { to: 'presented', reason: `Presentation ${presentation.reference} released` }, { viaCommand: true, trx });
    }
    await audit(trx, meta, { action: 'presentation.released', subjectType: 'presentation', subjectId: id, metadata: { snapshotId: input.snapshotId, releaseId: release.id, recipientContactId: contact.id } });
    await emit(trx, meta, { type: 'presentation.released', subjectType: 'presentation', subjectId: id, payload: { releaseId: release.id, related: { presentation: id, family: current.familyId, job_order: current.jobOrderId } }, dedupeKey: `presentation.released:${release.id}` });
    return { status: 201, body: { releaseId: release.id, deliveryId: delivery.id } };
  });
  if (!result.replayed) await dispatchDeliveries(deps, { ids: [result.body.deliveryId] }).catch(error => deps.log.warn({ err: error }, 'Presentation email will be retried'));
  return result;
}

export async function cancelPresentation(deps: AppDeps, meta: RequestMeta, staff: StaffActor, id: string, input: { version: number; reason?: string }) {
  const presentation = await getPresentation(deps, deps.db, staff, id);
  if (presentation.status === 'released') throw unprocessable('A released presentation cannot be cancelled; the family already has it.', 'already_released');
  await updateVersioned(deps.db, 'presentations', id, input.version, { status: 'cancelled' }, 'Presentation');
  await audit(deps.db, meta, { action: 'presentation.cancelled', subjectType: 'presentation', subjectId: id, metadata: { reason: input.reason ?? null } });
}

export async function recordFamilyFeedback(deps: AppDeps, meta: RequestMeta, staff: StaffActor, jobCandidateId: string, input: { sentiment?: string | null; summary: string; familyContactId?: string | null; receivedAt?: string }) {
  const jc = await deps.db.selectFrom('jobCandidates as jc').innerJoin('jobOrders as j', 'j.id', 'jc.jobOrderId').select(['j.assignedStaffId', 'j.familyId']).where('jc.id', '=', jobCandidateId).executeTakeFirst();
  if (!jc) throw notFound('Job candidate');
  await assertInScope(deps.db, staff, jc.assignedStaffId);
  const row = await deps.db
    .insertInto('familyFeedback')
    .values({ jobCandidateId, sentiment: input.sentiment ?? null, summary: input.summary, familyContactId: input.familyContactId ?? null, receivedAt: input.receivedAt ?? meta.now.toISOString(), recordedBy: staff.staffId, createdAt: meta.now.toISOString() })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(deps.db, meta, { action: 'job_candidate.feedback_recorded', subjectType: 'job_candidate', subjectId: jobCandidateId, metadata: { sentiment: input.sentiment ?? null } });
  return row;
}
