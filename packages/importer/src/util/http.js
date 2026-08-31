import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_UA =
  process.env.UNDERPIN_USER_AGENT ??
  'UnderpinBot/0.1 (+WordPress migration tooling; respects robots.txt)';

const DELAY_MS = Number(process.env.UNDERPIN_DELAY_MS ?? 350);
const CONCURRENCY = Number(process.env.UNDERPIN_CONCURRENCY ?? 3);

/** Per-origin serialised delay. Politeness is per host, not global. */
const lastHit = new Map();

async function throttle(origin) {
  const now = Date.now();
  const last = lastHit.get(origin) ?? 0;
  const wait = last + DELAY_MS - now;
  if (wait > 0) await sleep(wait);
  lastHit.set(origin, Date.now());
}

const cache = new Map();

/**
 * Fetch with politeness, retry and backoff. Returns { ok, status, url, headers, text }.
 * Never throws on HTTP status — callers branch on `status`, because a 401 or 404 is
 * information rather than a failure.
 */
export async function get(url, { retries = 2, timeoutMs = 20000, accept = 'text/html,*/*' } = {}) {
  if (cache.has(url)) return cache.get(url);

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return { ok: false, status: 0, url, headers: {}, text: '', error: 'invalid url' };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(origin);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ctl.signal,
        headers: { 'user-agent': DEFAULT_UA, accept, 'accept-language': 'en;q=0.9' }
      });
      clearTimeout(timer);

      // Retry only on transient server-side conditions.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        await sleep(retryAfter * 1000 || 800 * (attempt + 1));
        continue;
      }

      const ct = res.headers.get('content-type') ?? '';
      const isText = /text|xml|json|javascript/.test(ct);
      const out = {
        ok: res.ok,
        status: res.status,
        url: res.url,
        headers: Object.fromEntries(res.headers.entries()),
        contentType: ct,
        text: isText ? await res.text() : ''
      };
      cache.set(url, out);
      return out;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) {
        const out = { ok: false, status: 0, url, headers: {}, text: '', error: String(err.message ?? err) };
        cache.set(url, out);
        return out;
      }
      await sleep(600 * (attempt + 1));
    }
  }
  return { ok: false, status: 0, url, headers: {}, text: '' };
}

/**
 * HEAD-like probe. Returns the status AND where a redirect points, because WordPress
 * 301s unknown paths to the homepage — so a bare 3xx is evidence of ABSENCE, not
 * presence. Treating it as presence produced false WooCommerce detections in testing.
 */
export async function probe(url) {
  try {
    const origin = new URL(url).origin;
    await throttle(origin);
    let res = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': DEFAULT_UA } });
    if (res.status === 405 || res.status === 501) {
      const g = await get(url);
      return { status: g.status, location: null, headers: g.headers };
    }
    return {
      status: res.status,
      location: res.headers.get('location'),
      headers: Object.fromEntries(res.headers.entries())
    };
  } catch {
    return { status: 0, location: null, headers: {} };
  }
}

/**
 * True only when a path genuinely resolves to its own resource. A redirect to `/`
 * (or to a path that shares no segment with the request) means the route does not exist.
 */
export function resolvesToSelf(requestPath, { status, location }) {
  if (status === 200) return true;
  if (status !== 301 && status !== 302 && status !== 308) return false;
  if (!location) return false;
  let target;
  try {
    target = new URL(location, 'https://x.invalid').pathname;
  } catch {
    return false;
  }
  if (target === '/' || target === '') return false;
  const seg = requestPath.replace(/^\/|\/$/g, '').split('/').filter(Boolean)[0];
  return Boolean(seg) && target.toLowerCase().includes(seg.toLowerCase());
}

/** Bounded-concurrency map. Keeps us polite on large sitemaps. */
export async function mapLimit(items, fn, limit = CONCURRENCY) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function clearCache() {
  cache.clear();
}
