# Underpin

**Point it at a website. Pick the pages you want. Get a real Next.js project back** — the
same page, split into editable React components, with its own stylesheets, images and
animations intact and nothing calling the old site at runtime.

Built for WordPress migrations, and it works on any server-rendered site.

---

## Quick start

```bash
git clone https://github.com/Pradipta-Jana-SDE/underpin.git
cd underpin
npm install
npx playwright install chromium     # the capture runs in a real browser
npm run studio                      # → http://localhost:4400
```

Open <http://localhost:4400>, paste a site URL, and work through the seven steps. The
Build step installs and compiles the generated project for you, so **Preview shows the
real thing** — not a placeholder.

Needs **Node 20+** (built on 22). No API key, no database, no Docker.

---

## What you get

A standalone Next.js 15 app that depends on **`next`, `react` and `react-dom` and nothing
else**:

```
sites/<host>/site/
├── app/
│   ├── layout.jsx                     shared header/footer when identical across pages
│   └── [[...slug]]/page.jsx           one route for every migrated page
├── components/
│   ├── pages/<page>/Page.jsx          composes that page's sections, in order
│   ├── pages/<page>/SiteHeader.jsx    ← readable JSX you can edit
│   ├── pages/<page>/*.content.js      ← its text and images, safe to edit
│   └── runtime/                       the small script-replay helper, copied in
├── content/                           the captured page data
├── public/assets/                     every stylesheet, script, font and image, re-hosted
└── out/                               the static export (after build)
```

A generated component is source you open and edit, not a JSON blob:

```jsx
import content from './Section02Pricing.content.js';

export default function Section02Pricing() {
  return (
    <section className="pricing-band" data-section="pricing">
      <h2>{content.heading}</h2>
      <img src={content.imageSrc} alt={content.imageAlt} />
    </section>
  );
}
```

Its words and images live beside it in `Section02Pricing.content.js`, so a copy change
never means touching markup.

---

## The seven steps

| # | Step | What happens |
|---|---|---|
| 1 | **Source** | Enter a URL. Nothing is crawled yet. |
| 2 | **Findings** | The discovery chain and what the site actually runs — evidence, not assumptions. |
| 3 | **Scope** | The decisions the tool will not make for you. Excluded URLs get a routing policy, never a bare 404. |
| 4 | **Pages** | Tick the pages to migrate. **Only ticked pages are ever crawled.** |
| 5 | **Review** | Confirm what was found. |
| 6 | **Build** | Capture → emit components → **install and compile** → run the acceptance checks. |
| 7 | **Preview** | The original and the migration side by side at 375, 768 and 1440. |

The Build step also has **Measure against the original** — a pixel, text and node
comparison of every built page against the live site, plus a check that the migrated
pages' own scripts actually still run.

---

## Two modes

Chosen on the Build step. They answer different questions.

| | **Exact copy** (default) | **Reusable templates** |
|---|---|---|
| What you get | The page verbatim, split into named JSX components | The page rebuilt from a 15-component library |
| Fidelity | 100% at the capture width; 97–100% at other breakpoints | Visibly tidier than the original, not identical |
| Shared between sites | Nothing | The whole component library |
| Use when | The migration is a lift-and-shift | The migration is a redesign |

---

## Or drive it from the CLI

```bash
# everything, headless
npm run migrate -- https://example.com --yes --componentize

# or one stage at a time
npm run underpin -- discover https://example.com
npm run underpin -- scope    https://example.com
npm run underpin -- build    https://example.com --mode fidelity --componentize
npm run underpin -- verify   https://example.com
npm run underpin -- measure  https://example.com --base http://localhost:3000
```

| Flag | Effect |
|---|---|
| `--yes` | Take the recommended answer to every scope question |
| `--componentize` | Split each page into per-section components |
| `--limit <n>` | Sample n pages, spread across URL shapes |
| `--mode template` | Rebuild from the shared component library instead |
| `--no-virgin` | Capture after the scroll pass (use if a reveal animation leaves content invisible) |
| `--llm` | Let a model name the components (optional, see below) |

Build the export yourself with `cd sites/<host>/site && npm install && npm run build`.

---

## How it is verified

`npm test` — **145 tests, 144 passing on a fresh clone.**

The one skip is deliberate and it names itself: a test that re-emits every section of
every capture on disk. A fresh clone has no captures — they are gitignored, being other
people's markup — so it stands down until you have run a migration, at which point it
runs against whatever you captured. Everything else, including the round-trip tests over
a committed 1,072-node capture, runs from a clean checkout.

Every acceptance check reads the built export rather than asserting something in a README:

```
OK  Every planned URL exists in the export
OK  No asset still loads from the source origin
OK  Every page has a non-empty title
OK  Canonical links carried across
OK  sitemap.xml and robots.txt generated
OK  Nothing loads from wp-admin / wp-login / xmlrpc / wp-json
OK  Every section emitted as editable JSX
```

