import { get } from './http.js';

/**
 * Minimal robots.txt handling: the Sitemap: directives (which the probe showed are the
 * only authoritative pointer) plus Disallow rules for our own user-agent.
 */
export async function readRobots(origin) {
  const res = await get(`${origin}/robots.txt`, { accept: 'text/plain' });
  const sitemaps = [];
  const disallow = [];
  if (!res.ok || !res.text) return { sitemaps, disallow, present: false };

  let appliesToUs = false;
  for (const raw of res.text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.toLowerCase().trim();
    const value = rest.join(':').trim();
    if (key === 'sitemap' && value) sitemaps.push(value);
    else if (key === 'user-agent') appliesToUs = value === '*' || /underpin/i.test(value);
    else if (key === 'disallow' && appliesToUs && value) disallow.push(value);
  }
  return { sitemaps, disallow, present: true };
}

export function isAllowed(pathname, disallow) {
  return !disallow.some((rule) => rule !== '/' && pathname.startsWith(rule));
}
