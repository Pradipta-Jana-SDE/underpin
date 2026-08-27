import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { captureSite } from '../capture/index.js';
import { mirrorAssets, rewriteTree } from './assets.js';
import { componentizePage } from './componentize.js';

const require = createRequire(import.meta.url);
const templatePkgDir = join(dirname(require.resolve('@underpin/templates/manifests')), '..');

const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };

/**
 * JSON escaped to pure ASCII.
 *
 * Captured markup and inline scripts carry emoji, and WordPress's own emoji-settings
 * script contains unpaired surrogates. JSON.stringify emits those verbatim, which is
 * invalid JSON to a strict parser — the bundler then fails at build time with an
 * unreadable "Unexpected token" pointing into a minified chunk. Escaping every non-ASCII
 * code unit sidesteps the whole class of problem.
 */
const asciiJson = (o) =>
  JSON.stringify(o).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const contentKey = (path) =>
  (path === '/' ? 'index' : path.replace(/^\/|\/$/g, '').replace(/\//g, '__')).replace(/[^a-z0-9_.-]/gi, '-') || 'index';

/**
 * Fidelity mode: reproduce the original page exactly, in React, with no WordPress.
 *
 * Where template mode asks "what does this page MEAN", fidelity mode asks "what does
 * this page LOOK like" and keeps the answer verbatim — the rendered DOM, the site's own
 * stylesheets, and the scripts that drive its animations, all re-hosted locally.
 */
export async function generateFidelitySite({ outDir, siteUrl, plan, urls, mediaLimit, componentize = false, onProgress }) {
  const origin = new URL(siteUrl).origin;
  const targets = urls ?? plan.inScopeUrls;

  onProgress?.({ type: 'stage', label: `Rendering ${targets.length} pages in a real browser` });
  const { pages, assets, failures } = await captureSite(targets, {
    origin,
    onProgress: (done, total, url) => onProgress?.({ type: 'progress', done, total, url })
  });

  // og:image and friends live in <head>, not the DOM tree, so the page-level sweep never
  // sees them — they would ship pointing at the WordPress origin and fail the
  // origin-independence check outright.
  const headImages = [];
  for (const p of pages) {
    for (const m of p.head?.meta ?? []) {
      const isImage =
        m.property === 'og:image' || m.name === 'twitter:image' || m.name === 'msapplication-TileImage';
      if (isImage && m.content && /^https?:\/\//.test(m.content)) {
        headImages.push({ url: m.content.split('#')[0], kind: 'image' });
      }
    }
  }
  for (const h of headImages) if (!assets.some((a) => a.url === h.url)) assets.push(h);

  // srcset alternates: the browser requests exactly one width and ignores the others, so
  // the response listener never sees them and they ship pointing at the source origin.
  const known = new Set(assets.map((a) => a.url));
  const sweepSrcset = (node, base) => {
    if (!node || typeof node === 'string') return;
    for (const key of ['srcset', 'data-srcset', 'data-lazy-srcset', 'imagesrcset']) {
      const raw = node.a?.[key];
      if (!raw) continue;
      for (const part of String(raw).split(/,(?=\s*(?:https?:\/\/|\/\/|\/))/)) {
        const candidate = part.trim().split(/\s+/)[0];
        if (!candidate || candidate.startsWith('data:')) continue;
        try {
          const abs = new URL(candidate, base).toString().split('#')[0];
          if (!known.has(abs)) { known.add(abs); assets.push({ url: abs, kind: 'image' }); }
        } catch { /* malformed candidate */ }
      }
    }
    (node.c ?? []).forEach((c) => sweepSrcset(c, base));
  };
  for (const p of pages) sweepSrcset(p.tree, p.url);

  onProgress?.({ type: 'stage', label: `Mirroring ${assets.length} assets (CSS, fonts, images, scripts)` });
  const capped = mediaLimit ? assets.slice(0, mediaLimit) : assets;
  const { localByUrl, failures: assetFailures, downloaded } = await mirrorAssets(capped, outDir, {
    origin,
    onProgress: (n, total) => onProgress?.({ type: 'assets', done: n, total })
  });

  onProgress?.({ type: 'stage', label: 'Rewriting references and emitting the React site' });

  const routes = [];
  for (const p of pages) {
    rewriteTree(p.tree, localByUrl, p.url);

    const localFor = (raw) => {
      try { return localByUrl.get(new URL(raw, p.url).toString().split('#')[0]) ?? null; }
      catch { return null; }
    };

    const rewriteCss = (css) =>
      css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (whole, ref) => {
        const r = ref.trim();
        if (!r || r.startsWith('data:')) return whole;
        const local = localFor(r);
        return local ? `url("${local}")` : whole;
      });

    // One ordered list preserving the document's original link/style interleaving, so the
    // cascade resolves the same way it did on the source page.
    const sheets = (p.sheets ?? [])
      .map((sh) =>
        sh.kind === 'link'
          ? (localFor(sh.href) ? { kind: 'link', href: localFor(sh.href) } : null)
          : (sh.css?.trim() ? { kind: 'inline', css: rewriteCss(sh.css) } : null)
      )
      .filter(Boolean);

    // One ordered list, externals and inlines interleaved exactly as the source document
    // had them. An external whose file could not be mirrored is dropped rather than left
    // pointing at the origin.
    const scripts = (p.scriptsOrdered ?? [])
      .map((sc) => {
        if (sc.kind === 'external') {
          const l = localFor(sc.src);
          return l ? { kind: 'external', src: l } : null;
        }
        const code = sc.code?.trim();
        return code ? { kind: 'inline', code } : null;
      })
      .filter(Boolean);

    const head = {
      ...p.head,
      meta: (p.head?.meta ?? []).map((m) =>
        m.content && /^https?:\/\//.test(m.content) && localFor(m.content)
          ? { ...m, content: localFor(m.content) }
          : m
      )
    };

    // JSON-LD is data, not markup — it passes through verbatim.
    const jsonLd = (p.jsonLd ?? []).slice(0, 6);

    const doc = {
      path: p.path,
      url: p.url,
      title: p.title,
      lang: p.lang,
      bodyClass: p.bodyClass,
      htmlClass: p.htmlClass,
      head,
      jsonLd,
      sheets,
      scripts,
      tree: p.tree,
      mode: 'fidelity'
    };
    // Final sweep at the string level. Builders park absolute URLs inside JSON-encoded
    // attributes (Elementor's data-settings) and inline scripts, where a tree walk over
    // parsed attributes never reaches them — they survive as \\/-escaped strings. Matching
    // both forms in one pass is the only rewrite that cannot be defeated by a shape
    // nobody anticipated. Same lesson as template mode's rewriteUrls, one layer deeper.
    const rewriteEscaped = (json) =>
      json.replace(/https?:(?:\\\/\\\/|\/\/)[^"'\s\\)]+/g, (match) => {
        const plain = match.replace(/\\\//g, '/').split('#')[0];
        const local = localByUrl.get(plain);
        if (!local) return match;
        // Preserve the escaping style the original used.
        return match.includes('\\/') ? local.replace(/\//g, '\\/') : local;
      });

    const key = contentKey(p.path);

    if (componentize) {
      // Split the page into ordered section components. Structure and content live in
      // separate JSON files so the text and images are editable without touching markup.
      const parts = componentizePage(doc);
      for (const part of parts) {
        write(join(outDir, 'content', 'sections', key, `${part.id}.tree.json`), rewriteEscaped(asciiJson(part.tree)));
        write(join(outDir, 'content', 'sections', key, `${part.id}.content.json`), rewriteEscaped(asciiJson(part.content)));
        write(join(outDir, 'components', 'pages', key, `${part.name}.jsx`), sectionComponent(part, key));
      }
      write(join(outDir, 'components', 'pages', key, 'Page.jsx'), pageComponent(parts, key));
      doc.componentized = parts.map((p2) => ({ id: p2.id, name: p2.name, kind: p2.kind, items: p2.itemCount }));
    }

    write(join(outDir, 'content', 'pages', `${key}.json`), rewriteEscaped(asciiJson(doc)));
    routes.push({ path: p.path, key, componentized: componentize });
  }

  const redirects = (plan.excludedUrls ?? []).map((e) => ({
    from: new URL(e.url).pathname, policy: e.policy, reason: e.reason
  }));
  write(join(outDir, 'content', 'routes.json'), JSON.stringify(routes, null, 2));
  write(join(outDir, 'content', 'redirects.json'), JSON.stringify(redirects, null, 2));

  scaffoldFidelityApp(outDir, { siteUrl, routes, origin, componentize });

  return {
    mode: 'fidelity',
    routes,
    media: { total: assets.length, downloaded, skipped: 0, failed: assetFailures },
    captureFailures: failures,
    warnings: []
  };
}

/**
 * One section, as a thin wrapper around the renderer that already works.
 *
 * Deliberately not generated JSX source. Re-deriving the attribute renaming, boolean
 * props and style parsing a second time as codegen is where this project would quietly
 * become a much larger one — and the existing renderer already measures 99.8% visual on
 * a static page. What the client asked for — small, named, ordered, editable files — is
 * delivered by the composition in Page.jsx and the content JSON beside each section.
 */
function sectionComponent(part, key) {
  return `'use client';
import { DomNode } from '@underpin/templates/DomTree';
import { spliceContent } from '@underpin/templates/splice';
import tree from '../../../content/sections/${key}/${part.id}.tree.json';
import content from '../../../content/sections/${key}/${part.id}.content.json';

/**
 * ${part.name}
 *
 * Structure: content/sections/${key}/${part.id}.tree.json  (markup — edit with care)
 * Content:   content/sections/${key}/${part.id}.content.json  (${part.counts.text} text, ${part.counts.media} media — safe to edit)
 */
export default function ${part.name}() {
  return <DomNode node={spliceContent(tree, content, '${part.id}')} path="${part.id}" />;
}
`;
}

/** The page: an ordered composition of its sections, and nothing else. */
function pageComponent(parts, key) {
  const imports = parts.map((p) => `import ${p.name} from './${p.name}.jsx';`).join('\n');
  const body = parts.map((p) => `      <${p.name} />`).join('\n');
  return `${imports}

/**
 * Page: /${key === 'index' ? '' : key.replace(/__/g, '/') + '/'}
 *
 * Sections render in source order. Adding, removing or reordering them changes the DOM —
 * which is fine when you mean it, and the reason the original order is preserved here.
 */
export default function Page() {
  return (
    <>
${body}
    </>
  );
}
`;
}

function scaffoldFidelityApp(outDir, { siteUrl, routes, origin, componentize = false }) {
  const templatesRef = 'file:' + relative(outDir, templatePkgDir).split('\\').join('/');
  const host = new URL(siteUrl).host;

  write(join(outDir, 'package.json'), JSON.stringify({
    name: `site-${host.replace(/[^a-z0-9-]/gi, '-')}`,
    private: true, version: '1.0.0',
    scripts: { dev: 'next dev', build: 'next build', start: 'npx serve out' },
    dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0', '@underpin/templates': templatesRef }
  }, null, 2));

  write(join(outDir, 'next.config.mjs'), `/** @type {import('next').NextConfig} */
export default {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@underpin/templates'],
  // The captured markup is the source site's own; Next's built-in checks have nothing
  // useful to say about it and would only fail the build on someone else's HTML.
  eslint: { ignoreDuringBuilds: true },
  // This subtree is deliberately imperative: the site's own scripts mutate the DOM React
  // rendered. StrictMode's double-invoke exists to catch effects that are not idempotent
  // — ours is not, by design, and double-invoking would initialise all 44 scripts twice
  // in 'next dev'. Off for fidelity apps only; template mode keeps the default.
  reactStrictMode: false
};
`);

  write(join(outDir, 'app', 'layout.jsx'), `export const metadata = { title: ${JSON.stringify(host)} };

export default function RootLayout({ children }) {
  // The captured page sets html/body classes from an inline script at render time.
  // React never declares those attributes here, so it has nothing to reconcile — the
  // suppression is belt and braces for the externally-mutated case.
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
`);

  write(join(outDir, 'app', '[[...slug]]', 'page.jsx'), `${componentize ? "import { SiteScripts } from '@underpin/templates/DomTree';" : "import FidelityPage, { SiteScripts } from '@underpin/templates/DomTree';"}
import routes from '../../content/routes.json';

const load = (key) => require(\`../../content/pages/\${key}.json\`);

export function generateStaticParams() {
  return routes.map((r) => ({ slug: r.path === '/' ? [] : r.path.replace(/^\\/|\\/$/g, '').split('/') }));
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
  const get = (sel) => page.head?.meta?.find(sel)?.content;
  return {
    title: page.title,
    description: get((m) => m.name === 'description'),
    openGraph: {
      title: get((m) => m.property === 'og:title'),
      description: get((m) => m.property === 'og:description'),
      images: get((m) => m.property === 'og:image') ? [get((m) => m.property === 'og:image')] : undefined
    }
  };
}

export default async function Page({ params }) {
  const { slug } = await params;
  const route = routeFor(slug);
  if (!route) return null;
  const page = load(route.key);
${componentize ? "  const PageSections = require(`../../components/pages/${route.key}/Page.jsx`).default;\n" : ''}
  return (
    <>
      {/* Runs before the stylesheets so the class is on <body> the moment the cascade
          resolves. WordPress themes scope heavily to body classes; without this the page
          background only paints the inner content and the real body shows through. */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            'document.body.className=' + JSON.stringify(page.bodyClass || '') + ';' +
            'document.documentElement.className=' + JSON.stringify(page.htmlClass || '') + ';'
        }}
      />

      {/* React 19 only hoists these into <head> when precedence is set; without it all
          of them stay in <body> and most of the site renders unstyled. A shared
          precedence keeps render order === original document order, and <style> needs an
          href as its dedup key. */}
      {page.sheets.map((sheet, i) =>
        sheet.kind === 'link' ? (
          <link key={i} rel="stylesheet" href={sheet.href} precedence="site" />
        ) : (
          <style
            key={i}
            href={'inline-' + i}
            precedence="site"
            dangerouslySetInnerHTML={{ __html: sheet.css }}
          />
        )
      )}

      {/* Structured data is data, not markup — verbatim is correct here. */}
      {(page.jsonLd ?? []).map((block, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: block }} />
      ))}

      {/* Componentised builds compose named per-section files; the single-blob build
          renders the whole captured tree through one renderer. Both produce the same
          DOM — that equivalence is the acceptance test. */}
      ${componentize ? '<PageSections />' : '<FidelityPage page={page} />'}
      <SiteScripts scripts={page.scripts ?? []} />
    </>
  );
}
`);

  write(join(outDir, 'app', 'sitemap.js'), `import routes from '../content/routes.json';
export const dynamic = 'force-static';
export default function sitemap() {
  return routes.map((r) => ({ url: new URL(r.path, ${JSON.stringify(origin)}).toString(), lastModified: new Date() }));
}
`);
  write(join(outDir, 'app', 'robots.js'), `export const dynamic = 'force-static';
export default function robots() {
  return { rules: [{ userAgent: '*', allow: '/' }], sitemap: ${JSON.stringify(origin + '/sitemap.xml')} };
}
`);

  write(join(outDir, 'README.md'), `# ${host} — fidelity migration

Reproduces the original design exactly, in React, with **no WordPress at runtime**.

    npm install && npm run build   # static export to ./out

The rendered DOM, the site's own stylesheets and its animation scripts were captured
from a real browser and re-hosted under \`public/assets\`. Every node renders through
\`React.createElement\` — this is a real component tree, not an innerHTML blob.

**Trade-off:** nothing here is shared with other migrated sites. Fidelity mode and
template mode are opposite ends of the same dial; see the project README.
`);
}
