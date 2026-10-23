import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import type { AppDeps, StaffActor } from '../../context.js';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { Id, IdParams, PageQuery, Timestamp } from '../../http/schemas.js';
import { notFound } from '../../http/errors.js';
import { assignedOnly, assertInScope } from '../../domain/records.js';
import { getSettings } from '../../domain/settings.js';
import { audit } from '../../domain/audit.js';

const Kind = z.enum(['application_review', 'reference_review', 'screening_review', 'offer_follow_up', 'job_follow_up', 'family_feedback', 'task']);
const QueueItem = z.object({ id: z.string(), subjectId: Id, kind: Kind, title: z.string(), detail: z.string(), dueAt: Timestamp.nullable(), href: z.string(), priority: z.number() });
type Item = z.infer<typeof QueueItem>;

async function queueSql(deps: AppDeps, staff: StaffActor) {
  const scoped = await assignedOnly(deps.db, staff);
  const scope = (column: string) => scoped ? sql`(${sql.ref(column)} IS NULL OR ${sql.ref(column)} = ${staff.staffId})` : sql`TRUE`;
  const parts: RawBuilder<unknown>[] = [];
  if (staff.permissions.has('candidates.read')) parts.push(sql`
    SELECT 'application:' || c.id AS id, c.id AS "subjectId", 'application_review' AS kind,
      c.first_name || ' ' || c.last_name AS title, 'Application awaiting review' AS detail,
      c.submitted_at AS "dueAt", '/candidates/' || c.id || '?tab=Application' AS href, 2 AS priority
    FROM candidates c WHERE c.recruitment_stage IN ('received', 'review') AND c.archived_at IS NULL
      AND c.merged_into_candidate_id IS NULL AND ${scope('c.assigned_staff_id')}`);
  if (staff.permissions.has('screening.read')) {
    parts.push(sql`SELECT 'reference:' || r.id AS id, c.id AS "subjectId", 'reference_review' AS kind,
      c.first_name || ' ' || c.last_name AS title, 'Professional reference needs follow-up' AS detail,
      r.created_at AS "dueAt", '/candidates/' || c.id || '?tab=References' AS href, 2 AS priority
      FROM candidate_references r JOIN candidates c ON c.id=r.candidate_id WHERE r.status NOT IN ('completed','cancelled')
      AND c.archived_at IS NULL AND c.merged_into_candidate_id IS NULL AND ${scope('c.assigned_staff_id')}`);
    parts.push(sql`SELECT 'check:' || s.id AS id, c.id AS "subjectId", 'screening_review' AS kind,
      c.first_name || ' ' || c.last_name AS title, 'Completed check awaiting agency review' AS detail,
      s.completed_at AS "dueAt", '/candidates/' || c.id || '?tab=Screening' AS href, 1 AS priority
      FROM screening_checks s JOIN candidates c ON c.id=s.candidate_id WHERE s.status='completed'
      AND c.archived_at IS NULL AND c.merged_into_candidate_id IS NULL AND ${scope('c.assigned_staff_id')}`);
  }
  if (staff.permissions.has('jobs.read')) {
    parts.push(sql`SELECT 'offer:' || o.id AS id, j.id AS "subjectId", 'offer_follow_up' AS kind,
      j.title AS title, 'Offer review due' AS detail, (o.review_date::timestamp AT TIME ZONE ${((await getSettings(deps.db)).timezone)}) AS "dueAt",
      '/jobs/' || j.id || '?tab=Offers' AS href, 1 AS priority FROM offers o JOIN job_candidates jc ON jc.id=o.job_candidate_id
      JOIN job_orders j ON j.id=jc.job_order_id WHERE o.status='extended' AND o.review_date <= (${deps.clock.now().toISOString()}::timestamptz AT TIME ZONE ${((await getSettings(deps.db)).timezone)})::date
      AND ${scope('j.assigned_staff_id')}`);
    parts.push(sql`SELECT 'job:' || j.id AS id, j.id AS "subjectId", 'job_follow_up' AS kind, j.title AS title,
      'Open job has no activity for 14 days' AS detail, j.updated_at AS "dueAt", '/jobs/' || j.id AS href, 3 AS priority
      FROM job_orders j WHERE j.status='open' AND j.updated_at < ${deps.clock.now().toISOString()}::timestamptz - interval '14 days' AND ${scope('j.assigned_staff_id')}`);
    parts.push(sql`SELECT 'feedback:' || jc.id AS id, j.id AS "subjectId", 'family_feedback' AS kind, j.title AS title,
      'Presented candidate awaiting recorded feedback' AS detail, jc.updated_at AS "dueAt", '/jobs/' || j.id || '?tab=Presentations' AS href, 2 AS priority
      FROM job_candidates jc JOIN job_orders j ON j.id=jc.job_order_id WHERE jc.stage='presented'
      AND NOT EXISTS (SELECT 1 FROM family_feedback f WHERE f.job_candidate_id=jc.id) AND ${scope('j.assigned_staff_id')}`);
  }
  if (staff.permissions.has('tasks.read')) parts.push(sql`SELECT 'task:' || t.id AS id, t.id AS "subjectId", 'task' AS kind,
    t.title AS title, 'Open follow-up task' AS detail, t.due_at AS "dueAt", '/tasks' AS href,
    CASE WHEN t.due_at < ${deps.clock.now().toISOString()}::timestamptz THEN 1 ELSE 3 END AS priority FROM tasks t
    WHERE t.status='open' AND ${scope('t.assigned_staff_id')}`);
  return sql<Item>`(${sql.join(parts, sql` UNION ALL `)})`;
}