The last one is the load-bearing check. Every generated component is **re-parsed and
compared against the DOM it came from**. A section whose JSX does not round-trip falls
back to a runtime renderer — per section, reported, never silent — so a codegen bug can
cost you an ugly file but never a page that renders differently.

Measured across **1,062 sections from 69 real captured pages on 5 different sites: zero
parity failures.**

`measure` then loads the built pages in a browser and reports:

```
demos.kadencewp.com  (WordPress)   design 100.0%   content 100.0%   nodes 100.0%   6/6 widths
goranggosolutions.com (Next.js)    design  99.3%   content 100.0%   nodes 100.0%  18/18 widths
```

Both also pass the animation smoke check — every migrated page's scripts boot, with no
console errors and no failed requests.

**Design and content fidelity are reported separately and never averaged.** They answer
different questions, and a blended number hides whichever one actually went wrong.

---

## Optional: let a model name the components

Entirely optional and off unless you ask for it.

```bash
cp .env.example .env      # set LLM_PROVIDER=anthropic and LLM_API_KEY
npm run underpin -- build https://example.com --mode fidelity --componentize --llm
```

It renames components and nothing else — naming cannot change the DOM, so the worst it
can do is pick a duller filename. With no key the rules name everything and the migration
is byte-for-byte identical; there is a test that asserts exactly that.

---

## Honest limits

Worth knowing before you demo it.

- **The capture is taken at 1440px.** A site that builds *different markup* at mobile from
  JavaScript will differ there — measured at 97–99% on such pages, against 100% at 1440.
  Nothing is missing; the original simply renders a different menu. Server-rendered sites,
  which respond to breakpoints with CSS, score 100% at every width.
- **A source site that is itself a React/Next/Nuxt app** cannot have its own runtime
  replayed inside the migrated app — two hydration frameworks fight over the same DOM and
  both break. Its runtime is dropped and reported. Navigation menus are recovered anyway:
  capture opens each one, ships the panel hidden, and reveals it with CSS on hover and
  keyboard focus — so a dropdown that only existed while the source's React ran still
  works. Other framework-driven widgets stay inert. Server-rendered sites — WordPress
  included — replay their scripts fine: measured 56/56 and 69/69 running on real pages.
- **Anything personalised, A/B tested or fed from a live API** was captured once. It is a
  snapshot, and calling it one is the honest description.
- **Third-party embeds** are preserved verbatim; keys referrer-locked to the old domain
  need re-scoping before they render.
- **An asset that was already broken on the source** is reproduced exactly as broken, and
  graded a warning that says so rather than a failure.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `EADDRINUSE` on 4400 | Studio already running — `PORT=4500 npm run studio` |
| Build fails on `chromium` | `npx playwright install chromium` |
| Preview is empty | The compile step failed — the log on the Build step says why |
| A section never reveals itself | Its animation library did not survive capture; rebuild with `--no-virgin` |
| Lots of `429` in the asset log | The source is rate limiting. The mirror backs off and retries; a very large site may still lose a few |
| Crawl finds 0 URLs | No reachable sitemap and the link-crawl fallback was blocked — see `sites/<host>/discovery.json` |

---

## How it works

```
discover → fingerprint → scope → [pick pages] → capture → componentize → emit → compile → verify → measure
```

- **discover** — robots.txt, then the sitemap chain, then a link crawl. Measured against
  real sites: no single sitemap path wins on more than two of three.
- **fingerprint** — what the site actually runs, from independent signal classes. One
  signal is a coincidence, so it takes two.
- **scope** — the questions with business consequences. Excluded URLs get `410` or a
  redirect; a bare 404 strands indexed URLs.
- **capture** — Playwright renders each page. The DOM is snapshotted **before** the scroll
  pass, so entrance animations replay instead of shipping already-played; the scroll pass
  runs afterwards purely to discover what lazy-loading resolved to.
- **componentize** — splits at the section boundaries the page already has, then nests a
  dominant wrapper into parent and child components. It never adds, removes or reorders a
  node — that rule is what keeps CSS sibling selectors and `:nth-child` counts valid.
- **emit** — real JSX, gated by the round-trip parity check above.

Deeper notes: [`docs/decisions.md`](docs/decisions.md) — 22 architecture decisions,
including the ones that were reversed and why.

---

## Layout

```
packages/
  importer/     the pipeline and the CLI          (plain ESM, no build step)
  studio/       the web UI                        (node:http + vanilla JS, zero deps)
  templates/    the 15-component library for template mode
  schema/       Zod schemas
  vocabulary/   the section vocabulary — the seam every layer imports
docs/           architecture notes and the ADR log
sites/<host>/   generated per-site output
```
