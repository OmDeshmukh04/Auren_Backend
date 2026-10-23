import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestContext, expectOk, signedIn, uuid, type TestContext } from './helpers.js';
import { DAY } from '../src/lib/time.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx?.close();
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function lastEmail(to: string) {
  const message = ctx.email.to(to).at(-1);
  if (!message) throw new Error(`No email to ${to}`);
  return { token: decodeURIComponent(/token=([^\s]+)/.exec(message.text)![1]!), code: /code on the application page: (\d{6})/.exec(message.text)![1]!, text: message.text };
}

async function upload(client: Client, documentType: string, bytes: Buffer, contentType = 'application/pdf', fileName = 'resume.pdf') {
  const slot = expectOk(await client.post('/public/application-drafts/current/uploads', { documentType, fileName, contentType, sizeBytes: bytes.length }), 201);
  const path = new URL(slot.upload.url).pathname;
  expectOk(await client.request('PUT', path, bytes, { 'content-type': 'application/octet-stream' }));
  return expectOk(await client.post(`/public/application-drafts/current/uploads/${slot.document.id}/complete`));
}

const FULL = {
  contact: { firstName: 'Jordan', lastName: 'Applicant', phone: '720-555-0199', city: 'Denver', state: 'CO', contactMethods: ['email', 'phone'], preferredAreas: ['Cherry Creek'] },
  experience: { childcareYears: 9, professionalNannyYears: 6, ageGroups: ['newborn', 'infant', 'toddler'], maxChildrenCared: 3, privateHouseholdExperience: true, introduction: 'I love supporting families.' },
  employment: {
    entries: [
      { employerDescription: 'Private family, Denver', roleTitle: 'Nanny', startDate: '2021-01-04', isCurrent: true, ageGroups: ['infant'] },
      { employerDescription: 'Private family, Boulder', roleTitle: 'Nanny', startDate: '2018-03-01', endDate: '2020-12-18', departureReason: 'Children started school' }
    ]
  },
  qualifications: { educationLevel: 'bachelor', drivingEligible: true, certifications: [{ qualificationKey: 'cpr', expiresOn: '2027-04-01' }], languages: [{ languageCode: 'es', proficiency: 'fluent' }], skills: ['meal_preparation'] },
  preferences: { desiredServiceTypes: ['nanny'], desiredScheduleTypes: ['full_time'], availabilityStatus: 'available', availabilityWindows: [{ dayOfWeek: 1, start: '07:00', end: '18:00' }], compensation: { minMinor: 3000, maxMinor: 3600, currency: 'USD', period: 'hour' } },
  references: {
    entries: [
      { fullName: 'Reference One', relationship: 'employer_family', email: 'ref1@example.invalid', permissionToContact: true },
      { fullName: 'Reference Two', relationship: 'agency_supervisor', phone: '303-555-0111', permissionToContact: false }
    ]
  },
  acknowledgements: { accuracyAttestation: true, privacyNotice: true, referenceContactAuthorization: true, presentationSharing: true }
} as const;

