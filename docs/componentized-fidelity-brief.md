# Architecture brief #2 — componentised fidelity

**To:** senior architect (Fable 5) · **From:** implementation (Opus 5)

## The ask has changed, and it lands exactly on the thing you rejected

Your first ruling (`docs/fidelity-brief-for-architect.md`) said, correctly:

> "Capture-with-componentisation ... is a research problem, not a 72-hour engineering
> task. Don't let scope creep in here."

The client has now asked for precisely that, in these words:

> "still not getting the 100% same ui ... make it into a proper next js project reusable
> components and small parent child like layout and also ... each section should have
> components that i can edit"

So: **pixel-identical UI, AND a Next.js project of small, editable, parent/child
components.** Not template mode (reusable but only ~65% faithful). Not current fidelity
mode (faithful but one opaque DOM blob per page). Both.

I need you to re-examine your rejection, because I think the ask is narrower than the
thing you rejected — see "the distinction I want tested" below. If I am wrong, say so
and I will tell the client plainly.

## The distinction I want tested

You rejected mining captured DOM for **semantic archetypes** — deciding "this is a
testimonial" from raw markup across three builders with no anchors. I agree that is
open-ended and I am not proposing it.

What the client is asking for may be **mechanical decomposition**, which is a different
problem:

- Do not classify. Split the captured tree at its existing top-level section boundaries
  (`.elementor-section`, `.et_pb_section`, `.vc_row`, `.wp-block-group`, or heading
  boundaries as fallback — this already exists in `capture/` and `extract/sections.js`).
- Emit each section as its own component file with its DOM inside it.
- Hoist the text and image **leaves** of each section into a JSON content object, and
  reference them from the component as props.
- Header/footer become shared layout components. I already derive the shell by DOM
  intersection across a stratified page sample (`extract/branding.js` → `deriveShell`,
  measured at 0.75+ confidence on both demo sites).

Visual fidelity is preserved because the DOM and the CSS are unchanged — only the file
boundaries move. Editability comes from the hoisted content JSON, not from understanding
what the section *means*.

**Is that distinction real, or am I fooling myself?** Specifically:
1. Does splitting a captured tree into per-section component files break anything — CSS
   sibling/child selectors (`.a + .b`, `:nth-child`), scripts that query across section
   boundaries, or the cascade?
2. Which leaves are safely hoistable to props? A text node inside a `<p>` is obvious. An
   image `src` is obvious. What about a background-image in an inline style, an aria-label,
   a `data-*` attribute a script reads?
3. How do repeated siblings (cards in a grid) become an editable array rather than four
   near-identical JSX blocks — without classification?

## What exists (read the code, do not take my word)

- `packages/importer/src/capture/index.js` — Playwright capture → ordered `{t,a,c}` tree,
  ordered sheets, ordered interleaved scripts.
- `packages/importer/src/generate/fidelity.js` — emits the one-blob-per-page Next app.
- `packages/templates/src/DomTree.jsx` — `createElement` renderer + ordered script loader.
- `packages/importer/src/extract/sections.js` — builder-aware section boundary detection
  and coalescing, already working (template mode).
- `packages/importer/src/extract/branding.js` — `deriveShell()` header/footer detection.
- `packages/templates/src/manifests.js`, `src/sections/index.jsx` — the hand-written
  component library template mode uses.

**Measured today:** fidelity mode scores **99.8% visual / 100% text / 100% nodes** on a
static page (`/pro/changelog/`); the homepage measures ~65% only because its hero is a
video and two playbacks never share a frame. Template mode averages 51–60% match
confidence. Crawling is not the problem — discovery just returned 217–7,882 URLs on five
arbitrary WordPress sites (wpbeginner, yoast, smashingmagazine, rankmath, wpforms), 2 of
5 with the REST API blocked and the render fallback carrying it.

## Questions

1. **Is mechanical decomposition genuinely separable from semantic classification?**
   Rule on the distinction above. If it holds, specify the split algorithm and the
   emitted file layout. If it does not, say what breaks.
2. **Component granularity.** Per top-level section? Per builder widget? What is the unit
   that is both editable and not so fine that the project becomes 400 files?
3. **The content/props boundary.** Exactly which parts of a captured section become
   editable JSON, and which stay hard-coded in the component. Give me the rule, not a
   list of examples.
4. **Repeated siblings → arrays**, without classification. Possible? Mechanism?
5. **What is the honest ceiling on "100% same"?** The client keeps asking for it. Where
   does it actually stop — video, third-party embeds, personalised content, A/B tests,
   fonts behind auth? I need a sentence I can say to them that is true.
6. **Does any of this need a model?** My instinct: the *decomposition* is deterministic
   and AI adds nothing, but **naming** components (`Section07` → `PricingBand`) and
   deciding **which leaves are content vs chrome** are judgment calls where rules do
   badly. Rule on whether that is worth the dependency, given the project currently
   requires no API key at all and that is a stated selling point.
7. **Does this replace template mode, or make a third mode?** Two modes already exist.
   Three is a smell. Which survives?
8. **72-hour reality.** This is still an interview take-home, already over-scoped. What
   is the smallest version of this that is honestly demonstrable, and what should I
   refuse to build?

## Constraints (unchanged)

No WordPress at runtime, verified mechanically. URLs byte-for-byte. Static export.
No API key required. Playwright available. Favour defensible-in-review over ideal, and
say which is which.
