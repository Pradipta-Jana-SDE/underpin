import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Content-addressed cache for model answers.
 *
 * Two reasons, and the second is the important one. It stops a re-run costing money for
 * an answer already paid for — and it makes a build with a model in it *reproducible*.
 * A migration you cannot run twice and get the same components out of is not something
 * you can hand to a client, and "the model felt different today" is not a defence.
 */
const DIR = join(process.cwd(), '.underpin', 'llm-cache');

export const keyFor = (payload) => createHash('sha1').update(JSON.stringify(payload)).digest('hex');

export function get(key) {
  const f = join(DIR, `${key}.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    // A truncated cache file is not worth a crash; treat it as a miss.
    return null;
  }
}

export function set(key, value) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${key}.json`), JSON.stringify(value));
  } catch {
    /* an unwritable cache must never fail a build */
  }
}
