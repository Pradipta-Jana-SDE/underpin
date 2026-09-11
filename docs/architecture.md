# Underpin — architecture and codebase guide

Working notes for explaining this project out loud. Not published; `docs/` is gitignored.

Order to present in: **the problem → the one design decision everything hangs off →
the pipeline → the seam → the code map → how it is proven → what I'd do next.**

---

## 1. The problem, in one paragraph

WordPress sites need to move off WordPress. The naive answer is "read the REST API and
render the JSON in React", and it fails on roughly half the fleet: Elementor is 32.67% of
WordPress sites, WPBakery 8.52%, Divi 5.72%, and on all of them `content.rendered` is
shortcode soup or empty, because the builder stores its layout in postmeta and renders it
at request time. So the tool has to work from what the browser actually sees.

That is decision #1 in `docs/decisions.md` and it drives everything else:
**rendered HTML is the trunk, REST is an accelerator.**

## 2. The decision everything hangs off: two modes, not one

There are two honest answers to "migrate this site", and they are in direct tension. The
project ships both instead of splitting the difference.

| | **fidelity** (default) | **template** |
|---|---|---|
| Question it answers | Is this the same page? | Does this page fit a reusable library? |
| How | Render in a real browser, keep the DOM, the site's own CSS and its animation scripts, re-host everything | Read the page for meaning, map it onto 15 section archetypes, rebuild from a shared component library |
| Result | Visually identical. Nothing shared between sites | Tidier than the original, not identical. One library serves many sites |
| Use it when | The migration is a platform move | The migration is a redesign |

If someone asks "why not one mode that does both" — because acceptance criterion 1
(visual fidelity) and criterion 3 (reusable across multiple sites) are structurally
opposed. A component that serves two unrelated brands cannot also reproduce either one
pixel for pixel. Averaging them produces a tool that does neither. ADR #7 is the same
principle applied to scoring: two fidelity numbers, never blended, because a combined 85
hides whichever half actually failed.

## 3. The pipeline

Ten stages. Fidelity mode skips 4–6 (it does not need meaning), template mode runs all of
them. Both end at report and verify.

```
01 Discover     sitemap chain + REST probe        discover/index.js
02 Fingerprint  what does this site DO             fingerprint/index.js
03 Scope        negotiate what to migrate          scope/index.js
   ─── fidelity mode branches here ───
04 Extract      rendered HTML → normalised IR      extract/index.js
05 Classify     what type of page is this          classify/index.js
06 Match        page → template, slot by slot      match/index.js
07 Generate     emit the Next.js project           generate/index.js | generate/fidelity.js
08 Report       migration report + preview         report/index.js | report/fidelity.js
09 Verify       6 acceptance checks on the build   verify/index.js
10 Measure      pixels + does it still run         verify/score.js | verify/animation.js
```

**Why scope runs at #3 and not later.** Crawling 142 product pages and *then* discovering
nobody wanted them wastes the most expensive stage. Fingerprinting is cheap; extraction is
not. So the tool detects capabilities (WooCommerce, memberships, forms, multilingual),
presents them, and gets a decision before it spends anything.

**Every excluded URL gets a routing policy** — `410`, `redirect`, or `proxy_to_legacy`.
A bare 404 strands indexed URLs, so it is not an available answer. Enforced by test and by
a build gate.

## 4. The seam: one vocabulary, codegen'd

`packages/vocabulary/sections.vocabulary.json` is the only place the 15 section archetypes
are defined:

> hero, text_media, feature_grid, testimonial, cta_band, faq, pricing_table, stats_strip,
> logo_wall, team_grid, contact_panel, content_list, product_card_grid, form, rich_text

Extract, classify, match and render all import from it. `npm run build -w
@underpin/vocabulary` regenerates TypeScript types from the JSON, so **renaming an
archetype breaks the consumers' build** instead of silently going stale. `archetype()`
throws on unknown ids by design.

Two rules that come up in review:
- **Cardinality is a `variant`, never part of an id.** `feature_grid` with
  `variant.count = 3`, not `feature-grid-3`. Folding count into the id multiplies
  archetypes combinatorially.
- Three vocabularies would mean two lossy boundaries. There is one.

## 5. Data contracts

`packages/schema/` — Zod schemas, runtime-validated, one file each:

