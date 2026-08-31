import { loadEnv } from '../util/env.js';
import { createAnthropic } from './anthropic.js';

/**
 * The optional model layer.
 *
 * Load-bearing invariant, stated once so it is not eroded by a later convenience: the
 * pipeline must run with no API key. Rules already decide everything; a model only ever
 * makes a *cosmetic* call better — what to name a component, and whether a strip of markup
 * is site chrome or content. Neither answer can change the DOM, so the worst a model can
 * do here is pick a duller filename.
 *
 * Everything is therefore fail-open: no key, no package, a timeout, a refusal, a malformed
 * answer — every one of them lands back on the rule that was already there.
 */
/**
 * Validates a model's naming answer, or rejects the whole thing.
 *
 * Whole, not partly: a name becomes a filename and an import, so a half-applied set is
 * harder to reason about than none at all. Exported so the tests exercise the real rule
 * rather than a copy of it that can drift.
 */
export function validateNames(answer, sections) {
  const rows = answer?.names;
  if (!Array.isArray(rows) || rows.length !== sections.length) return null;

  const ids = new Set(sections.map((s) => s.id));
  const seen = new Set();
  const out = {};
  for (const r of rows) {
    if (!ids.has(r?.id) || typeof r?.name !== 'string') return null;
    if (!/^[A-Z][A-Za-z0-9]{2,31}$/.test(r.name) || seen.has(r.name)) return null;
    seen.add(r.name);
    out[r.id] = r.name;
  }
  return out;
}

export function createLlm({ env = loadEnv(), enabled = true } = {}) {
  if (!enabled) return { available: false, reason: 'not requested' };

  const provider = (env.LLM_PROVIDER ?? 'none').toLowerCase();
  if (provider === 'none' || !provider) return { available: false, reason: 'LLM_PROVIDER is not set' };
  if (provider !== 'anthropic') return { available: false, reason: `unknown provider "${provider}"` };

  const apiKey = env.LLM_API_KEY || env.ANTHROPIC_API_KEY;
  if (!apiKey) return { available: false, reason: 'no LLM_API_KEY' };

  const model = env.LLM_MODEL || 'claude-opus-5';
  const client = createAnthropic({ apiKey, model });

  return {
    available: true,
    provider,
    model,

    /**
     * Names a page's sections.
     *
     * Validated hard, because a name becomes a filename and an import: it must be a
     * PascalCase identifier, there must be exactly one per section, and they must be
     * unique. Anything else and the whole answer is discarded — a partially-applied set
     * of names is harder to reason about than none.
     */
    async nameSections(sections) {
      const result = await client.ask({
        system:
          'You name React components for sections of a migrated web page. Reply with JSON only. ' +
          'Each name is PascalCase, 3-32 letters and digits, no punctuation, and describes what the ' +
          'section IS to a visitor (HeroBanner, PricingTiers, LogoWall), never its position or its CSS classes.',
        prompt: JSON.stringify({ sections }, null, 1),
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['names'],
          properties: {
            names: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name'],
                properties: { id: { type: 'string' }, name: { type: 'string' } }
              }
            }
          }
        }
      });

      return validateNames(result, sections);
    }
  };
}
