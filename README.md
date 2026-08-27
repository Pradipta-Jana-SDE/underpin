# Underpin

Template-driven WordPress → React migration. Lifts content, brand, URLs and SEO off a
WordPress site onto reusable React templates — detecting what the site actually runs,
then asking a human what to keep.

## Quick start

```bash
npm install
npm test                                        # 14 tests
npm run scope -- https://example.com --yes      # discover → fingerprint → agree scope
```

No API key required. See [Model layer](docs/model-layer.md).

## What works today

```
01 Discover     sitemap chain + REST probe            ✅ tested on live sites
02 Fingerprint  what the site DOES, not just has      ✅ tested on live sites
03 Scope        negotiate, write the contract         ✅
04 Extract      four-rung ladder                      ⬜
05 Classify     page type + section archetypes        ⬜
06 Match        template scoring                      ⬜
07 Review       CLI + static preview                  ⬜
08 Generate     Next.js static export + gates         ⬜
```

Verified against `wordpress.org` (794 URLs, 121 locales detected) and `woocommerce.com`
(17,872 URLs, WooCommerce detected at confidence 1.0 from five independent signal
classes, 95 products, cart URLs correctly excluded with a 410 policy).

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
| Admin dashboard | A CLI plus two static pages proves migration quality; a CRUD app proves CRUD. Right phase-two build. |
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