| File | What it is |
|---|---|
| `page-ir.js` | One page: sections, slots, media refs, forms, SEO. Carries exactly **7 computed style properties** — font size, line height, radius and shadow are excluded as high-cardinality, low-signal |
| `site-ir.js` | Site-wide: nav, brand, locations, shell selectors |
| `migration-plan.js` | The scope contract. Written by `scope`, read by every later stage, reprinted at the top of the report — so the migration is judged against what was agreed |
| `site-config.js` | The generated site's own config: theme tokens, form endpoint |
| `template-manifest.js` | A template = manifest + React component. The manifest is what the matcher scores against |

## 6. Code map, package by package

### `packages/importer/` — the CLI and the pipeline (55 files)

**Entry point:** `bin/underpin.js`. Commands: `run`, `discover`, `scope`, `extract`,
`plan`, `build`, `report`, `verify`, `measure`, `reuse`.

| Path | Does what |
|---|---|
| `src/discover/index.js` | The 5-step sitemap chain, robots.txt first. Probing three production sites showed `/wp-sitemap.xml` returned 200 on **none** of them |
| `src/fingerprint/index.js` | Capability detection. Scores independent signal *classes* (rest/body/asset/path/url/jsonld) — fewer than two caps below the decision bar |
| `src/fingerprint/signatures.js` | The patterns themselves. Data, not logic |
| `src/scope/index.js` + `options.js` | Interactive negotiation and the disposition menus |
| `src/capture/index.js` | **The scraper.** Playwright: render, wait, take the DOM twice, filter scripts, probe menus |
| `src/capture/merge.js` | Merges resolved lazy-load URLs from the driven snapshot into the virgin one. Virgin structure always wins |
| `src/capture/strip-animation.js` | Resets animation state so the source's own scripts can replay — gated on whether the library's script survived |
| `src/extract/sections.js` | Section boundaries: builder classes → structural grouping → heading split. Holds `coalesce()` |
| `src/extract/builder-map.js` | Builder widget class → archetype hint. ~300 lines buys boundaries *and* types for ~47% of sites |
| `src/extract/branding.js` | Logo, colours, shell (header/footer) by intersecting DOM across a stratified sample |
| `src/extract/media.js` | Every kind of media, not just `<img src>`: lazy attrs, CSS masks, icon fonts, inline SVG. Holds `parseSrcset()` |
| `src/extract/forms.js` | Field schema with a **label-reliability tier** per field, because plugins differ sharply |
| `src/classify/index.js` | The cost ladder: deterministic → weighted rules → model → human queue |
| `src/match/index.js` | Weighted Jaccard over archetype multisets, required sections double-weighted, plus an inversion-count order penalty |
| `src/generate/fidelity.js` | Fidelity build: writes the whole Next.js project |
| `src/generate/componentize.js` | Splits a captured page into per-section components. **Never adds, removes or reorders a node** |
| `src/generate/jsx-emit.js` | Real JSX codegen from a captured tree, plus the re-parser that proves it round-trips |
| `src/generate/chrome.js` | The 5-rule decision on whether header/footer can be hoisted into the shared layout |
| `src/generate/assets.js` | Mirrors every asset, rewrites CSS `url()` against the *stylesheet's* URL, backs off on 429 |
| `src/generate/targets.js` | One shared answer to "which pages does this build render" |
| `src/verify/index.js` | The 6 acceptance checks |
| `src/verify/score.js` | Pixel/text/node scoring at three widths |
| `src/verify/animation.js` | Loads the built page in a browser and asks whether the scripts actually booted |
| `src/report/*.js` | Two reports (one per mode) over a shared shell, plus the reuse matrix |
| `src/llm/*.js` | Optional model layer, content-addressed cache, fails open in every path |
| `src/util/http.js` | Polite fetch. `get()` never throws on status — a 401 is information |

### `packages/templates/` — the React component library

15 manifests, 15 section components, theme tokens. Plain `.jsx` so the generated app needs
no build step beyond Next itself.

- `sections/index.jsx` — one component per archetype. Every one is a pure function of
  `(slots, variant)`. All styling reads CSS custom properties, which is what lets the same
  component serve two unrelated brands.
- `manifests.js` — the templates. Deliberately **not** derived from any one demo site; if
  they were, "reusable across multiple websites" would be unfalsifiable.
- `DomTree.jsx` — renders a captured DOM tree through `createElement`, not
  `dangerouslySetInnerHTML`. `SiteScripts` replays the source's own scripts in document order.
- `dom-tables.js` — the HTML→React attribute tables, shared by the runtime renderer and
  the codegen so they cannot drift.
- `splice.js`, `theme.js`, `Template.jsx`.

