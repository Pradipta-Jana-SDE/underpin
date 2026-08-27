import { mapLimit } from '../util/http.js';
import { extractPage } from './page.js';
import { extractBranding } from './branding.js';
import { SiteIR } from '@underpin/schema';

export { extractPage, extractBranding };
export { extractSections } from './sections.js';

/**
 * Runs extraction across the in-scope URL set.
 *
 * Site IR is built first because the shell selectors it derives let every page strip
 * its own chrome — without that, the header and footer land in page content on every
 * single page.
 */
/**
 * Picks a representative subset rather than the first N.
 *
 * Sitemaps are usually ordered by post date, so `slice(0, 10)` on a content-heavy site
 * returns ten blog posts and tells you nothing about the templates that matter. Sampling
 * across URL shapes surfaces the homepage, the section landing pages and the long tail.
 */
export function stratifiedSample(urls, n) {
  if (!n || urls.length <= n) return urls;
  const buckets = new Map();
  for (const u of urls) {
    let key = 'other';
    try {
      const segs = new URL(u).pathname.split('/').filter(Boolean);
      key = segs.length === 0 ? 'root' : `${segs[0]}:${Math.min(segs.length, 3)}`;
    } catch {}
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(u);
  }
  // Round-robin across buckets so no single section dominates the sample.
  const lists = [...buckets.values()];
  const out = [];
  for (let i = 0; out.length < n; i++) {
    let progressed = false;
    for (const list of lists) {
      if (i < list.length) {
        out.push(list[i]);
        progressed = true;
        if (out.length >= n) break;
      }
    }
    if (!progressed) break;
  }
  return out;
}

export async function extractSite({ origin, plan, discovery, limit = null, onProgress = null }) {
  const urls = stratifiedSample(plan.inScopeUrls, limit);

  const siteIrRaw = await extractBranding(origin, discovery.urls);
  const siteIr = SiteIR.parse({
    ...siteIrRaw,
    detectedBuilder: discovery.builder ?? siteIrRaw.detectedBuilder,
    restReachable: Boolean(discovery.rest?.reachable)
  });

  let done = 0;
  const results = await mapLimit(
    urls,
    async (url) => {
      const r = await extractPage(url, {
        origin,
        shell: siteIr.shell,
        restReachable: Boolean(discovery.rest?.reachable)
      });
      done++;
      onProgress?.(done, urls.length, url, r);
      return r;
    },
    3
  );

  const pages = results.filter((r) => r.ok).map((r) => r.ir);
  const failed = results.filter((r) => !r.ok).map((r) => ({ url: r.url, status: r.status, error: r.error }));

  return { siteIr, pages, failed };
}

/** Aggregate stats the migration report needs. */
export function extractionStats(pages) {
  const byArchetype = {};
  const byBuilder = {};
  const byDecidedBy = {};
  let sections = 0;
  let lowConfidence = 0;
  let incomplete = 0;

  for (const p of pages) {
    byBuilder[p.source.builder ?? 'none'] = (byBuilder[p.source.builder ?? 'none'] ?? 0) + 1;
    for (const s of p.sections) {
      sections++;
      byArchetype[s.archetype] = (byArchetype[s.archetype] ?? 0) + 1;
      byDecidedBy[s.decidedBy] = (byDecidedBy[s.decidedBy] ?? 0) + 1;
      if (s.confidence < 0.6) lowConfidence++;
      if (s.incompleteCapture) incomplete++;
    }
  }
  return {
    pages: pages.length,
    sections,
    byArchetype,
    byBuilder,
    byDecidedBy,
    lowConfidence,
    incompleteCapture: incomplete,
    media: pages.reduce((a, p) => a + p.media.length, 0)
  };
}
