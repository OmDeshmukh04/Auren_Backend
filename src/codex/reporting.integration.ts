/** Isolated integration test; no production/local agency records are modified. Run with npx tsx src/codex/reporting.integration.ts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { startLocalPostgres } from '../../scripts/lib/embedded-postgres.js';
import { createPool, createDatabase } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import type { AppDeps } from '../context.js';
import { registerRoutes } from '../http/register.js';
import { AppError } from '../http/errors.js';
import { reportRange, ReportQuery, ReportResponse, recruitmentReport, sourceReport, placementReport, financialReport, reportRoutes, formatMoney } from './report-routes.js';

const now = new Date('2026-10-22T18:00:00Z');
const query = ReportQuery.parse({days:30});
// Calendar windows preserve Denver local midnight through the fall daylight-saving change.
const dst = reportRange(ReportQuery.parse({from:'2026-11-01',to:'2026-11-01'}),new Date('2026-11-03T12:00:00Z'),'America/Denver');
assert.equal((Date.parse(dst.toExclusive)-Date.parse(dst.from))/3600000,25);
assert.throws(()=>reportRange(ReportQuery.parse({from:'2026-10-23',to:'2026-10-24'}),now,'America/Denver'));
assert.equal(reportRoutes.filter(r=>r.access.kind==='staff'&&r.access.permission==='reports.financial').length,1);
assert.equal(formatMoney(1234,'USD'),'$12.34');
assert.ok(formatMoney(1234,'JPY').includes('1,234'));
assert.ok(formatMoney(1234,'KWD').includes('1.234'));

const local = await startLocalPostgres({dataDir:'.data/codex-report-tests',port:54331});
const databaseName = `codex_reports_${Date.now()}`;
await local.createDatabase(databaseName);
const pool = createPool({connectionString:local.url(databaseName)});
const db = createDatabase(pool);
try {
  await migrate(pool);
  const deps = {db,clock:{now:()=>now}} as AppDeps;
  const empty = await sourceReport(deps,query);
  assert.equal(empty.metrics['New enquiries'],0);
  assert.equal(empty.metrics['Cohort conversion'],null);
  assert.equal((await placementReport(deps,query)).metrics['Median time to placement'],null);
  const f1=randomUUID(),f2=randomUUID(),ft=randomUUID(),e1=randomUUID(),e2=randomUUID(),et=randomUUID();
  await pool.query(`INSERT INTO families (id,reference,display_name,is_test) VALUES ($1,'COD-F1','Test family one',false),($2,'COD-F2','Test family two',false),($3,'COD-FT','Excluded test family',true)`,[f1,f2,ft]);
  await pool.query(`INSERT INTO enquiries (id,reference,family_id,channel,source,submitted_at) VALUES
    ($1,'COD-E1',$4,'website','Referral','2026-10-10T15:00:00Z'),
    ($2,'COD-E2',$5,'website',null,'2026-10-12T15:00:00Z'),
    ($3,'COD-ET',$6,'website','Test only','2026-10-12T15:00:00Z')`,[e1,e2,et,f1,f2,ft]);
  await pool.query(`INSERT INTO consultations (family_id,enquiry_id,status,outcome,completed_at) VALUES
    ($1,$2,'completed','proceed','2026-10-15T15:00:00Z'),($1,$2,'completed','follow_up','2026-10-16T15:00:00Z')`,[f1,e1]);
  const sources = await sourceReport(deps,query);
  assert.equal(sources.metrics['New enquiries'],2);
  assert.equal(sources.metrics['Consultations completed'],1);
  assert.equal(sources.metrics['Cohort conversion'],'50.0%');
  assert.deepEqual(sources.series.map(r=>r.name).sort(),['Referral','Unknown']);
  const cid=randomUUID(),ct=randomUUID();
  await pool.query(`INSERT INTO candidates (id,reference,first_name,last_name,email,recruitment_stage,is_test) VALUES
    ($1,'COD-C1','Test','Candidate','candidate@example.invalid','review',false),
    ($2,'COD-CT','Excluded','Candidate','excluded@example.invalid','eligible',true)`,[cid,ct]);
  const recruitment = await recruitmentReport(deps,query);
  assert.equal(recruitment.metrics['Active candidates'],1);
  assert.equal(recruitment.metrics['Agency reviewed'],0);
  assert.equal(recruitment.series.reduce((n,r)=>n+r.value,0),1);
  const usd=randomUUID(),eur=randomUUID(),testInvoice=randomUUID();
  await pool.query(`INSERT INTO invoices (id,number,family_id,status,currency,total_minor,issued_on) VALUES
    ($1,'COD-USD',$4,'issued','USD',10000,'2026-10-10'),($2,'COD-EUR',$4,'issued','EUR',20000,'2026-10-10'),
    ($3,'COD-TEST',$5,'issued','USD',300000,'2026-10-10')`,[usd,eur,testInvoice,f1,ft]);
  await pool.query(`INSERT INTO payments (invoice_id,kind,amount_minor,currency,received_on) VALUES
    ($1,'payment',3000,'USD','2026-10-12'),($1,'credit',1000,'USD','2026-10-13'),($1,'refund',500,'USD','2026-10-14')`,[usd]);
  const finance = await financialReport(deps,query);
  assert.equal(finance.currencyTotals?.length,2);
  assert.equal(finance.metrics['Fees invoiced'],'See currency breakdown');
  assert.deepEqual(finance.currencyTotals?.find(r=>r.currency==='USD'),{currency:'USD',invoicedMinor:10000,paymentsMinor:3000,creditsMinor:1000,refundsMinor:500,outstandingMinor:6500});
  for(const report of [sources,recruitment,finance,await placementReport(deps,query)])ReportResponse.parse({data:report});
  const editorUser=randomUUID(),financeUser=randomUUID();
  await pool.query(`INSERT INTO auth_users (id,name,email) VALUES ($1,'Editor','editor@example.invalid'),($2,'Finance','finance@example.invalid')`,[editorUser,financeUser]);
  await pool.query(`INSERT INTO staff_members (user_id,email,display_name,role) VALUES ($1,'editor@example.invalid','Editor','content_editor'),($2,'finance@example.invalid','Finance','finance_viewer')`,[editorUser,financeUser]);
  const httpDeps={...deps,config:{SIGNING_SECRET:'isolated-test-not-a-production-secret'},auth:{api:{getSession:async({headers}:{headers:Headers})=>{const id=headers.get('x-test-user');return id?{user:{id},session:{id:'test-session'}}:null}}}} as unknown as AppDeps;
  const app=Fastify();
  await app.register(cookie);
  app.setErrorHandler((error,_req,reply)=>{const e=error as AppError;void reply.status(e.status||500).send({error:{code:e.code||'internal_error'}})});
  registerRoutes(app,httpDeps,reportRoutes);
  try {
    assert.equal((await app.inject({method:'GET',url:'/api/v1/reports/financials'})).statusCode,401);
    assert.equal((await app.inject({method:'GET',url:'/api/v1/reports/financials',headers:{'x-test-user':editorUser}})).statusCode,403);
    assert.equal((await app.inject({method:'GET',url:'/api/v1/reports/recruitment',headers:{'x-test-user':financeUser}})).statusCode,403);
    const allowed=await app.inject({method:'GET',url:'/api/v1/reports/financials',headers:{'x-test-user':financeUser}});
    assert.equal(allowed.statusCode,200,allowed.body);
    ReportResponse.parse(allowed.json());
  } finally {await app.close()}
  console.log('Reporting integration passed: real Postgres, 11 migrations, zero-data, cohort deduplication, test-record exclusion, currency/credit/refund balances, DST, response schemas, anonymous 401, forbidden roles 403 and allowed financial HTTP response.');
} finally {
  await db.destroy();
  // Verified generated name belongs exclusively to this test database.
  assert.match(databaseName,/^codex_reports_[0-9]+$/);
  await local.dropDatabase(databaseName);
  await local.stop();
}
