import { sql } from 'kysely';
import { z } from 'zod';
import { defineRoute, RawResponse, type AnyRoute } from '../../http/route.js';
import { Timestamp, Version } from '../../http/schemas.js';
import { conflict, notFound, unprocessable, versionConflict } from '../../http/errors.js';
import { pendingMigrations } from '../../db/migrate.js';
import { getSettings, invalidateSettings } from '../../domain/settings.js';
import { audit, changedFields } from '../../domain/audit.js';
import { buildOpenApi } from '../../http/openapi.js';
import { allRoutes } from '../../routes.js';
import { API_VERSION } from '../../version.js';

const Taxonomy = z.object({ key: z.string(), label: z.string(), active: z.boolean(), sortOrder: z.int() });
const StageDefinition = z
  .object({
    dimension: z.string(),
    key: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    sortOrder: z.int(),
    active: z.boolean(),
    required: z.boolean(),
    isTerminal: z.boolean(),
    manualEntry: z.boolean().meta({ description: 'False when only a dedicated command can enter this stage.' }),
    allowedNext: z.array(z.string())
  })
  .meta({ id: 'StageDefinition' });

export const ReferenceData = z
  .object({
    serviceTypes: z.array(Taxonomy.extend({ description: z.string().nullable() })),
    qualificationTypes: z.array(Taxonomy.extend({ category: z.string(), hasExpiry: z.boolean(), requiresReview: z.boolean() })),
    skills: z.array(Taxonomy.extend({ category: z.string() })),
    screeningCheckTypes: z.array(Taxonomy.extend({ description: z.string().nullable(), requiresAuthorization: z.boolean(), validityMonths: z.int().nullable() })),
    stages: z.array(StageDefinition),
    enums: z.record(z.string(), z.array(z.string())).meta({ description: 'Fixed value lists used by forms (age groups, schedule types, etc.).' })
  })
  .meta({ id: 'ReferenceData' });

export const ENUMS = {
  ageGroups: ['newborn', 'infant', 'toddler', 'preschool', 'school_age', 'teen'],
  childAgeBands: ['expecting', 'newborn', 'infant', 'toddler', 'preschool', 'school_age', 'teen'],
  scheduleTypes: ['full_time', 'part_time', 'temporary', 'overnight', 'weekend', 'evening', 'date_night', 'travel', 'rotational'],
  arrangements: ['live_in', 'live_out', 'either'],
  compensationPeriods: ['hour', 'day', 'week', 'month', 'year'],
  educationLevels: ['none', 'high_school', 'some_college', 'associate', 'bachelor', 'master', 'doctorate', 'other'],
  employmentTypes: ['private_household', 'agency', 'childcare_center', 'school', 'hospitality', 'other'],
  contactMethods: ['email', 'phone', 'text'],
  languageProficiency: ['basic', 'conversational', 'fluent', 'native'],
  provenance: ['self_reported', 'document_supplied', 'agency_verified'],
  referenceRelationships: ['employer_family', 'agency_supervisor', 'workplace_supervisor', 'colleague', 'teacher', 'other'],
  familyContactRelationships: ['parent', 'guardian', 'household_manager', 'family_office', 'assistant', 'other'],
  startTimings: ['asap', 'within_1_month', 'within_3_months', 'flexible', 'specific_date'],
  enquiryChannels: ['website', 'phone', 'email', 'referral', 'staff_entry', 'other']
};

