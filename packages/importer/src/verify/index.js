import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.html')) out.push(p);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Verifies the built output against the acceptance criteria that can be checked
 * mechanically, rather than asserted in a README.
 *
 * The load-bearing one is origin independence: if a single asset still points at the
 * source domain, the migrated site depends on WordPress staying up, and "does not depend
 * on WordPress at runtime" is false no matter what the architecture diagram claims.
 */
export function verifyBuild({ outDir, siteUrl, routes }) {
  const dist = join(outDir, 'site', 'out');
  if (!existsSync(dist)) {
    return {
      built: false,
      passed: false,
      checks: [
        {
          id: 'built',
          label: 'Exported build exists',
          pass: false,
          detail: 'no export found — run `npm install && npm run build` in the site directory'
        }
      ]
    };
  }

  const files = walk(dist);
  const origin = new URL(siteUrl).origin;
  const checks = [];

  // 1. URL parity — every planned route exists as a real file on disk.
  const missing = routes.filter((r) => {
    const rel = r.path === '/' ? 'index.html' : join(r.path.replace(/^\/|\/$/g, ''), 'index.html');
    return !existsSync(join(dist, rel));
  });
  checks.push({
    id: 'url_parity',
    label: 'Every planned URL exists in the export',
    pass: missing.length === 0,
    detail: missing.length
      ? `${missing.length} missing: ${missing.slice(0, 5).map((m) => m.path).join(', ')}`
      : `${routes.length}/${routes.length} routes exported`
  });

  // 2. Origin independence — the criterion the whole project turns on.
  //
  // Not every absolute URL on the origin is a violation. og:image MUST be absolute, and
  // Next resolves our own /media/ paths against metadataBase, which is the same domain
  // the migrated site deploys to — that asset is served by us, not by WordPress. What
  // actually matters is whether the path is one WE generated. Anything under /wp-content,
  // /wp-includes or /wp-json is still being served by the old stack.
  const assetRe = new RegExp(`["'(]\\s*(${escapeRe(origin)}/[^"')\\s\\\\]+)`, 'gi');
  const ourPath = (u) => {
    try {
      return new URL(u).pathname.startsWith('/media/');
    } catch {
      return false;
    }
  };
  const offenders = [];
  for (const f of files) {
    const html = readFileSync(f, 'utf8');
    const hits = [...html.matchAll(assetRe)]
      .map((m) => m[1])
      .filter((u) => /\.(jpe?g|png|gif|webp|avif|svg|css|js|woff2?|mp4)(\?|$)/i.test(u))
      .filter((u) => !ourPath(u));
    if (hits.length) offenders.push({ file: relative(dist, f), refs: [...new Set(hits)].slice(0, 4) });
  }
  checks.push({
    id: 'origin_independence',
    label: 'No asset still loads from the WordPress origin',
    pass: offenders.length === 0,
    detail: offenders.length
      ? `${offenders.length} page(s) still reference ${origin} — ` +
        offenders.slice(0, 3).map((o) => `${o.file} → ${o.refs[0]}`).join('; ')
      : 'every asset is served by the migrated site'
  });

  // 3. SEO essentials.
  let noTitle = 0;
  let noCanonical = 0;
  for (const f of files) {
    const html = readFileSync(f, 'utf8');
    if (!/<title>[^<]{1,}<\/title>/i.test(html)) noTitle++;
    if (!/rel="canonical"/i.test(html)) noCanonical++;
  }
  checks.push({
    id: 'seo_title',
    label: 'Every page has a non-empty title',
    pass: noTitle === 0,
    detail: noTitle ? `${noTitle} of ${files.length} page(s) missing a title` : `${files.length} pages checked`
  });
  checks.push({
    id: 'seo_canonical',
    label: 'Canonical links carried across',
    // Soft: a page whose source had no canonical should not fail the build.
    pass: noCanonical <= Math.ceil(files.length * 0.25),
    detail: `${files.length - noCanonical}/${files.length} pages carry a canonical`
  });

  // 4. Sitemap and robots — cheap, and their absence is an easy own goal.
  const hasSitemap = existsSync(join(dist, 'sitemap.xml'));
  checks.push({
    id: 'sitemap',
    label: 'sitemap.xml and robots.txt generated',
    pass: hasSitemap && existsSync(join(dist, 'robots.txt')),
    detail: hasSitemap ? 'both present' : 'missing'
  });

  // 5. No WordPress runtime endpoints leaked into the output.
  const wpArtefacts = files.filter((f) => /wp-admin|wp-login|xmlrpc\.php/i.test(readFileSync(f, 'utf8')));
  checks.push({
    id: 'no_wp_runtime',
    label: 'No wp-admin / wp-login / xmlrpc references',
    pass: wpArtefacts.length === 0,
    detail: wpArtefacts.length ? `${wpArtefacts.length} page(s) reference WordPress endpoints` : 'clean'
  });

  return { built: true, pages: files.length, checks, passed: checks.every((c) => c.pass) };
}
