import PDFDocument from 'pdfkit';
import type { Executor } from '../../db/index.js';
import { formatDate } from '../automation/subjects.js';

/**
 * Presentation content. Fields are default-deny: only keys in this catalogue can be included,
 * and each is built from a fixed, non-sensitive projection of the profile. Contact details,
 * addresses, references, notes, screening details, raw resumes and custom answers are never
 * reachable from here.
 */

export const PRESENTATION_FIELDS = [
  'introduction', 'experienceSummary', 'ageGroups', 'relevantExperience', 'qualifications', 'languages', 'skills',
  'education', 'driving', 'availability', 'compensation', 'rationale', 'photo'
] as const;
export type PresentationField = (typeof PRESENTATION_FIELDS)[number];

export const DEFAULT_FIELDS: PresentationField[] = ['introduction', 'experienceSummary', 'ageGroups', 'relevantExperience', 'qualifications', 'languages', 'availability', 'rationale'];

export interface CandidateOverrides {
  introduction?: string;
  rationale?: string;
  availabilityText?: string;
  compensationText?: string;
  /** Employment entry ids to show under relevant experience (default: all). */
  employmentIds?: string[];
}

const label = (value: string) => value.replace(/_/g, ' ');
const years = (value: number | null) => (value === null ? null : `${Number(value)} year${Number(value) === 1 ? '' : 's'}`);

