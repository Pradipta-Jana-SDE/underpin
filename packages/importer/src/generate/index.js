import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { buildTheme, themeToCss } from '@underpin/templates';
import { TEMPLATES_BY_ID } from '@underpin/templates/manifests';
import { mapToTemplate } from '../match/index.js';
import { downloadMedia } from './media.js';
import { originalUrl } from '../extract/media.js';

const require = createRequire(import.meta.url);
// The generated site links the shared template package by relative path rather than
// vendoring a copy. That is the architecture the brief asks for: one library, many
// sites. In production this becomes a versioned registry dependency with per-site pins
// so a template fix can be rolled out deliberately instead of all at once.
const templatePkgDir = join(dirname(require.resolve('@underpin/templates/manifests')), '..');

const write = (p, s) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};

/** Slug used for the content file. The URL path stays authoritative. */
const contentKey = (path) =>
  (path === '/' ? 'index' : path.replace(/^\/|\/$/g, '').replace(/\//g, '__')).replace(/[^a-z0-9_.-]/gi, '-') || 'index';

function siteConfigFrom(siteIr, plan, pages) {
  const nav = (siteIr.nav?.primary ?? []).map((n) => ({
    label: n.label,
    href: toLocalHref(n.href, siteIr.siteUrl, pages)
  }));
  return {
    id: new URL(siteIr.siteUrl).host.replace(/^www\./, ''),
    schemaVersion: 1,
    name: siteIr.siteName || new URL(siteIr.siteUrl).host,
    domain: siteIr.siteUrl,
    brand: {
      colors: Object.fromEntries(
        Object.entries(siteIr.brand.colors).filter(([k, v]) => typeof v === 'string' && k !== 'palette')
      ),
      fonts: { heading: siteIr.brand.fonts.heading ?? '', body: siteIr.brand.fonts.body ?? '' },
      logo: { default: siteIr.brand.logo.default ?? '', favicon: siteIr.brand.logo.favicon ?? '' },
      radius: 'md',
      spacingScale: 1
    },
    contact: {
      phone: siteIr.contact.phones[0] ?? '',
      email: siteIr.contact.emails[0] ?? '',
      hours: ''
    },
    locations: siteIr.locations ?? [],
    navigation: { header: nav, footer: [] },
    seoDefaults: { titleTemplate: '%s', robots: 'index,follow' },
    integrations: {},
    templates: { byType: {}, byPath: {} },
    // The scope contract travels with the site so the finished build can be judged
    // against what was agreed rather than an unstated ideal.
    migrationPlan: {
      decidedAt: plan.decidedAt,
      capabilities: plan.capabilities.map((c) => ({ id: c.id, disposition: c.disposition }))
    }
  };
}

/** Rewrites absolute source URLs to local paths when that page was migrated. */
function toLocalHref(href, siteUrl, pages) {
  if (!href) return '#';
  try {
    const u = new URL(href, siteUrl);
    if (u.origin !== new URL(siteUrl).origin) return u.toString();
    const path = u.pathname;
    return pages.some((p) => p.path === path) ? path : path;
  } catch {
    return href;
  }
}


/**
 * Rewrites every remote asset URL buried anywhere in a slot tree.
 *
 * Grid items carry raw `src` strings rather than media refs, so the per-page media
 * sweep never touched them and they shipped pointing at the source domain. Walking the
 * whole structure is the only rewrite that cannot be defeated by a slot shape nobody
 * anticipated — and the acceptance criterion is absolute, so a catch-all is right here.
 */
function rewriteUrls(value, rehost) {
  if (typeof value === 'string') {
    if (!/^https?:\/\//.test(value)) return value;
    return rehost(value) ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteUrls(v, rehost));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteUrls(v, rehost);
    return out;
  }
  return value;
}

export async function generateSite({ outDir, siteIr, pages, plan, matches, mediaLimit = null, onProgress }) {
  const byUrl = new Map(matches.map((m) => [m.url, m]));

  // ---- media: re-host everything so the built site has no dependency on the origin
  const allMedia = new Map();
  for (const p of pages) for (const m of p.media) allMedia.set(m.id, m);

  // og:image lives in metadata, not in the section tree, so it misses the normal media
  // sweep — and an og:image left pointing at the old domain is exactly the runtime
  // dependency on WordPress the brief says must not exist.
  const addAsset = (url, source) => {
    if (!url || !/^https?:\/\//.test(url)) return;
    const id = source + ':' + createHash('sha1').update(url).digest('hex').slice(0, 12);
    if (!allMedia.has(id)) {
      allMedia.set(id, { id, kind: 'image', originalUrl: url, alt: '', width: null, height: null, source });
    }
  };
  for (const p of pages) addAsset(p.seo?.ogImage, 'og');
  // Sweep the slot trees too: grid items hold raw src strings, so their images are
  // invisible to the media[] collection built during extraction.
  const sweep = (v) => {
    if (typeof v === 'string') {
      if (/^https?:\/\/\S+\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i.test(v)) addAsset(v, 'slot');
    } else if (Array.isArray(v)) v.forEach(sweep);
    else if (v && typeof v === 'object') Object.values(v).forEach(sweep);
  };
  for (const p of pages) sweep(p.sections);
  // Site chrome is rendered on EVERY page, so a remote logo or favicon is the most
  // widespread possible violation of "no runtime dependency on WordPress" — one missed
  // rewrite here leaves every page in the export phoning home.
  addAsset(siteIr.brand?.logo?.default, 'og');
  addAsset(siteIr.brand?.logo?.favicon, 'og');
  addAsset(siteIr.brand?.logo?.appleTouchIcon, 'og');
  onProgress?.('media', allMedia.size);
  // og:images go first and are never subject to --media. That flag is an iteration
  // convenience, and letting it drop an og:image turns a dev shortcut into a failed
  // acceptance criterion: the page would still load an image from the old origin.
  const ordered = [...allMedia.values()].sort((a, b) => (a.source === 'og' ? -1 : 0) - (b.source === 'og' ? -1 : 0));
  const ogCount = ordered.filter((m) => m.source === 'og').length;
  const { media: downloadedMedia, downloaded, skipped, failed: mediaFailed } = await downloadMedia(
    ordered,
    outDir,
    { limit: mediaLimit ? mediaLimit + ogCount : null }
  );
  const mediaById = new Map(downloadedMedia.map((m) => [m.id, m]));
  // Keyed on the normalised URL: the extractor stores normalised URLs while metadata
  // carries raw ones, and comparing them directly silently never matches.
  const localByUrl = new Map(
    downloadedMedia.filter((m) => m.localPath).map((m) => [originalUrl(m.originalUrl), m.localPath])
  );
  const rehost = (url) => (url ? localByUrl.get(originalUrl(url)) ?? null : null);

  // ---- content, one JSON per page so a CMS can address a single record later
  const routes = [];
  const perPageWarnings = [];
  for (const page of pages) {
    const match = byUrl.get(page.url);
    const templateId = match?.chosen ?? 'GenericPage';
    const mapping = mapToTemplate(page, templateId);

    const localMedia = page.media.map((m) => mediaById.get(m.id) ?? m);

    const seo = { ...page.seo };
    if (seo.ogImage) seo.ogImage = rehost(seo.ogImage) ?? seo.ogImage;

    const doc = {
      path: page.path,
      slug: page.slug,
      locale: page.locale,
      templateId,
      pageType: match?.pageType ?? 'generic',
      seo,
      placed: rewriteUrls(mapping.placed, rehost),
      flexible: rewriteUrls(mapping.flexible, rehost),
      leftover: mapping.leftover,
      media: localMedia,
      provenance: {
        sourceUrl: page.url,
        builder: page.source.builder,
        strategy: page.source.strategy,
        extractionConfidence: page.confidence,
        matchConfidence: match?.matchConfidence ?? 0
      }
    };
    write(join(outDir, 'content', 'pages', `${contentKey(page.path)}.json`), JSON.stringify(doc, null, 2));
    routes.push({ path: page.path, key: contentKey(page.path), templateId });
    if (mapping.leftover.length) {
      perPageWarnings.push({ path: page.path, leftover: mapping.leftover.length });
    }
  }

  // ---- redirects, including the 410s the scope contract promised
  const redirects = (plan.excludedUrls ?? []).map((e) => ({
    from: new URL(e.url).pathname,
    policy: e.policy,
    reason: e.reason
  }));
  write(join(outDir, 'content', 'redirects.json'), JSON.stringify(redirects, null, 2));
  write(join(outDir, 'content', 'routes.json'), JSON.stringify(routes, null, 2));

  const config = siteConfigFrom(siteIr, plan, pages);
  config.brand.logo.default = rehost(config.brand.logo.default) ?? config.brand.logo.default;
  config.brand.logo.favicon = rehost(config.brand.logo.favicon) ?? config.brand.logo.favicon;
  write(join(outDir, 'site.config.json'), JSON.stringify(config, null, 2));

  // ---- the Next.js app
  scaffoldApp(outDir, config, routes);

  return {
    routes,
    media: { total: allMedia.size, downloaded, skipped, failed: mediaFailed },
    warnings: perPageWarnings,
    config
  };
}

function scaffoldApp(outDir, config, routes) {
  const templatesRef = 'file:' + relative(outDir, templatePkgDir).split('\\').join('/');
  const theme = themeToCss(buildTheme({ brand: { colors: config.brand.colors, fonts: config.brand.fonts } }));

  write(join(outDir, 'package.json'), JSON.stringify({
    name: `site-${config.id.replace(/[^a-z0-9-]/gi, '-')}`,
    private: true,
    version: '1.0.0',
    scripts: { dev: 'next dev', build: 'next build', start: 'npx serve out' },
    dependencies: {
      next: '^15.0.0',
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      '@underpin/templates': templatesRef
    }
  }, null, 2));

  write(join(outDir, 'next.config.mjs'), `/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the built site is plain files. No Node server, no WordPress, nothing
  // to keep patched — which is the point of the whole exercise.
  output: 'export',
  // WordPress defaults to trailing-slash permalinks. A mismatch here silently
  // double-hops every URL on the site.
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@underpin/templates']
};
export default nextConfig;
`);

  write(join(outDir, 'app', 'theme.css'), theme + '\n');

  write(join(outDir, 'app', 'layout.jsx'), `import '@underpin/templates/styles.css';
import './theme.css';
import config from '../site.config.json';

export const metadata = {
  title: { default: config.name, template: config.seoDefaults.titleTemplate.replace('%s', '%s') },
  metadataBase: new URL(config.domain)
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`);

  // One compiled route serves every page. Generating a .tsx per page would make build
  // time a function of file count and put content in code, where a CMS cannot reach it.
  write(join(outDir, 'app', '[[...slug]]', 'page.jsx'), `import { PageTemplate } from '@underpin/templates/Template';
import config from '../../site.config.json';
import routes from '../../content/routes.json';

const load = (key) => require(\`../../content/pages/\${key}.json\`);

export function generateStaticParams() {
  // Byte-for-byte URL preservation: every param set comes from the crawled path,
  // so /services/roof-repair/ stays /services/roof-repair/.
  return routes.map((r) => ({
    slug: r.path === '/' ? [] : r.path.replace(/^\\/|\\/$/g, '').split('/')
  }));
}

function routeFor(slug) {
  const path = !slug || slug.length === 0 ? '/' : '/' + slug.join('/') + '/';
  return routes.find((r) => r.path === path) ?? routes.find((r) => r.path === path.replace(/\\/$/, ''));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const route = routeFor(slug);
  if (!route) return {};
  const page = load(route.key);
  const seo = page.seo ?? {};
  return {
    title: seo.title || config.name,
    description: seo.description || undefined,
    alternates: seo.canonical ? { canonical: seo.canonical } : undefined,
    robots: seo.robots || undefined,
    openGraph: {
      title: seo.ogTitle || seo.title || undefined,
      description: seo.ogDescription || seo.description || undefined,
      url: seo.canonical || undefined,
      images: seo.ogImage ? [seo.ogImage] : undefined
    }
  };
}

export default async function Page({ params }) {
  const { slug } = await params;
  const route = routeFor(slug);
  if (!route) return null;
  const page = load(route.key);
  return <PageTemplate page={page} config={config} />;
}
`);

  write(join(outDir, 'app', 'sitemap.js'), `import routes from '../content/routes.json';
import config from '../site.config.json';

export const dynamic = 'force-static';

export default function sitemap() {
  return routes.map((r) => ({
    url: new URL(r.path, config.domain).toString(),
    lastModified: new Date()
  }));
}
`);

  write(join(outDir, 'app', 'robots.js'), `import config from '../site.config.json';

export const dynamic = 'force-static';

export default function robots() {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: new URL('/sitemap.xml', config.domain).toString()
  };
}
`);

  write(join(outDir, 'README.md'), `# ${config.name}

Migrated with [Underpin](../../README.md). **This site runs no WordPress.**

    npm install
    npm run build     # static export to ./out
    npx serve out

- Content: \`content/pages/*.json\` — one record per page, diffable, CMS-addressable
- Branding: \`site.config.json\` — colours, fonts, logo, contact, navigation
- Templates: \`@underpin/templates\` — shared across every migrated site
- Routing: \`app/[[...slug]]/page.jsx\` — one compiled route, URLs preserved byte-for-byte

Each page JSON carries a \`provenance\` block recording the source URL, which page
builder it came from, which extraction strategy read it, and how confident both the
extraction and the template match were.
`);
}