const Settings = z
  .object({
    agencyName: z.string(),
    timezone: z.string(),
    defaultCurrency: z.string(),
    businessHours: z.record(z.string(), z.array(z.tuple([z.string(), z.string()]))),
    quietHours: z.object({ start: z.string(), end: z.string() }).nullable(),
    holidays: z.array(z.string()),
    notificationEmail: z.string().nullable(),
    replyToEmail: z.string().nullable(),
    requireStaffMfa: z.boolean(),
    coordinatorScope: z.enum(['agency', 'assigned']),
    draftExpiryDays: z.int(),
    draftFormChangePolicy: z.enum(['keep_version', 'migrate_on_resume']),
    automationPaused: z.boolean(),
    automationPausedReason: z.string().nullable(),
    staleMessageHours: z.int(),
    dailyDigestTime: z.string(),
    uploadMaxBytes: z.int(),
    allowedUploadTypes: z.array(z.string()),
    acceptingSubmissions: z.boolean(),
    branding: z.record(z.string(), z.unknown()),
    seoDefaults: z.record(z.string(), z.unknown()),
    version: Version,
    updatedAt: Timestamp
  })
  .meta({ id: 'AgencySettings' });

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const SettingsPatch = z.object({
  version: Version,
  agencyName: z.string().trim().min(1).max(120).optional(),
  businessHours: z.record(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), z.array(z.tuple([hhmm, hhmm]))).optional(),
  quietHours: z.object({ start: hhmm, end: hhmm }).nullable().optional(),
  holidays: z.array(z.iso.date()).max(100).optional(),
  notificationEmail: z.email().nullable().optional(),
  replyToEmail: z.email().nullable().optional(),
  requireStaffMfa: z.boolean().optional(),
  coordinatorScope: z.enum(['agency', 'assigned']).optional(),
  draftExpiryDays: z.int().min(1).max(365).optional(),
  draftFormChangePolicy: z.enum(['keep_version', 'migrate_on_resume']).optional(),
  staleMessageHours: z.int().min(1).max(720).optional(),
  dailyDigestTime: hhmm.optional(),
  uploadMaxBytes: z.int().min(1024).max(52428800).optional(),
  allowedUploadTypes: z.array(z.enum(['pdf', 'docx', 'jpg', 'png'])).min(1).optional(),
  acceptingSubmissions: z.boolean().optional(),
  branding: z.record(z.string(), z.unknown()).optional(),
  seoDefaults: z.record(z.string(), z.unknown()).optional()
});

const JSON_COLUMNS = new Set(['businessHours', 'quietHours', 'branding', 'seoDefaults']);

async function loadReferenceData(db: Parameters<typeof getSettings>[0], activeOnly: boolean) {
  const filter = <T extends { active: boolean }>(rows: T[]) => (activeOnly ? rows.filter(row => row.active) : rows);
  const [serviceTypes, qualificationTypes, skills, checkTypes, stages, rules] = await Promise.all([
    db.selectFrom('serviceTypes').select(['key', 'label', 'description', 'active', 'sortOrder']).orderBy('sortOrder').execute(),
    db.selectFrom('qualificationTypes').select(['key', 'label', 'category', 'hasExpiry', 'requiresReview', 'active', 'sortOrder']).orderBy('sortOrder').execute(),
    db.selectFrom('skills').select(['key', 'label', 'category', 'active', 'sortOrder']).orderBy('sortOrder').execute(),
    db.selectFrom('screeningCheckTypes').select(['key', 'label', 'description', 'requiresAuthorization', 'validityMonths', 'active', 'sortOrder']).orderBy('sortOrder').execute(),
    db.selectFrom('stageDefinitions').selectAll().orderBy('dimension').orderBy('sortOrder').execute(),
    db.selectFrom('stageTransitionRules').selectAll().execute()
  ]);
  return {
    serviceTypes: filter(serviceTypes),
    qualificationTypes: filter(qualificationTypes),
    skills: filter(skills),
    screeningCheckTypes: filter(checkTypes),
    stages: filter(stages).map(stage => ({
      ...stage,
      allowedNext: rules.filter(rule => rule.dimension === stage.dimension && rule.fromKey === stage.key).map(rule => rule.toKey)
    })),
    enums: ENUMS
  };
}

let openApiCache: unknown;

