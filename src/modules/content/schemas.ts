import { z } from 'zod';

/**
 * Typed content for each collection. Rich text is Markdown (the frontend renders it with HTML
 * disabled). Links are site-relative paths or https URLs; javascript: and data: URLs are refused.
 */

const Href = z
  .string()
  .max(500)
  .refine(v => /^\/(?!\/)/.test(v) || /^https:\/\//.test(v) || /^mailto:/.test(v) || /^tel:/.test(v), { message: 'Use a site path (/about), an https:// link, mailto: or tel:' })
  .meta({ id: 'ContentHref' });
const MediaRef = z.uuid().meta({ description: 'Public media id (licensed website imagery only).' });
const Markdown = z.string().max(50_000);
const Cta = z.object({ label: z.string().min(1).max(80), href: Href });

export const Block = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('hero'), heading: z.string().min(1).max(200), subheading: z.string().max(500).optional(), mediaId: MediaRef.optional(), cta: Cta.optional() }),
    z.object({ type: z.literal('rich_text'), markdown: Markdown }),
    z.object({ type: z.literal('image'), mediaId: MediaRef, caption: z.string().max(300).optional() }),
    z.object({ type: z.literal('split'), heading: z.string().max(200), markdown: Markdown, mediaId: MediaRef.optional(), mediaSide: z.enum(['left', 'right']).default('right') }),
    z.object({ type: z.literal('cta'), heading: z.string().max(200), markdown: Markdown.optional(), button: Cta }),
    z.object({ type: z.literal('faq_list'), category: z.string().max(80).optional(), faqSlugs: z.array(z.string()).max(50).optional() }),
    z.object({ type: z.literal('service_list'), serviceSlugs: z.array(z.string()).max(30).optional() }),
    z.object({ type: z.literal('resource_list'), category: z.string().max(80).optional(), limit: z.int().min(1).max(50).optional() }),
    z.object({ type: z.literal('testimonial'), quote: z.string().max(1500), attribution: z.string().max(120), publishingPermissionConfirmed: z.literal(true, { error: 'Confirm the client gave permission to publish this testimonial' }) }),
    z.object({ type: z.literal('form'), form: z.enum(['family_enquiry', 'candidate_application']) })
  ])
  .meta({ id: 'ContentBlock' });

export const Seo = z
  .object({
    title: z.string().max(70).optional(),
    description: z.string().max(170).optional(),
    canonicalPath: z.string().regex(/^\/[a-z0-9/_-]*$/).max(200).optional(),
    noindex: z.boolean().optional(),
    ogImageMediaId: MediaRef.optional()
  })
  .default({})
  .meta({ id: 'ContentSeo' });

const NavItem: z.ZodType<{ label: string; href: string; children?: Array<{ label: string; href: string }> }> = z.object({
  label: z.string().min(1).max(60),
  href: Href,
  children: z.array(z.object({ label: z.string().min(1).max(60), href: Href })).max(12).optional()
});

export const COLLECTION_DATA = {
  page: z.object({ blocks: z.array(Block).max(60) }).meta({ id: 'PageContent' }),
  service: z.object({ summary: z.string().max(500), markdown: Markdown, serviceTypeKey: z.string().max(64).optional(), highlights: z.array(z.string().max(200)).max(12).default([]), mediaId: MediaRef.optional() }).meta({ id: 'ServiceContent' }),
  faq: z.object({ question: z.string().min(1).max(300), answerMarkdown: Markdown, category: z.string().max(80).default('general') }).meta({ id: 'FaqContent' }),
  resource: z.object({ summary: z.string().max(500), markdown: Markdown, category: z.string().max(80).default('general'), mediaId: MediaRef.optional(), publishedOn: z.iso.date().optional() }).meta({ id: 'ResourceContent' }),
  global: z.union([
    z.object({ kind: z.literal('navigation'), primary: z.array(NavItem).max(12), footer: z.array(NavItem).max(30).default([]) }),
    z.object({ kind: z.literal('site_settings'), siteName: z.string().max(120), tagline: z.string().max(200).optional(), contactEmail: z.email().optional(), phone: z.string().max(40).optional(), serviceArea: z.string().max(200).optional(), social: z.array(z.object({ network: z.string().max(40), href: Href })).max(10).default([]) }),
    z.object({ kind: z.literal('footer'), markdown: Markdown, legalLinks: z.array(NavItem).max(10).default([]) })
  ]).meta({ id: 'GlobalContent' })
} as const;

export type Collection = keyof typeof COLLECTION_DATA;
export const COLLECTIONS = Object.keys(COLLECTION_DATA) as Collection[];

export function parseCollectionData(collection: Collection, data: unknown) {
  return COLLECTION_DATA[collection].safeParse(data);
}

/** Media ids referenced anywhere in a content document. */
export function mediaIdsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(item => mediaIdsIn(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'mediaId' || key === 'ogImageMediaId') && typeof item === 'string') found.add(item);
      else mediaIdsIn(item, found);
    }
  }
  return found;
}
