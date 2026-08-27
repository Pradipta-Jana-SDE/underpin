import { z } from 'zod';

/** The central config the acceptance criteria call for: one file controls branding fleet-wide. */
export const SiteConfig = z.object({
  id: z.string(),
  schemaVersion: z.literal(1),
  name: z.string(),
  domain: z.string(),
  brand: z.object({
    colors: z.record(z.string(), z.string()),
    fonts: z.object({ heading: z.string(), body: z.string() }),
    logo: z.object({
      default: z.string(),
      darkVariant: z.string().optional(),
      favicon: z.string().optional()
    }),
    radius: z.enum(['none', 'sm', 'md', 'lg']).default('md'),
    spacingScale: z.number().default(1)
  }),
  contact: z.object({
    phone: z.string().default(''),
    email: z.string().default(''),
    hours: z.string().default('')
  }),
  locations: z.array(z.any()).default([]),
  navigation: z.object({ header: z.array(z.any()).default([]), footer: z.array(z.any()).default([]) }),
  seoDefaults: z.object({
    titleTemplate: z.string().default('%s'),
    ogImage: z.string().optional(),
    robots: z.string().default('index,follow')
  }),
  integrations: z.object({
    analyticsId: z.string().optional(),
    formsEndpoint: z.string().optional(),
    mapsKey: z.string().optional()
  }).default({}),
  /** pageType -> templateId, with per-page overrides keyed by path. */
  templates: z.object({
    byType: z.record(z.string(), z.string()).default({}),
    byPath: z.record(z.string(), z.string()).default({})
  }).default({})
});
