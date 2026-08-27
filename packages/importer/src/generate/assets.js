import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { mapLimit } from '../util/http.js';

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

const EXT_FOR = {
  stylesheet: '.css', script: '.js', font: '.woff2', image: '.png', document: '.html'
};

function extFor(url, kind) {
  const e = extname(new URL(url).pathname).toLowerCase().split('?')[0];
  if (/^\.(css|js|mjs|woff2?|ttf|otf|eot|jpe?g|png|gif|webp|avif|svg|ico|mp4|webm)$/.test(e)) return e;
  return EXT_FOR[kind] ?? '.bin';
}

/**
 * Downloads every asset a captured page needs and rewrites the references between them.
 *
 * The part that decides whether fidelity mode actually works is CSS rewriting: a
 * stylesheet's `url()` references resolve against the STYLESHEET's own URL, not the
 * page's. Rewriting them against the page silently breaks every background image and
 * @font-face on a site whose CSS lives in a subdirectory — which is most of them.
 */
export async function mirrorAssets(assets, outDir, { origin, onProgress } = {}) {
  const dir = join(outDir, 'public', 'assets');
  mkdirSync(dir, { recursive: true });

  const localByUrl = new Map();
  const failures = [];
  let count = 0;

  const nameFor = (url, kind) => `${hash(url)}${extFor(url, kind)}`;

  // First pass: fetch everything and park it. CSS is rewritten afterwards, once every
  // asset it might reference is known.
  const fetched = await mapLimit(
    assets,
    async (a) => {
      try {
        const res = await fetch(a.url, {
          headers: { 'user-agent': process.env.UNDERPIN_USER_AGENT ?? 'UnderpinBot/0.1' }
        });
        if (!res.ok) { failures.push({ url: a.url, status: res.status }); return null; }
        const buf = Buffer.from(await res.arrayBuffer());
        const name = nameFor(a.url, a.kind);
        localByUrl.set(a.url, `/assets/${name}`);
        onProgress?.(++count, assets.length);
        return { ...a, name, buf };
      } catch (err) {
        failures.push({ url: a.url, status: String(err?.message ?? err) });
        return null;
      }
    },
    6
  );

  const ok = fetched.filter(Boolean);

  // Second pass: pull in anything CSS references that the page never requested — fonts
  // behind a media query, sprites on a hover state.
  const extraQueue = [];
  for (const a of ok) {
    if (a.kind !== 'stylesheet') continue;
    const css = a.buf.toString('utf8');
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const ref = m[1].trim();
      if (!ref || ref.startsWith('data:') || ref.startsWith('#')) continue;
      try {
        const abs = new URL(ref, a.url).toString().split('#')[0];
        if (!localByUrl.has(abs) && !extraQueue.some((x) => x.url === abs)) {
          extraQueue.push({ url: abs, kind: /\.(woff2?|ttf|otf|eot)/i.test(abs) ? 'font' : 'image' });
        }
      } catch { /* malformed url() in CSS is common; skip it */ }
    }
  }

  const extra = await mapLimit(
    extraQueue,
    async (a) => {
      try {
        const res = await fetch(a.url, { headers: { 'user-agent': 'UnderpinBot/0.1' } });
        if (!res.ok) { failures.push({ url: a.url, status: res.status }); return null; }
        const buf = Buffer.from(await res.arrayBuffer());
        const name = nameFor(a.url, a.kind);
        localByUrl.set(a.url, `/assets/${name}`);
        return { ...a, name, buf };
      } catch {
        return null;
      }
    },
    6
  );

  // Third pass: write everything, rewriting CSS references against each stylesheet's
  // own URL.
  for (const a of [...ok, ...extra.filter(Boolean)]) {
    let out = a.buf;
    if (a.kind === 'stylesheet') {
      let css = a.buf.toString('utf8');
      css = css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (whole, ref) => {
        const r = ref.trim();
        if (!r || r.startsWith('data:') || r.startsWith('#')) return whole;
        try {
          const abs = new URL(r, a.url).toString().split('#')[0];
          const local = localByUrl.get(abs);
          return local ? `url("${local}")` : whole;
        } catch {
          return whole;
        }
      });
      // Inline @import targets are rare post-build but break silently when missed.
      css = css.replace(/@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?/g, (whole, ref) => {
        try {
          const abs = new URL(ref, a.url).toString();
          const local = localByUrl.get(abs);
          return local ? `@import url("${local}")` : whole;
        } catch {
          return whole;
        }
      });
      out = Buffer.from(css, 'utf8');
    }
    const dest = join(dir, a.name);
    if (!existsSync(dest)) writeFileSync(dest, out);
  }

  return { localByUrl, failures, downloaded: localByUrl.size };
}

/** Rewrites every source URL inside a captured DOM tree to its local copy. */
export function rewriteTree(node, localByUrl, origin) {
  const map = (v) => {
    if (typeof v !== 'string') return v;
    try {
      const abs = new URL(v, origin).toString().split('#')[0];
      return localByUrl.get(abs) ?? v;
    } catch {
      return v;
    }
  };
  const mapSrcset = (v) =>
    typeof v === 'string'
      ? v
          .split(/,(?=\s*(?:https?:\/\/|\/\/|\/))/)
          .map((part) => {
            const [u, ...rest] = part.trim().split(/\s+/);
            return [map(u), ...rest].join(' ');
          })
          .join(', ')
      : v;

  const walk = (n) => {
    if (typeof n === 'string' || n == null) return n;
    if (n.a) {
      for (const k of ['src', 'href', 'poster', 'data-src', 'data-lazy-src']) {
        if (n.a[k]) n.a[k] = map(n.a[k]);
      }
      for (const k of ['srcset', 'data-srcset', 'data-lazy-srcset', 'imagesrcset']) {
        if (n.a[k]) n.a[k] = mapSrcset(n.a[k]);
      }
      if (n.a.style) {
        n.a.style = n.a.style.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (w, r) => {
          const local = map(r.trim());
          return local !== r.trim() ? `url("${local}")` : w;
        });
      }
    }
    if (Array.isArray(n.c)) n.c.forEach(walk);
    return n;
  };
  return walk(node);
}
