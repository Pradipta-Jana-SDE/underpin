import { XMLParser } from 'fast-xml-parser';
import { get, probe } from '../util/http.js';
import { readRobots, isAllowed } from '../util/robots.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/**
 * Sitemap discovery chain, in the order the evidence supports.
 *
 * Probing three production WordPress sites showed the "just fetch /wp-sitemap.xml"
 * assumption fails: the WP core default returned 200 on NONE of them, and no single
 * path won on more than two. robots.txt is the only authoritative pointer, and it was
 * absent on one site — so the chain is the minimum that works, not belt-and-braces.
 */
const SITEMAP_FALLBACKS = ['/wp-sitemap.xml', '/sitemap_index.xml', '/sitemap.xml', '/sitemap-index.xml'];

/** REST discovery. The Link header survives plain permalinks, where /wp-json/ 404s. */
export async function probeRest(origin) {
  const home = await get(origin + '/');
  const link = home.headers?.link ?? home.headers?.Link ?? '';
  const m = /<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/.exec(link);
  const advertised = m?.[1] ?? null;

  const candidates = [advertised, `${origin}/wp-json/`, `${origin}/?rest_route=/`].filter(Boolean);
  for (const url of candidates) {
    const res = await get(url, { accept: 'application/json' });
    if (res.ok && /json/.test(res.contentType ?? '')) {
      let base = url;
      try {
        const parsed = JSON.parse(res.text);
        if (parsed?.routes) base = url;
      } catch {
        continue;
      }
      // Confirm the pages collection is actually readable — a 200 on / proves little.
      const sep = base.includes('?rest_route=') ? '' : '';
      const pagesUrl = base.includes('?rest_route=')
        ? `${origin}/?rest_route=/wp/v2/pages&per_page=1`
        : `${base.replace(/\/$/, '')}/wp/v2/pages?per_page=1`;
      const pages = await get(pagesUrl, { accept: 'application/json' });
      return {
        reachable: pages.ok,
        base: base.replace(/\/$/, ''),
        advertised: Boolean(advertised),
        viaRestRoute: base.includes('rest_route'),
        pagesStatus: pages.status,
        totalPages: Number(pages.headers?.['x-wp-totalpages'] ?? 0),
        total: Number(pages.headers?.['x-wp-total'] ?? 0)
      };
    }
  }
  return { reachable: false, base: null, advertised: Boolean(advertised), pagesStatus: 0 };
}

function collectUrls(node) {
  // urlset -> pages; sitemapindex -> more sitemaps
  const out = { pages: [], sitemaps: [] };
  if (node?.urlset?.url) {
    const list = Array.isArray(node.urlset.url) ? node.urlset.url : [node.urlset.url];
    for (const u of list) {
      if (!u?.loc) continue;
      out.pages.push({
        loc: String(u.loc).trim(),
        lastmod: u.lastmod ? String(u.lastmod) : null,
        images: u['image:image']
          ? (Array.isArray(u['image:image']) ? u['image:image'] : [u['image:image']])
              .map((i) => i?.['image:loc'])
              .filter(Boolean)
          : []
      });
    }
  }
  if (node?.sitemapindex?.sitemap) {
    const list = Array.isArray(node.sitemapindex.sitemap) ? node.sitemapindex.sitemap : [node.sitemapindex.sitemap];
    for (const s of list) if (s?.loc) out.sitemaps.push(String(s.loc).trim());
  }
  return out;
}

async function readSitemap(url, seen, depth = 0) {
  if (seen.has(url) || depth > 3) return [];
  seen.add(url);
  const res = await get(url, { accept: 'application/xml,text/xml' });
  if (!res.ok || !res.text.trim().startsWith('<')) return [];
  let parsed;
  try {
    parsed = xml.parse(res.text);
  } catch {
    return [];
  }
  const { pages, sitemaps } = collectUrls(parsed);
  const nested = [];
  for (const child of sitemaps) nested.push(...(await readSitemap(child, seen, depth + 1)));
  return [...pages, ...nested];
}

/**
 * Walks the discovery chain and returns the full URL inventory plus how it was found.
 * `chain` is kept in the result because "which path worked" is itself evidence the
 * report should show.
 */
export async function discover(siteUrl) {
  const origin = new URL(siteUrl).origin;
  const chain = [];

  const robots = await readRobots(origin);
  chain.push({ step: 'robots.txt', found: robots.present, sitemaps: robots.sitemaps.length });

  const candidates = [...robots.sitemaps];
  for (const p of SITEMAP_FALLBACKS) if (!candidates.some((c) => c.endsWith(p))) candidates.push(origin + p);

  const seen = new Set();
  let pages = [];
  for (const candidate of candidates) {
    const found = await readSitemap(candidate, seen);
    if (found.length) {
      chain.push({ step: 'sitemap', url: candidate, urls: found.length });
      pages = found;
      break;
    }
    chain.push({ step: 'sitemap', url: candidate, urls: 0 });
  }

  // Last resort: crawl links off the homepage.
  let viaLinkCrawl = false;
  if (!pages.length) {
    const home = await get(origin + '/');
    const hrefs = [...home.text.matchAll(/href=["']([^"'#]+)["']/g)].map((m) => m[1]);
    const set = new Set();
    for (const h of hrefs) {
      try {
        const u = new URL(h, origin);
        if (u.origin === origin && !/\.(jpe?g|png|gif|svg|pdf|zip|css|js)$/i.test(u.pathname)) {
          set.add(u.origin + u.pathname);
        }
      } catch {}
    }
    pages = [...set].map((loc) => ({ loc, lastmod: null, images: [] }));
    viaLinkCrawl = true;
    chain.push({ step: 'homepage_link_crawl', urls: pages.length });
  }

  const rest = await probeRest(origin);
  chain.push({ step: 'rest', reachable: rest.reachable, viaRestRoute: Boolean(rest.viaRestRoute) });

  const allowed = pages.filter((p) => {
    try {
      return isAllowed(new URL(p.loc).pathname, robots.disallow);
    } catch {
      return false;
    }
  });

  return {
    origin,
    urls: allowed,
    blockedByRobots: pages.length - allowed.length,
    viaLinkCrawl,
    rest,
    robots,
    chain
  };
}
