import * as cache from './cache.js';

/**
 * The Claude call, behind a schema and a timeout. The SDK is an optionalDependency loaded
 * dynamically, like Playwright: the pipeline must run with no API key, including on a
 * machine where the package was never installed. Every failure path returns null, and
 * every caller reads null as "use the rule".
 */
const ENDPOINT_TIMEOUT_MS = 20000;

export function createAnthropic({ apiKey, model }) {
  return {
    async ask({ system, prompt, schema, maxTokens = 2000 }) {
      const key = cache.keyFor({ model, system, prompt, schema });
      const hit = cache.get(key);
      if (hit) return hit.value;

      let Anthropic;
      try {
        ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
      } catch {
        return null; // package not installed — rules it is
      }

      const client = new Anthropic({ apiKey, timeout: ENDPOINT_TIMEOUT_MS, maxRetries: 1 });

      try {
        const res = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          // Naming a section is a small, well-specified judgement, not a reasoning
          // problem. Low effort keeps a 79-page site affordable.
          output_config: { effort: 'low', format: { type: 'json_schema', schema } },
          messages: [{ role: 'user', content: prompt }]
        });

        if (res.stop_reason === 'refusal') return null;
        const text = res.content.find((b) => b.type === 'text')?.text;
        if (!text) return null;

        const value = JSON.parse(text);
        cache.set(key, { value });
        return value;
      } catch {
        // Rate limit, network blip, a schema the model would not satisfy — same answer
        // to all of them. The rules already give a usable result; the model only improves it.
        return null;
      }
    }
  };
}
