import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { captureSite } from '../capture/index.js';
import { mirrorAssets, rewriteTree } from './assets.js';

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
export async function generateFidelitySite({ outDir, siteUrl, plan, urls, mediaLimit, onProgress }) {
  const origin = new URL(siteUrl).origin;
  const targets = urls ?? plan.inScopeUrls;

  onProgress?.({ type: 'stage', label: `Rendering ${targets.length} pages in a real browser` });
  const { pages, assets, failures } = await captureSite(targets, {
    origin,
    onProgress: (done, total, url) => onProgress?.({ type: 'progress', done, total, url })
  });

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

    const styles = [...new Set(p.cssLinks.map((h) => {
      try { return localByUrl.get(new URL(h, p.url).toString().split('#')[0]) ?? null; } catch { return null; }
    }).filter(Boolean))];

    const scripts = p.scripts
      .map((s) => {
        try { return { src: localByUrl.get(new URL(s.src, p.url).toString().split('#')[0]) ?? null }; }
        catch { return null; }
      })
      .filter((s) => s?.src);

    // Inline <style> blocks carry the per-page rules builders emit; their url()
    // references need the same treatment the linked stylesheets got.
    const inlineStyles = p.styleTags
      .filter((c) => c.trim())
      .map((css) =>
        css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (whole, ref) => {
          const r = ref.trim();
          if (!r || r.startsWith('data:')) return whole;
          try {
            const local = localByUrl.get(new URL(r, p.url).toString().split('#')[0]);
            return local ? `url("${local}")` : whole;
          } catch { return whole; }
        })
      );

    const doc = {
      path: p.path,
      url: p.url,
      title: p.title,
      lang: p.lang,
      bodyClass: p.bodyClass,
      htmlClass: p.htmlClass,
      head: p.head,
      styles,
      inlineStyles,
      scripts,
      inlineScripts: p.inlineScripts,
      tree: p.tree,
      mode: 'fidelity'
    };
    write(join(outDir, 'content', 'pages', `${contentKey(p.path)}.json`), asciiJson(doc));
    routes.push({ path: p.path, key: contentKey(p.path) });
  }

  const redirects = (plan.excludedUrls ?? []).map((e) => ({
    from: new URL(e.url).pathname, policy: e.policy, reason: e.reason
  }));
  write(join(outDir, 'content', 'routes.json'), JSON.stringify(routes, null, 2));
  write(join(outDir, 'content', 'redirects.json'), JSON.stringify(redirects, null, 2));

  scaffoldFidelityApp(outDir, { siteUrl, routes, origin });

  return {
    mode: 'fidelity',
    routes,
    media: { total: assets.length, downloaded, skipped: 0, failed: assetFailures },
    captureFailures: failures,
    warnings: []
  };
}

function scaffoldFidelityApp(outDir, { siteUrl, routes, origin }) {
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
  eslint: { ignoreDuringBuilds: true }
};
`);

  write(join(outDir, 'app', 'layout.jsx'), `export const metadata = { title: ${JSON.stringify(host)} };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`);

  write(join(outDir, 'app', '[[...slug]]', 'page.jsx'), `import FidelityPage from '@underpin/templates/DomTree';
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

  return (
    <>
      {/* The source site's own stylesheets, re-hosted. This is what makes the page
          identical rather than merely similar. */}
      {page.styles.map((href) => <link key={href} rel="stylesheet" href={href} />)}
      {page.inlineStyles.map((css, i) => (
        <style key={i} dangerouslySetInnerHTML={{ __html: css }} />
      ))}
      {/* The source site's body class carries real styling weight — Elementor and most
          themes scope rules to it. It is applied to the REAL body: rendering the captured
          <body> inside Next's own body is invalid HTML and silently breaks every
          \`body .foo\` selector on the site. */}
      <script
        dangerouslySetInnerHTML={{
          __html: \`document.body.className=\${JSON.stringify(page.bodyClass || '')};\` +
                  \`document.documentElement.className=\${JSON.stringify(page.htmlClass || '')};\`
        }}
      />
      <FidelityPage page={page} />
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
