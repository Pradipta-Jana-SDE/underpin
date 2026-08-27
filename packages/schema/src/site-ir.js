import { z } from 'zod';

const Sourced = (inner) =>
  z.object({ value: inner, source: z.string(), confidence: z.number().min(0).max(1).default(0.5) });

export const NavItem = z.lazy(() =>
  z.object({
    label: z.string(),
    href: z.string(),
    order: z.number().int(),
    children: z.array(NavItem).default([])
  })
);

export const Location = z.object({
  name: z.string(),
  address: z.object({
    street: z.string().default(''),
    locality: z.string().default(''),
    region: z.string().default(''),
    postalCode: z.string().default(''),
    country: z.string().default('')
  }),
  phone: z.string().default(''),
  email: z.string().default(''),
  geo: z.object({ lat: z.number(), lng: z.number() }).nullable().default(null),
  hours: z.array(z.object({ day: z.string(), open: z.string(), close: z.string() })).default([]),
  sourceUrl: z.string().nullable().default(null)
});

export const Brand = z.object({
  colors: z.object({
    primary: z.string().nullable().default(null),
    secondary: z.string().nullable().default(null),
    accent: z.string().nullable().default(null),
    text: z.string().nullable().default(null),
    background: z.string().nullable().default(null),
    palette: z.array(z.object({ hex: z.string(), weight: z.number(), roles: z.array(z.string()).default([]) })).default([])
  }),
  fonts: z.object({
    heading: z.string().nullable().default(null),
    body: z.string().nullable().default(null),
    googleFonts: z.array(z.string()).default([]),
    webfonts: z.array(z.string()).default([])
  }),
  logo: z.object({
    default: z.string().nullable().default(null),
    darkVariant: z.string().nullable().default(null),
    favicon: z.string().nullable().default(null),
    appleTouchIcon: z.string().nullable().default(null)
  }),
  radii: z.object({ button: z.string().nullable().default(null), card: z.string().nullable().default(null) }),
  /** Which method produced each field — a theme.json read is not a colour-frequency guess. */
  sources: z.record(z.string(), z.string()).default({})
});

export const SiteIR = z.object({
  siteUrl: z.string(),
  siteName: z.string().default(''),
  detectedBuilder: z.string().nullable().default(null),
  restReachable: z.boolean().default(false),
  pluginFingerprint: z
    .array(z.object({ slug: z.string(), confidence: z.number(), evidence: z.string() }))
    .default([]),
  brand: Brand,
  nav: z.object({
    primary: z.array(NavItem).default([]),
    source: z.string().default('dom_parse'),
    confidence: z.number().default(0.5)
  }),
  footer: z.object({
    columns: z.array(z.object({ heading: z.string(), links: z.array(NavItem) })).default([]),
    legalLinks: z.array(NavItem).default([]),
    socialLinks: z.array(z.object({ platform: z.string(), href: z.string() })).default([])
  }),
  contact: z.object({
    phones: z.array(z.string()).default([]),
    emails: z.array(z.string()).default([]),
    addresses: z.array(z.string()).default([])
  }),
  locations: z.array(Location).default([]),
  /** Derived by intersecting DOM across a stratified page sample — not guessed. */
  shell: z.object({
    headerSelector: z.string().nullable().default(null),
    footerSelector: z.string().nullable().default(null),
    derivedFromNPages: z.number().default(0),
    method: z.string().default('jaccard_tag_class_paths'),
    threshold: z.number().default(0.9),
    confidence: z.number().default(0)
  }),
  generatedAt: z.string()
});
