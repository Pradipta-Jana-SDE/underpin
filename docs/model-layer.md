# The model layer - and running with no API key

## The rule
The pipeline runs end to end with NO API key and NO account. Rules resolve
75-85% of pages. Without a model the tail doesn't fail - it routes to the human
review queue. The model is an accelerator that shrinks the queue, never a
dependency. Design it the other way round and the tool is unusable the first
time a rate limit hits.

## Three modes, all demoable

  MODE A - no model         LLM_PROVIDER unset. Rules only. Deterministic.
                            Use for: fallback demo, CI, reproducibility.

  MODE B - local, no signup Ollama + a 7-14B instruct model on your Mac.
                            No key, no quota, no data leaves the machine.
                            Use for: offline work, client-confidentiality answer.

  MODE C - free hosted key  2-minute signup, no credit card.
                            Use for: the main demo.

## Free tiers compared (Aug 2026 - these move without notice)

| Provider              | Free ceiling            | JSON schema | Trains on data | Verdict     |
|-----------------------|-------------------------|-------------|----------------|-------------|
| Groq (Qwen3-32B)      | 14,400 req/day, 30k TPM | yes         | no             | PRIMARY     |
| Cerebras              | 30 RPM, 1M tokens/day   | yes         | no             | backup      |
| Google AI Studio Flash| 250 req/day, 10 RPM     | yes         | YES            | escalation  |
| Google Flash-Lite     | 1,000 req/day, 15 RPM   | yes         | YES            | volume      |
| OpenRouter            | ~50 req/day, ~20 RPM    | varies      | no             | A/B only    |

Groq wins on ceiling by an order of magnitude. Get a key at console.groq.com -
no credit card.

## Quota maths
500-page site, rules resolve 80% -> ~100 model calls.
Groq free ceiling = 144 such sites per day. The free tier is not the constraint.
Results cached by content hash, so an unchanged re-run costs zero calls (and
that cache is what makes classification reproducible).

## On Google's training clause
Google's free tier uses submitted content to improve its products and human
reviewers may see it. Disqualifying for private data - but the input here is the
PUBLIC HTML of a PUBLIC marketing page, already indexed by every crawler alive.
Exposure is ~nil. Say this explicitly in the docs rather than letting a reviewer
wonder if you noticed. If a client objects on principle, Mode B answers it.

## Config - one env var
  LLM_PROVIDER=groq     # groq | cerebras | gemini | openrouter | ollama | none
  LLM_MODEL=qwen3-32b
  LLM_API_KEY=...       # omit entirely for ollama or none

## Where the model actually earns its place (ranked)
  1. Section archetypes on unknown builders (rung C is weakest; fidelity won here)
  2. Which colour is the brand colour (frequency picks the body background)
  3. Leftover reconciliation - "which template would have held this?"
  4. The per-page review note in plain English
  5. Slot mapping on messy content (heading levels lie constantly)
  6. Scope recommendations - proposing the default disposition per capability

## Four guardrails, non-negotiable
  - Every call bound to a JSON schema whose enum comes from sections.vocabulary.json.
    The model cannot invent an archetype.
  - Every result carries confidence + decided_by:"llm" so reviewers can filter to
    exactly what the model touched.
  - Every call cached by content hash -> same input, same answer.
  - Every failure (quota, timeout, refusal, bad JSON) falls through to the human
    queue, never to a guess.

## Naming it honestly
"Schema-constrained classification with a rules fast path" is a good design and
worth describing plainly. "AI-powered semantic understanding" invites one probing
question the code cannot survive.
