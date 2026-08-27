import * as cheerio from 'cheerio';
import { get, probe, mapLimit, resolvesToSelf } from '../util/http.js';
import { CAPABILITIES, BUILDERS } from './signatures.js';

/** Every <script src> and <link href> on the page — the richest plugin signal available. */
function assetUrls($) {
  const out = [];
  $('script[src]').each((_, el) => out.push($(el).attr('src')));
  $('link[href]').each((_, el) => out.push($(el).attr('href')));
  return out.filter(Boolean);
}

function jsonLdTypes($) {
  const types = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          if (node['@type']) [].concat(node['@type']).forEach((t) => types.add(String(t)));
          if (node['@graph']) walk(node['@graph']);
        }
      };
      walk(parsed);
    } catch {
      /* malformed JSON-LD is common in the wild; not worth failing over */
    }
  });
  return [...types];
}

async function restNamespaces(restBase) {
  if (!restBase) return [];
  const res = await get(restBase.endsWith('/') ? restBase : restBase + '/', { accept: 'application/json' });
  if (!res.ok) return [];
  try {
    return JSON.parse(res.text)?.namespaces ?? [];
  } catch {
    return [];
  }
}

function detectBuilder(html) {
  const scores = BUILDERS.map((b) => ({
    id: b.id,
    hits: b.match.filter((re) => re.test(html)).length
  })).filter((b) => b.hits > 0);
  scores.sort((a, b) => b.hits - a.hits);
  // Gutenberg is present on almost every modern site; only call it the builder if nothing else matched.
  const nonGutenberg = scores.filter((s) => s.id !== 'gutenberg');
  return (nonGutenberg[0] ?? scores[0])?.id ?? null;
}

/**
 * Fingerprints what a site actually DOES, before extraction runs.
 *
 * Scope must be decided before we crawl: fetching 142 product pages and then finding
 * out nobody wanted them wastes the most expensive part of the pipeline.
 */
export async function fingerprint({ origin, urls, rest }) {
  const home = await get(origin + '/');
  const html = home.text ?? '';
  const $ = cheerio.load(html);

  const bodyClass = ($('body').attr('class') ?? '').toLowerCase();
  const assets = assetUrls($).join('\n');
  const jsonld = jsonLdTypes($);
  const namespaces = await restNamespaces(rest?.base);
  const hreflangs = $('link[rel="alternate"][hreflang]')
    .map((_, el) => $(el).attr('hreflang'))
    .get()
    .filter((h) => h && h !== 'x-default');

  const urlList = urls.map((u) => {
    try {
      return new URL(u.loc).pathname;
    } catch {
      return '';
    }
  });

  // Probe well-known paths, but only ones the sitemap did not already confirm.
  const pathsToProbe = [...new Set(CAPABILITIES.flatMap((c) => c.paths))].filter(
    (p) => !urlList.includes(p)
  );
  const probeResults = new Map(
    await mapLimit(pathsToProbe, async (p) => [p, await probe(origin + p)], 3)
  );
  const pathExists = (p) =>
    urlList.includes(p) || resolvesToSelf(p, probeResults.get(p) ?? { status: 0, location: null });

  const truncate = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + '\u2026' : s);

  const detected = [];
  for (const cap of CAPABILITIES) {
    const evidence = [];
    /**
     * Score by independent signal CLASS, not by raw hit count. One weak signal is a
     * coincidence; two unrelated ones are a finding. This is what stops a 301-to-homepage
     * on /shop/ from reading as a storefront.
     */
    const classes = new Set();
    let score = 0;

    const nsHit = cap.restNamespaces.filter((ns) => namespaces.includes(ns));
    if (nsHit.length) { evidence.push(`REST namespace ${nsHit.join(', ')}`); score += 0.55; classes.add('rest'); }

    const bcHit = cap.bodyClasses.filter((c) => bodyClass.includes(c));
    if (bcHit.length) { evidence.push(`body class ${bcHit.join(', ')}`); score += 0.2; classes.add('body'); }

    const aHit = cap.assetPatterns.filter((re) => re.test(assets));
    if (aHit.length) { evidence.push(`${aHit.length} plugin asset handle(s)`); score += 0.4; classes.add('asset'); }

    const pHit = cap.paths.filter(pathExists);
    if (pHit.length) { evidence.push(`path ${pHit.join(', ')} resolves`); score += 0.15; classes.add('path'); }

    const uHit = cap.urlPatterns ? urlList.filter((p) => cap.urlPatterns.some((re) => re.test(p))) : [];
    if (uHit.length) { evidence.push(`${uHit.length} matching URL(s) in sitemap`); score += 0.3; classes.add('url'); }

    const jHit = cap.jsonld ? cap.jsonld.filter((t) => jsonld.includes(t)) : [];
    if (jHit.length) { evidence.push(`JSON-LD ${jHit.join(', ')}`); score += 0.25; classes.add('jsonld'); }

    if (cap.id === 'multilingual' && hreflangs.length > 1) {
      const locales = [...new Set(hreflangs.map((h) => h.split('-')[0]))];
      evidence.push(truncate(`hreflang declares ${locales.length} locales: ${locales.join(', ')}`));
      score += 0.55;
      classes.add('hreflang');
    }

    if (!evidence.length) continue;

    // A single signal class caps out below the decision bar unless it is a hard signal.
    const hasHard = (cap.hardSignals ?? []).some((h) =>
      ({ restNamespaces: nsHit.length, assetPatterns: aHit.length, paths: pHit.length, hreflang: hreflangs.length > 1 }[h])
    );
    if (classes.size < 2 && !hasHard) score = Math.min(score, 0.35);

    // Counts come from the URLs that actually matched, not a second guess at the
    // permalink shape — /product/ vs /products/ differs per site and undercounting here
    // is how a 95-product store gets presented to the operator as empty.
    const counts = {};
    if (cap.id === 'woocommerce') counts.products = uHit.length;
    if (cap.id === 'blog') counts.posts = uHit.length;
    if (cap.id === 'lms') counts.courses = uHit.length;
    if (cap.id === 'multilingual') {
      const locales = [...new Set(hreflangs.map((h) => h.split('-')[0]))];
      counts.localeCount = locales.length;
      counts.locales = locales.slice(0, 12); // sample for display; localeCount is the truth
    }

    detected.push({
      id: cap.id,
      label: cap.label,
      confidence: Math.min(1, Number(score.toFixed(2))),
      signalClasses: [...classes],
      evidence: evidence.map((e) => truncate(e, 110)),
      detected: counts,
      matchedUrls: uHit.slice(0, 500)
    });
  }

  detected.sort((a, b) => b.confidence - a.confidence);

  return {
    builder: detectBuilder(html),
    restNamespaces: namespaces,
    jsonldTypes: jsonld,
    hreflangs: [...new Set(hreflangs)],
    capabilities: detected,
    /** Capabilities above this bar carry a business consequence and must be decided by a human. */
    needsDecision: detected.filter((d) => d.confidence >= 0.4 && d.id !== 'embeds' && d.id !== 'forms')
  };
}
