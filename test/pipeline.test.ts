import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, activateSeedPolicy, createTestContext, expectOk, signedIn, uuid, type TestContext } from './helpers.js';
import { DAY } from '../src/lib/time.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
  await activateSeedPolicy(ctx);
});
afterAll(async () => {
  await ctx?.close();
});

/** Takes a candidate through every requirement of the seeded policy. */
async function screenFully(client: Client, candidateId: string) {
  let candidate = expectOk(await client.get(`/candidates/${candidateId}`));
  // Current verified CPR and First Aid.
  for (const key of ['cpr', 'first_aid']) {
    candidate = expectOk(await client.post(`/candidates/${candidateId}/qualifications`, { version: candidate.version, qualification: { qualificationKey: key, expiresOn: '2027-09-30' } }), 201);
    const q = candidate.qualifications.find((x: any) => x.qualificationKey === key);
    candidate = expectOk(await client.post(`/candidates/${candidateId}/qualifications/${q.id}/review`, { decision: 'verified', qualificationVersion: q.version }));
  }
  // Interview: scheduling alone does not count.
  const { id: interviewId } = expectOk(await client.post(`/candidates/${candidateId}/interviews`, { method: 'video', startsAt: '2026-10-23T16:00:00.000Z', endsAt: '2026-10-23T17:00:00.000Z' }), 201);
  let eligibility = expectOk(await client.get(`/candidates/${candidateId}/eligibility`));
  expect(eligibility.requirements.find((r: any) => r.key === 'interview_general').status).toBe('not_met');
  const interview = expectOk(await client.get(`/candidates/${candidateId}/interviews`)).items[0];
  expect((await client.put(`/interviews/${interviewId}/evaluation`, { recommendation: 'advance' })).status).toBe(422);
  expectOk(await client.post(`/interviews/${interviewId}/complete`, { version: interview.version }));
  expectOk(await client.put(`/interviews/${interviewId}/evaluation`, { recommendation: 'advance', strengths: 'Calm and organised' }));
  // Two satisfactory references (permission required before outreach).
  for (let i = 0; i < 2; i++) {
    const { id: refId } = expectOk(await client.post(`/candidates/${candidateId}/references`, { fullName: `Ref ${i}`, relationship: 'employer_family', email: `ref${i}.${uuid().slice(0, 4)}@example.invalid`, permissionToContact: false }), 201);
    let ref = expectOk(await client.get(`/candidates/${candidateId}/references`)).items.find((r: any) => r.id === refId);
    const blocked = await client.post(`/references/${refId}/start-outreach`, { version: ref.version });
    expect(blocked.body.error.code).toBe('reference_permission_required');
    expectOk(await client.post(`/references/${refId}/permission`, { granted: true, evidence: 'Signed authorization form', version: ref.version }));
    ref = expectOk(await client.get(`/candidates/${candidateId}/references`)).items.find((r: any) => r.id === refId);
    expectOk(await client.post(`/references/${refId}/start-outreach`, { version: ref.version }));
    expectOk(await client.post(`/references/${refId}/attempts`, { method: 'phone', outcome: 'spoke' }), 201);
    expectOk(await client.put(`/references/${refId}/evaluation`, { recommendation: 'positive', concerns: 'CONFIDENTIAL-REFERENCE-NOTE' }));
    ref = expectOk(await client.get(`/candidates/${candidateId}/references`)).items.find((r: any) => r.id === refId);
    expectOk(await client.post(`/references/${refId}/close`, { status: 'completed', reviewOutcome: 'satisfactory', version: ref.version }));
  }
  // Background check: a provider "clear" alone is not enough; the agency review is.
  const { id: checkId } = expectOk(await client.post(`/candidates/${candidateId}/checks`, { checkTypeKey: 'background_check', provider: 'ExampleScreen' }), 201);
  let check = expectOk(await client.get(`/candidates/${candidateId}/checks`)).items[0];
  expect((await client.post(`/checks/${checkId}/status`, { to: 'requested', version: check.version })).body.error.code).toBe('authorization_required');
  expectOk(await client.post(`/checks/${checkId}/authorization`, { authorizationReference: 'AUTH-123', method: 'provider_portal', version: check.version }));
  check = expectOk(await client.get(`/candidates/${candidateId}/checks`)).items[0];
  expectOk(await client.post(`/checks/${checkId}/status`, { to: 'requested', version: check.version }));
  check = expectOk(await client.get(`/candidates/${candidateId}/checks`)).items[0];
  expectOk(await client.post(`/checks/${checkId}/status`, { to: 'completed', resultCategory: 'clear', version: check.version }));
  eligibility = expectOk(await client.get(`/candidates/${candidateId}/eligibility`));
  expect(eligibility.requirements.find((r: any) => r.key === 'background_check').status).toBe('not_met');
  check = expectOk(await client.get(`/candidates/${candidateId}/checks`)).items[0];
  expectOk(await client.post(`/checks/${checkId}/review`, { outcome: 'acceptable', version: check.version }));
  return expectOk(await client.get(`/candidates/${candidateId}/eligibility`));
}

