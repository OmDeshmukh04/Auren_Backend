import type { Executor } from '../../db/index.js';
import { unprocessable } from '../../http/errors.js';

/**
 * Email templates use {{ variable.path }} placeholders from a fixed allowlist per template.
 * There is no logic in templates. Output is plain text.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)\s*\}\}/g;

export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map(match => match[1]!))];
}

export function assertTemplateVariables(subject: string, body: string, allowed: string[]) {
  const unknown = [...placeholdersIn(subject), ...placeholdersIn(body)].filter(name => !allowed.includes(name));
  if (unknown.length) {
    throw unprocessable(`Unknown template variables: ${unknown.join(', ')}`, 'unknown_template_variables', { unknown, allowed });
  }
}

export function render(text: string, variables: Record<string, string | number | null | undefined>) {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = variables[name];
    return value === null || value === undefined ? '' : String(value);
  });
}

export const renderSubject = (text: string, variables: Record<string, string | number | null | undefined>) =>
  render(text, variables).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);

export async function publishedTemplate(db: Executor, key: string) {
  return db
    .selectFrom('emailTemplates as t')
    .innerJoin('emailTemplateVersions as v', join => join.onRef('v.id', '=', 't.currentVersionId').on('v.status', '=', 'published'))
    .select(['t.id as templateId', 't.key', 't.category', 't.allowedVariables', 'v.id as versionId', 'v.subject', 'v.bodyText'])
    .where('t.key', '=', key)
    .executeTakeFirst();
}
