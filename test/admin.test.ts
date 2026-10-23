import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestContext, expectOk, signedIn, uuid, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx?.close();
});

describe('website content', () => {
  it('keeps drafts private, publishes, previews with a token and restores old revisions', async () => {
    const { client: editor } = await signedIn(ctx, 'content_editor');
    const slug = `about-${uuid().slice(0, 6)}`;
    const created = expectOk(await editor.post('/content/entries', { collection: 'page', slug, title: 'About us', data: { blocks: [{ type: 'hero', heading: 'Original heading' }] } }), 201);
    const anon = new Client(ctx.app);
    expect((await anon.get(`/public/content/page/by-slug?slug=${slug}`)).status).toBe(404);
    const unsafe = await editor.post(`/content/entries/${created.id}/revisions`, { baseRevisionId: created.latestRevisionId, title: 'About', data: { blocks: [{ type: 'cta', heading: 'x', button: { label: 'Go', href: 'javascript:alert(1)' } }] } });
    expect(unsafe.status).toBe(422);
    expectOk(await editor.post(`/content/entries/${created.id}/publish`, {}));
    expect(expectOk(await anon.get(`/public/content/page/by-slug?slug=${slug}`)).data.blocks[0].heading).toBe('Original heading');

    const edited = expectOk(await editor.post(`/content/entries/${created.id}/revisions`, { baseRevisionId: created.latestRevisionId, title: 'About us', data: { blocks: [{ type: 'hero', heading: 'Updated heading' }] } }), 201);
    expect(edited.hasUnpublishedChanges).toBe(true);
    const stale = await editor.post(`/content/entries/${created.id}/revisions`, { baseRevisionId: created.latestRevisionId, title: 'x', data: { blocks: [] } });
    expect(stale.body.error.code).toBe('revision_conflict');
    expect(expectOk(await anon.get(`/public/content/page/by-slug?slug=${slug}`)).data.blocks[0].heading).toBe('Original heading');
    const { token } = expectOk(await editor.post(`/content/entries/${created.id}/preview-link`, {}));
    const preview = expectOk(await anon.get(`/public/content/page/by-slug?slug=${slug}&preview=${encodeURIComponent(token)}`));
    expect(preview.data.blocks[0].heading).toBe('Updated heading');
    expect((await anon.get(`/public/content/page/by-slug?slug=${slug}&preview=forged.token`)).status).toBe(401);

    expectOk(await editor.post(`/content/entries/${created.id}/publish`, {}));
    expectOk(await editor.post(`/content/entries/${created.id}/restore`, { revisionId: created.latestRevisionId }));
    expectOk(await editor.post(`/content/entries/${created.id}/publish`, {}));
    expect(expectOk(await anon.get(`/public/content/page/by-slug?slug=${slug}`)).data.blocks[0].heading).toBe('Original heading');
    const detail = expectOk(await editor.get(`/content/entries/${created.id}`));
    expect(detail.revisions).toHaveLength(3);
    expect(detail.publishHistory.map((h: any) => h.action)).toEqual(['published', 'restored', 'published', 'published']);
    // Content editors never see applicant or family data.
    expect((await editor.get('/candidates')).status).toBe(403);
  });

  it('validates media uploads by content and refuses SVG', async () => {
    const { client } = await signedIn(ctx, 'content_editor');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const slot = expectOk(await client.post('/media', { fileName: 'logo.png', contentType: 'image/png', sizeBytes: svg.length, altText: 'Logo' }), 201);
    expectOk(await client.request('PUT', new URL(slot.upload.url).pathname, svg, { 'content-type': 'application/octet-stream' }));
    expect((await client.post(`/media/${slot.media.id}/complete`)).body.error.code).toBe('invalid_media');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32]), Buffer.alloc(32)]);
    const good = expectOk(await client.post('/media', { fileName: 'hero.png', contentType: 'image/png', sizeBytes: png.length, altText: 'Nanny reading' }), 201);
    expectOk(await client.request('PUT', new URL(good.upload.url).pathname, png, { 'content-type': 'application/octet-stream' }));
    const ready = expectOk(await client.post(`/media/${good.media.id}/complete`));
    expect([ready.status, ready.width, ready.height]).toEqual(['ready', 64, 32]);
    const served = await new Client(ctx.app).get(new URL(ready.publicUrl).pathname);
    expect(served.status).toBe(200);
  });
});