describe('candidate application', () => {
  it('saves, resumes on another device, uploads, and submits exactly once', async () => {
    const email = `applicant.${uuid().slice(0, 6)}@example.invalid`;
    const deviceA = new Client(ctx.app);
    const started = expectOk(await deviceA.post('/public/application-drafts', { email, firstName: 'Jordan' }), 201);
    expect(started.emailVerified).toBe(false);
    expect(deviceA.cookie('auren_draft')).toBeTruthy();

    let revision = started.revision;
    const saved = expectOk(await deviceA.put('/public/application-drafts/current/sections/contact', { revision, data: FULL.contact }));
    revision = saved.revision;
    const blocked = await deviceA.post('/public/application-drafts/current/uploads', { documentType: 'resume', fileName: 'r.pdf', contentType: 'application/pdf', sizeBytes: 10 });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('email_not_verified');

    // Device B resumes with the emailed single-use link.
    const { token } = lastEmail(email);
    const deviceB = new Client(ctx.app);
    const resumed = expectOk(await deviceB.post('/public/application-drafts/resume', { token }));
    expect(resumed.emailVerified).toBe(true);
    expect(resumed.data.contact.city).toBe('Denver');
    expect((await new Client(ctx.app).post('/public/application-drafts/resume', { token })).status).toBe(401);

    // Concurrent tabs: the stale revision is refused rather than overwriting.
    expectOk(await deviceB.put('/public/application-drafts/current/sections/experience', { revision, data: FULL.experience }));
    const stale = await deviceA.put('/public/application-drafts/current/sections/experience', { revision, data: { childcareYears: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('revision_conflict');
    revision = stale.body.error.details.currentRevision;

    for (const section of ['employment', 'qualifications', 'preferences', 'references'] as const) {
      revision = expectOk(await deviceB.put(`/public/application-drafts/current/sections/${section}`, { revision, data: FULL[section] })).revision;
    }

    const clean = await upload(deviceB, 'resume', PDF);
    expect(clean.scanStatus).toBe('clean');
    const disguised = await upload(deviceB, 'resume', Buffer.from('<html><script>alert(1)</script></html>'), 'application/pdf', 'evil.pdf');
    expect(disguised.scanStatus).toBe('rejected');
    const infected = await upload(deviceB, 'certificate', Buffer.concat([PDF, Buffer.from(EICAR)]), 'application/pdf', 'cert.pdf');
    expect(infected.scanStatus).toBe('rejected');

    // Missing acknowledgements are reported by path.
    const incomplete = await deviceB.post('/public/application-drafts/current/submit', {}, { 'idempotency-key': uuid() });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error.fieldErrors.map((f: any) => f.path)).toContain('acknowledgements.accuracyAttestation');

    revision = expectOk(await deviceB.put('/public/application-drafts/current/sections/acknowledgements', { revision, data: FULL.acknowledgements })).revision;
    const key = uuid();
    const submits = await Promise.all([1, 2, 3].map(() => deviceB.post('/public/application-drafts/current/submit', {}, { 'idempotency-key': key })));
    expect(submits.map(s => s.status)).toEqual([201, 201, 201]);
    expect(new Set(submits.map(s => s.body.reference)).size).toBe(1);
    const again = await deviceB.post('/public/application-drafts/current/submit', {}, { 'idempotency-key': uuid() });
    expect(again.status).toBe(409);

    const applications = await ctx.deps.db.selectFrom('applications').innerJoin('candidates', 'candidates.id', 'applications.candidateId').select(['applications.id', 'candidates.id as candidateId']).where('candidates.email', '=', email).execute();
    expect(applications).toHaveLength(1);
    const candidateId = applications[0]!.candidateId;

    const { client: staff } = await signedIn(ctx, 'coordinator');
    const profile = expectOk(await staff.get(`/candidates/${candidateId}`));
    expect(profile.employments).toHaveLength(2);
    expect(profile.professionalNannyYears).toBe(6);
    expect(profile.qualifications[0].reviewState).toBe('pending_review');
    expect(profile.availabilityWindows).toEqual([{ dayOfWeek: 1, start: '07:00', end: '18:00' }]);
    const refs = await ctx.deps.db.selectFrom('candidateReferences').select(['fullName', 'permissionToContact', 'permissionConsentId']).where('candidateId', '=', candidateId).orderBy('fullName').execute();
    expect(refs.map(r => [r.fullName, r.permissionToContact, Boolean(r.permissionConsentId)])).toEqual([['Reference One', true, true], ['Reference Two', false, false]]);
    const docs = expectOk(await staff.get(`/candidates/${candidateId}/documents`)).items;
    expect(docs.filter((d: any) => d.scanStatus === 'clean')).toHaveLength(1);
    const consents = await ctx.deps.db.selectFrom('consents').select('consentType').where('candidateId', '=', candidateId).execute();
    expect(consents.map(c => c.consentType).sort()).toEqual(['accuracy_attestation', 'presentation_sharing', 'privacy_notice', 'reference_contact_authorization']);
    expect(await ctx.deps.db.selectFrom('outboxEvents').select('id').where('eventType', '=', 'application.submitted').where('subjectId', '=', applications[0]!.id).execute()).toHaveLength(1);

    // Staff download is audited and served as an attachment.
    const cleanDoc = docs.find((d: any) => d.scanStatus === 'clean');
    const link = expectOk(await staff.post(`/documents/${cleanDoc.id}/download-link`));
    const file = await new Client(ctx.app).get(new URL(link.url).pathname + new URL(link.url).search);
    expect(file.status).toBe(200);
    expect(String(file.headers['content-disposition'])).toContain('attachment');
    const auditRows = await ctx.deps.db.selectFrom('auditEvents').select('action').where('subjectId', '=', cleanDoc.id).execute();
    expect(auditRows.map(r => r.action)).toEqual(expect.arrayContaining(['document.download_link_issued', 'document.downloaded']));
  });

  it('never exposes another draft, expired links or other people\'s files', async () => {
    const a = new Client(ctx.app);
    const b = new Client(ctx.app);
    const emailA = `a.${uuid().slice(0, 6)}@example.invalid`;
    const emailB = `b.${uuid().slice(0, 6)}@example.invalid`;
    expectOk(await a.post('/public/application-drafts', { email: emailA, firstName: 'A' }), 201);
    expectOk(await b.post('/public/application-drafts', { email: emailB, firstName: 'B' }), 201);
    expectOk(await a.post('/public/application-drafts/current/verify', { code: lastEmail(emailA).code }));
    const aDoc = await upload(a, 'resume', PDF);

    expect((await b.post(`/public/application-drafts/current/uploads/${aDoc.id}/complete`)).status).toBe(404);
    expect((await b.request('PUT', `/public/application-drafts/current/uploads/${aDoc.id}/content`, PDF, { 'content-type': 'application/octet-stream' })).status).toBe(404);
    expect((await new Client(ctx.app).get('/public/application-drafts/current')).status).toBe(401);
    const forged = new Client(ctx.app);
    expect((await forged.get('/public/application-drafts/current', { cookie: 'auren_draft=forged-token-value' })).status).toBe(401);
    expect((await new Client(ctx.app).get(`/documents/${aDoc.id}/content?token=forged.token.value`)).status).toBe(401);

    // Resume links expire.
    const { token } = lastEmail(emailB);
    ctx.clock.advance(2 * DAY);
    expect((await new Client(ctx.app).post('/public/application-drafts/resume', { token })).status).toBe(401);
    ctx.clock.advance(-2 * DAY);

    // Requesting a link never reveals whether a draft exists.
    const known = await new Client(ctx.app).post('/public/application-drafts/resume-link', { email: emailA });
    const unknown = await new Client(ctx.app).post('/public/application-drafts/resume-link', { email: `nobody.${uuid().slice(0, 6)}@example.invalid` });
    expect([known.status, unknown.status]).toEqual([202, 202]);
    expect(known.body).toEqual(unknown.body);

    // Wrong codes are limited.
    for (let i = 0; i < 5; i++) await b.post('/public/application-drafts/current/verify', { code: '000000' });
    expect((await b.post('/public/application-drafts/current/verify', { code: lastEmail(emailB).code })).body.error.code).toBe('code_expired');
  });
});
