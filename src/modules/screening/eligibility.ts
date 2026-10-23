import { z } from 'zod';
import type { Executor } from '../../db/index.js';
import { localDate } from '../../lib/time.js';

/**
 * Presentation eligibility is a server-calculated policy result over current evidence. Merely
 * scheduled interviews or ordered checks never count; a provider's "completed" is not a review;
 * expired or undated certificates are not current. Owner overrides are scoped, reasoned and may
 * expire. Stage edits cannot bypass this: entering "eligible" and releasing a presentation both
 * re-run it.
 */

export const PolicyRequirement = z.discriminatedUnion('kind', [
  z.object({ key: z.string(), label: z.string(), kind: z.literal('interview_completed'), params: z.object({ interviewKind: z.enum(['general', 'job_fit']).default('general'), recommendations: z.array(z.enum(['advance', 'hold', 'do_not_advance'])).default(['advance']) }) }),
  z.object({ key: z.string(), label: z.string(), kind: z.literal('references_completed'), params: z.object({ minimum: z.int().min(1).max(10) }) }),
  z.object({ key: z.string(), label: z.string(), kind: z.literal('check_reviewed'), params: z.object({ checkType: z.string() }) }),
  z.object({ key: z.string(), label: z.string(), kind: z.literal('qualification_current'), params: z.object({ qualifications: z.array(z.string()).min(1) }) }),
  z.object({ key: z.string(), label: z.string(), kind: z.literal('field_verified'), params: z.object({ field: z.string() }) })
]).meta({ id: 'PolicyRequirement' });
export type PolicyRequirementT = z.infer<typeof PolicyRequirement>;
export const PolicyRequirements = z.array(PolicyRequirement).max(30);

export interface RequirementResult {
  key: string;
  label: string;
  kind: string;
  status: 'met' | 'not_met' | 'overridden';
  detail: string;
  evidence: Record<string, unknown>;
  lastVerifiedAt: string | null;
  override: { id: string; reason: string; actorStaffId: string; createdAt: string; expiresAt: string | null; jobOrderId: string | null } | null;
}

export interface EligibilityResultT {
  eligible: boolean;
  policyId: string | null;
  policyVersion: number | null;
  asOfDate: string;
  evaluatedAt: string;
  jobOrderId: string | null;
  requirements: RequirementResult[];
  blockers: string[];
}

async function evaluateRequirement(db: Executor, candidateId: string, requirement: PolicyRequirementT, today: string): Promise<Omit<RequirementResult, 'override'>> {
  const base = { key: requirement.key, label: requirement.label, kind: requirement.kind };
  switch (requirement.kind) {
    case 'interview_completed': {
      const rows = await db
        .selectFrom('interviews as i')
        .innerJoin('interviewEvaluations as e', 'e.interviewId', 'i.id')
        .select(['i.id', 'i.completedAt', 'e.recommendation', 'e.submittedAt'])
        .where('i.candidateId', '=', candidateId)
        .where('i.kind', '=', requirement.params.interviewKind)
        .where('i.status', '=', 'completed')
        .orderBy('e.submittedAt', 'desc')
        .execute();
      const passing = rows.find(row => requirement.params.recommendations.includes(row.recommendation as 'advance'));
      return passing
        ? { ...base, status: 'met', detail: `Completed interview with recommendation "${passing.recommendation}"`, evidence: { interviewId: passing.id }, lastVerifiedAt: passing.submittedAt }
        : { ...base, status: 'not_met', detail: rows.length ? 'No completed interview has a qualifying recommendation' : 'No completed and evaluated interview', evidence: {}, lastVerifiedAt: null };
    }
    case 'references_completed': {
      const rows = await db
        .selectFrom('candidateReferences')
        .select(['id', 'reviewedAt'])
        .where('candidateId', '=', candidateId)
        .where('status', '=', 'completed')
        .where('reviewOutcome', '=', 'satisfactory')
        .orderBy('reviewedAt', 'desc')
        .execute();
      const met = rows.length >= requirement.params.minimum;
      return {
        ...base,
        status: met ? 'met' : 'not_met',
        detail: `${rows.length} of ${requirement.params.minimum} reviewed satisfactory references`,
        evidence: { referenceIds: rows.map(row => row.id) },
        lastVerifiedAt: rows[0]?.reviewedAt ?? null
      };
    }
    case 'check_reviewed': {
      const row = await db
        .selectFrom('screeningChecks')
        .select(['id', 'status', 'reviewOutcome', 'reviewedAt', 'validUntil'])
        .where('candidateId', '=', candidateId)
        .where('checkTypeKey', '=', requirement.params.checkType)
        .orderBy('reviewedAt', 'desc')
        .orderBy('createdAt', 'desc')
        .executeTakeFirst();
      if (!row) return { ...base, status: 'not_met', detail: 'Not requested', evidence: {}, lastVerifiedAt: null };
      if (row.status !== 'reviewed') return { ...base, status: 'not_met', detail: `Check is ${row.status.replace(/_/g, ' ')}; it needs an agency review`, evidence: { checkId: row.id }, lastVerifiedAt: null };
      if (row.reviewOutcome !== 'acceptable') return { ...base, status: 'not_met', detail: `Reviewed with outcome "${row.reviewOutcome}"`, evidence: { checkId: row.id }, lastVerifiedAt: row.reviewedAt };
      if (row.validUntil && row.validUntil < today) return { ...base, status: 'not_met', detail: `Expired on ${row.validUntil}`, evidence: { checkId: row.id }, lastVerifiedAt: row.reviewedAt };
      return { ...base, status: 'met', detail: row.validUntil ? `Reviewed, valid until ${row.validUntil}` : 'Reviewed as acceptable', evidence: { checkId: row.id }, lastVerifiedAt: row.reviewedAt };
    }
    case 'qualification_current': {
      const rows = await db
        .selectFrom('candidateQualifications as q')
        .innerJoin('qualificationTypes as t', 't.key', 'q.qualificationKey')
        .select(['q.id', 'q.qualificationKey', 'q.reviewState', 'q.expiresOn', 'q.reviewedAt', 't.hasExpiry'])
        .where('q.candidateId', '=', candidateId)
        .where('q.qualificationKey', 'in', requirement.params.qualifications)
        .execute();
      const current = rows
        .filter(row => row.reviewState === 'verified' && (!row.hasExpiry || (row.expiresOn !== null && row.expiresOn >= today)))
        .sort((a, b) => (b.expiresOn ?? '9999').localeCompare(a.expiresOn ?? '9999'))[0];
      if (current) {
        return { ...base, status: 'met', detail: current.expiresOn ? `Verified, expires ${current.expiresOn}` : 'Verified', evidence: { qualificationId: current.id, expiresOn: current.expiresOn }, lastVerifiedAt: current.reviewedAt };
      }
      const reason = !rows.length
        ? 'Not recorded'
        : rows.some(row => row.reviewState === 'verified' && row.hasExpiry && row.expiresOn === null)
          ? 'Verified but no expiry date is recorded'
          : rows.some(row => row.reviewState === 'verified')
            ? 'Expired'
            : 'Awaiting verification';
      return { ...base, status: 'not_met', detail: reason, evidence: { qualificationIds: rows.map(row => row.id) }, lastVerifiedAt: null };
    }
    case 'field_verified': {
      const row = await db
        .selectFrom('candidateFieldVerifications')
        .select(['provenance', 'verifiedAt'])
        .where('candidateId', '=', candidateId)
        .where('fieldKey', '=', requirement.params.field)
        .executeTakeFirst();
      return row?.provenance === 'agency_verified'
        ? { ...base, status: 'met', detail: 'Verified by the agency', evidence: {}, lastVerifiedAt: row.verifiedAt }
        : { ...base, status: 'not_met', detail: row ? `Recorded as ${row.provenance.replace(/_/g, ' ')}` : 'Not verified', evidence: {}, lastVerifiedAt: null };
    }
  }
}

