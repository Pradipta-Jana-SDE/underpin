import { stratifiedSample } from '../extract/index.js';

/**
 * Which pages a build actually renders. One shared function because three callers used to
 * answer this separately: the CLI and the fidelity generator both read `inScopeUrls`
 * directly, so a selection made in the studio was ignored and the build rendered everything.
 *
 * A selection is an instruction, not a hint — the operator has already said which pages
 * matter, so `limit` applies only when nobody has chosen.
 */
export function resolveTargets(plan, { urls = null, limit = null } = {}) {
  if (urls?.length) return { urls, source: 'explicit' };
  if (plan?.selectedUrls?.length) return { urls: plan.selectedUrls, source: 'selected' };

  const all = plan?.inScopeUrls ?? [];
  return limit
    ? { urls: stratifiedSample(all, limit), source: 'sampled' }
    : { urls: all, source: 'in-scope' };
}

/** Progress-line wording, so the operator can see their selection took effect. */
export function describeTargets({ urls, source }) {
  const n = urls.length;
  const noun = n === 1 ? 'page' : 'pages';
  if (source === 'selected') return `${n} selected ${noun}`;
  if (source === 'sampled') return `${n} sampled ${noun}`;
  return `${n} ${noun}`;
}
