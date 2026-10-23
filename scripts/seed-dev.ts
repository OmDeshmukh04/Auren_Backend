import { getConfig } from '../src/config.js';
import { closeDeps, createDeps } from '../src/deps.js';
import { systemMeta } from '../src/context.js';
import { createFamily } from '../src/modules/families/service.js';
import { createCandidate } from '../src/modules/candidates/service.js';
import { createJob } from '../src/modules/jobs/service.js';

/**
 * Synthetic local data for frontend work. Every record is fictional (example.invalid addresses)
 * and flagged as test data where the schema allows. Refused outside development.
 *
 *   npm run db:seed
 */
const config = getConfig();
if (config.APP_ENV !== 'development') {
  console.error('db:seed only runs with APP_ENV=development.');
  process.exit(1);
}
const deps = createDeps(config);
const now = new Date();
const meta = systemMeta('seed', now);
try {
  const owner = await deps.db.selectFrom('staffMembers').select(['id', 'userId', 'email', 'displayName']).where('role', '=', 'owner').executeTakeFirst();
  if (!owner) throw new Error('Create the owner first: npm run owner:create -- --email ... --name ...');
  const existing = await deps.db.selectFrom('candidates').select('id').where('email', '=', 'candidate1@example.invalid').executeTakeFirst();
  if (existing) {
    console.log('Synthetic data already present; nothing to do.');
  } else {
    const staff = { type: 'staff' as const, staffId: owner.id, userId: owner.userId, sessionId: 'seed', email: owner.email, displayName: owner.displayName, role: 'owner' as const, permissions: new Set<never>(), mfaEnabled: false };
    const staffMeta = { ...meta, actor: staff };
    const families = [];
    for (const [i, city] of ['Denver', 'Boulder', 'Lakewood'].entries()) {
      families.push(await createFamily(deps, staffMeta, { displayName: `Sample Family ${i + 1}`, city, state: 'CO', primaryContact: { firstName: `Parent${i + 1}`, lastName: 'Sample', email: `family${i + 1}@example.invalid`, relationship: 'parent', isPrimary: true, authorizedRecipient: true } }));
    }
    const people = [
      { firstName: 'Avery', city: 'Denver', professionalNannyYears: 7, childcareYears: 10, ageGroups: ['newborn', 'infant', 'toddler'] },
      { firstName: 'Jordan', city: 'Denver', professionalNannyYears: 5, childcareYears: 6, ageGroups: ['infant', 'toddler', 'preschool'] },
      { firstName: 'Riley', city: 'Boulder', professionalNannyYears: 3, childcareYears: 8, ageGroups: ['school_age', 'teen'] },
      { firstName: 'Casey', city: 'Lakewood', professionalNannyYears: 9, childcareYears: 12, ageGroups: ['newborn', 'infant'] },
      { firstName: 'Morgan', city: 'Aurora', professionalNannyYears: null, childcareYears: 2, ageGroups: ['toddler'] }
    ];
    for (const [i, person] of people.entries()) {
      await createCandidate(deps, staffMeta, {
        ...person,
        lastName: 'Sample',
        email: `candidate${i + 1}@example.invalid`,
        state: 'CO',
        desiredScheduleTypes: i % 2 ? ['part_time'] : ['full_time'],
        desiredServiceTypes: ['nanny'],
        drivingEligible: i !== 2,
        introduction: `Synthetic profile ${i + 1} for local development.`,
        compensation: { minMinor: 2800 + i * 200, maxMinor: 3600 + i * 200, currency: 'USD', period: 'hour' }
      } as never);
    }
    for (const [i, family] of families.entries()) {
      await createJob(deps, staffMeta, staff as never, {
        familyId: family.id,
        title: ['Full-time nanny for two', 'After-school nanny', 'Newborn care support'][i]!,
        serviceTypeKey: i === 2 ? 'newborn_care' : 'nanny',
        scheduleTypes: [i === 1 ? 'part_time' : 'full_time'],
        locationCity: family.city,
        criteria: [
          { importance: 'required', criterion: 'min_professional_nanny_years', params: { years: 3 }, sortOrder: 0 },
          { importance: 'required', criterion: 'qualification_current', params: { qualifications: ['cpr', 'pediatric_cpr_first_aid'] }, sortOrder: 1 }
        ],
        scheduleWindows: [{ dayOfWeek: 1, start: '08:00', end: '17:00' }]
      });
    }
    await deps.db.updateTable('families').set({ isTest: true }).where('displayName', 'like', 'Sample Family %').execute();
    await deps.db.updateTable('candidates').set({ isTest: false }).where('email', 'like', 'candidate%@example.invalid').execute();
    console.log('Seeded 3 families, 5 candidates and 3 jobs (synthetic).');
  }
  // Local development convenience: make the suggested screening policy active so eligibility can be exercised.
  const active = await deps.db.selectFrom('screeningPolicies').select('id').where('status', '=', 'active').executeTakeFirst();
  if (!active) {
    await deps.db.updateTable('screeningPolicies').set({ status: 'active', publishedAt: now.toISOString() }).where('versionNumber', '=', 1).where('status', '=', 'draft').execute();
    console.log('Activated the suggested screening policy (development only).');
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await closeDeps(deps);
}