describe('screening -> presentation -> placement', () => {
  it('gates presentations on eligibility and sharing permission, releases only the snapshot, then places', async () => {
    const { client } = await signedIn(ctx, 'coordinator');
    const { client: owner } = await signedIn(ctx, 'owner');
    const family = expectOk(await client.post('/families', { displayName: 'Pipeline family', primaryContact: { firstName: 'Morgan', email: `morgan.${uuid().slice(0, 6)}@example.invalid`, authorizedRecipient: false } }), 201);
    const contact = family.contacts[0];
    const job = expectOk(await client.post('/jobs', { familyId: family.id, title: 'Infant nanny' }), 201);
    expectOk(await client.post(`/jobs/${job.id}/transition`, { to: 'open', version: job.version }));
    const candidate = expectOk(await client.post('/candidates', { firstName: 'Riley', lastName: 'Pipeline', email: `riley.${uuid().slice(0, 6)}@example.invalid`, phone: '303-555-0142', city: 'Denver', introduction: 'Experienced with infants.', professionalNannyYears: 7, childcareYears: 10 }), 201);
    const jc = expectOk(await client.post(`/jobs/${job.id}/candidates`, { candidateId: candidate.id, rationale: 'Ideal infant experience' }), 201);

    const presentation = expectOk(await client.post(`/jobs/${job.id}/presentations`, { recipientContactId: contact.id, candidates: [{ jobCandidateId: jc.id }] }), 201);
    let preview = expectOk(await client.get(`/presentations/${presentation.id}/preview`));
    expect(preview.ready).toBe(false);
    expect(preview.issues.map((i: any) => i.code).sort()).toEqual(['eligibility_not_met', 'recipient_not_authorized', 'sharing_permission_missing']);
    expect((await client.post(`/presentations/${presentation.id}/approve`, { version: presentation.version })).body.error.code).toBe('presentation_not_ready');

    const eligibility = await screenFully(client, candidate.id);
    expect(eligibility.eligible).toBe(true);
    // Sharing permission recorded through a consent (from the application form in real use).
    await ctx.deps.db.insertInto('consents').values({ consentType: 'presentation_sharing', candidateId: candidate.id, granted: true, recordedByType: 'staff', recordedByStaffId: (await ctx.deps.db.selectFrom('staffMembers').select('id').where('role', '=', 'owner').executeTakeFirstOrThrow()).id, evidence: '{}' }).execute();
    const freshContact = expectOk(await client.get(`/families/${family.id}`)).contacts[0];
    expectOk(await client.patch(`/families/${family.id}/contacts/${contact.id}`, { version: freshContact.version, authorizedRecipient: true }));

    preview = expectOk(await client.get(`/presentations/${presentation.id}/preview`));
    expect(preview.ready).toBe(true);
    const serialized = JSON.stringify(preview.candidates[0].content);
    for (const secret of [candidate.email, '303-555-0142', 'CONFIDENTIAL-REFERENCE-NOTE', 'Pipeline']) expect(serialized).not.toContain(secret);
    expect(preview.candidates[0].content.displayName).toBe('Riley P.');

    const current = expectOk(await client.get(`/presentations/${presentation.id}`));
    const approved = expectOk(await client.post(`/presentations/${presentation.id}/approve`, { version: current.version }));
    expect(approved.presentation.status).toBe('approved');
    expect(expectOk(await client.get(`/job-candidates/${jc.id}`)).stage).toBe('presentation_approved');

    // Profile edits after approval do not change the frozen snapshot.
    const latest = expectOk(await client.get(`/candidates/${candidate.id}`));
    expectOk(await client.patch(`/candidates/${candidate.id}`, { version: latest.version, introduction: 'CHANGED AFTER APPROVAL' }));
    const snapshot = await ctx.deps.db.selectFrom('presentationSnapshots').select(['content']).where('id', '=', approved.snapshotId).executeTakeFirstOrThrow();
    expect(JSON.stringify(snapshot.content)).not.toContain('CHANGED AFTER APPROVAL');

    const missingAck = await client.post(`/presentations/${presentation.id}/release`, { snapshotId: approved.snapshotId, recipientConfirmed: true, noRevocationAcknowledged: false }, { 'idempotency-key': uuid() });
    expect(missingAck.status).toBe(422);
    const key = uuid();
    const releases = await Promise.all([1, 2].map(() => client.post(`/presentations/${presentation.id}/release`, { snapshotId: approved.snapshotId, recipientConfirmed: true, noRevocationAcknowledged: true }, { 'idempotency-key': key })));
    expect(releases.map(r => r.status)).toEqual([201, 201]);
    expect(new Set(releases.map(r => r.body.releaseId)).size).toBe(1);
    const sent = ctx.email.to(contact.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments?.[0]?.filename).toMatch(/\.pdf$/);
    const pdfText = sent[0]!.attachments![0]!.content.toString('latin1');
    expect(pdfText).not.toContain(candidate.email);
    expect(pdfText).not.toContain('CHANGED AFTER APPROVAL');
    expect(expectOk(await client.get(`/job-candidates/${jc.id}`)).stage).toBe('presented');

    // Offer -> accepted -> placement.
    let association = expectOk(await client.get(`/job-candidates/${jc.id}`));
    const offer = expectOk(await client.post(`/job-candidates/${jc.id}/offers`, { version: association.version, compensation: { amountMinor: 3400, currency: 'USD', period: 'hour' }, proposedStartDate: '2026-11-30' }), 201);
    expectOk(await client.post(`/offers/${offer.id}/respond`, { outcome: 'accepted', version: offer.version }));
    association = expectOk(await client.get(`/job-candidates/${jc.id}`));
    expect(association.stage).toBe('accepted');
    const placement = expectOk(await client.post('/placements', { jobCandidateId: jc.id, jobCandidateVersion: association.version, agreedStartDate: '2026-11-30', fee: { amountMinor: 1500000, currency: 'USD' }, guaranteeEndsOn: '2027-02-28' }), 201);
    expect(placement.status).toBe('booked');
    expect(expectOk(await client.get(`/jobs/${job.id}`)).status).toBe('filled');
    expect(expectOk(await client.get(`/job-candidates/${jc.id}`)).stage).toBe('placed');
    // Coordinators cannot record finance; finance viewers can read the placement.
    const { client: finance } = await signedIn(ctx, 'finance_viewer');
    expect(expectOk(await finance.get(`/placements/${placement.id}`)).fee.amountMinor).toBe(1500000);
    expect(owner).toBeTruthy();
  });

  it('blocks release when evidence expires after approval and honours scoped overrides', async () => {
    const { client } = await signedIn(ctx, 'coordinator');
    const { client: owner } = await signedIn(ctx, 'owner');
    const family = expectOk(await client.post('/families', { displayName: 'Expiry family', primaryContact: { firstName: 'Quinn', email: `quinn.${uuid().slice(0, 6)}@example.invalid`, authorizedRecipient: true } }), 201);
    const job = expectOk(await client.post('/jobs', { familyId: family.id, title: 'Weekend nanny' }), 201);
    const candidate = expectOk(await client.post('/candidates', { firstName: 'Sky', lastName: 'Expiry', email: `sky.${uuid().slice(0, 6)}@example.invalid` }), 201);
    await screenFully(client, candidate.id);
    await ctx.deps.db.insertInto('consents').values({ consentType: 'presentation_sharing', candidateId: candidate.id, granted: true, recordedByType: 'applicant', evidence: '{}' }).execute();
    const jc = expectOk(await client.post(`/jobs/${job.id}/candidates`, { candidateId: candidate.id }), 201);
    const presentation = expectOk(await client.post(`/jobs/${job.id}/presentations`, { recipientContactId: family.contacts[0].id, candidates: [{ jobCandidateId: jc.id }] }), 201);
    const approved = expectOk(await client.post(`/presentations/${presentation.id}/approve`, { version: presentation.version }));

    // The CPR expires before release.
    await ctx.deps.db.updateTable('candidateQualifications').set({ expiresOn: '2026-10-22' }).where('candidateId', '=', candidate.id).where('qualificationKey', '=', 'cpr').execute();
    ctx.clock.advance(1 * DAY);
    const blocked = await client.post(`/presentations/${presentation.id}/release`, { snapshotId: approved.snapshotId, recipientConfirmed: true, noRevocationAcknowledged: true }, { 'idempotency-key': uuid() });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('eligibility_changed');

    // Coordinators cannot override; the owner can, with a reason, scoped to this job.
    const reason = 'Renewal class booked for next week; family informed.';
    expect((await client.post(`/candidates/${candidate.id}/eligibility-overrides`, { requirementKey: 'cpr_current', jobOrderId: job.id, reason })).status).toBe(403);
    expectOk(await owner.post(`/candidates/${candidate.id}/eligibility-overrides`, { requirementKey: 'cpr_current', jobOrderId: job.id, reason }), 201);
    const forJob = expectOk(await client.get(`/candidates/${candidate.id}/eligibility?jobOrderId=${job.id}`));
    expect(forJob.eligible).toBe(true);
    expect(forJob.requirements.find((r: any) => r.key === 'cpr_current').status).toBe('overridden');
    const elsewhere = expectOk(await client.get(`/candidates/${candidate.id}/eligibility`));
    expect(elsewhere.eligible).toBe(false);
    const released = await client.post(`/presentations/${presentation.id}/release`, { snapshotId: approved.snapshotId, recipientConfirmed: true, noRevocationAcknowledged: true }, { 'idempotency-key': uuid() });
    expect(released.status).toBe(201);
    ctx.clock.advance(-1 * DAY);
  });
});
