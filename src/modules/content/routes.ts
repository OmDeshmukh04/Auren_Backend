import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDeps, RequestMeta } from '../../context.js';
import type { Executor } from '../../db/index.js';
import { defineRoute, RawResponse, type AnyRoute } from '../../http/route.js';
import { Id, IdParams, Ok, Timestamp, Version } from '../../http/schemas.js';
import { conflict, notFound, unauthorized, unprocessable, validationFailed, zodFieldErrors } from '../../http/errors.js';
import { audit } from '../../domain/audit.js';
import { updateVersioned } from '../../domain/records.js';
import { API_PREFIX } from '../../http/register.js';
import { signPayload, verifySignedPayload } from '../../lib/crypto.js';
import { COLLECTIONS, mediaIdsIn, parseCollectionData, Seo, type Collection } from './schemas.js';

const CollectionParam = z.enum(COLLECTIONS as [Collection, ...Collection[]]);
const Slug = z.string().regex(/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/, 'Use lowercase letters, numbers, hyphens and slashes').max(160);

const Entry = z
  .object({
    id: Id, collection: CollectionParam, slug: z.string(), status: z.enum(['draft', 'published', 'archived']), sortOrder: z.int(),
    latestRevisionId: Id.nullable(), publishedRevisionId: Id.nullable(), publishedAt: Timestamp.nullable(),
    hasUnpublishedChanges: z.boolean(), title: z.string().nullable(), version: Version, createdAt: Timestamp, updatedAt: Timestamp
  })
  .meta({ id: 'ContentEntry' });
const Revision = z
  .object({ id: Id, entryId: Id, revisionNumber: z.int(), title: z.string(), data: z.unknown(), seo: z.unknown(), changeNote: z.string().nullable(), authorStaffId: Id.nullable(), restoredFromRevisionId: Id.nullable(), createdAt: Timestamp })
  .meta({ id: 'ContentRevision' });
const PublicEntry = z
  .object({ slug: z.string(), collection: z.string(), title: z.string(), data: z.unknown(), seo: z.unknown(), sortOrder: z.int(), publishedAt: Timestamp.nullable(), updatedAt: Timestamp, preview: z.boolean() })
  .meta({ id: 'PublishedContent', description: 'Only published content (or a signed preview of a revision).' });
const Media = z
  .object({ id: Id, publicUrl: z.string().nullable(), contentType: z.string(), sizeBytes: z.int().nullable(), width: z.int().nullable(), height: z.int().nullable(), altText: z.string(), credit: z.string().nullable(), license: z.string().nullable(), sourceUrl: z.string().nullable(), status: z.string(), createdAt: Timestamp, version: Version })
  .meta({ id: 'PublicMedia' });

const entrySelect = (db: Executor) =>
  db
    .selectFrom('contentEntries as e')
    .leftJoin('contentRevisions as r', 'r.id', 'e.latestRevisionId')
    .select(['e.id', 'e.collection', 'e.slug', 'e.status', 'e.sortOrder', 'e.latestRevisionId', 'e.publishedRevisionId', 'e.publishedAt', 'e.version', 'e.createdAt', 'e.updatedAt', 'r.title']);

const toEntry = <T extends { latestRevisionId: string | null; publishedRevisionId: string | null }>(row: T) => ({ ...row, hasUnpublishedChanges: row.latestRevisionId !== row.publishedRevisionId });

async function assertMediaExists(db: Executor, data: unknown, seo: unknown) {
  const ids = [...mediaIdsIn(data), ...mediaIdsIn(seo)];
  if (!ids.length) return;
  const found = await db.selectFrom('publicMedia').select('id').where('id', 'in', ids).where('status', '=', 'ready').execute();
  const missing = ids.filter(id => !found.some(row => row.id === id));
  if (missing.length) throw validationFailed([{ path: 'data', code: 'invalid_media', message: `Unknown or unpublished media: ${missing.join(', ')}` }]);
}

