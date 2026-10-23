import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createTestContext,expectOk,signedIn,type TestContext} from './helpers.js';
let ctx:TestContext;
beforeAll(async()=>{ctx=await createTestContext()});
afterAll(async()=>{await ctx.close()});
describe('workspace and assigned scope',()=>{
  it('returns exact queue totals, applies pagination and validates readiness without secrets',async()=>{
    const {client}=await signedIn(ctx,'owner');
    const a=expectOk(await client.post('/candidates',{firstName:'Queue',lastName:'Candidate',email:'queue@example.invalid'}),201);
    const page=expectOk(await client.get('/work-queue?kind=application_review&pageSize=1'));
    expect(page.total).toBeGreaterThanOrEqual(1);expect(page.items).toHaveLength(1);expect(page.counts.application_review).toBe(page.total);
    expect(page.items[0].href).toContain('/candidates/');
    const readiness=expectOk(await client.get('/settings/readiness'));expect(readiness.items.some((i:any)=>i.key==='privacy_notice')).toBe(true);
    expect(JSON.stringify(readiness)).not.toContain('test-auth-secret');
    expect(a.id).toBeTruthy();
  });
  it('does not leak another coordinator’s presentations, calendar or duplicates',async()=>{
    const owner=await signedIn(ctx,'owner'),a=await signedIn(ctx,'coordinator'),b=await signedIn(ctx,'coordinator');
    const settings=expectOk(await owner.client.get('/settings'));
    expectOk(await owner.client.patch('/settings',{version:settings.version,coordinatorScope:'assigned'}));
    const family=expectOk(await owner.client.post('/families',{displayName:'Assigned family',assignedStaffId:b.staffId}),201);
    const job=expectOk(await owner.client.post('/jobs',{familyId:family.id,title:'Private search',assignedStaffId:b.staffId}),201);
    const candidate=expectOk(await owner.client.post('/candidates',{firstName:'Assigned',lastName:'Candidate',email:'assigned@example.invalid',assignedStaffId:b.staffId}),201);
    const other=expectOk(await owner.client.post('/candidates',{firstName:'Other',lastName:'Candidate',email:'other@example.invalid',assignedStaffId:b.staffId}),201);
    await ctx.deps.db.insertInto('appointments').values({kind:'other',title:'Private appointment',startsAt:'2026-10-22T17:00:00Z',endsAt:'2026-10-22T18:00:00Z',familyId:family.id,organizerStaffId:b.staffId}).execute();
    const duplicate=await ctx.deps.db.insertInto('duplicateCases').values({entityType:'candidate',firstRecordId:candidate.id,secondRecordId:other.id,matchReasons:['test']}).returning('id').executeTakeFirstOrThrow();
    expect((await a.client.get(`/jobs/${job.id}/presentations`)).status).toBe(403);
    const calendar=expectOk(await a.client.get('/calendar?from=2026-10-22T00:00:00Z&to=2026-10-23T00:00:00Z'));
    expect(calendar.appointments.some((row:any)=>row.title==='Private appointment')).toBe(false);
    const duplicates=expectOk(await a.client.get('/duplicates'));expect(duplicates.items.some((row:any)=>row.id===duplicate.id)).toBe(false);
    expect((await a.client.post(`/duplicates/${duplicate.id}/dismiss`,{})).status).toBe(403);
    const queue=expectOk(await a.client.get('/work-queue?kind=application_review'));expect(queue.items.some((r:any)=>r.subjectId===candidate.id)).toBe(false);
  });
});
