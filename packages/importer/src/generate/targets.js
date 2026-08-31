import { stratifiedSample } from '../extract/index.js';

/**
 * Which pages a build actually renders.
 *
 * One function because three callers used to answer this question separately and two of
 * them got it wrong: the CLI and the fidelity generator both read `inScopeUrls` directly,
 * so a selection made in the studio — the whole point of the page-picker step — was
 * silently ignored and the build rendered everything in scope instead.
 *
 * The precedence rule is the interesting part. A selection is an INSTRUCTION, not a hint:
 * the operator has already looked at the page list and said which ones matter, so
 * sampling on top of that would be second-guessing them. `limit` therefore applies only
 * when nobody has chosen. The studio's own migrate handler already worked this way; this
 * is that rule, shared, so every entry point agrees.
 */
export function resolveTargets(plan, { urls = null, limit = null } = {}) {
  if (urls?.length) return { urls, source: 'explicit' };
  if (plan?.selectedUrls?.length) return { urls: plan.selectedUrls, source: 'selected' };

  const all = plan?.inScopeUrls ?? [];
  return limit
    ? { urls: stratifiedSample(all, limit), source: 'sampled' }
    : { urls: all, source: 'in-scope' };
}

/** How to describe the target set in a progress line, so the operator can see it took effect. */
export function describeTargets({ urls, source }) {
  const n = urls.length;
  const noun = n === 1 ? 'page' : 'pages';
  if (source === 'selected') return `${n} selected ${noun}`;
  if (source === 'sampled') return `${n} sampled ${noun}`;
  return `${n} ${noun}`;
}