function validateContent(collection: Collection, data: unknown, seo: unknown) {
  const parsed = parseCollectionData(collection, data);
  if (!parsed.success) throw validationFailed(zodFieldErrors(parsed.error, 'data'));
  const seoParsed = Seo.safeParse(seo ?? {});
  if (!seoParsed.success) throw validationFailed(zodFieldErrors(seoParsed.error, 'seo'));
  return { data: parsed.data, seo: seoParsed.data };
}

async function addRevision(db: Executor, meta: RequestMeta, entryId: string, input: { title: string; data: unknown; seo: unknown; changeNote?: string | null; restoredFrom?: string | null }) {
  const last = await db.selectFrom('contentRevisions').select(eb => eb.fn.max('revisionNumber').as('n')).where('entryId', '=', entryId).executeTakeFirst();
  const revision = await db
    .insertInto('contentRevisions')
    .values({
      entryId,
      revisionNumber: Number(last?.n ?? 0) + 1,
      title: input.title,
      data: JSON.stringify(input.data),
      seo: JSON.stringify(input.seo ?? {}),
      changeNote: input.changeNote ?? null,
      authorStaffId: meta.actor.type === 'staff' ? meta.actor.staffId : null,
      restoredFromRevisionId: input.restoredFrom ?? null,
      createdAt: meta.now.toISOString()
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return revision.id;
}

function previewToken(deps: AppDeps, revisionId: string) {
  const exp = Math.floor(deps.clock.now().getTime() / 1000) + 30 * 60;
  return { token: signPayload(deps.config.SIGNING_SECRET, { p: revisionId, exp }), expiresAt: new Date(exp * 1000).toISOString() };
}

const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' };

function detectMedia(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return 'video/mp4';
  }
  return null;
}

function imageSize(bytes: Buffer, type: string): { width: number; height: number } | null {
  if (type === 'image/png' && bytes.length > 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (type === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1]!;
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      offset += 2 + length;
    }
  }
  return null;
}

