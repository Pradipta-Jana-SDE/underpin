# Architecture decision record

Four-specialist review, two rounds with cross-examination. Where the panel
disagreed, the resolution is recorded rather than smoothed over.

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| 1 | Rendered HTML is the primary extraction path; REST is an accelerator | REST-first | Elementor (32.67%) + WPBakery (8.52%) + Divi (5.72%) = ~47% of the fleet where `content.rendered` is soup or empty |
| 2 | Builder-aware DOM boundaries (rung C-prime) | Generic heading-split for all builders | ~300 lines total buys section boundaries AND type hints for ~47% of sites; confidence 0.75-0.85 instead of 0.4 |
| 3 | Navigation from rendered DOM, never `wp/v2/menus` | REST menus endpoint | Measured 401 on 3/3 production sites |
| 4 | 5-step sitemap discovery chain, robots.txt first | Fetch `/wp-sitemap.xml` | Core path returned 200 on 0/3 sites probed |
| 5 | One versioned `sections.vocabulary.json`, codegen'd types | Per-layer vocabularies | Three vocabularies = two lossy boundaries; drift must be a build-time type error |
| 6 | Cardinality in `variant`, not the archetype ID | `feature-grid-3` / `feature-grid-4` | Folding it into the ID multiplies archetypes combinatorially |
| 7 | Two separate fidelity scores, never blended | Single Migration Fidelity Score | Acceptance criteria 1 and 3 are structurally opposed; a blended 85 hides a visibly different site |
| 8 | Leftover content fails closed (blocks prod build until reviewed) | Render it and move on | Silently dropping content fails criterion 2; silently shipping unreviewed HTML is worse |
| 9 | Next.js `output: 'export'`, catch-all route over per-page JSON | Generated .tsx per page | JSON is diffable, Zod-validatable, and lets templates swap without regenerating code |
| 10 | One JSON file per page, not a monolith | `content/pages.json` | Merge-conflict magnet; a CMS can't address a single record inside it. This is the editing seam |
| 11 | Bounded override surface (tone/width/density) | Pass computed style through | Unbounded style is the per-site CSS drift the token system exists to prevent |
| 12 | npm-published templates, per-site version pins | Monorepo in-tree / vendor-and-freeze | Accepted failure mode: fleet drift. Beats "one bad merge breaks 200 sites" |
| 13 | 7 computed-style properties per section, no more | Full computed-style capture | High cardinality, low signal; macro layout/tone parity is the goal, not CSS cloning |
| 14 | Companion MU-plugin argued in docs, not built | Build it / ignore it | Right production path, wrong POC move - needs write access to prod installs and reads as the coupling the brief wants gone |
| 15 | Fidelity + componentise is the studio's default; template mode is one click away | Keep template mode as the default | The wizard was the only path most people ever took, and it could only run template mode - so the demo shipped the ~50%-match output while the exact path sat behind a CLI flag. The default should be what someone opening a migration tool is asking for |
| 16 | Real JSX codegen per section, gated by a round-trip parity check | Wrap the runtime renderer (the previous decision) | "Editable components" was the thing actually bought, and a 6-line file importing a minified JSON tree is not that. The earlier objection was that codegen could silently diverge from the capture - the parity gate answers exactly that objection, so the decision it justified no longer holds |
| 17 | Parity by re-parsing our own emitted JSX | `react-dom/server` in the importer | The importer is plain ESM with no build step and no React installed; adding a JSX toolchain to it contradicts the pitch. Two independent gates instead: a separate-code-path re-parser at generation time, and a Playwright node/text score against the real built page. Measured value: caught 1 bad section in 1,044 on elementor.com, and the failure was in the *checker*, not the emitter |
| 18 | A section that fails parity falls back to the runtime renderer | Fail the build | Fail-safe beats fail-broken. The worst outcome of a codegen bug becomes a file that is less pleasant to edit, never a page that renders differently. Reported per section, never silent |
| 19 | Copy the two runtime files into the generated app | `file:` dependency back into this monorepo | Makes "depends only on next and react" a fact you check with one grep instead of a claim in a README, and lets the zip ship without vendoring a package tree |
| 20 | Capture the DOM *before* the scroll pass; drive the page only to discover assets | Capture after driving it (the previous behaviour) | Scrolling fires every reveal, so capturing afterwards bakes the finished animation into the markup - then the replayed scripts initialise on top of their own output and nothing ever animates again. The site looks right and is dead |
| 21 | Strip a library's animation state only when that library's script survived capture | Always strip / never strip | If AOS's bundle was dropped and `aos-animate` is removed anyway, every reveal element stays at opacity:0. A baked-in finished animation is a disappointment; a blank section is a broken migration |
| 22 | The model layer names components and nothing else | Let it classify, split, or judge structure | Naming cannot change the DOM, so the worst a model can do is pick a duller filename. Off by default even when a key is present, because a demo has to be reproducible |

## Cut after being fully specified

- Embedding-to-centroid classification stage - no labelled set at day zero
- Needleman-Wunsch template alignment - Jaccard + slot check already solves it
- Content-addressed blob storage - fleet-scale optimisation, invisible in a POC
- OpenNext/Workers ISR path - real-engagement concern
- Lighthouse CI blocking gate - report the number, don't build the gate
