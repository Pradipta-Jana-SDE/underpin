import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dirFor, hostOf, ndjson, fail } from '../../../lib/studio.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

/**
 * Stage 7b: actually compile the generated project.
 *
 * Generating an app and leaving `npm install && npm run build` to the operator means Preview,
 * one click later, has nothing to serve. This runs both and streams their output.
 */
/**
 * The generated app has to build in a clean environment.
 *
 * This spawns from inside the studio's own Next process, so the child inherits that
 * process's Next-internal variables and resolves framework internals meant for the parent.
 * The build then dies prerendering /404 with "<Html> should not be imported outside of
 * pages/_document" — a failure in the studio, not in the site it generated, and the same
 * project builds fine from a plain shell.
 */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('NEXT_') || k.startsWith('__NEXT') || k === 'NODE_OPTIONS' || k === 'NODE_ENV') continue;
    env[k] = v;
  }
  return { ...env, NO_COLOR: '1', CI: '1' };
}

export async function POST(request) {
  const { siteUrl } = await request.json().catch(() => ({}));
  const dir = join(dirFor(siteUrl), 'site');
  if (!existsSync(join(dir, 'package.json'))) return fail('Generate the site first.');

  return ndjson(async (send) => {
    const run = (cmd, args, label) =>
      new Promise((resolve) => {
        send({ type: 'stage', stage: 'compile', label });
        const child = spawn(cmd, args, { cwd: dir, env: cleanEnv() });
        const push = (buf) => {
          for (const line of String(buf).split('\n')) {
            const t = line.trim();
            // npm and next are chatty; progress and failure are the interesting lines.
            if (t && !/^npm (notice|warn)/i.test(t)) send({ type: 'note', text: t.slice(0, 200) });
          }
        };
        child.stdout.on('data', push);
        child.stderr.on('data', push);
        child.on('error', (e) => resolve({ code: 1, error: String(e?.message ?? e) }));
        child.on('close', (code) => resolve({ code }));
      });

    // The dependencies are the same three every time, so this is skipped once they are there.
    if (!existsSync(join(dir, 'node_modules'))) {
      const install = await run('npm', ['install', '--no-audit', '--no-fund'], 'Installing next and react');
      if (install.code !== 0) {
        send({ type: 'error', message: `npm install failed (${install.error ?? 'exit ' + install.code})` });
        return;
      }
    }

    const build = await run('npm', ['run', 'build'], 'Building the static export');
    if (build.code !== 0) {
      send({ type: 'error', message: 'next build failed — see the log above' });
      return;
    }

    const pages = existsSync(join(dir, 'out'))
      ? (await readdir(join(dir, 'out'), { recursive: true })).filter((f) => String(f).endsWith('.html')).length
      : 0;
    send({ type: 'compiled', pages });
    send({ type: 'done', host: hostOf(siteUrl) });
  });
}
