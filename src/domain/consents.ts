import type { Config } from '../config.js';
import type { Executor } from '../db/index.js';
import { unavailable } from '../http/errors.js';

export type NoticeKey =
  | 'privacy_notice' | 'application_terms' | 'reference_authorization' | 'background_authorization'
  | 'marketing_consent' | 'presentation_sharing' | 'family_terms';

export const CONSENT_NOTICE: Record<string, NoticeKey> = {
  privacy_notice: 'privacy_notice',
  accuracy_attestation: 'application_terms',
  reference_contact_authorization: 'reference_authorization',
  background_check_authorization: 'background_authorization',
  marketing_email: 'marketing_consent',
  presentation_sharing: 'presentation_sharing',
  family_terms: 'family_terms'
};

/**
 * The notice version a consent is recorded against. In staging/production a published notice is
 * required, so forms cannot collect real submissions against placeholder wording. Locally the
 * latest draft is used and marked as a placeholder in the consent evidence.
 */
export async function noticeFor(db: Executor, config: Config, key: NoticeKey) {
  const published = await db
    .selectFrom('legalNotices')
    .select(['id', 'version', 'title'])
    .where('noticeKey', '=', key)
    .where('status', '=', 'published')
    .executeTakeFirst();
  if (published) return { ...published, placeholder: false };
  if (config.isDeployed) throw unavailable('Submissions open once the agency publishes its notices.', 'notice_not_published');
  const draft = await db
    .selectFrom('legalNotices')
    .select(['id', 'version', 'title'])
    .where('noticeKey', '=', key)
    .orderBy('createdAt', 'desc')
    .executeTakeFirst();
  if (!draft) throw unavailable('Submissions are not available right now.', 'notice_missing');
  return { ...draft, placeholder: true };
}
