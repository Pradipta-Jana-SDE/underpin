# Underpin

Template-driven WordPress → React migration. Lifts content, brand, URLs and SEO off a
WordPress site onto reusable React templates — detecting what the site actually runs,
then asking a human what to keep.

## Running it

Needs **Node 20+** (built on 22). No API key, no database, no Docker.

```bash
npm install
```

### 1. The studio (recommended)

```bash
npm run studio          # → http://localhost:4400
```

Open that URL and work through seven steps: enter a site → review what the crawler
found → answer the scope questions → **pick which pages you want** → review each page's
template → build and verify → preview side by side. The build step has a
**Download codebase (.zip)** button.

### 2. Or the CLI, if you prefer it headless

```bash
npm run migrate -- https://example.com --yes --limit 12
```

`--yes` takes the recommended answer to every scope question instead of prompting.
`--limit` samples that many pages, spread across URL shapes; drop it to migrate
everything. Individual stages run on their own too:

```bash
npm run underpin -- discover https://example.com   # just the discovery evidence
npm run underpin -- scope    https://example.com   # capability questions, interactive
npm run underpin -- verify   https://example.com   # acceptance checks on a built export
npm run reuse                                      # which templates work across sites
```

### 3. Build the migrated site

The generator writes a Next.js project; it does not install or build it for you.

```bash
cd sites/example.com/site
npm install
npm run build           # static export → ./out
npx serve out           # view it
```

The downloaded zip is the same thing with the workspace packages vendored in, so it
installs and builds anywhere — no monorepo required.

### 4. Checking the result

```bash
npm run underpin -- verify https://example.com     # 6 mechanical acceptance checks
npm run score -- https://example.com http://localhost:4400/preview/example.com /
```

`score` compares the migrated page against the live original — visual, text and node
coverage at 375/768/1440.

### Fidelity mode (exact reproduction)

Needs a browser engine, once:

```bash
npx playwright install chromium
npm run underpin -- build https://example.com --mode fidelity --limit 5
```

Renders each page in a real browser and keeps its own CSS and animation scripts.
Static pages come out ~99.8% pixel-identical. See the trade-off note below.

### Common problems

| Symptom | Cause |
|---|---|
| `EADDRINUSE` on 4400 | Studio already running. `PORT=4500 npm run studio` |
| Fidelity build fails on `chromium` | Run `npx playwright install chromium` |
| Studio preview shows an unstyled page | The site was generated but not built — run `npm run build` inside `sites/<host>/site` |
| Crawl finds 0 URLs | Site has no reachable sitemap and blocked the link-crawl fallback; check `sites/<host>/discovery.json` for the chain |

## What works

**A web studio over the whole pipeline** (`npm run studio`) — enter a URL, review what
the crawler found, answer the scope questions, review every page's extracted structure
and change its template, then build, verify and preview side by side. Long stages stream
real progress rather than showing a spinner.

The pipeline underneath, end to end:

```
01 Discover     sitemap chain + REST probe
02 Fingerprint  what the site DOES, not just what it has
03 Scope        negotiate dispositions, write the contract
04 Extract      four-rung ladder → normalised section IR
05 Classify     page type, cost ladder, no API key needed
06 Match        template scoring with an explainable breakdown
07 Generate     Next.js static export, media re-hosted
08 Report       per-page pass/warn/fail + responsive preview
09 Verify       mechanical acceptance checks against the built export
```

### Proven on two unrelated live sites

| | elementor.com | kinsta.com |
|---|---|---|
| Page builder | Elementor | Gutenberg |
| Pages migrated | 12 | 11 |
| Static pages exported | 17 | 16 |
| Media re-hosted | 79 | 104 |
| **Acceptance checks** | **6/6 pass** | **6/6 pass** |

Capability detection was separately verified against `woocommerce.com` — WooCommerce
found at confidence 1.0 from five independent signal classes, 95 products, cart URLs
excluded with a 410 policy — and `wordpress.org` (794 URLs, 121 locales).

### The checks that actually run

```
underpin verify https://elementor.com

OK  Every planned URL exists in the export         12/12 routes exported
OK  No asset still loads from the WordPress origin every asset is served by the migrated site
OK  Every page has a non-empty title               14 pages checked
OK  Canonical links carried across                 12/14 pages carry a canonical
OK  sitemap.xml and robots.txt generated           both present
OK  No wp-admin / wp-login / xmlrpc references     clean
```

### Reusability, tested rather than claimed

`underpin reuse` prints which templates absorbed pages from more than one site. Three of
eight currently qualify; the rest are honestly marked "one site only" because the two
demo sites have different page-type mixes. A template that only ever fits the site it was
written against is not evidence of reuse, and the tool says so.

## Design in one page

**Rendered HTML is the trunk; REST is an accelerator.** Elementor (32.67% of WP sites)
stores layout as JSON in postmeta, outside the REST field whitelist. With WPBakery and
Divi, roughly half the fleet defeats a REST-first importer.

**Scope is negotiated, not assumed.** A plumbing company with a 40-page service site and
a 12-product shop should migrate the 40 pages and make a *decision* about the 12.
Refusing the whole site to avoid the hard part is a tool failing its user. Every
excluded URL still gets a routing policy — a bare 404 strands indexed URLs.

**One vocabulary, three consumers.** `sections.vocabulary.json` defines 15 section
archetypes. Extract, classify, match and render all import it, with types generated from
it, so drift is a build error rather than silent data loss.

**Two fidelity scores, never blended.** "Closely matches the original design" and
"templates reusable across multiple websites" are structurally opposed — a template that
matches every source pixel-for-pixel has been copied, not reused. Content Fidelity and
Design Fidelity answer different questions; averaging them hides the failure a reviewer
needs to see.

## Not built, deliberately

| | Why |
|---|---|
| ~~Admin dashboard~~ | **Built** — see `packages/studio`. Originally scoped out in favour of a CLI; reversed on request. Six-step wizard covering the whole pipeline. |
| Headless commerce | A 6–12 week engagement. Named as unavailable in the scope prompt so nobody discovers it at review. |
| Rebuilt authentication | Gated content stays on WordPress and is proxied. |
| Companion WP MU-plugin | The right production path, but it needs write access to production installs and reads as the coupling the brief wants removed. Argued in [decisions.md](docs/decisions.md), not built. |
| Embedding classification stage | No labelled training set at day zero. Folds into the model call. |

## Docs

- [Architecture decisions](docs/decisions.md) — 14 ADRs plus what was cut and why
- [Discovery probe evidence](docs/discovery-probe-evidence.md) — measured, not assumed
- [Scope negotiation](docs/scope-negotiation.md)
- [Model layer](docs/model-layer.md) — running with no key
- [Elementor page trace](docs/trace-elementor-page.md) — where a real page bleeds
- [CLAUDE.md](CLAUDE.md) — codebase map
