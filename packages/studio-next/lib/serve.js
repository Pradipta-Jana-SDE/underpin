import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { SITES } from './studio.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8'
};

export const outDirFor = (host) => join(SITES, host, 'site', 'out');

/**
 * Scopes a preview's navigation to its own project, and nothing else.
 *
 * `<a href>` is rewritten so a click cannot escape into another project's export. Asset URLs
 * are left exactly as the build wrote them, and that restraint is load-bearing: React dedupes
 * hoisted stylesheets by href, so rewriting `<link href>` server-side while the client
 * re-inserted the original path gave twelve sheets where the build emitted seven, and the
 * changed cascade order cost seven points at mobile.
 */
function scopeToPreview(body, host) {
  const p = `/preview/${host}/`;
  return body.replace(/<a\b[^>]*?\bhref=(["'])\/(?!\/|preview\/)/g, (m) => m.slice(0, m.length - 1) + p);
}

/**
 * Reads one file out of a migrated site's static export.
 *
 * The path is normalised and confined to that site's own `out/` directory — a preview must
 * never be able to read another project's files, which is exactly how a migration once
 * appeared wearing the previous site's navigation.
 */
export async function serveFromExport(host, relPath, { rewriteHtml = true } = {}) {
  const root = outDirFor(host);
  if (!existsSync(root)) return null;

  const safe = normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, safe);
  if (!file.startsWith(root)) return null;

  if (!existsSync(file) || statSync(file).isDirectory()) {
    // A static export writes each route as its own index.html.
    const candidate = join(file, 'index.html');
    if (existsSync(candidate)) file = candidate;
    else if (existsSync(`${file}.html`)) file = `${file}.html`;
    else return null;
  }

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  let buf = await readFile(file);

  if (rewriteHtml && type.startsWith('text/html')) {
    buf = Buffer.from(scopeToPreview(buf.toString('utf8'), host), 'utf8');
  }

  return new Response(buf, {
    headers: {
      'content-type': type,
      'cache-control': 'no-store',
      // Assets a stylesheet requests carry the stylesheet as their Referer, not the page,
      // so the cookie is the fallback that tells us which project they belong to.
      'set-cookie': `underpin_preview=${encodeURIComponent(host)}; Path=/; SameSite=Lax`
    }
  });
}