describe('form editor', () => {
  it('freezes question definitions into a published version and protects keys and used options', async () => {
    const { client } = await signedIn(ctx, 'owner');
    const key = `pets_${uuid().slice(0, 4)}`;
    const q = expectOk(await client.post('/questions', { key, scope: 'candidate_application', answerType: 'single_choice', label: 'Comfortable with pets?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], filterable: true }), 201);
    const versions = expectOk(await client.get('/forms/candidate_application/versions')).items;
    const current = versions.find((v: any) => v.status === 'published');
    const layout = { ...current.layout, sections: current.layout.sections.map((s: any) => ({ key: s.key, title: s.title, core: s.core, questions: s.key === 'additional' ? [{ key, required: true }] : s.questions.map((x: any) => ({ key: x.key, required: x.required })) })) };
    const dropCore = await client.put('/forms/candidate_application/draft', { layout: { ...layout, sections: layout.sections.filter((s: any) => s.key !== 'references') } });
    expect(dropCore.body.error.fieldErrors[0].code).toBe('core_section_required');
    const draft = expectOk(await client.put('/forms/candidate_application/draft', { layout }));
    const impact = expectOk(await client.get(`/forms/versions/${draft.id}/impact`));
    expect(impact.addedQuestions).toContain(key);
    expect(impact.newlyRequiredQuestions).toContain(key);
    const published = expectOk(await client.post(`/forms/versions/${draft.id}/publish`, { version: draft.version }));
    expect(published.status).toBe('published');
    // Renaming later does not change the published version.
    expectOk(await client.patch(`/questions/${key}`, { version: q.version, label: 'Renamed label' }));
    const form = expectOk(await new Client(ctx.app).get('/public/forms/candidate_application'));
    expect(form.layout.sections.find((s: any) => s.key === 'additional').questions[0].definition.label).toBe('Comfortable with pets?');
    const latest = expectOk(await client.get('/questions?scope=candidate_application')).items.find((x: any) => x.key === key);
    const removeOption = await client.patch(`/questions/${key}`, { version: latest.version, options: [{ value: 'yes', label: 'Yes' }] });
    expect(removeOption.body.error.code).toBe('option_in_use');
  });
});

describe('finance', () => {
  it('tracks issued balances in one currency and refuses mixed currencies and overpayments', async () => {
    const { client: owner } = await signedIn(ctx, 'owner');
    const { client: coordinator } = await signedIn(ctx, 'coordinator');
    const family = expectOk(await owner.post('/families', { displayName: 'Invoice family' }), 201);
    expect((await coordinator.post('/invoices', { familyId: family.id, currency: 'USD', lines: [{ description: 'Fee', amountMinor: 100 }] })).status).toBe(403);
    const invoice = expectOk(await owner.post('/invoices', { familyId: family.id, currency: 'USD', lines: [{ description: 'Placement fee', amountMinor: 1_000_000 }, { description: 'Search fee', amountMinor: 50_000 }] }), 201);
    expect(invoice.totalMinor).toBe(1_050_000);
    expect(invoice.number).toMatch(/^INV-\d{4}-\d+$/);
    const issued = expectOk(await owner.post(`/invoices/${invoice.id}/issue`, { version: invoice.version, dueOn: '2026-11-30' }));
    expect(issued.outstandingMinor).toBe(1_050_000);
    expect((await owner.post(`/invoices/${invoice.id}/payments`, { kind: 'payment', amountMinor: 100, currency: 'CAD', receivedOn: '2026-10-22' })).body.error.fieldErrors[0].code).toBe('currency_mismatch');
    expect((await owner.post(`/invoices/${invoice.id}/payments`, { kind: 'payment', amountMinor: 2_000_000, currency: 'USD', receivedOn: '2026-10-22' })).status).toBe(422);
    expectOk(await owner.post(`/invoices/${invoice.id}/payments`, { kind: 'payment', amountMinor: 600_000, currency: 'USD', receivedOn: '2026-10-22' }), 201);
    const afterCredit = expectOk(await owner.post(`/invoices/${invoice.id}/payments`, { kind: 'credit', amountMinor: 50_000, currency: 'USD', receivedOn: '2026-10-22' }), 201);
    expect([afterCredit.paidMinor, afterCredit.creditedMinor, afterCredit.outstandingMinor]).toEqual([600_000, 50_000, 400_000]);
    const { client: finance } = await signedIn(ctx, 'finance_viewer');
    expect(expectOk(await finance.get(`/invoices/${invoice.id}`)).outstandingMinor).toBe(400_000);
    expect((await finance.post(`/invoices/${invoice.id}/void`, { version: 1, reason: 'no' })).status).toBe(403);
  });
});

describe('governance', () => {
  it('merges duplicate families, re-pointing records and keeping the original submission', async () => {
    const { client: owner } = await signedIn(ctx, 'owner');
    const anon = new Client(ctx.app);
    const email = `dupe.${uuid().slice(0, 6)}@example.invalid`;
    for (const city of ['Denver', 'Aurora']) {
      expectOk(await anon.post('/public/enquiries', { contact: { firstName: 'Kai', lastName: 'Dupe', email }, household: { city, state: 'CO' }, role: {}, consents: { privacyNotice: true } }, { 'idempotency-key': uuid() }), 202);
    }
    const cases = expectOk(await owner.get('/duplicates?entityType=family')).items;
    const duplicate = cases.find((c: any) => c.records.some((r: any) => r.email === email));
    const [first, second] = duplicate.records;
    expect((await owner.post(`/duplicates/${duplicate.id}/merge`, { survivorId: first.id, survivorVersion: first.version + 5, mergedVersion: second.version })).body.error.code).toBe('version_conflict');
    const { client: coordinator } = await signedIn(ctx, 'coordinator');
    expect((await coordinator.post(`/duplicates/${duplicate.id}/merge`, { survivorId: first.id, survivorVersion: first.version, mergedVersion: second.version })).status).toBe(403);
    const result = expectOk(await owner.post(`/duplicates/${duplicate.id}/merge`, { survivorId: first.id, survivorVersion: first.version, mergedVersion: second.version, fieldChoices: { city: 'merged' } }));
    expect(result.reparented.enquiries).toBe(1);
    const survivor = expectOk(await owner.get(`/families/${first.id}`));
    expect(survivor.enquiryCount).toBe(2);
    expect(survivor.city).toBe(second.city);
    expect(expectOk(await owner.get(`/families/${second.id}`)).mergedIntoFamilyId).toBe(first.id);
    const enquiries = await ctx.deps.db.selectFrom('enquiries').select('submissionSnapshot').where('familyId', '=', first.id).execute();
    expect(enquiries.every(e => e.submissionSnapshot !== null)).toBe(true);
  });

  it('merges candidates without duplicating a job association', async () => {
    const { client: owner } = await signedIn(ctx, 'owner');
    const email = `cand.dupe.${uuid().slice(0, 6)}@example.invalid`;
    const a = expectOk(await owner.post('/candidates', { firstName: 'Lee', lastName: 'Dupe', email, professionalNannyYears: 3 }), 201);
    const b = expectOk(await owner.post('/candidates', { firstName: 'Lee', lastName: 'Dupe', email, professionalNannyYears: 8 }), 201);
    const family = expectOk(await owner.post('/families', { displayName: 'Merge job family' }), 201);
    const job = expectOk(await owner.post('/jobs', { familyId: family.id, title: 'Job' }), 201);
    expectOk(await owner.post(`/jobs/${job.id}/candidates`, { candidateId: a.id }), 201);
    expectOk(await owner.post(`/jobs/${job.id}/candidates`, { candidateId: b.id }), 201);
    const duplicate = expectOk(await owner.get('/duplicates?entityType=candidate')).items.find((c: any) => c.records.some((r: any) => r.email === email));
    const fresh = (id: string) => duplicate.records.find((r: any) => r.id === id);
    const result = expectOk(await owner.post(`/duplicates/${duplicate.id}/merge`, { survivorId: a.id, survivorVersion: fresh(a.id).version, mergedVersion: fresh(b.id).version, fieldChoices: { professionalNannyYears: 'merged' } }));
    expect(result.reparented.jobAssociationsWithdrawn).toBe(1);
    expect(expectOk(await owner.get(`/candidates/${a.id}`)).professionalNannyYears).toBe(8);
    const associations = expectOk(await owner.get(`/jobs/${job.id}/candidates`)).items;
    expect(associations.find((x: any) => x.candidateId === a.id).stage).toBe('shortlisted');
    expect(associations.find((x: any) => x.candidateId === b.id).stage).toBe('withdrawn');
  });

  it('exports CSV with metadata and neutralized formulas, behind an audited link', async () => {
    const { client: owner } = await signedIn(ctx, 'owner');
    const tag = uuid().slice(0, 6);
    expectOk(await owner.post('/candidates', { firstName: '=HYPERLINK("http://evil")', lastName: `Csv${tag}`, email: `csv.${tag}@example.invalid` }), 201);
    const exported = expectOk(await owner.post('/exports', { kind: 'candidates', params: { criteria: { text: `Csv${tag}` } } }), 201);
    expect(exported.status).toBe('completed');
    expect(exported.rowCount).toBe(1);
    const link = expectOk(await owner.post(`/exports/${exported.id}/download-link`));
    const file = await new Client(ctx.app).get(new URL(link.url).pathname + new URL(link.url).search);
    const text = String(file.body);
    expect(text).toContain('# timezone: America/Denver');
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    const { client: coordinator } = await signedIn(ctx, 'coordinator');
    expect((await coordinator.post('/exports', { kind: 'candidates', params: {} })).status).toBe(403);
  });

  it('honours legal holds and anonymizes approved deletion requests', async () => {
    const { client: owner } = await signedIn(ctx, 'owner');
    const candidate = expectOk(await owner.post('/candidates', { firstName: 'Del', lastName: 'Etion', email: `del.${uuid().slice(0, 6)}@example.invalid`, phone: '303-555-0177', introduction: 'Private intro' }), 201);
    const request = expectOk(await owner.post('/retention-requests', { kind: 'deletion', subjectType: 'candidate', subjectId: candidate.id, receivedVia: 'email' }), 201);
    const hold = expectOk(await owner.post('/legal-holds', { subjectType: 'candidate', subjectId: candidate.id, reason: 'Pending dispute about placement terms' }), 201);
    let row = (await owner.get('/retention-requests')).body.items.find((r: any) => r.id === request.id);
    expectOk(await owner.post(`/retention-requests/${request.id}/decide`, { status: 'approved', version: row.version }));
    row = (await owner.get('/retention-requests')).body.items.find((r: any) => r.id === request.id);
    expect((await owner.post(`/retention-requests/${request.id}/complete`, { version: row.version })).body.error.code).toBe('legal_hold');
    expectOk(await owner.post(`/legal-holds/${hold.id}/release`));
    expectOk(await owner.post(`/retention-requests/${request.id}/complete`, { version: row.version }));
    const after = expectOk(await owner.get(`/candidates/${candidate.id}`));
    expect([after.firstName, after.phone, after.introduction, after.recruitmentStage]).toEqual(['Deleted', null, null, 'archived']);
    const audit = expectOk(await owner.get(`/audit?subjectId=${candidate.id}`)).items.map((a: any) => a.action);
    expect(audit).toContain('retention.candidate_anonymized');
  });

  it('publishes legal notices that new consents are recorded against', async () => {
    const { client: owner } = await signedIn(ctx, 'owner');
    const version = `2026-${uuid().slice(0, 4)}`;
    const notice = expectOk(await owner.post('/legal-notices', { noticeKey: 'privacy_notice', version, title: 'Privacy notice', bodyMarkdown: 'Approved wording.' }), 201);
    expectOk(await owner.post(`/legal-notices/${notice.id}/publish`));
    expect(expectOk(await new Client(ctx.app).get('/public/legal-notices/privacy_notice')).version).toBe(version);
    const email = `notice.${uuid().slice(0, 6)}@example.invalid`;
    expectOk(await new Client(ctx.app).post('/public/enquiries', { contact: { firstName: 'N', lastName: 'Otice', email }, household: { city: 'Denver', state: 'CO' }, role: {}, consents: { privacyNotice: true } }, { 'idempotency-key': uuid() }), 202);
    const consent = await ctx.deps.db.selectFrom('consents as c').innerJoin('familyContacts as f', 'f.id', 'c.familyContactId').select('c.noticeVersion').where('f.email', '=', email).executeTakeFirstOrThrow();
    expect(consent.noticeVersion).toBe(version);
  });
});
