import * as cheerio from 'cheerio';
import { get } from '../util/http.js';
import { extractSections } from './sections.js';
import { detectBuilderFromHtml } from './builder-map.js';
import { PageIR } from '@underpin/schema';

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

function extractSeo($, url) {
  const meta = (name) =>
    $(`meta[name="${name}"]`).attr('content') ?? $(`meta[property="${name}"]`).attr('content') ?? null;

  const schemaTypes = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          if (n['@type']) [].concat(n['@type']).forEach((t) => schemaTypes.add(String(t)));
          if (n['@graph']) walk(n['@graph']);
        }
      };
      walk(JSON.parse($(el).text()));
    } catch {}
  });

  return {
    title: clean($('title').first().text()),
    description: meta('description') ?? '',
    canonical: $('link[rel="canonical"]').attr('href') ?? null,
    robots: meta('robots'),
    ogTitle: meta('og:title'),
    ogDescription: meta('og:description'),
    ogImage: meta('og:image'),
    schemaTypes: [...schemaTypes],
    hreflang: $('link[rel="alternate"][hreflang]')
      .map((_, el) => ({ lang: $(el).attr('hreflang'), href: $(el).attr('href') }))
      .get()
      .filter((h) => h.lang && h.href)
  };
}

function extractLinks($, baseUrl, origin) {
  const internal = new Set();
  const external = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    try {
      const u = new URL(href, baseUrl);
      (u.origin === origin ? internal : external).add(u.toString().split('#')[0]);
    } catch {}
  });
  return { internal: [...internal].slice(0, 400), external: [...external].slice(0, 200), broken: [] };
}

/** Post type from WordPress's own body classes — survives a blocked REST API. */
function postTypeFromBody(bodyClass) {
  const m = /\b(?:single|page|archive)-([a-z0-9_-]+)\b/.exec(bodyClass);
  if (/\bpage\b/.test(bodyClass) && !m) return 'page';
  if (/\bsingle-post\b/.test(bodyClass)) return 'post';
  return m?.[1] ?? 'page';
}

export async function extractPage(url, { origin, shell = null, restReachable = false } = {}) {
  const res = await get(url);
  if (!res.ok || !res.text) {
    return { ok: false, url, status: res.status, error: res.error ?? `HTTP ${res.status}` };
  }

  const $ = cheerio.load(res.text);
  const builderId = detectBuilderFromHtml(res.text);
  const { sections, media, boundaryMethod } = extractSections($, url, { builderId, shell });

  const bodyClass = ($('body').attr('class') ?? '').toLowerCase();
  const u = new URL(url);
  const slug = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() ?? 'home';

  // The page's own confidence is the weakest link among its sections — one badly
  // understood hero matters more than nine easy paragraphs.
  const confidence = sections.length
    ? Number((sections.reduce((a, s) => a + s.confidence, 0) / sections.length).toFixed(2))
    : 0;

  const ir = PageIR.parse({
    url,
    path: u.pathname,
    slug,
    type: postTypeFromBody(bodyClass),
    locale: $('html').attr('lang')?.split('-')[0] ?? 'en',
    source: {
      strategy: boundaryMethod === 'builder_dom' ? 'builder_dom' : 'static_dom',
      builder: builderId,
      restReachable,
      fetchedAt: new Date().toISOString(),
      httpStatus: res.status
    },
    seo: extractSeo($, url),
    sections,
    media,
    links: extractLinks($, url, origin ?? u.origin),
    leftover: [],
    rawHtmlRef: null,
    confidence
  });

  return { ok: true, ir, bodyClass, html: res.text };
}
