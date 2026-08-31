import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads a .env file into a plain object, merged UNDER process.env.
 *
 * Under, not over: a value exported in the shell is a deliberate act for this run, and a
 * committed file should never be able to override it. Node's own --env-file would do the
 * job, but it has to be passed on the command line and the npm scripts here are the
 * documented entry point.
 */
export function loadEnv(dir = process.cwd()) {
  const out = {};
  const file = join(dir, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 1) continue;
      const key = t.slice(0, i).trim();
      let value = t.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  }
  return { ...out, ...process.env };
}
