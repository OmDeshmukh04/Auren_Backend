import { sql, type Expression, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { Executor } from '../../db/index.js';
import { AgeGroup, Arrangement, CompensationPeriod, CurrencyCode, DateOnly, ScheduleType, WeeklyWindow, hhmmToMinutes } from '../../http/schemas.js';
import { AvailabilityStatus, EducationLevel, LanguageCode, Proficiency, RecruitmentStage } from './schemas.js';
import { likeEscape } from '../../domain/records.js';

/**
 * Combined candidate search. Dimensions combine with AND; values inside a dimension combine with
 * OR unless `match: "all"` is given. Unknown (null) values never satisfy a filter: a missing CPR
 * expiry is not "current CPR", an unrecorded driving status is not "drives".
 */

const Match = z.enum(['any', 'all']).default('any');
const EDUCATION_ORDER = ['none', 'high_school', 'some_college', 'associate', 'bachelor', 'master', 'doctorate'];
const PROFICIENCY_ORDER = ['basic', 'conversational', 'fluent', 'native'];

export const SearchCriteria = z
  .object({
    text: z.string().trim().max(120).optional().meta({ description: 'Name, email, reference, city or introduction contains this text.' }),
    recruitmentStages: z.array(RecruitmentStage).max(11).optional(),
    availability: z.array(AvailabilityStatus).max(4).optional(),
    availableBy: DateOnly.optional().meta({ description: 'Available now, or from a date on or before this date.' }),
    location: z
      .object({
        cities: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
        states: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
        includePreferredAreas: z.boolean().default(true).meta({ description: 'Also match the candidate\'s preferred work areas.' })
      })
      .optional()
      .meta({ description: 'Area filter. Distance matching is not offered until geocoding is configured.' }),
    minProfessionalNannyYears: z.number().min(0).max(70).optional(),
    minChildcareYears: z.number().min(0).max(70).optional(),
    ageGroups: z.object({ values: z.array(AgeGroup).min(1), match: Match }).optional(),
    minChildrenCared: z.int().min(1).max(20).optional(),
    currentQualifications: z
      .object({ keys: z.array(z.string()).min(1), match: z.enum(['any', 'all']).default('all') })
      .optional()
      .meta({ description: 'Verified and unexpired (agency-local today). Include equivalent keys, e.g. ["cpr","pediatric_cpr_first_aid"] with match "any".' }),
    qualificationGroups: z
      .array(z.array(z.string()).min(1))
      .max(10)
      .optional()
      .meta({ description: 'Each group must be satisfied by at least one current qualification (e.g. [["cpr","pediatric_cpr_first_aid"],["first_aid","pediatric_cpr_first_aid"]]).' }),
    minEducationLevel: EducationLevel.optional(),
    languages: z.object({ codes: z.array(LanguageCode).min(1), minProficiency: Proficiency.default('conversational'), match: Match }).optional(),
    skills: z.object({ keys: z.array(z.string()).min(1), match: Match }).optional(),
    drivingEligible: z.boolean().optional(),
    hasVehicle: z.boolean().optional(),
    willingToTravel: z.boolean().optional(),
    arrangement: z.enum(['live_in', 'live_out']).optional().meta({ description: 'Candidate wants this arrangement or "either".' }),
    scheduleTypes: z.object({ values: z.array(ScheduleType).min(1), match: Match }).optional(),
    scheduleWindows: z.array(WeeklyWindow).max(14).optional().meta({ description: 'Candidate availability must cover every window.' }),
    serviceTypes: z.array(z.string()).max(20).optional(),
    compensationWithin: z
      .object({ maxMinor: z.int().min(0), currency: CurrencyCode, period: CompensationPeriod })
      .optional()
      .meta({ description: 'Candidate minimum is at or below this amount. Only same currency and period compare; others are excluded as not comparable.' }),
    specialNeedsExperience: z.boolean().optional(),
    staffedHouseholdExperience: z.boolean().optional(),
    liveInExperience: z.boolean().optional(),
    referencesCompletedMin: z.int().min(1).max(10).optional(),
    checksReviewed: z.array(z.string()).max(10).optional().meta({ description: 'Screening check types reviewed as acceptable and not expired.' }),
    interviewRecommended: z.boolean().optional().meta({ description: 'Has a completed general interview recommended to advance.' }),
    custom: z
      .array(
        z.object({
          questionKey: z.string(),
          op: z.enum(['equals', 'in', 'gte', 'lte', 'is_true', 'is_false', 'contains_any']),
          value: z.union([z.string(), z.number(), z.array(z.string())]).optional()
        })
      )
      .max(10)
      .optional()
      .meta({ description: 'Filters on owner-defined questions marked filterable.' }),
    assignedStaffId: z.uuid().optional(),
    includeArchived: z.boolean().default(false),
    includeTest: z.boolean().default(false)
  })
  .meta({ id: 'CandidateSearchCriteria' });
export type SearchCriteriaT = z.infer<typeof SearchCriteria>;

type Where = Expression<SqlBool>;

/** Builds SQL predicates against alias "c" (candidates). `today` is agency-local. */
export function criteriaPredicates(criteria: SearchCriteriaT, today: string): Where[] {
  const where: Where[] = [sql<SqlBool>`c.merged_into_candidate_id is null`];
  if (!criteria.includeArchived) where.push(sql<SqlBool>`c.archived_at is null and c.recruitment_stage <> 'archived'`);
  if (!criteria.includeTest) where.push(sql<SqlBool>`not c.is_test`);
  if (criteria.text) {
    const term = `%${likeEscape(criteria.text)}%`;
    where.push(sql<SqlBool>`(c.first_name ilike ${term} or c.last_name ilike ${term} or (c.first_name || ' ' || c.last_name) ilike ${term}
      or c.email ilike ${term} or c.reference ilike ${term} or c.city ilike ${term} or c.introduction ilike ${term})`);
  }
  if (criteria.recruitmentStages?.length) where.push(sql<SqlBool>`c.recruitment_stage = any(${criteria.recruitmentStages}::text[])`);
  if (criteria.availability?.length) where.push(sql<SqlBool>`c.availability_status = any(${criteria.availability}::text[])`);
  if (criteria.availableBy) {
    where.push(sql<SqlBool>`(c.availability_status = 'available' or (c.availability_status = 'future_date' and c.available_from <= ${criteria.availableBy}::date))`);
  }
  if (criteria.location && (criteria.location.cities.length || criteria.location.states.length)) {
    const cities = criteria.location.cities.map(city => city.toLowerCase());
    const states = criteria.location.states.map(state => state.toLowerCase());
    const parts: Where[] = [];
    if (cities.length) {
      parts.push(sql<SqlBool>`lower(c.city) = any(${cities}::text[])`);
      if (criteria.location.includePreferredAreas) {
        parts.push(sql<SqlBool>`exists (select 1 from unnest(c.preferred_areas) a where lower(a) = any(${cities}::text[]))`);
      }
    }
    const cityClause = parts.length ? sql<SqlBool>`(${sql.join(parts, sql` or `)})` : sql<SqlBool>`true`;
    where.push(states.length ? sql<SqlBool>`(${cityClause} and lower(c.state) = any(${states}::text[]))` : cityClause);
  }
  if (criteria.minProfessionalNannyYears !== undefined) where.push(sql<SqlBool>`c.professional_nanny_years >= ${criteria.minProfessionalNannyYears}`);
  if (criteria.minChildcareYears !== undefined) where.push(sql<SqlBool>`c.childcare_years >= ${criteria.minChildcareYears}`);
  if (criteria.ageGroups) {
    where.push(criteria.ageGroups.match === 'all' ? sql<SqlBool>`c.age_groups @> ${criteria.ageGroups.values}::text[]` : sql<SqlBool>`c.age_groups && ${criteria.ageGroups.values}::text[]`);
  }
  if (criteria.minChildrenCared !== undefined) where.push(sql<SqlBool>`c.max_children_cared >= ${criteria.minChildrenCared}`);
  const currentQualification = (keys: string[]) => sql<SqlBool>`exists (
    select 1 from candidate_qualifications q join qualification_types t on t.key = q.qualification_key
    where q.candidate_id = c.id and q.qualification_key = any(${keys}::text[]) and q.review_state = 'verified'
      and (not t.has_expiry or (q.expires_on is not null and q.expires_on >= ${today}::date)))`;
  if (criteria.currentQualifications) {
    const { keys, match } = criteria.currentQualifications;
    if (match === 'any') where.push(currentQualification(keys));
    else for (const key of keys) where.push(currentQualification([key]));
  }
  for (const group of criteria.qualificationGroups ?? []) where.push(currentQualification(group));
  if (criteria.minEducationLevel) {
    const levels = EDUCATION_ORDER.slice(EDUCATION_ORDER.indexOf(criteria.minEducationLevel));
    where.push(sql<SqlBool>`c.education_level = any(${levels}::text[])`);
  }
  if (criteria.languages) {
    const levels = PROFICIENCY_ORDER.slice(PROFICIENCY_ORDER.indexOf(criteria.languages.minProficiency));
    const has = (codes: string[]) => sql<SqlBool>`exists (select 1 from candidate_languages l where l.candidate_id = c.id and l.language_code = any(${codes}::text[]) and l.proficiency = any(${levels}::text[]))`;
    if (criteria.languages.match === 'any') where.push(has(criteria.languages.codes));
    else for (const code of criteria.languages.codes) where.push(has([code]));
  }
  if (criteria.skills) {
    const has = (keys: string[]) => sql<SqlBool>`exists (select 1 from candidate_skills s where s.candidate_id = c.id and s.skill_key = any(${keys}::text[]))`;
    if (criteria.skills.match === 'any') where.push(has(criteria.skills.keys));
    else for (const key of criteria.skills.keys) where.push(has([key]));
  }
  for (const [flag, column] of [
    ['drivingEligible', 'driving_eligible'],
    ['hasVehicle', 'has_vehicle'],
    ['willingToTravel', 'willing_to_travel'],
    ['specialNeedsExperience', 'special_needs_experience'],
    ['staffedHouseholdExperience', 'staffed_household_experience'],
    ['liveInExperience', 'live_in_experience']
  ] as const) {
    const value = criteria[flag];
    if (value !== undefined) where.push(sql<SqlBool>`${sql.ref(`c.${column}`)} = ${value}`);
  }
  if (criteria.arrangement) where.push(sql<SqlBool>`c.desired_arrangement in (${criteria.arrangement}, 'either')`);
  if (criteria.scheduleTypes) {
    where.push(criteria.scheduleTypes.match === 'all' ? sql<SqlBool>`c.desired_schedule_types @> ${criteria.scheduleTypes.values}::text[]` : sql<SqlBool>`c.desired_schedule_types && ${criteria.scheduleTypes.values}::text[]`);
  }
  for (const window of criteria.scheduleWindows ?? []) {
    where.push(sql<SqlBool>`exists (select 1 from candidate_availability_windows w where w.candidate_id = c.id and w.day_of_week = ${window.dayOfWeek}
      and w.start_minute <= ${hhmmToMinutes(window.start)} and w.end_minute >= ${hhmmToMinutes(window.end)})`);
  }
  if (criteria.serviceTypes?.length) where.push(sql<SqlBool>`c.desired_service_types && ${criteria.serviceTypes}::text[]`);
  if (criteria.compensationWithin) {
    const { maxMinor, currency, period } = criteria.compensationWithin;
    where.push(sql<SqlBool>`(c.compensation_currency = ${currency} and c.compensation_period = ${period} and c.compensation_min_minor is not null and c.compensation_min_minor <= ${maxMinor})`);
  }
  if (criteria.referencesCompletedMin) {
    where.push(sql<SqlBool>`(select count(*) from candidate_references r where r.candidate_id = c.id and r.status = 'completed' and r.review_outcome = 'satisfactory') >= ${criteria.referencesCompletedMin}`);
  }
  for (const checkType of criteria.checksReviewed ?? []) {
    where.push(sql<SqlBool>`exists (select 1 from screening_checks s where s.candidate_id = c.id and s.check_type_key = ${checkType} and s.status = 'reviewed'
      and s.review_outcome = 'acceptable' and (s.valid_until is null or s.valid_until >= ${today}::date))`);
  }
  if (criteria.interviewRecommended) {
    where.push(sql<SqlBool>`exists (select 1 from interviews i join interview_evaluations e on e.interview_id = i.id where i.candidate_id = c.id
      and i.kind = 'general' and i.status = 'completed' and e.recommendation = 'advance')`);
  }
  for (const filter of criteria.custom ?? []) {
    const base = sql`select 1 from candidate_custom_answers a where a.candidate_id = c.id and a.question_key = ${filter.questionKey}`;
    switch (filter.op) {
      case 'equals':
        where.push(typeof filter.value === 'number'
          ? sql<SqlBool>`exists (${base} and a.value_number = ${filter.value})`
          : sql<SqlBool>`exists (${base} and lower(a.value_text) = lower(${String(filter.value ?? '')}))`);
        break;
      case 'in':
      case 'contains_any':
        where.push(sql<SqlBool>`exists (${base} and a.value_options && ${Array.isArray(filter.value) ? filter.value : [String(filter.value ?? '')]}::text[])`);
        break;
      case 'gte':
        where.push(sql<SqlBool>`exists (${base} and a.value_number >= ${Number(filter.value)})`);
        break;
      case 'lte':
        where.push(sql<SqlBool>`exists (${base} and a.value_number <= ${Number(filter.value)})`);
        break;
      case 'is_true':
      case 'is_false':
        where.push(sql<SqlBool>`exists (${base} and a.value_boolean = ${filter.op === 'is_true'})`);
        break;
    }
  }
  if (criteria.assignedStaffId) where.push(sql<SqlBool>`c.assigned_staff_id = ${criteria.assignedStaffId}`);
  return where;
}

/** Keys of verified, unexpired qualifications per candidate. */
export async function currentQualificationKeys(db: Executor, candidateIds: string[], today: string) {
  if (!candidateIds.length) return new Map<string, string[]>();
  const rows = await db
    .selectFrom('candidateQualifications as q')
    .innerJoin('qualificationTypes as t', 't.key', 'q.qualificationKey')
    .select(['q.candidateId', 'q.qualificationKey'])
    .where('q.candidateId', 'in', candidateIds)
    .where('q.reviewState', '=', 'verified')
    .where(eb => eb.or([eb('t.hasExpiry', '=', false), eb('q.expiresOn', '>=', today)]))
    .execute();
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.candidateId) ?? [];
    if (!list.includes(row.qualificationKey)) list.push(row.qualificationKey);
    map.set(row.candidateId, list);
  }
  return map;
}

export { Arrangement };