export const workspaceRoutes: AnyRoute[] = [
  defineRoute({ method: 'GET', path: '/applications/:id', operationId: 'getSubmittedApplication', summary: 'Original submitted application and published form layout', tags: ['Applications'], access: {kind:'staff',permission:'screening.read'}, params: IdParams,
    response: z.object({ id: Id, candidateId: Id, reference: z.string(), submittedAt: Timestamp, formVersionId: Id, formVersion: z.number(), snapshot: z.unknown(), snapshotSha256: z.string(), layout: z.unknown() }),
    async handler({deps,staff,meta,params}) {
      const row=await deps.db.selectFrom('applications as a').innerJoin('candidates as c','c.id','a.candidateId').innerJoin('formVersions as f','f.id','a.formVersionId')
        .select(['a.id','a.candidateId','a.reference','a.submittedAt','a.formVersionId','a.snapshot','a.snapshotSha256','c.assignedStaffId','f.versionNumber as formVersion','f.layout']).where('a.id','=',params.id).executeTakeFirst();
      if(!row)throw notFound('Application'); await assertInScope(deps.db,staff,row.assignedStaffId);
      await audit(deps.db,meta,{action:'application.viewed',subjectType:'candidate',subjectId:row.candidateId,metadata:{applicationId:row.id}});
      const {assignedStaffId:_,...result}=row; return result;
    }}),
  defineRoute({method:'GET',path:'/work-queue',operationId:'listWorkspaceAttention',summary:'Scoped actionable work with exact totals',tags:['Workspace'],access:{kind:'staff',permission:'reports.operational'},
    query:z.object({...PageQuery,kind:Kind.optional()}),response:z.object({items:z.array(QueueItem),page:z.number(),pageSize:z.number(),total:z.number(),counts:z.record(z.string(),z.number()),asOf:Timestamp}),
    async handler({deps,staff,query}) {
      const source=await queueSql(deps,staff); const condition=query.kind?sql`kind=${query.kind}`:sql`TRUE`;
      const [items,counts]=await Promise.all([
        sql<Item>`SELECT * FROM ${source} q WHERE ${condition} ORDER BY priority, "dueAt" NULLS LAST, id LIMIT ${query.pageSize} OFFSET ${(query.page-1)*query.pageSize}`.execute(deps.db),
        sql<{kind:string;n:number}>`SELECT kind,count(*)::int AS n FROM ${source} q GROUP BY kind`.execute(deps.db)
      ]);
      const totals=Object.fromEntries(counts.rows.map(r=>[r.kind,r.n]));return {items:items.rows,page:query.page,pageSize:query.pageSize,total:query.kind?(totals[query.kind]||0):counts.rows.reduce((n,r)=>n+r.n,0),counts:totals,asOf:deps.clock.now().toISOString()};
    }}),
  defineRoute({method:'GET',path:'/settings/readiness',operationId:'getLaunchReadiness',summary:'Non-secret launch configuration checklist',tags:['Settings'],access:{kind:'staff',permission:'settings.read'},
    response:z.object({environment:z.string(),items:z.array(z.object({key:z.string(),label:z.string(),ready:z.boolean(),detail:z.string()}))}),
    async handler({deps}) {
      const [notices,policy]=await Promise.all([deps.db.selectFrom('legalNotices').select('noticeKey').where('status','=','published').execute(),deps.db.selectFrom('screeningPolicies').select('id').where('status','=','active').execute()]);
      return {environment:deps.config.APP_ENV,items:[
        ...['privacy_notice','application_terms','reference_authorization','background_authorization','presentation_sharing'].map(key=>({key,label:key.replaceAll('_',' '),ready:notices.some(n=>n.noticeKey===key),detail:'Requires agency-approved published wording.'})),
        {key:'screening',label:'Screening policy',ready:policy.length>0,detail:'Publish a reviewed policy before approving candidates.'},
        {key:'email',label:'Email provider',ready:deps.config.EMAIL_PROVIDER==='resend',detail:deps.config.EMAIL_PROVIDER==='resend'?'Configured for provider delivery; staging delivery must still be verified.':'Local development mail only.'},
        {key:'storage',label:'Managed private storage',ready:deps.config.STORAGE_PROVIDER==='s3',detail:'Private file access and backups need deployment verification.'},
        {key:'scanner',label:'Malware scanning',ready:deps.config.SCANNER_PROVIDER==='clamd',detail:'A reachable scanner is required for real applicant uploads.'}
      ]};
    }})
];
