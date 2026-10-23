import type { Executor } from '../../db/index.js';
import { hhmmToMinutes, minutesToHhmm } from '../../http/schemas.js';

/**
 * Explicit criteria comparison for one candidate against one job: Meets / Does not meet / Not
 * recorded, with evidence and verification context. It never rejects automatically.
 */

type Result = 'meets' | 'does_not_meet' | 'not_recorded';
interface Row {
  criterionId: string | null;
  criterion: string;
  importance: 'required' | 'preferred';
  label: string;
  result: Result;
  evidence: string;
  provenance: string | null;
  lastVerifiedAt: string | null;
}

const EDUCATION = ['none', 'high_school', 'some_college', 'associate', 'bachelor', 'master', 'doctorate'];
const PROFICIENCY = ['basic', 'conversational', 'fluent', 'native'];

export async function compareCandidateToJob(db: Executor, jobOrderId: string, candidateId: string, today: string) {
  const [job, criteria, windows, candidate, qualifications, languages, skills, availability, verifications] = await Promise.all([
    db.selectFrom('jobOrders').selectAll().where('id', '=', jobOrderId).executeTakeFirstOrThrow(),
    db.selectFrom('jobOrderCriteria').selectAll().where('jobOrderId', '=', jobOrderId).orderBy('sortOrder').execute(),
    db.selectFrom('jobOrderScheduleWindows').selectAll().where('jobOrderId', '=', jobOrderId).execute(),
    db.selectFrom('candidates').selectAll().where('id', '=', candidateId).executeTakeFirstOrThrow(),
    db.selectFrom('candidateQualifications as q').innerJoin('qualificationTypes as t', 't.key', 'q.qualificationKey').select(['q.qualificationKey', 'q.reviewState', 'q.expiresOn', 'q.reviewedAt', 'q.provenance', 't.hasExpiry', 't.label']).where('q.candidateId', '=', candidateId).execute(),
    db.selectFrom('candidateLanguages').selectAll().where('candidateId', '=', candidateId).execute(),
    db.selectFrom('candidateSkills').selectAll().where('candidateId', '=', candidateId).execute(),
    db.selectFrom('candidateAvailabilityWindows').selectAll().where('candidateId', '=', candidateId).execute(),
    db.selectFrom('candidateFieldVerifications').selectAll().where('candidateId', '=', candidateId).execute()
  ]);
  const verification = (field: string) => verifications.find(v => v.fieldKey === field);
  const boolRow = (value: boolean | null, label: string, field?: string): Pick<Row, 'result' | 'evidence' | 'provenance' | 'lastVerifiedAt'> => ({
    result: value === null ? 'not_recorded' : value ? 'meets' : 'does_not_meet',
    evidence: value === null ? 'Not recorded' : value ? `${label}: yes` : `${label}: no`,
    provenance: field ? verification(field)?.provenance ?? 'self_reported' : null,
    lastVerifiedAt: field ? verification(field)?.verifiedAt ?? null : null
  });

  const rows: Row[] = criteria.map(c => {
    const params = (c.params ?? {}) as Record<string, unknown>;
    const base = { criterionId: c.id, criterion: c.criterion, importance: c.importance as 'required' | 'preferred' };
    switch (c.criterion) {
      case 'min_professional_nanny_years':
      case 'min_childcare_years': {
        const field = c.criterion === 'min_professional_nanny_years' ? 'professional_nanny_years' : 'childcare_years';
        const value = c.criterion === 'min_professional_nanny_years' ? candidate.professionalNannyYears : candidate.childcareYears;
        const years = Number(params.years ?? 0);
        const label = `At least ${years} ${c.criterion === 'min_professional_nanny_years' ? 'professional nanny' : 'childcare'} years`;
        return {
          ...base, label,
          result: value === null ? 'not_recorded' : Number(value) >= years ? 'meets' : 'does_not_meet',
          evidence: value === null ? 'Not recorded' : `${value} years`,
          provenance: verification(field)?.provenance ?? 'self_reported',
          lastVerifiedAt: verification(field)?.verifiedAt ?? null
        };
      }
      case 'age_group_experience': {
        const wanted = (params.ageGroups as string[] | undefined) ?? job.childrenAgeBands.filter(band => band !== 'expecting');
        const label = `Experience with ${wanted.join(', ').replace(/_/g, ' ')}`;
        if (!candidate.ageGroups.length) return { ...base, label, result: 'not_recorded', evidence: 'No age groups recorded', provenance: null, lastVerifiedAt: null };
        const missing = wanted.filter(group => !candidate.ageGroups.includes(group));
        return { ...base, label, result: missing.length ? 'does_not_meet' : 'meets', evidence: missing.length ? `Missing: ${missing.join(', ')}` : `Has: ${wanted.join(', ')}`, provenance: verification('age_groups')?.provenance ?? 'self_reported', lastVerifiedAt: verification('age_groups')?.verifiedAt ?? null };
      }
      case 'qualification_current': {
        const keys = (params.qualifications as string[] | undefined) ?? [];
        const label = `Current ${keys.join(' or ').replace(/_/g, ' ')}`;
        const matching = qualifications.filter(q => keys.includes(q.qualificationKey));
        const current = matching.find(q => q.reviewState === 'verified' && (!q.hasExpiry || (q.expiresOn !== null && q.expiresOn >= today)));
        if (current) return { ...base, label, result: 'meets', evidence: current.expiresOn ? `${current.label}, expires ${current.expiresOn}` : current.label, provenance: current.provenance, lastVerifiedAt: current.reviewedAt };
        if (!matching.length) return { ...base, label, result: 'not_recorded', evidence: 'Not recorded', provenance: null, lastVerifiedAt: null };
        const pending = matching.find(q => q.reviewState === 'pending_review' || (q.hasExpiry && q.expiresOn === null));
        if (pending) return { ...base, label, result: 'not_recorded', evidence: pending.reviewState === 'pending_review' ? 'Awaiting verification' : 'No expiry date recorded', provenance: pending.provenance, lastVerifiedAt: null };
        return { ...base, label, result: 'does_not_meet', evidence: 'Expired or rejected', provenance: matching[0]!.provenance, lastVerifiedAt: matching[0]!.reviewedAt };
      }
      case 'language': {
        const code = String(params.code ?? '');
        const min = String(params.minProficiency ?? 'conversational');
        const found = languages.find(l => l.languageCode === code);
        const label = `${code} (${min} or better)`;
        if (!found) return { ...base, label, result: languages.length ? 'does_not_meet' : 'not_recorded', evidence: languages.length ? 'Not listed' : 'No languages recorded', provenance: null, lastVerifiedAt: null };
        return { ...base, label, result: PROFICIENCY.indexOf(found.proficiency) >= PROFICIENCY.indexOf(min) ? 'meets' : 'does_not_meet', evidence: `${found.proficiency}`, provenance: 'self_reported', lastVerifiedAt: null };
      }
      case 'skill': {
        const skill = String(params.skill ?? '');
        const found = skills.find(s => s.skillKey === skill);
        return { ...base, label: `Skill: ${skill.replace(/_/g, ' ')}`, result: found ? 'meets' : skills.length ? 'does_not_meet' : 'not_recorded', evidence: found ? 'Listed' : skills.length ? 'Not listed' : 'No skills recorded', provenance: found?.provenance ?? null, lastVerifiedAt: null };
      }
      case 'driving_eligible':
        return { ...base, label: 'Eligible to drive', ...boolRow(candidate.drivingEligible, 'Driving eligible', 'driving_eligible') };
      case 'has_vehicle':
        return { ...base, label: 'Has a vehicle', ...boolRow(candidate.hasVehicle, 'Vehicle') };
      case 'special_needs_experience':
        return { ...base, label: 'Special-needs experience', ...boolRow(candidate.specialNeedsExperience, 'Special-needs experience', 'special_needs_experience') };
      case 'staffed_household_experience':
        return { ...base, label: 'Staffed household experience', ...boolRow(candidate.staffedHouseholdExperience, 'Staffed household', 'staffed_household_experience') };
      case 'live_in': {
        const wants = candidate.desiredArrangement;
        const label = 'Open to live-in';
        if (!wants) return { ...base, label, result: 'not_recorded', evidence: 'Arrangement preference not recorded', provenance: null, lastVerifiedAt: null };
        return { ...base, label, result: wants === 'live_in' || wants === 'either' ? 'meets' : 'does_not_meet', evidence: `Prefers ${wants.replace('_', '-')}`, provenance: 'self_reported', lastVerifiedAt: null };
      }
      case 'travel':
        return { ...base, label: 'Willing to travel', ...boolRow(candidate.willingToTravel, 'Willing to travel') };
      case 'education_level': {
        const min = String(params.minLevel ?? 'high_school');
        const label = `Education: ${min.replace(/_/g, ' ')} or higher`;
        if (!candidate.educationLevel || candidate.educationLevel === 'other') return { ...base, label, result: 'not_recorded', evidence: candidate.educationLevel === 'other' ? 'Recorded as other' : 'Not recorded', provenance: null, lastVerifiedAt: null };
        return { ...base, label, result: EDUCATION.indexOf(candidate.educationLevel) >= EDUCATION.indexOf(min) ? 'meets' : 'does_not_meet', evidence: candidate.educationLevel.replace(/_/g, ' '), provenance: verification('education_level')?.provenance ?? 'self_reported', lastVerifiedAt: verification('education_level')?.verifiedAt ?? null };
      }
      case 'service_area': {
        const cities = ((params.cities as string[] | undefined) ?? [job.locationCity].filter(Boolean)) as string[];
        const label = `Works in ${cities.join(', ')}`;
        const known = [candidate.city, ...candidate.preferredAreas].filter(Boolean).map(value => String(value).toLowerCase());
        if (!known.length) return { ...base, label, result: 'not_recorded', evidence: 'No location recorded', provenance: null, lastVerifiedAt: null };
        const hit = cities.some(city => known.includes(city.toLowerCase()));
        return { ...base, label, result: hit ? 'meets' : 'does_not_meet', evidence: `Based in ${candidate.city ?? 'unknown'}; areas: ${candidate.preferredAreas.join(', ') || 'none listed'}`, provenance: 'self_reported', lastVerifiedAt: null };
      }
      case 'max_children': {
        const count = Number(params.count ?? job.childrenCount ?? 1);
        const label = `Has cared for ${count}+ children at once`;
        if (candidate.maxChildrenCared === null) return { ...base, label, result: 'not_recorded', evidence: 'Not recorded', provenance: null, lastVerifiedAt: null };
        return { ...base, label, result: candidate.maxChildrenCared >= count ? 'meets' : 'does_not_meet', evidence: `${candidate.maxChildrenCared} children`, provenance: verification('max_children_cared')?.provenance ?? 'self_reported', lastVerifiedAt: verification('max_children_cared')?.verifiedAt ?? null };
      }
      case 'schedule_availability': {
        const label = 'Available for the job schedule';
        if (!windows.length) return { ...base, label, result: 'not_recorded', evidence: 'The job has no schedule windows', provenance: null, lastVerifiedAt: null };
        if (!availability.length) return { ...base, label, result: 'not_recorded', evidence: 'No weekly availability recorded', provenance: null, lastVerifiedAt: null };
        const gaps = windows.filter(w => !availability.some(a => a.dayOfWeek === w.dayOfWeek && a.startMinute <= w.startMinute && a.endMinute >= w.endMinute));
        return {
          ...base, label,
          result: gaps.length ? 'does_not_meet' : 'meets',
          evidence: gaps.length ? `Not available: ${gaps.map(g => `day ${g.dayOfWeek} ${minutesToHhmm(g.startMinute)}-${minutesToHhmm(g.endMinute)}`).join('; ')}` : 'Covers every scheduled window',
          provenance: 'self_reported',
          lastVerifiedAt: candidate.availabilityConfirmedAt
        };
      }
      case 'compensation_within_budget': {
        const label = 'Expected pay within budget';
        if (job.compensationMaxMinor === null || !job.compensationCurrency) return { ...base, label, result: 'not_recorded', evidence: 'The job has no budget maximum', provenance: null, lastVerifiedAt: null };
        if (candidate.compensationMinMinor === null || !candidate.compensationCurrency) return { ...base, label, result: 'not_recorded', evidence: 'Candidate expectation not recorded', provenance: null, lastVerifiedAt: null };
        if (candidate.compensationCurrency !== job.compensationCurrency || candidate.compensationPeriod !== job.compensationPeriod) {
          return { ...base, label, result: 'not_recorded', evidence: `Not comparable: candidate per ${candidate.compensationPeriod} ${candidate.compensationCurrency}, job per ${job.compensationPeriod} ${job.compensationCurrency}`, provenance: 'self_reported', lastVerifiedAt: null };
        }
        return { ...base, label, result: candidate.compensationMinMinor <= job.compensationMaxMinor ? 'meets' : 'does_not_meet', evidence: `Candidate minimum ${candidate.compensationMinMinor / 100} vs budget ${job.compensationMaxMinor / 100} ${job.compensationCurrency}/${job.compensationPeriod}`, provenance: 'self_reported', lastVerifiedAt: null };
      }
      default:
        return { ...base, label: c.criterion, result: 'not_recorded', evidence: 'Unsupported criterion', provenance: null, lastVerifiedAt: null };
    }
  });

  const count = (importance: string, result?: Result) => rows.filter(r => r.importance === importance && (!result || r.result === result)).length;
  return {
    jobOrderId,
    candidateId,
    asOfDate: today,
    rows,
    summary: {
      requiredMet: count('required', 'meets'),
      requiredTotal: count('required'),
      preferredMet: count('preferred', 'meets'),
      preferredTotal: count('preferred'),
      notRecorded: rows.filter(r => r.result === 'not_recorded').length
    }
  };
}

export const windowsToRows = (jobOrderId: string, windows: Array<{ dayOfWeek: number; start: string; end: string }>) =>
  windows.map(w => ({ jobOrderId, dayOfWeek: w.dayOfWeek, startMinute: hhmmToMinutes(w.start), endMinute: hhmmToMinutes(w.end) }));