### `packages/studio/` — the web wizard

Zero dependencies: `node:http` plus static files. Seven steps —
**Source → Findings → Scope → Pages → Review → Build → Preview**. Long stages stream
NDJSON so the browser shows real progress. `zip.js` is a hand-written ZIP writer (local
header, deflated data, central directory, end record) because the one library tried here
shipped a breaking major.

### `packages/vocabulary/`, `packages/schema/`

Covered above. Small, load-bearing, imported by everything.

## 7. Load-bearing invariants

State these as constraints you designed to, not features:

1. `sections.vocabulary.json` is the only definition of archetypes.
2. Cardinality is a variant, never an id.
3. Scope runs before extraction.
4. Every excluded URL gets a routing policy. Never a bare 404.
5. **The pipeline runs with no API key.** Rules resolve 75–85%; the rest go to a human
   queue. A model only shrinks that queue and is never a hard dependency.
6. Leftover content fails closed — blocks the production build until a human sets
   `reviewed: true`.
7. Two fidelity scores, never blended.
8. The generated fidelity app depends only on `next`, `react`, `react-dom`.
   `grep '@underpin' package.json` in a generated site returns nothing.
9. Emitted JSX must round-trip to the captured tree, or that section falls back to the
   runtime renderer — per section, reported, never silent.
10. Decomposition may never add, remove or reorder a node.

## 8. The bugs worth telling (interview gold)

Pick two or three. Each one is a real measurement, not a hypothetical.

**The capture-order bug.** Scrolling is the only way to make lazy images resolve. It is
also what fires every reveal animation — so capturing *after* the scroll bakes
`aos-animate` and GSAP's inline transforms into the markup permanently. Replay those
scripts in the migrated app and they initialise on top of their own output: the site looks
right and is completely dead. Fix: two snapshots in one page load. The virgin one ships;
the driven one is consulted only for what lazy-loading resolved to.

**The asymmetric gate.** Having fixed that, the obvious next step is to strip animation
state so the libraries can replay. But capture drops scripts that call WordPress — so if
AOS's bundle was dropped and you strip `aos-animate` anyway, AOS's stylesheet is still
holding every reveal at `opacity: 0` and nothing will ever set it back. Invisible page. A
baked-in animation is a disappointment; a blank section is a broken migration. So every
strip is gated on a fingerprint of the scripts that *survived*.

**Another app's runtime cannot be replayed inside this one.** `goranggosolutions.com` is
itself Next.js. Its chunks and `self.__next_f` flight payload pushed into the same globals
as our app, so our hydration died with "createMutableActionQueue is not a function" and
every interaction on the page was silently dead. Fix: detect and drop whole-page framework
runtimes, and *report* the drop, because losing a site's interactivity is worth saying out loud.

**The measurement that wasn't one.** The same page scored 81.7% and 99.5% on consecutive
runs — purely on whether a background image had finished decoding when the screenshot was
taken. A score that swings 18 points on timing is not a measurement. The scorer now waits
for `img.complete` plus two frames, and freezes video and CSS animation on both sides.

**`split(',')` on a srcset is wrong.** Cloudflare Image Resizing puts its options in the
path (`/cdn-cgi/image/f=auto,w=632/…`), so a naive split shredded every URL and all
downloads 404'd. Same class of bug as splitting a `style` attribute on `;` when a
`background-image:url(data:…;base64,…)` is in it.

**og:image is not a logo.** It is a social share image — on elementor.com, a photograph of
a person, which put a stranger's face in the header of every migrated page. Nor is
`[class*="logo"] img` safe: on one site it matched an ancestor container, on another a
*client* logo from a logo wall. A missing logo is better than a confidently wrong one.

**Builders emit each card as its own top-level container.** Boundary detection alone
reported a six-logo strip as six sections and a FAQ page as seventy-one. `coalesce()`
merges runs of structurally similar siblings. And hero promotion has to run *after*
coalescing, because before the merge the first card of a six-card grid is also "the first
section".

## 9. How any of this is proven

Say this part plainly — it is the difference between a demo and an engineering deliverable.

- **Tests:** `npm test` — 145 tests, 144 passing, 1 skipped. The skip is the
  real-capture parity test, which needs a capture under `sites/` (gitignored, so it skips
  on a clean checkout by design).
- **Six mechanical acceptance checks** (`verify/index.js`): URL parity, origin
  independence, SEO essentials, sitemap/robots, no leaked WordPress endpoints,
  componentisation actually produced components.