export const contentRoutes: AnyRoute[] = [
  // ---------------------------------------------------------------- public
  defineRoute({
    method: 'GET',
    path: '/public/content/:collection',
    operationId: 'listPublishedContent',
    summary: 'Published entries in a collection (pages, services, faqs, resources, globals)',
    tags: ['Public', 'Content'],
    access: { kind: 'public' },
    params: z.object({ collection: CollectionParam }),
    query: z.object({ category: z.string().max(80).optional() }),
    response: z.object({ items: z.array(PublicEntry) }),
    async handler({ deps, params, query }) {
      const rows = await deps.db
        .selectFrom('contentEntries as e')
        .innerJoin('contentRevisions as r', 'r.id', 'e.publishedRevisionId')
        .select(['e.slug', 'e.collection', 'r.title', 'r.data', 'r.seo', 'e.sortOrder', 'e.publishedAt', 'e.updatedAt'])
        .where('e.collection', '=', params.collection)
        .where('e.status', '=', 'published')
        .orderBy('e.sortOrder')
        .orderBy('r.title')
        .execute();
      const items = rows
        .filter(row => !query.category || (row.data as { category?: string }).category === query.category)
        .map(row => ({ ...row, preview: false }));
      return new RawResponse(200, JSON.stringify({ items }), { 'Content-Type': 'application/json', ...PUBLIC_CACHE });
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/public/content/:collection/by-slug',
    operationId: 'getPublishedContent',
    summary: 'One published entry by slug (or a draft revision with a signed preview token)',
    tags: ['Public', 'Content'],
    access: { kind: 'public' },
    params: z.object({ collection: CollectionParam }),
    query: z.object({ slug: Slug, preview: z.string().max(1000).optional() }),
    response: PublicEntry,
    async handler({ deps, params, query }) {
      let revisionId: string | null = null;
      if (query.preview) {
        const payload = verifySignedPayload<{ p: string; exp: number }>(deps.config.SIGNING_SECRET, query.preview, deps.clock.now().getTime());
        if (!payload) throw unauthorized('This preview link has expired.', 'preview_invalid');
        revisionId = payload.p;
      }
      const row = await deps.db
        .selectFrom('contentEntries as e')
        .innerJoin('contentRevisions as r', join => join.onRef('r.entryId', '=', 'e.id'))
        .select(['e.slug', 'e.collection', 'e.status', 'r.id as revisionId', 'r.title', 'r.data', 'r.seo', 'e.sortOrder', 'e.publishedAt', 'e.updatedAt', 'e.publishedRevisionId'])
        .where('e.collection', '=', params.collection)
        .where('e.slug', '=', query.slug)
        .where(eb => (revisionId ? eb('r.id', '=', revisionId) : eb.and([eb('e.status', '=', 'published'), eb('r.id', '=', eb.ref('e.publishedRevisionId'))])))
        .executeTakeFirst();
      if (!row) throw notFound('Page');
      const body = { slug: row.slug, collection: row.collection, title: row.title, data: row.data, seo: row.seo, sortOrder: row.sortOrder, publishedAt: row.publishedAt, updatedAt: row.updatedAt, preview: Boolean(revisionId) };
      return new RawResponse(200, JSON.stringify(body), { 'Content-Type': 'application/json', ...(revisionId ? { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } : PUBLIC_CACHE) });
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/public/media/:id',
    operationId: 'getPublicMediaFile',
    summary: 'Serve a public media file (when no public bucket URL is configured)',
    tags: ['Public', 'Content'],
    access: { kind: 'public' },
    params: IdParams,
    produces: 'application/octet-stream',
    response: z.unknown(),
    async handler({ deps, params }) {
      const media = await deps.db.selectFrom('publicMedia').select(['storageKey', 'contentType', 'status']).where('id', '=', params.id).executeTakeFirst();
      if (!media || media.status !== 'ready') throw notFound('Media');
      const bytes = await deps.publicStorage.get(media.storageKey);
      if (!bytes) throw notFound('Media');
      return new RawResponse(200, bytes, { 'Content-Type': media.contentType, 'Cache-Control': 'public, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    }
  }),

  // ---------------------------------------------------------------- staff
  defineRoute({
    method: 'GET',
    path: '/content/entries',
    operationId: 'listContentEntries',
    summary: 'Content entries with draft/published state',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.read' },
    query: z.object({ collection: CollectionParam.optional(), status: z.enum(['draft', 'published', 'archived']).optional(), q: z.string().max(120).optional() }),
    response: z.object({ items: z.array(Entry) }),
    async handler({ deps, query }) {
      let q = entrySelect(deps.db);
      if (query.collection) q = q.where('e.collection', '=', query.collection);
      if (query.status) q = q.where('e.status', '=', query.status);
      if (query.q) q = q.where(eb => eb.or([eb('e.slug', 'ilike', `%${query.q}%`), eb('r.title', 'ilike', `%${query.q}%`)]));
      const rows = await q.orderBy('e.collection').orderBy('e.sortOrder').orderBy('e.slug').execute();
      return { items: rows.map(toEntry) as never };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/content/entries',
    operationId: 'createContentEntry',
    summary: 'Create an entry with its first draft revision',
    description: 'The data shape depends on the collection (PageContent, ServiceContent, FaqContent, ResourceContent, GlobalContent).',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.write' },
    body: z.object({ collection: CollectionParam, slug: Slug, title: z.string().trim().min(1).max(200), data: z.unknown(), seo: z.unknown().optional(), sortOrder: z.int().default(0) }),
    response: Entry,
    status: 201,
    async handler({ deps, meta, staff, body }) {
      const content = validateContent(body.collection, body.data, body.seo);
      await assertMediaExists(deps.db, content.data, content.seo);
      const id = await deps.db.transaction().execute(async trx => {
        const existing = await trx.selectFrom('contentEntries').select('id').where('collection', '=', body.collection).where('slug', '=', body.slug).executeTakeFirst();
        if (existing) throw conflict('An entry with this slug already exists.', 'slug_taken');
        const entry = await trx.insertInto('contentEntries').values({ collection: body.collection, slug: body.slug, sortOrder: body.sortOrder, createdBy: staff.staffId, createdAt: meta.now.toISOString() }).returning('id').executeTakeFirstOrThrow();
        const revisionId = await addRevision(trx, meta, entry.id, { title: body.title, data: content.data, seo: content.seo });
        await trx.updateTable('contentEntries').set({ latestRevisionId: revisionId }).where('id', '=', entry.id).execute();
        await audit(trx, meta, { action: 'content.created', subjectType: 'content_entry', subjectId: entry.id, metadata: { collection: body.collection, slug: body.slug } });
        return entry.id;
      });
      return toEntry(await entrySelect(deps.db).where('e.id', '=', id).executeTakeFirstOrThrow()) as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/content/entries/:id',
    operationId: 'getContentEntry',
    summary: 'Entry with its latest revision and revision history',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.read' },
    params: IdParams,
    response: z.object({ entry: Entry, latest: Revision.nullable(), revisions: z.array(z.object({ id: Id, revisionNumber: z.int(), title: z.string(), changeNote: z.string().nullable(), authorStaffId: Id.nullable(), createdAt: Timestamp, published: z.boolean() })), publishHistory: z.array(z.object({ action: z.string(), revisionId: Id.nullable(), actorStaffId: Id.nullable(), occurredAt: Timestamp })) }),
    async handler({ deps, params }) {
      const entry = await entrySelect(deps.db).where('e.id', '=', params.id).executeTakeFirst();
      if (!entry) throw notFound('Entry');
      const [latest, revisions, history] = await Promise.all([
        entry.latestRevisionId ? deps.db.selectFrom('contentRevisions').selectAll().where('id', '=', entry.latestRevisionId).executeTakeFirst() : null,
        deps.db.selectFrom('contentRevisions').select(['id', 'revisionNumber', 'title', 'changeNote', 'authorStaffId', 'createdAt']).where('entryId', '=', params.id).orderBy('revisionNumber', 'desc').limit(100).execute(),
        deps.db.selectFrom('contentPublishEvents').select(['action', 'revisionId', 'actorStaffId', 'occurredAt']).where('entryId', '=', params.id).orderBy('occurredAt', 'desc').orderBy('id', 'desc').limit(50).execute()
      ]);
      return { entry: toEntry(entry), latest: latest ?? null, revisions: revisions.map(r => ({ ...r, published: r.id === entry.publishedRevisionId })), publishHistory: history } as never;
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/content/revisions/:id',
    operationId: 'getContentRevision',
    summary: 'One revision (for comparison or restore)',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.read' },
    params: IdParams,
    response: Revision,
    async handler({ deps, params }) {
      const row = await deps.db.selectFrom('contentRevisions').selectAll().where('id', '=', params.id).executeTakeFirst();
      if (!row) throw notFound('Revision');
      return row as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/content/entries/:id/revisions',
    operationId: 'saveContentRevision',
    summary: 'Save edits as a new draft revision',
    description: 'Send the revision you started from as baseRevisionId; if someone saved in the meantime the response is 409 revision_conflict.',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.write' },
    params: IdParams,
    body: z.object({ baseRevisionId: Id, title: z.string().trim().min(1).max(200), data: z.unknown(), seo: z.unknown().optional(), changeNote: z.string().max(300).optional() }),
    response: Entry,
    status: 201,
    async handler({ deps, meta, params, body }) {
      await deps.db.transaction().execute(async trx => {
        const entry = await trx.selectFrom('contentEntries').select(['collection', 'latestRevisionId', 'status']).where('id', '=', params.id).forUpdate().executeTakeFirst();
        if (!entry) throw notFound('Entry');
        if (entry.latestRevisionId !== body.baseRevisionId) throw conflict('Someone saved a newer version. Reload to see it before saving.', 'revision_conflict', { latestRevisionId: entry.latestRevisionId });
        const content = validateContent(entry.collection as Collection, body.data, body.seo);
        await assertMediaExists(trx, content.data, content.seo);
        const revisionId = await addRevision(trx, meta, params.id, { title: body.title, data: content.data, seo: content.seo, changeNote: body.changeNote });
        await trx.updateTable('contentEntries').set({ latestRevisionId: revisionId }).where('id', '=', params.id).execute();
        await audit(trx, meta, { action: 'content.revision_saved', subjectType: 'content_entry', subjectId: params.id });
      });
      return toEntry(await entrySelect(deps.db).where('e.id', '=', params.id).executeTakeFirstOrThrow()) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/content/entries/:id/publish',
    operationId: 'publishContentEntry',
    summary: 'Publish a revision (defaults to the latest)',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.publish' },
    params: IdParams,
    body: z.object({ revisionId: Id.optional() }),
    response: Entry,
    async handler({ deps, meta, staff, params, body }) {
      await deps.db.transaction().execute(async trx => {
        const entry = await trx.selectFrom('contentEntries').select(['latestRevisionId', 'collection']).where('id', '=', params.id).forUpdate().executeTakeFirst();
        if (!entry) throw notFound('Entry');
        const revisionId = body.revisionId ?? entry.latestRevisionId;
        const revision = revisionId ? await trx.selectFrom('contentRevisions').select(['id', 'data', 'seo']).where('id', '=', revisionId).where('entryId', '=', params.id).executeTakeFirst() : undefined;
        if (!revision) throw notFound('Revision');
        validateContent(entry.collection as Collection, revision.data, revision.seo);
        await assertMediaExists(trx, revision.data, revision.seo);
        await trx.updateTable('contentEntries').set({ status: 'published', publishedRevisionId: revision.id, publishedAt: meta.now.toISOString() }).where('id', '=', params.id).execute();
        await trx.insertInto('contentPublishEvents').values({ entryId: params.id, revisionId: revision.id, action: 'published', actorStaffId: staff.staffId, occurredAt: meta.now.toISOString() }).execute();
        await audit(trx, meta, { action: 'content.published', subjectType: 'content_entry', subjectId: params.id, metadata: { revisionId: revision.id } });
      });
      return toEntry(await entrySelect(deps.db).where('e.id', '=', params.id).executeTakeFirstOrThrow()) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/content/entries/:id/unpublish',
    operationId: 'unpublishContentEntry',
    summary: 'Take an entry off the public site (revisions are kept)',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.publish' },
    params: IdParams,
    body: z.object({ archive: z.boolean().default(false) }),
    response: Entry,
    async handler({ deps, meta, staff, params, body }) {
      const updated = await deps.db.updateTable('contentEntries').set({ status: body.archive ? 'archived' : 'draft', publishedRevisionId: null, publishedAt: null }).where('id', '=', params.id).returning('id').executeTakeFirst();
      if (!updated) throw notFound('Entry');
      await deps.db.insertInto('contentPublishEvents').values({ entryId: params.id, action: body.archive ? 'archived' : 'unpublished', actorStaffId: staff.staffId, occurredAt: meta.now.toISOString() }).execute();
      await audit(deps.db, meta, { action: body.archive ? 'content.archived' : 'content.unpublished', subjectType: 'content_entry', subjectId: params.id });
      return toEntry(await entrySelect(deps.db).where('e.id', '=', params.id).executeTakeFirstOrThrow()) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/content/entries/:id/restore',
    operationId: 'restoreContentRevision',
    summary: 'Copy an earlier revision into a new draft revision',
    description: 'Publish it afterwards to make it live.',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.write' },
    params: IdParams,
    body: z.object({ revisionId: Id }),
    response: Entry,
    async handler({ deps, meta, params, body }) {
      await deps.db.transaction().execute(async trx => {
        const old = await trx.selectFrom('contentRevisions').selectAll().where('id', '=', body.revisionId).where('entryId', '=', params.id).executeTakeFirst();
        if (!old) throw notFound('Revision');
        const revisionId = await addRevision(trx, meta, params.id, { title: old.title, data: old.data, seo: old.seo, changeNote: `Restored revision ${old.revisionNumber}`, restoredFrom: old.id });
        await trx.updateTable('contentEntries').set({ latestRevisionId: revisionId, status: 'draft' }).where('id', '=', params.id).where('status', '=', 'archived').execute();
        await trx.updateTable('contentEntries').set({ latestRevisionId: revisionId }).where('id', '=', params.id).execute();
        await trx.insertInto('contentPublishEvents').values({ entryId: params.id, revisionId, action: 'restored', actorStaffId: meta.actor.type === 'staff' ? meta.actor.staffId : null, occurredAt: meta.now.toISOString() }).execute();
        await audit(trx, meta, { action: 'content.restored', subjectType: 'content_entry', subjectId: params.id, metadata: { fromRevision: old.revisionNumber } });
      });
      return toEntry(await entrySelect(deps.db).where('e.id', '=', params.id).executeTakeFirstOrThrow()) as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/content/entries/:id',
    operationId: 'updateContentEntry',
    summary: 'Change slug or ordering',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.write' },
    params: IdParams,
    body: z.object({ version: Version, slug: Slug.optional(), sortOrder: z.int().optional() }),
    response: Entry,
    async handler({ deps, meta, params, body }) {
      const { version, ...values } = body;
      await updateVersioned(deps.db, 'contentEntries', params.id, version, values, 'Entry');
      await audit(deps.db, meta, { action: 'content.updated', subjectType: 'content_entry', subjectId: params.id, metadata: { fields: Object.keys(values) } });
      return toEntry(await entrySelect(deps.db).where('e.id', '=', params.id).executeTakeFirstOrThrow()) as never;
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/content/entries/:id/preview-link',
    operationId: 'createContentPreviewLink',
    summary: 'Signed 30-minute token to preview a draft revision on the public site',
    description: 'Pass it as ?preview=… to GET /public/content/{collection}/by-slug.',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.read' },
    params: IdParams,
    body: z.object({ revisionId: Id.optional() }),
    response: z.object({ token: z.string(), expiresAt: Timestamp, slug: z.string(), collection: z.string() }),
    async handler({ deps, params, body }) {
      const entry = await deps.db.selectFrom('contentEntries').select(['slug', 'collection', 'latestRevisionId']).where('id', '=', params.id).executeTakeFirst();
      if (!entry) throw notFound('Entry');
      const revisionId = body.revisionId ?? entry.latestRevisionId;
      if (!revisionId) throw unprocessable('Nothing to preview.', 'no_revision');
      return { ...previewToken(deps, revisionId), slug: entry.slug, collection: entry.collection };
    }
  }),

  // ---------------------------------------------------------------- public media
  defineRoute({
    method: 'GET',
    path: '/media',
    operationId: 'listPublicMedia',
    summary: 'Website media library',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'content.read' },
    response: z.object({ items: z.array(Media) }),
    async handler({ deps }) {
      return { items: (await deps.db.selectFrom('publicMedia').selectAll().where('status', '<>', 'archived').orderBy('createdAt', 'desc').limit(500).execute()) as never };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/media',
    operationId: 'createPublicMediaUpload',
    summary: 'Start a website media upload (licensed imagery only; never applicant files)',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'media.write' },
    body: z.object({
      fileName: z.string().min(1).max(255),
      contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'video/mp4']),
      sizeBytes: z.int().positive().max(40 * 1024 * 1024),
      altText: z.string().max(300).default(''),
      credit: z.string().max(200).nullable().optional(),
      license: z.string().max(200).nullable().optional(),
      sourceUrl: z.url().nullable().optional()
    }),
    response: z.object({ media: Media, upload: z.object({ method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: Timestamp }) }),
    status: 201,
    async handler({ deps, meta, staff, body }) {
      const storageKey = `media/${randomUUID()}`;
      const media = await deps.db
        .insertInto('publicMedia')
        .values({ storageKey, contentType: body.contentType, sizeBytes: body.sizeBytes, altText: body.altText, credit: body.credit ?? null, license: body.license ?? null, sourceUrl: body.sourceUrl ?? null, uploadedBy: staff.staffId, createdAt: meta.now.toISOString() })
        .returningAll()
        .executeTakeFirstOrThrow();
      const direct = await deps.publicStorage.createUploadUrl(storageKey, { contentType: body.contentType, expiresInSeconds: 900 });
      const upload = direct ?? { method: 'PUT' as const, url: `${deps.config.API_PUBLIC_URL.replace(/\/$/, '')}${API_PREFIX}/media/${media.id}/content`, headers: { 'Content-Type': 'application/octet-stream' }, expiresAt: new Date(meta.now.getTime() + 900_000).toISOString() };
      return { media: media as never, upload };
    }
  }),
  defineRoute({
    method: 'PUT',
    path: '/media/:id/content',
    operationId: 'uploadPublicMediaContent',
    summary: 'Upload media bytes (when the slot URL points at the API)',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'media.write' },
    params: IdParams,
    binaryBodyLimit: 41_943_040,
    response: Ok,
    async handler({ deps, params, body }) {
      const media = await deps.db.selectFrom('publicMedia').select(['storageKey', 'status', 'contentType']).where('id', '=', params.id).executeTakeFirst();
      if (!media || media.status !== 'pending_upload') throw notFound('Pending upload');
      await deps.publicStorage.put(media.storageKey, body as Buffer, media.contentType);
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/media/:id/complete',
    operationId: 'completePublicMediaUpload',
    summary: 'Validate an uploaded media file and make it available',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'media.write' },
    params: IdParams,
    response: Media,
    async handler({ deps, meta, params }) {
      const media = await deps.db.selectFrom('publicMedia').selectAll().where('id', '=', params.id).executeTakeFirst();
      if (!media) throw notFound('Media');
      const bytes = await deps.publicStorage.get(media.storageKey);
      if (!bytes) throw unprocessable('The file has not been uploaded yet.', 'upload_missing');
      const detected = detectMedia(bytes);
      if (detected !== media.contentType) {
        await deps.publicStorage.delete(media.storageKey);
        await deps.db.updateTable('publicMedia').set({ status: 'archived' }).where('id', '=', params.id).execute();
        throw unprocessable('The file is not a valid image or video of the declared type (SVG and other formats are not accepted).', 'invalid_media');
      }
      const size = imageSize(bytes, detected);
      const publicUrl = deps.publicStorage.publicUrl?.(media.storageKey) ?? null;
      const updated = await deps.db
        .updateTable('publicMedia')
        .set({ status: 'ready', sizeBytes: bytes.length, width: size?.width ?? null, height: size?.height ?? null, publicUrl: publicUrl && deps.publicStorage.name === 's3' ? publicUrl : `${deps.config.API_PUBLIC_URL.replace(/\/$/, '')}${API_PREFIX}/public/media/${params.id}` })
        .where('id', '=', params.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(deps.db, meta, { action: 'media.uploaded', subjectType: 'public_media', subjectId: params.id });
      return updated as never;
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/media/:id',
    operationId: 'updatePublicMedia',
    summary: 'Edit alt text, credit and license, or archive',
    tags: ['Content'],
    access: { kind: 'staff', permission: 'media.write' },
    params: IdParams,
    body: z.object({ version: Version, altText: z.string().max(300).optional(), credit: z.string().max(200).nullable().optional(), license: z.string().max(200).nullable().optional(), archived: z.boolean().optional() }),
    response: Media,
    async handler({ deps, meta, params, body }) {
      const { version, archived, ...values } = body;
      if (archived) {
        const used = await deps.db.selectFrom('contentRevisions as r').innerJoin('contentEntries as e', 'e.publishedRevisionId', 'r.id').select('e.slug').where(eb => eb(eb.cast('r.data', 'text'), 'like', `%${params.id}%`)).executeTakeFirst();
        if (used) throw conflict(`This media is used on published content (${used.slug}).`, 'media_in_use');
      }
      const updated = await updateVersioned(deps.db, 'publicMedia', params.id, version, { ...values, ...(archived ? { status: 'archived' } : {}) }, 'Media');
      await audit(deps.db, meta, { action: 'media.updated', subjectType: 'public_media', subjectId: params.id });
      return updated as never;
    }
  })
];
