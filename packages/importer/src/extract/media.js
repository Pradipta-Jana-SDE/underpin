import { createHash } from 'node:crypto';

const abs = (src, base) => {
  if (!src) return null;
  // `new URL('undefined', origin)` resolves happily to origin + '/undefined', so a
  // stringified undefined that slipped through anywhere upstream becomes a real fetch
  // and a real 404 in the report. Reject the literals rather than hunt every source.
  const t = String(src).trim();
  if (!t || t === 'undefined' || t === 'null' || t === 'about:blank') return null;
  try {
    return new URL(t, base).toString();
  } catch {
    return null;
  }
};

const id = (url) => 'media:' + createHash('sha1').update(url).digest('hex').slice(0, 12);

/** WordPress appends -1024x768 and -scaled to generated sizes. Recover the original. */
export function originalUrl(url) {
  if (!url) return url;
  // Jetpack Photon proxies through i0.wp.com and friends; unwrap it.
  const photon = /^https?:\/\/i\d\.wp\.com\/(.+?)(\?.*)?$/.exec(url);
  if (photon) url = 'https://' + photon[1];
  // Cloudflare Image Resizing: /cdn-cgi/image/<options>/<real path>. Unwrapping gets
  // the full-resolution original instead of a downscaled derivative.
  url = url.replace(/\/cdn-cgi\/image\/[^/]+\//, '/');
  return url
    .replace(/-\d{2,5}x\d{2,5}(?=\.[a-z]{3,4}(?:$|\?))/i, '')
    .replace(/-scaled(?=\.[a-z]{3,4}(?:$|\?))/i, '')
    .replace(/\?.*$/, '');
}

/**
 * Picks the largest candidate from a srcset.
 *
 * Splitting on every comma is wrong and silently produces garbage URLs: Cloudflare
 * Image Resizing encodes its options in the path as `/cdn-cgi/image/f=auto,w=632/...`,
 * so a naive split shreds the URL and every download 404s. Split only on commas that
 * actually separate candidates — the ones followed by something that starts a URL.
 */
export function parseSrcset(srcset) {
  if (!srcset) return [];
  return srcset
    .split(/,(?=\s*(?:https?:\/\/|\/\/|\/|data:))/)
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      const m = /^(\S+)(?:\s+(\d+(?:\.\d+)?)([wx]))?$/.exec(trimmed);
      if (!m) return { url: trimmed.split(/\s+/)[0], width: 0 };
      const [, url, n, unit] = m;
      const width = unit === 'w' ? Number(n) : unit === 'x' ? Number(n) * 1000 : 0;
      return { url, width };
    })
    .filter(Boolean);
}

function widestFromSrcset(srcset) {
  const candidates = parseSrcset(srcset);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.width > a.width ? b : a)).url;
}

/**
 * Extracts every kind of media, not just <img src>.
 *
 * Tracing a real Elementor page showed icon-box graphics render as icon-font <i> tags
 * or CSS masks — an extractor keyed on img[src] never looks there, and the icons vanish
 * with no error raised because nothing was technically wrong. Lazy-loading is the same
 * failure in a different costume: the real URL sits in data-src, not src.
 */
export function extractMedia($, $scope, baseUrl) {
  const found = new Map();
  const push = (rawUrl, meta) => {
    const url = abs(rawUrl, baseUrl);
    if (!url || url.startsWith('data:')) return null;
    const key = originalUrl(url);
    if (!found.has(key)) found.set(key, { id: id(key), originalUrl: key, ...meta });
    return found.get(key).id;
  };

  $scope.find('img').each((_, el) => {
    const $el = $(el);
    // Lazy-loaded images keep a placeholder in src and the real URL in a data attribute.
    const lazy =
      $el.attr('data-src') ||
      $el.attr('data-lazy-src') ||
      $el.attr('data-original') ||
      widestFromSrcset($el.attr('data-srcset') || $el.attr('data-lazy-srcset'));
    const src = lazy || widestFromSrcset($el.attr('srcset')) || $el.attr('src');
    push(src, {
      kind: 'image',
      alt: $el.attr('alt') ?? '',
      width: Number($el.attr('width')) || null,
      height: Number($el.attr('height')) || null,
      source: lazy ? 'srcset' : 'img'
    });
  });

  $scope.find('[style*="background-image"]').each((_, el) => {
    const style = $(el).attr('style') ?? '';
    const m = /background-image\s*:\s*url\((['"]?)(.*?)\1\)/i.exec(style);
    if (m?.[2]) push(m[2], { kind: 'image', alt: '', width: null, height: null, source: 'background' });
  });

  $scope.find('source[srcset]').each((_, el) => {
    push(widestFromSrcset($(el).attr('srcset')), { kind: 'image', alt: '', width: null, height: null, source: 'srcset' });
  });

  // Icon fonts. These are real content — a feature grid without its icons is a
  // different design. We record them as tokens rather than files.
  const icons = [];
  $scope.find('i[class], span[class]').each((_, el) => {
    const cls = $(el).attr('class') ?? '';
    const m = /\b(fa[bsrl]?|fas|far|icon|eicon|dashicons|ti|bi|material-icons)[- ]([a-z0-9-]+)/i.exec(cls);
    if (m && !$(el).text().trim()) icons.push(`${m[1]}:${m[2]}`);
  });

  // Inline SVG used as an icon.
  const svgCount = $scope.find('svg').length;

  return { media: [...found.values()], icons: [...new Set(icons)], svgCount };
}
