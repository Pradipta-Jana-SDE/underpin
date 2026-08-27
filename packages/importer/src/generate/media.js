import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { mapLimit } from '../util/http.js';

const SAFE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.ico']);

/**
 * Downloads and re-hosts media.
 *
 * Re-hosting is not optional: leaving images pointed at the old domain means the
 * migrated site still depends on WordPress being up, which fails the acceptance
 * criterion outright. Failures are recorded rather than thrown — one dead image should
 * not abort a migration, but it must appear in the report.
 */
export async function downloadMedia(mediaList, outDir, { concurrency = 4, limit = null } = {}) {
  const dir = join(outDir, 'public', 'media');
  mkdirSync(dir, { recursive: true });

  const list = limit ? mediaList.slice(0, limit) : mediaList;
  const failed = [];
  let downloaded = 0;
  let skipped = 0;

  const results = await mapLimit(
    list,
    async (m) => {
      try {
        const url = new URL(m.originalUrl);
        let ext = extname(url.pathname).toLowerCase().split('?')[0];
        if (!SAFE_EXT.has(ext)) ext = '.jpg';
        const name = createHash('sha1').update(m.originalUrl).digest('hex').slice(0, 16) + ext;
        const dest = join(dir, name);
        const localPath = `/media/${name}`;

        if (existsSync(dest)) {
          skipped++;
          return { ...m, localPath };
        }

        const res = await fetch(m.originalUrl, {
          headers: { 'user-agent': process.env.UNDERPIN_USER_AGENT ?? 'UnderpinBot/0.1' }
        });
        if (!res.ok) {
          failed.push({ url: m.originalUrl, status: res.status });
          return { ...m, localPath: null };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        // A 0-byte or HTML error page saved as .jpg is worse than a missing image,
        // because it renders as a broken box with no error anywhere.
        if (buf.length < 64 || buf.slice(0, 14).toString('utf8').trim().toLowerCase().startsWith('<!doctype')) {
          failed.push({ url: m.originalUrl, status: 'not an image' });
          return { ...m, localPath: null };
        }
        writeFileSync(dest, buf);
        downloaded++;
        return { ...m, localPath, bytes: buf.length };
      } catch (err) {
        failed.push({ url: m.originalUrl, status: String(err.message ?? err) });
        return { ...m, localPath: null };
      }
    },
    concurrency
  );

  return { media: results, downloaded, skipped, failed };
}
