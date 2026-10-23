import type { Executor } from '../db/index.js';

/**
 * Records possible duplicates for staff review. A matching email or phone is a suggestion only;
 * nothing is merged or overwritten automatically.
 */
async function recordPairs(db: Executor, entityType: 'family' | 'candidate', recordId: string, matches: Array<{ id: string; reason: string }>) {
  const byId = new Map<string, Set<string>>();
  for (const match of matches) {
    if (match.id === recordId) continue;
    if (!byId.has(match.id)) byId.set(match.id, new Set());
    byId.get(match.id)!.add(match.reason);
  }
  for (const [otherId, reasons] of byId) {
    const [a, b] = recordId < otherId ? [recordId, otherId] : [otherId, recordId];
    await db
      .insertInto('duplicateCases')
      .values({ entityType, firstRecordId: a, secondRecordId: b, matchReasons: [...reasons] })
      .onConflict(oc => oc.columns(['entityType', 'firstRecordId', 'secondRecordId']).doNothing())
      .execute();
  }
  return byId.size;
}

export async function detectFamilyDuplicates(db: Executor, familyId: string, email: string | null, phoneNormalized: string | null) {
  const matches: Array<{ id: string; reason: string }> = [];
  if (email) {
    const rows = await db
      .selectFrom('familyContacts as c')
      .innerJoin('families as f', 'f.id', 'c.familyId')
      .select('c.familyId')
      .where('c.email', '=', email)
      .where('f.mergedIntoFamilyId', 'is', null)
      .execute();
    matches.push(...rows.map(row => ({ id: row.familyId, reason: 'email' })));
  }
  if (phoneNormalized) {
    const rows = await db
      .selectFrom('familyContacts as c')
      .innerJoin('families as f', 'f.id', 'c.familyId')
      .select('c.familyId')
      .where('c.phoneNormalized', '=', phoneNormalized)
      .where('f.mergedIntoFamilyId', 'is', null)
      .execute();
    matches.push(...rows.map(row => ({ id: row.familyId, reason: 'phone' })));
  }
  return recordPairs(db, 'family', familyId, matches);
}

export async function detectCandidateDuplicates(db: Executor, candidateId: string, email: string, phoneNormalized: string | null) {
  const matches: Array<{ id: string; reason: string }> = [];
  const byEmail = await db.selectFrom('candidates').select('id').where('email', '=', email).where('mergedIntoCandidateId', 'is', null).execute();
  matches.push(...byEmail.map(row => ({ id: row.id, reason: 'email' })));
  if (phoneNormalized) {
    const byPhone = await db.selectFrom('candidates').select('id').where('phoneNormalized', '=', phoneNormalized).where('mergedIntoCandidateId', 'is', null).execute();
    matches.push(...byPhone.map(row => ({ id: row.id, reason: 'phone' })));
  }
  return recordPairs(db, 'candidate', candidateId, matches);
}