- **The parity gate:** every emitted section is re-parsed and compared against the DOM it
  came from. On elementor.com that caught 1 bad section in 1,044 — and the bug was in the
  *checker*, not the emitter (JSX attribute values are not JS string literals, so
  `pattern="\d"` was having its backslash eaten).
- **The reusability falsifiability test:** `underpin reuse` prints which templates absorbed
  pages from more than one site. A template that only ever matches the site it was written
  against has not been shown to be reusable.
- **Proven on two unrelated live sites:**

| | elementor.com | kinsta.com |
|---|---|---|
| Builder | Elementor | Gutenberg |
| Pages migrated | 12 | 11 |
| Static pages exported | 17 | 16 |
| Acceptance checks | 6/6 | 6/6 |
| Media re-hosted | 79 | 104 |

## 10. What I deliberately did not build

Having a clear "no" list is worth as much as the feature list. From `decisions.md`:

- **A companion MU-plugin.** The right production path, the wrong POC move — it needs
  write access to production installs and reads as exactly the coupling the brief wants removed.
- **Embedding-based classification.** No labelled set at day zero.
- **Needleman–Wunsch template alignment.** Weighted Jaccard plus the required-slot check
  already solves it; a substitution matrix is bioinformatics machinery for a 15-tag vocabulary.
- **A blocking Lighthouse gate.** Report the number, don't build the gate.
- **A dashboard.** Out of scope, and it would have eaten the time the verification work took.

## 11. How this was built — say it straight

Be direct about the AI-assisted split and let the design reasoning carry the interview.
Suggested framing, adjust to what is actually true for you:

> The browser capture layer (`src/capture/`) I generated with Claude and then debugged
> against real sites — the two-snapshot ordering, the animation-strip gate and the
> framework-runtime detection all came out of things that broke on live pages. The
> architecture is mine: the two-mode split, the vocabulary seam, the schema contracts, the
> scoring model and the invariants in §7. The ADR log in `docs/decisions.md` is the record
> of those calls.

Two things worth knowing before you say it:

- Don't over-narrow the claim. `git log` and `CLAUDE.md` show the assistant was involved
  well beyond `src/capture/`. "AI-assisted throughout, with the design decisions and the
  debugging mine" is both truer and stronger than drawing a hard line at one directory.
- The bugs in §8 are the strongest material you have, and they are the part no code
  generator produced for you — they came from running it against real sites and reading
  the failures. Lead with those.

## 12. A 10-minute walkthrough

1. **Show the studio** (`npm run studio` → `localhost:4400`). Run one site end to end.
   Seven steps, real progress, preview side by side. Two minutes.
2. **Open a generated section component.** Real JSX, with its text and media in a content
   module beside it. This is the thing that was actually bought — not a JSON blob.
3. **Open `docs/decisions.md`.** 22 decisions, each with the rejected alternative. Talk
   through #1 (rendered HTML over REST), #7 (never blend the scores), #16→#18 (the codegen
   reversal and the parity gate that justified it).
4. **Tell one bug from §8.** The capture-order one is the best story: a fix that made the
   site look right and be dead, and the second fix that could have made it invisible.
5. **Show `underpin verify` and `underpin reuse`.** Claims with numbers attached.

### Questions you should have an answer ready for

**"Why not just use the REST API?"** ~47% of the fleet defeats it. Measured, not assumed —
`docs/discovery-probe-evidence.md`.

**"Why two modes? Isn't that indecision?"** The opposite. The two acceptance criteria are
structurally opposed; shipping one blended mode would fail both quietly.

**"How do I know the generated JSX matches the original?"** It is re-parsed and compared
against the captured DOM, per section. A section that fails falls back to the runtime
renderer and is reported. Plus an independent Playwright node-count and text-coverage
score against the real built page.

**"What happens without an API key?"** Everything. Rules resolve 75–85%; the remainder goes
to a human review queue rather than being guessed at. That is invariant #5, and the model
is only ever allowed to make a cosmetic call better — naming a component. It cannot change
the DOM.

**"What breaks at scale?"** Fleet drift — decision #12 accepts it explicitly. Templates are
npm-published with per-site version pins, so a site can lag. The alternative (a monorepo)
means one bad merge breaks 200 sites, which is worse.

**"What would you do next?"** The MU-plugin path for sites you control, so extraction can
read postmeta directly instead of inferring from rendered DOM; and a labelled set, which
would make the classification stage worth training rather than ruling.