export const systemRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/health',
    operationId: 'health',
    summary: 'Service health',
    description: 'Returns 503 when the database is unreachable or migrations are pending.',
    tags: ['System'],
    access: { kind: 'public' },
    response: z.object({ ok: z.boolean(), service: z.string(), version: z.string(), database: z.enum(['ok', 'error']), pendingMigrations: z.array(z.string()), time: Timestamp }),
    async handler({ deps }) {
      let database: 'ok' | 'error' = 'ok';
      let pending: string[] = [];
      try {
        await sql`select 1`.execute(deps.db);
        pending = await pendingMigrations(deps.pool);
      } catch {
        database = 'error';
      }
      const body = { ok: database === 'ok' && pending.length === 0, service: 'auren-households-api', version: API_VERSION, database, pendingMigrations: pending, time: deps.clock.now().toISOString() };
      if (!body.ok) return new RawResponse(503, JSON.stringify(body), { 'Content-Type': 'application/json' });
      return body;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/openapi.json',
    operationId: 'openApiDocument',
    summary: 'This API contract (OpenAPI 3.1)',
    tags: ['System'],
    access: { kind: 'public' },
    response: z.unknown(),
    async handler({ deps }) {
      openApiCache ??= buildOpenApi(allRoutes(), { version: API_VERSION, serverUrl: deps.config.API_PUBLIC_URL });
      return new RawResponse(200, JSON.stringify(openApiCache), { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/public/reference-data',
    operationId: 'getPublicReferenceData',
    summary: 'Active service types and option lists for public forms',
    tags: ['Public'],
    access: { kind: 'public' },
    response: z.object({ serviceTypes: z.array(z.object({ key: z.string(), label: z.string(), description: z.string().nullable() })), qualificationTypes: z.array(z.object({ key: z.string(), label: z.string(), hasExpiry: z.boolean() })), skills: z.array(z.object({ key: z.string(), label: z.string() })), enums: z.record(z.string(), z.array(z.string())) }).meta({ id: 'PublicReferenceData' }),
    async handler({ deps }) {
      return loadReferenceData(deps.db, true);
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/reference-data',
    operationId: 'getReferenceData',
    summary: 'Taxonomies, stage labels/transitions and option lists for staff screens',
    tags: ['Settings'],
    access: { kind: 'staff', permission: null },
    query: z.object({ includeInactive: z.enum(['true', 'false']).optional() }),
    response: ReferenceData,
    async handler({ deps, query }) {
      return loadReferenceData(deps.db, query.includeInactive !== 'true');
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/settings',
    operationId: 'getAgencySettings',
    summary: 'Agency settings',
    tags: ['Settings'],
    access: { kind: 'staff', permission: 'settings.read' },
    response: Settings,
    async handler({ deps }) {
      return getSettings(deps.db, { fresh: true }) as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/settings',
    operationId: 'updateAgencySettings',
    summary: 'Update agency settings',
    tags: ['Settings'],
    access: { kind: 'staff', permission: 'settings.write' },
    body: SettingsPatch,
    response: Settings,
    async handler({ deps, meta, body }) {
      const { version, ...changes } = body;
      const updated = await deps.db.transaction().execute(async trx => {
        const current = await trx.selectFrom('agencySettings').selectAll().where('id', '=', 1).forUpdate().executeTakeFirstOrThrow();
        if (current.version !== version) throw versionConflict(current.version);
        const values: Record<string, unknown> = { version: current.version + 1 };
        for (const [key, value] of Object.entries(changes)) {
          if (value === undefined) continue;
          values[key] = JSON_COLUMNS.has(key) && value !== null ? JSON.stringify(value) : value;
        }
        await trx.updateTable('agencySettings').set(values).where('id', '=', 1).execute();
        await audit(trx, meta, { action: 'settings.updated', subjectType: 'agency_settings', subjectId: '1', metadata: { fields: changedFields(current as never, changes as never) } });
        return trx.selectFrom('agencySettings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
      });
      invalidateSettings(deps.db);
      return updated as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/settings/stages/:dimension/:key',
    operationId: 'updateStageDefinition',
    summary: 'Relabel, reorder or deactivate a stage',
    description: 'Keys are permanent. Required stages cannot be deactivated (422).',
    tags: ['Settings'],
    access: { kind: 'staff', permission: 'settings.write' },
    params: z.object({ dimension: z.string().max(40), key: z.string().max(40) }),
    body: z.object({ label: z.string().trim().min(1).max(80).optional(), description: z.string().max(500).nullable().optional(), sortOrder: z.int().optional(), active: z.boolean().optional() }),
    response: StageDefinition,
    async handler({ deps, meta, params, body }) {
      const current = await deps.db.selectFrom('stageDefinitions').selectAll().where('dimension', '=', params.dimension).where('key', '=', params.key).executeTakeFirst();
      if (!current) throw notFound('Stage');
      if (body.active === false && current.required) throw unprocessable('This stage is used by the system and cannot be turned off.', 'stage_required');
      const updated = await deps.db
        .updateTable('stageDefinitions')
        .set(body)
        .where('dimension', '=', params.dimension)
        .where('key', '=', params.key)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(deps.db, meta, { action: 'settings.stage_updated', subjectType: 'stage_definition', subjectId: `${params.dimension}:${params.key}`, metadata: { fields: Object.keys(body) } });
      const rules = await deps.db.selectFrom('stageTransitionRules').select('toKey').where('dimension', '=', params.dimension).where('fromKey', '=', params.key).execute();
      return { ...updated, allowedNext: rules.map(rule => rule.toKey) };
    }
  }),
  defineRoute({
    method: 'PUT',
    path: '/settings/taxonomies/:kind/:key',
    operationId: 'upsertTaxonomyItem',
    summary: 'Create or update a service type, qualification type, skill or check type',
    description: 'Keys are permanent identifiers (lowercase, underscores). Deactivate instead of deleting.',
    tags: ['Settings'],
    access: { kind: 'staff', permission: 'settings.write' },
    params: z.object({ kind: z.enum(['service_types', 'qualification_types', 'skills', 'screening_check_types']), key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/) }),
    body: z.object({
      label: z.string().trim().min(1).max(120),
      description: z.string().max(500).nullable().optional(),
      active: z.boolean().default(true),
      sortOrder: z.int().default(0),
      category: z.string().max(40).optional(),
      hasExpiry: z.boolean().optional(),
      requiresReview: z.boolean().optional(),
      requiresAuthorization: z.boolean().optional(),
      validityMonths: z.int().min(1).max(120).nullable().optional()
    }),
    response: z.object({ ok: z.literal(true), key: z.string() }),
    async handler({ deps, meta, params, body }) {
      const table = ({ service_types: 'serviceTypes', qualification_types: 'qualificationTypes', skills: 'skills', screening_check_types: 'screeningCheckTypes' } as const)[params.kind];
      const allowed: Record<string, string[]> = {
        serviceTypes: ['label', 'description', 'active', 'sortOrder'],
        qualificationTypes: ['label', 'category', 'hasExpiry', 'requiresReview', 'active', 'sortOrder'],
        skills: ['label', 'category', 'active', 'sortOrder'],
        screeningCheckTypes: ['label', 'description', 'requiresAuthorization', 'validityMonths', 'active', 'sortOrder']
      };
      const values = Object.fromEntries(Object.entries(body).filter(([key, value]) => allowed[table]!.includes(key) && value !== undefined));
      if (table === 'qualificationTypes' && !values.category) {
        const existing = await deps.db.selectFrom('qualificationTypes').select('category').where('key', '=', params.key).executeTakeFirst();
        if (!existing) throw unprocessable('category is required for a new qualification type.', 'category_required');
      }
      try {
        await deps.db
          .insertInto(table)
          .values({ key: params.key, ...values } as never)
          .onConflict(oc => oc.column('key').doUpdateSet(values as never))
          .execute();
      } catch (error) {
        if ((error as { code?: string }).code === '23514') throw conflict('The values are not valid for this list.', 'constraint_violation');
        throw error;
      }
      await audit(deps.db, meta, { action: 'settings.taxonomy_updated', subjectType: params.kind, subjectId: params.key, metadata: { fields: Object.keys(values) } });
      return { ok: true as const, key: params.key };
    }
  })
];