function monthsBetween(start: string, end: string | null, today: string) {
  const s = new Date(start);
  const e = new Date(end ?? today);
  const months = Math.max(0, (e.getFullYear() - s.getFullYear()) * 12 + e.getMonth() - s.getMonth());
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} yr` : null, m ? `${m} mo` : null].filter(Boolean).join(' ') || 'under 1 mo';
}

export async function buildCandidateContent(
  db: Executor,
  input: { candidateId: string; jobCandidateId: string; includedFields: string[]; overrides: CandidateOverrides; today: string }
) {
  const fields = new Set(input.includedFields.filter((f): f is PresentationField => (PRESENTATION_FIELDS as readonly string[]).includes(f)));
  const candidate = await db
    .selectFrom('candidates')
    .select([
      'id', 'firstName', 'lastName', 'preferredName', 'introduction', 'childcareYears', 'professionalNannyYears', 'ageGroups', 'educationLevel',
      'drivingEligible', 'hasVehicle', 'availabilityStatus', 'availableFrom', 'earliestStartDate', 'desiredScheduleTypes', 'compensationMinMinor',
      'compensationMaxMinor', 'compensationCurrency', 'compensationPeriod', 'presentationPhotoDocumentId'
    ])
    .where('id', '=', input.candidateId)
    .executeTakeFirstOrThrow();
  const jobCandidate = await db.selectFrom('jobCandidates').select('rationale').where('id', '=', input.jobCandidateId).executeTakeFirstOrThrow();
  const first = candidate.preferredName || candidate.firstName;
  const content: Record<string, unknown> = { displayName: `${first} ${candidate.lastName.charAt(0)}.` };

  if (fields.has('introduction')) content.introduction = input.overrides.introduction ?? candidate.introduction ?? null;
  if (fields.has('experienceSummary')) {
    content.experienceSummary = [
      candidate.professionalNannyYears !== null ? `${years(candidate.professionalNannyYears)} as a professional nanny` : null,
      candidate.childcareYears !== null ? `${years(candidate.childcareYears)} of childcare experience` : null
    ].filter(Boolean).join('; ') || null;
  }
  if (fields.has('ageGroups')) content.ageGroups = candidate.ageGroups.map(label);
  if (fields.has('relevantExperience')) {
    let rows = await db
      .selectFrom('candidateEmployments')
      .select(['id', 'roleTitle', 'employmentType', 'startDate', 'endDate', 'isCurrent', 'ageGroups', 'liveIn', 'staffedHousehold'])
      .where('candidateId', '=', input.candidateId)
      .orderBy('startDate', 'desc')
      .execute();
    if (input.overrides.employmentIds?.length) rows = rows.filter(row => input.overrides.employmentIds!.includes(row.id));
    // Employer descriptions are omitted: they can identify other families.
    content.relevantExperience = rows.map(row => ({
      role: row.roleTitle,
      setting: label(row.employmentType),
      duration: monthsBetween(row.startDate, row.isCurrent ? null : row.endDate, input.today),
      current: row.isCurrent,
      ageGroups: row.ageGroups.map(label),
      details: [row.liveIn ? 'live-in' : null, row.staffedHousehold ? 'staffed household' : null].filter(Boolean)
    }));
  }
  if (fields.has('qualifications')) {
    const rows = await db
      .selectFrom('candidateQualifications as q')
      .innerJoin('qualificationTypes as t', 't.key', 'q.qualificationKey')
      .select(['t.label', 't.hasExpiry', 'q.expiresOn'])
      .where('q.candidateId', '=', input.candidateId)
      .where('q.reviewState', '=', 'verified')
      .execute();
    content.qualifications = rows
      .filter(row => !row.hasExpiry || (row.expiresOn !== null && row.expiresOn >= input.today))
      .map(row => ({ name: row.label, validThrough: row.expiresOn ? row.expiresOn.slice(0, 7) : null, verified: true }));
  }
  if (fields.has('languages')) {
    content.languages = (await db.selectFrom('candidateLanguages').select(['languageCode', 'proficiency']).where('candidateId', '=', input.candidateId).execute()).map(l => ({ language: l.languageCode, proficiency: l.proficiency }));
  }
  if (fields.has('skills')) {
    content.skills = (await db.selectFrom('candidateSkills as s').innerJoin('skills as k', 'k.key', 's.skillKey').select('k.label').where('s.candidateId', '=', input.candidateId).execute()).map(s => s.label);
  }
  if (fields.has('education')) content.education = candidate.educationLevel ? label(candidate.educationLevel) : null;
  if (fields.has('driving')) {
    content.driving = candidate.drivingEligible === null ? null : candidate.drivingEligible ? (candidate.hasVehicle ? 'Drives, has own vehicle' : 'Drives') : 'Does not drive';
  }
  if (fields.has('availability')) {
    content.availability = input.overrides.availabilityText ?? [
      candidate.availabilityStatus === 'available' ? 'Available now' : candidate.availabilityStatus === 'future_date' && candidate.availableFrom ? `Available from ${formatDate(candidate.availableFrom)}` : null,
      candidate.desiredScheduleTypes.length ? `Seeking ${candidate.desiredScheduleTypes.map(label).join(', ')}` : null
    ].filter(Boolean).join('. ');
  }
  if (fields.has('compensation')) {
    const range = candidate.compensationCurrency && candidate.compensationMinMinor !== null
      ? `${candidate.compensationCurrency} ${(candidate.compensationMinMinor / 100).toFixed(0)}${candidate.compensationMaxMinor ? `–${(candidate.compensationMaxMinor / 100).toFixed(0)}` : '+'} per ${candidate.compensationPeriod}`
      : null;
    content.compensation = input.overrides.compensationText ?? range;
  }
  if (fields.has('rationale')) content.rationale = input.overrides.rationale ?? jobCandidate.rationale ?? null;
  if (fields.has('photo') && candidate.presentationPhotoDocumentId) {
    const photo = await db.selectFrom('documents').select(['id', 'scanStatus', 'detectedType']).where('id', '=', candidate.presentationPhotoDocumentId).where('deletedAt', 'is', null).executeTakeFirst();
    content.photoDocumentId = photo?.scanStatus === 'clean' && (photo.detectedType === 'jpg' || photo.detectedType === 'png') ? photo.id : null;
  }
  return content;
}

/** Removes EXIF/metadata segments (APP1–APP15, COM) from a JPEG before embedding. */
export function stripJpegMetadata(bytes: Buffer): Buffer {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const parts: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    if (marker === 0xda) break; // start of scan: the rest is image data
    const length = bytes.readUInt16BE(offset + 2);
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) parts.push(bytes.subarray(offset, offset + 2 + length));
    offset += 2 + length;
  }
  parts.push(bytes.subarray(offset));
  return Buffer.concat(parts);
}

export interface PdfCandidate {
  content: Record<string, unknown>;
  photo?: Buffer | null;
}

/** Branded PDF for one approved snapshot. Only the snapshot content is rendered. */
export async function renderPresentationPdf(input: { agencyName: string; title: string; familyName: string; coverNote: string | null; reference: string; approvedAt: string; candidates: PdfCandidate[] }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: input.title, Author: input.agencyName, Subject: `Confidential candidate presentation ${input.reference}` } });
  const chunks: Buffer[] = [];
  doc.on('data', chunk => chunks.push(chunk as Buffer));
  const done = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const ink = '#031211';
  const teal = '#00AEBB';

  doc.fillColor(ink).font('Helvetica-Bold').fontSize(22).text(input.agencyName);
  doc.moveDown(0.3).font('Helvetica').fontSize(14).fillColor(teal).text(input.title);
  doc.moveDown(0.3).fontSize(10).fillColor('#555555').text(`Prepared for ${input.familyName} · Ref. ${input.reference} · ${formatDate(input.approvedAt.slice(0, 10))}`);
  doc.moveDown(0.6).fontSize(9).fillColor('#777777').text('Confidential. Prepared for the named family only. Please do not forward or share these profiles.');
  if (input.coverNote) doc.moveDown().fontSize(11).fillColor(ink).text(input.coverNote);

  const section = (heading: string, body: string | string[] | null | undefined) => {
    if (body === null || body === undefined || (Array.isArray(body) && body.length === 0) || body === '') return;
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11).fillColor(teal).text(heading);
    doc.font('Helvetica').fontSize(10.5).fillColor(ink);
    if (Array.isArray(body)) body.forEach(line => doc.text(`•  ${line}`, { indent: 6 }));
    else doc.text(body);
  };

  for (const { content, photo } of input.candidates) {
    doc.addPage();
    if (photo) {
      try {
        doc.image(photo, doc.page.width - 54 - 110, 54, { fit: [110, 130] });
      } catch {
        // An unreadable image is skipped rather than failing the whole presentation.
      }
    }
    doc.font('Helvetica-Bold').fontSize(18).fillColor(ink).text(String(content.displayName ?? ''), 54, 54, { width: doc.page.width - 54 * 2 - (photo ? 120 : 0) });
    section('Why we recommend them', content.rationale as string);
    section('Introduction', content.introduction as string);
    section('Experience', content.experienceSummary as string);
    section('Age groups', content.ageGroups as string[]);
    const experience = content.relevantExperience as Array<{ role: string; setting: string; duration: string; current: boolean; ageGroups: string[]; details: string[] }> | undefined;
    if (experience?.length) {
      section('Relevant roles', experience.map(e => `${e.role} (${e.setting}), ${e.duration}${e.current ? ', current' : ''}${e.ageGroups.length ? ` — ${e.ageGroups.join(', ')}` : ''}${e.details.length ? `; ${e.details.join(', ')}` : ''}`));
    }
    const qualifications = content.qualifications as Array<{ name: string; validThrough: string | null }> | undefined;
    if (qualifications) section('Verified qualifications', qualifications.map(q => (q.validThrough ? `${q.name} (valid through ${q.validThrough})` : q.name)));
    const languages = content.languages as Array<{ language: string; proficiency: string }> | undefined;
    if (languages) section('Languages', languages.map(l => `${l.language.toUpperCase()} — ${l.proficiency}`));
    section('Skills', content.skills as string[]);
    section('Education', content.education as string);
    section('Driving', content.driving as string);
    section('Availability', content.availability as string);
    section('Compensation expectations', content.compensation as string);
  }
  doc.end();
  return done;
}
