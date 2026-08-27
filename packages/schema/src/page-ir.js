import { z } from 'zod';
import { ARCHETYPE_IDS } from '@underpin/vocabulary';

export const ArchetypeId = z.enum(ARCHETYPE_IDS);

/** Records which layer reached a conclusion, so the review queue can be sorted by trustworthiness. */
export const DecidedBy = z.enum(['builder_map', 'rule', 'llm', 'human']);

/**
 * Seven computed properties, no more. Font size, line height, radius and shadow are
 * deliberately excluded: high cardinality, low signal. Radius is a site-level token.
 */
export const SectionStyle = z.object({
  bgColor: z.string().nullable().default(null),
  bgImage: z.string().nullable().default(null),
  textColor: z.string().nullable().default(null),
  textAlign: z.enum(['left', 'center', 'right']).nullable().default(null),
  containerWidth: z.number().nullable().default(null),
  paddingBlock: z.object({ top: z.number(), bottom: z.number() }).nullable().default(null),
  isDark: z.boolean().default(false)
});

export const MediaRef = z.object({
  id: z.string(),
  kind: z.enum(['image', 'video', 'icon', 'svg']).default('image'),
  originalUrl: z.string(),
  localPath: z.string().optional(),
  alt: z.string().default(''),
  width: z.number().nullable().default(null),
  height: z.number().nullable().default(null),
  /** Icon-font and CSS-mask graphics are media too — missing this is how icons silently vanish. */
  source: z.enum(['img', 'srcset', 'background', 'icon_font', 'css_mask', 'svg_inline']).default('img')
});

export const FormField = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string().default('text'),
  required: z.boolean().default(false),
  options: z.array(z.string()).default([]),
  /** Which extraction tier produced the label — CF7 often has no programmatic association. */
  labelConfidence: z.enum(['for_attr', 'positional', 'humanised_name']).default('for_attr')
});

export const Section = z.object({
  id: z.string(),
  order: z.number().int(),
  archetype: ArchetypeId,
  variant: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  decidedBy: DecidedBy,
  slots: z.record(z.string(), z.unknown()).default({}),
  mediaRefs: z.array(z.string()).default([]),
  style: SectionStyle.nullable().default(null),
  sourceSelector: z.string().optional(),
  /** Set when a carousel was detected but could not be fully driven — content may be incomplete. */
  incompleteCapture: z.boolean().default(false)
});

export const SeoData = z.object({
  title: z.string().default(''),
  description: z.string().default(''),
  canonical: z.string().nullable().default(null),
  robots: z.string().nullable().default(null),
  ogTitle: z.string().nullable().default(null),
  ogDescription: z.string().nullable().default(null),
  ogImage: z.string().nullable().default(null),
  schemaTypes: z.array(z.string()).default([]),
  hreflang: z.array(z.object({ lang: z.string(), href: z.string() })).default([])
});

export const PageIR = z.object({
  url: z.string(),
  path: z.string(),
  slug: z.string(),
  type: z.string().default('page'),
  locale: z.string().default('en'),
  source: z.object({
    // static_dom = cheerio over fetched HTML (no browser). render_scrape = Playwright,
    // which is the only path that can produce computed style.
    strategy: z.enum(['rest', 'rest_verified', 'builder_dom', 'static_dom', 'render_scrape']),
    builder: z.string().nullable().default(null),
    restReachable: z.boolean().default(false),
    fetchedAt: z.string(),
    httpStatus: z.number().default(200)
  }),
  seo: SeoData.default({}),
  sections: z.array(Section).default([]),
  media: z.array(MediaRef).default([]),
  links: z
    .object({
      internal: z.array(z.string()).default([]),
      external: z.array(z.string()).default([]),
      broken: z.array(z.string()).default([])
    })
    .default({}),
  /** Content that matched no slot. Never deleted; blocks the production build until reviewed. */
  leftover: z
    .array(
      z.object({
        sourceOrder: z.number(),
        reason: z.string(),
        html: z.string(),
        text: z.string(),
        reviewed: z.boolean().default(false)
      })
    )
    .default([]),
  rawHtmlRef: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0)
});

export function parsePageIR(input) {
  return PageIR.parse(input);
}
