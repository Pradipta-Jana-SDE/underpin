import { z } from 'zod';

/**
 * The scope contract. Written by `underpin scope`, read by every later stage, and
 * reprinted at the top of the final report — so the migration is judged against what
 * was agreed rather than an unstated ideal.
 */

export const CAPABILITY_IDS = [
  'woocommerce',
  'membership',
  'lms',
  'booking',
  'multilingual',
  'blog',
  'forms',
  'search',
  'embeds'
];

export const Disposition = z.enum([
  'migrate',            // bring it across as normal
  'static_catalogue',   // products browse-only, enquiry CTA, no cart
  'external_checkout',  // catalogue + link out to Shopify/Stripe
  'keep_on_wordpress',  // stays where it is, linked from the React site
  'exclude',            // not migrated
  'migrate_all',        // all locales / all posts
  'default_only'        // default locale / posts without archives
]);

/** What happens to a URL we are not migrating. A bare 404 is never acceptable. */
export const UrlPolicy = z.enum(['migrate', 'redirect', '410', 'proxy_to_legacy']);

export const CapabilityDecision = z.object({
  id: z.string(),
  label: z.string(),
  detected: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(z.string()).default([]),
  disposition: Disposition,
  /** Glob -> policy. Every excluded path must appear here or the build gate fails. */
  urlPolicy: z.record(z.string(), UrlPolicy).default({}),
  redirectTarget: z.string().nullable().default(null),
  locales: z.array(z.string()).default([]),
  note: z.string().default('')
});

export const MigrationPlan = z.object({
  site: z.string(),
  planVersion: z.literal(1),
  decidedAt: z.string(),
  decidedBy: z.string().default('cli'),
  capabilities: z.array(CapabilityDecision).default([]),
  pages: z.object({
    total: z.number().default(0),
    inScope: z.number().default(0),
    excluded: z.number().default(0),
    exclusionReasons: z.record(z.string(), z.number()).default({})
  }),
  /** Explicit list so later stages never have to re-derive scope from globs. */
  inScopeUrls: z.array(z.string()).default([]),
  excludedUrls: z.array(z.object({ url: z.string(), reason: z.string(), policy: UrlPolicy })).default([])
});

export function parseMigrationPlan(input) {
  return MigrationPlan.parse(input);
}
