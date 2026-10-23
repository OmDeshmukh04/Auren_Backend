import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestContext, expectOk, signedIn, uuid, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx?.close();
});

const enquiryBody = (email: string) => ({
  contact: { firstName: 'Sam', lastName: 'Rivera', email, phone: '303-555-0101' },
  household: { city: 'Denver', state: 'CO', childrenCount: 1, childrenAgeBands: ['infant'] },
  role: { serviceTypeKey: 'nanny', scheduleTypes: ['full_time'] },
  consents: { privacyNotice: true }
});

describe('auth', () => {
  it('signs in, reports the session and signs out', async () => {
    const { client } = await signedIn(ctx, 'owner');
    const session = expectOk(await client.get('/auth/session'));
    expect(session.authenticated).toBe(true);
    expect(session.staff.role).toBe('owner');
    expectOk(await client.post('/auth/sign-out'));
    expect((await client.get('/auth/session')).body.authenticated).toBe(false);
    expect((await client.get('/families')).status).toBe(401);
  });

  it('rejects wrong passwords with a generic error', async () => {
    const { email } = await signedIn(ctx, 'coordinator');
    const response = await new Client(ctx.app).post('/auth/sign-in', { email, password: 'not-the-password-123' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_email_or_password');
  });

  it('refuses mutations from an unlisted origin', async () => {
    const { client } = await signedIn(ctx, 'owner');
    const evil = new Client(ctx.app, 'https://evil.example');
    const response = await evil.post('/auth/sign-in', { email: 'x@example.invalid', password: 'whatever-123456' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('origin_not_allowed');
    expect(client).toBeTruthy();
  });

  it('invites a coordinator who accepts and signs in', async () => {
    const { client } = await signedIn(ctx, 'owner');
    const email = `invitee.${uuid().slice(0, 6)}@example.invalid`;
    expectOk(await client.post('/staff/invitations', { email, displayName: 'New Coordinator', role: 'coordinator' }), 201);
    const message = ctx.email.to(email).at(-1)!;
    const token = decodeURIComponent(/token=([^\s]+)/.exec(message.text)![1]!);
    const anon = new Client(ctx.app);
    expect(expectOk(await anon.get(`/auth/invitations/${token}`)).role).toBe('coordinator');
    expectOk(await anon.post('/auth/invitations/accept', { token, password: 'another-long-password' }), 201);
    expect((await anon.post('/auth/invitations/accept', { token, password: 'another-long-password' })).status).toBe(422);
    const signIn = expectOk(await anon.post('/auth/sign-in', { email, password: 'another-long-password' }));
    expect(signIn.session.staff.role).toBe('coordinator');
  });

  it('keeps at least one active owner', async () => {
    const { client, staffId } = await signedIn(ctx, 'owner');
    const others = await ctx.deps.db.selectFrom('staffMembers').select('id').where('role', '=', 'owner').where('id', '<>', staffId).execute();
    for (const other of others) await ctx.deps.db.updateTable('staffMembers').set({ status: 'suspended' }).where('id', '=', other.id).execute();
    const me = expectOk(await client.get('/staff')).items.find((s: any) => s.id === staffId);
    const response = await client.patch(`/staff/${staffId}`, { version: me.version, role: 'coordinator' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('last_owner');
    for (const other of others) await ctx.deps.db.updateTable('staffMembers').set({ status: 'active' }).where('id', '=', other.id).execute();
  });
});

describe('role permissions', () => {
  it('denies applicant and family data to content editors and finance viewers', async () => {
    const { client: editor } = await signedIn(ctx, 'content_editor');
    const { client: finance } = await signedIn(ctx, 'finance_viewer');
    for (const path of ['/families', '/candidates', '/enquiries', '/jobs']) {
      expect((await editor.get(path)).status).toBe(403);
      expect((await finance.get(path)).status).toBe(403);
    }
    expect((await finance.get('/placements')).status).toBe(200);
    expect((await editor.patch('/settings', { version: 1, agencyName: 'X' })).status).toBe(403);
  });

  it('lets coordinators work records but not manage staff or settings', async () => {
    const { client } = await signedIn(ctx, 'coordinator');
    expect((await client.get('/candidates')).status).toBe(200);
    expect((await client.post('/staff/invitations', { email: 'a@example.invalid', displayName: 'A', role: 'owner' })).status).toBe(403);
    expect((await client.patch('/settings', { version: 1, agencyName: 'X' })).status).toBe(403);
  });
});

describe('public family enquiry', () => {
  it('saves once per idempotency key and never reveals existing emails', async () => {
    const anon = new Client(ctx.app);
    const key = uuid();
    const email = `family.${uuid().slice(0, 6)}@example.invalid`;
    const first = await anon.post('/public/enquiries', enquiryBody(email), { 'idempotency-key': key });
    expect(first.status).toBe(202);
    const replay = await anon.post('/public/enquiries', enquiryBody(email), { 'idempotency-key': key });
    expect(replay.status).toBe(202);
    expect(replay.body.reference).toBe(first.body.reference);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const reused = await anon.post('/public/enquiries', { ...enquiryBody(email), role: { scheduleTypes: [] } }, { 'idempotency-key': key });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('idempotency_key_reused');

    const second = await anon.post('/public/enquiries', enquiryBody(email), { 'idempotency-key': uuid() });
    expect(second.status).toBe(202);
    expect(Object.keys(second.body).sort()).toEqual(Object.keys(first.body).sort());

    const { client } = await signedIn(ctx, 'coordinator');
    const list = expectOk(await client.get(`/enquiries?q=${encodeURIComponent(email)}`));
    expect(list.total).toBe(2);
    expect(list.items.every((item: any) => item.possibleDuplicate)).toBe(true);
    const outbox = await ctx.deps.db.selectFrom('outboxEvents').select('eventType').where('eventType', '=', 'enquiry.submitted').execute();
    expect(outbox.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts concurrent duplicates exactly once', async () => {
    const anon = new Client(ctx.app);
    const key = uuid();
    const email = `race.${uuid().slice(0, 6)}@example.invalid`;
    const results = await Promise.all([1, 2, 3].map(() => anon.post('/public/enquiries', enquiryBody(email), { 'idempotency-key': key })));
    expect(new Set(results.map(r => r.body.reference)).size).toBe(1);
    const rows = await ctx.deps.db.selectFrom('familyContacts').select('id').where('email', '=', email).execute();
    expect(rows).toHaveLength(1);
  });

  it('returns structured field errors and requires the privacy acknowledgement', async () => {
    const anon = new Client(ctx.app);
    const response = await anon.post('/public/enquiries', { ...enquiryBody('x@example.invalid'), consents: { privacyNotice: false } }, { 'idempotency-key': uuid() });
    expect(response.status).toBe(422);
    expect(response.body.error.fieldErrors.map((f: any) => f.path)).toContain('consents.privacyNotice');
  });

  it('drops honeypot submissions silently', async () => {
    const anon = new Client(ctx.app);
    const email = `bot.${uuid().slice(0, 6)}@example.invalid`;
    const response = await anon.post('/public/enquiries', { ...enquiryBody(email), website: 'http://spam' }, { 'idempotency-key': uuid() });
    expect(response.status).toBe(202);
    expect(await ctx.deps.db.selectFrom('familyContacts').select('id').where('email', '=', email).execute()).toHaveLength(0);
  });
});

async function createCandidate(client: Client, overrides: Record<string, unknown> = {}) {
  return expectOk(
    await client.post('/candidates', {
      firstName: 'Casey',
      lastName: `Test${uuid().slice(0, 4)}`,
      email: `cand.${uuid().slice(0, 8)}@example.invalid`,
      city: 'Denver',
      state: 'CO',
      professionalNannyYears: 6,
      ageGroups: ['infant', 'toddler'],
      desiredScheduleTypes: ['full_time'],
      ...overrides
    }),
    201
  );
}

async function addVerifiedQualification(client: Client, candidate: any, key: string, expiresOn: string | null) {
  let detail = expectOk(await client.post(`/candidates/${candidate.id}/qualifications`, { version: candidate.version, qualification: { qualificationKey: key, expiresOn } }), 201);
  const qualification = detail.qualifications.find((q: any) => q.qualificationKey === key && q.reviewState === 'pending_review');
  const review = await client.post(`/candidates/${candidate.id}/qualifications/${qualification.id}/review`, { decision: 'verified', qualificationVersion: qualification.version });
  if (review.status === 200) detail = review.body;
  return { detail, review };
}

describe('candidate search and gates', () => {
  it('finds Denver + 5 professional years + infant + current CPR and First Aid + full time, excluding unknown or expired', async () => {
    const { client } = await signedIn(ctx, 'coordinator');
    const tag = uuid().slice(0, 6);
    const match = await createCandidate(client, { lastName: `Match${tag}` });
    let m = (await addVerifiedQualification(client, match, 'cpr', '2027-05-01')).detail;
    m = (await addVerifiedQualification(client, m, 'first_aid', '2027-05-01')).detail;

    const combined = await createCandidate(client, { lastName: `Combined${tag}` });
    await addVerifiedQualification(client, combined, 'pediatric_cpr_first_aid', '2027-01-01');

    const expired = await createCandidate(client, { lastName: `Expired${tag}` });
    let e = (await addVerifiedQualification(client, expired, 'cpr', '2026-10-21')).detail;
    e = (await addVerifiedQualification(client, e, 'first_aid', '2027-05-01')).detail;

    const undated = await createCandidate(client, { lastName: `Undated${tag}` });
    const undatedReview = await addVerifiedQualification(client, undated, 'cpr', null);
    expect(undatedReview.review.status).toBe(422);

    const unknownYears = await createCandidate(client, { lastName: `Unknown${tag}`, professionalNannyYears: null });
    let u = (await addVerifiedQualification(client, unknownYears, 'cpr', '2027-05-01')).detail;
    u = (await addVerifiedQualification(client, u, 'first_aid', '2027-05-01')).detail;

    await createCandidate(client, { lastName: `Boulder${tag}`, city: 'Boulder' });
    await createCandidate(client, { lastName: `Four${tag}`, professionalNannyYears: 4.9 });
    await createCandidate(client, { lastName: `Exactly${tag}`, professionalNannyYears: 5 }).then(async c => {
      const a = (await addVerifiedQualification(client, c, 'cpr', '2026-10-22')).detail;
      await addVerifiedQualification(client, a, 'first_aid', '2026-10-22');
    });

    const result = expectOk(
      await client.post('/candidates/search', {
        criteria: {
          text: tag,
          location: { cities: ['Denver'] },
          minProfessionalNannyYears: 5,
          ageGroups: { values: ['infant'] },
          qualificationGroups: [['cpr', 'pediatric_cpr_first_aid'], ['first_aid', 'pediatric_cpr_first_aid']],
          scheduleTypes: { values: ['full_time'] }
        },
        pageSize: 50
      })
    );
    const names = result.items.map((item: any) => item.lastName).sort();
    expect(names).toEqual([`Combined${tag}`, `Exactly${tag}`, `Match${tag}`].sort());
  });

  it('detects concurrent edits with a version conflict', async () => {
    const { client } = await signedIn(ctx, 'coordinator');
    const candidate = await createCandidate(client);
    expectOk(await client.patch(`/candidates/${candidate.id}`, { version: candidate.version, city: 'Lakewood' }));
    const stale = await client.patch(`/candidates/${candidate.id}`, { version: candidate.version, city: 'Arvada' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.details.currentVersion).toBe(candidate.version + 1);
  });

  it('blocks the eligible stage without a passing policy', async () => {
    const { client } = await signedIn(ctx, 'coordinator');
    const candidate = await createCandidate(client);
    const review = expectOk(await client.post(`/candidates/${candidate.id}/transition`, { to: 'review', version: candidate.version }));
    const response = await client.post(`/candidates/${candidate.id}/transition`, { to: 'eligible', version: review.version });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('eligibility_not_met');
  });
});

describe('jobs', () => {
  it('keeps candidate-job associations independent and families with several jobs', async () => {
    const { client } = await signedIn(ctx, 'coordinator');
    const family = expectOk(await client.post('/families', { displayName: 'Two Roles family', primaryContact: { firstName: 'Pat', email: `pat.${uuid().slice(0, 6)}@example.invalid` } }), 201);
    const jobA = expectOk(await client.post('/jobs', { familyId: family.id, title: 'Weekday nanny' }), 201);
    const jobB = expectOk(await client.post('/jobs', { familyId: family.id, title: 'Weekend sitter' }), 201);
    const candidate = await createCandidate(client);
    const onA = expectOk(await client.post(`/jobs/${jobA.id}/candidates`, { candidateId: candidate.id }), 201);
    const onB = expectOk(await client.post(`/jobs/${jobB.id}/candidates`, { candidateId: candidate.id }), 201);
    expect((await client.post(`/jobs/${jobA.id}/candidates`, { candidateId: candidate.id })).status).toBe(409);
    expectOk(await client.post(`/job-candidates/${onA.id}/transition`, { to: 'withdrawn', version: onA.version }));
    const b = expectOk(await client.get(`/job-candidates/${onB.id}`));
    expect(b.stage).toBe('shortlisted');
    const detail = expectOk(await client.get(`/candidates/${candidate.id}`));
    expect(detail.recruitmentStage).toBe('received');
    const jobs = expectOk(await client.get(`/jobs?familyId=${family.id}`));
    expect(jobs.total).toBe(2);
    const direct = await client.post(`/job-candidates/${onB.id}/transition`, { to: 'presented', version: b.version });
    expect(direct.body.error.code).toBe('stage_requires_command');
  });
});