export async function activePolicy(db: Executor) {
  const row = await db.selectFrom('screeningPolicies').select(['id', 'versionNumber', 'requirements']).where('status', '=', 'active').executeTakeFirst();
  return row ? { ...row, requirements: PolicyRequirements.parse(row.requirements) } : null;
}

export async function evaluateEligibility(
  db: Executor,
  candidateId: string,
  options: { now: Date; timezone: string; jobOrderId?: string | null }
): Promise<EligibilityResultT> {
  const today = localDate(options.now, options.timezone);
  const evaluatedAt = options.now.toISOString();
  const policy = await activePolicy(db);
  const candidate = await db.selectFrom('candidates').select(['recruitmentStage', 'archivedAt', 'mergedIntoCandidateId']).where('id', '=', candidateId).executeTakeFirst();
  const blockers: string[] = [];
  if (!candidate) blockers.push('Candidate not found');
  else {
    if (candidate.mergedIntoCandidateId) blockers.push('Candidate was merged into another record');
    if (candidate.archivedAt || ['archived', 'not_selected'].includes(candidate.recruitmentStage)) blockers.push(`Candidate is ${candidate.recruitmentStage.replace(/_/g, ' ')}`);
  }
  if (!policy) {
    return { eligible: false, policyId: null, policyVersion: null, asOfDate: today, evaluatedAt, jobOrderId: options.jobOrderId ?? null, requirements: [], blockers: [...blockers, 'No screening policy has been published'] };
  }
  const overrides = await db
    .selectFrom('eligibilityOverrides')
    .select(['id', 'requirementKey', 'reason', 'actorStaffId', 'createdAt', 'expiresAt', 'jobOrderId'])
    .where('candidateId', '=', candidateId)
    .where('revokedAt', 'is', null)
    .where(eb => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', evaluatedAt)]))
    .where(eb => eb.or([eb('jobOrderId', 'is', null), ...(options.jobOrderId ? [eb('jobOrderId', '=', options.jobOrderId)] : [])]))
    .execute();
  const requirements: RequirementResult[] = [];
  for (const requirement of policy.requirements) {
    const result = await evaluateRequirement(db, candidateId, requirement, today);
    const override = result.status === 'not_met' ? overrides.find(item => item.requirementKey === requirement.key) : undefined;
    requirements.push({ ...result, status: override ? 'overridden' : result.status, override: override ?? null });
  }
  const eligible = blockers.length === 0 && requirements.every(item => item.status !== 'not_met');
  return { eligible, policyId: policy.id, policyVersion: policy.versionNumber, asOfDate: today, evaluatedAt, jobOrderId: options.jobOrderId ?? null, requirements, blockers };
}
