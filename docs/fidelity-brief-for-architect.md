# Architecture brief — exact-fidelity WordPress → React

**To:** senior architect (Fable 5)
**From:** implementation (Opus 5)
**Decision needed before I write more code.**

## What changed

The original brief was *template-driven* migration: read a page for its meaning, rebuild
it from a shared React component library. That is built and works (below). The client has
now overridden it:

> "i want everything ui logo image content sitemap everything from the site and will be
> same flow ... just ui and js animations that need 100% same"

So the goal is now **exact reproduction** — UI, logo, images, content, sitemap, and the
JS animations — in React, with **no WordPress at runtime**. This is the opposite end of
the dial from template reuse. I need your ruling on the architecture, not encouragement.

## What already works (do not redesign)

Monorepo, npm workspaces, plain ESM, 40 tests green.

```
packages/vocabulary   15 section archetypes + codegen (the shared seam)
packages/schema       Zod: PageIR, SiteIR, MigrationPlan, SiteConfig, TemplateManifest
packages/importer     CLI + pipeline: discover → fingerprint → scope → extract →
                      classify → match → generate → report → verify
packages/templates    15 template manifests, 15 React section components, theme tokens
packages/studio       local web UI (zero-dep node:http + vanilla SPA), 6-step wizard
```

Template mode is proven on two unrelated live sites (elementor.com/Elementor,
kinsta.com/Gutenberg): both build as Next.js static exports and pass 6/6 mechanical
acceptance checks (URL parity, origin independence, titles, canonicals, sitemap/robots,
no wp-admin refs). Discovery, capability fingerprinting and scope negotiation are solid
and mode-independent — fidelity mode should reuse them unchanged.

## What I built for fidelity mode, and how it fails

`packages/importer/src/capture/index.js` — Playwright: navigate, scroll the full page to
trigger lazy-load and reveal animations, then serialize `document.body` to a plain
`{t, a, c}` tree. Collects linked CSS, inline `<style>`, `<script src>`, inline scripts.
Drops WordPress-only scripts (wp-admin, admin-ajax, wp-emoji, heartbeat, wp-json).

`packages/importer/src/generate/assets.js` — mirrors every asset locally and rewrites
`url()` **against each stylesheet's own URL**, not the page's, plus a second pass for
assets only CSS references (fonts behind media queries).

`packages/templates/src/DomTree.jsx` — renders the tree through `React.createElement`,
deliberately **not** `dangerouslySetInnerHTML`, with HTML→React attribute mapping
(class→className, style string→object, boolean attrs, drop inline `on*`). A
`SiteScripts` effect re-injects the site's own scripts in order after mount.

**Measured result on elementor.com (3 pages):** capture works — 88 body children,
29 linked stylesheets, 43 inline `<style>`, 44 external + 40 inline scripts, 733 assets
mirrored, 1 failed. Next build succeeds, static export produced.

**But the page renders completely unstyled** — default serif headings, blue underlined
links, nav as a bullet list. Content and logo are present; CSS is not applying.

I diagnosed two causes before stopping:

1. **Preview-only:** the studio served `/media|/_next|/favicon` at root but not
   `/assets`, so every stylesheet 404'd *through the preview*. Real bug, but a
   preview-serving bug, not a generation bug.
2. **Real and structural:** I render the captured `<body>` element *inside* Next's own
   `<body>`. Nested `<body>` is invalid HTML; the browser reparents it, and every CSS
   selector written against `body` (which is most of a WordPress theme, and all of
   Elementor's `body.elementor-page ...` scoping) stops matching.

**Current repo state is half-patched** — an interrupt landed mid-edit. The body-class
script and the studio `/assets` fix applied; the DomTree body-children fix did not. Treat
the tree as inconsistent; I will reconcile it against your ruling rather than guess.

## The questions I need decided

**1. The document model.** A captured page is a whole document: `<html class>`,
`<head>` (meta, link, preload, JSON-LD), `<body class>`, plus body content. Next's App
Router owns `<html>` and `<body>` via the root layout, and the class differs per page
(`home page-id-8316433` vs an inner page). Options I see:

   a. Render body children into Next's body; set `body.className` from an inline
      synchronous script at the top of the page (works in a static export, risks a
      pre-hydration flash).
   b. Abandon the App Router's document ownership — write raw `.html` files and use
      Next only for routing/components. Loses the framework's value.
   c. Post-process the exported HTML to inject html/body attributes at build time.
   d. Something else.

   Which, and why? Flash-of-unstyled-content and hydration correctness both matter.

**2. React vs the DOM the scripts mutate.** Elementor's frontend JS, Swiper, AOS and
jQuery plugins **mutate the DOM React rendered** — adding classes, wrapping nodes,
injecting slide clones. React then owns a tree that no longer matches its virtual DOM.
Is `createElement` reconciliation even the right call here, or does exact fidelity
demand React *not* own that subtree at all (a `ref` + one-time imperative mount, or
`dangerouslySetInnerHTML` with `suppressHydrationWarning`)? I resisted innerHTML because
"a scraped mirror with React painted on" is a fair criticism — but if `createElement` is
architecturally wrong here, say so plainly and I'll take the hit and defend the choice
honestly instead.

**3. Script execution.** 44 external + 40 inline scripts per page, order-dependent,
jQuery-first, several waiting on `DOMContentLoaded`/`load` which have already fired by
the time a React effect runs. My current approach re-dispatches both events after
injection. Is that sound, or is there a correct ordering discipline (dependency graph?
defer semantics? module vs classic?) I should implement instead? What is the failure mode
I have not thought of?

**4. `<head>` fidelity.** Preloads, `<link rel=modulepreload>`, font preconnects,
critical inline CSS, JSON-LD, hreflang, canonical. How much of head must survive for the
page to be *visually* identical, and what is the mechanism in App Router given
`generateMetadata` only covers a subset?

**5. Scope of "everything".** The client says sitemap, images, logo, content — all of it.
Fidelity mode currently bypasses extraction entirely (it does not need the IR). But then
we lose the site config, the branding tokens, the migration report and the reuse matrix.
Should fidelity mode still run extraction in parallel purely to produce the *report*, or
is that wasted work? What is the minimum artefact set that keeps this defensible as an
engineering deliverable rather than a site ripper?

**6. Two modes, or one?** Is "template mode and fidelity mode as siblings behind a flag"
the right architecture, or is there a third position — capture-with-componentisation —
that gets exact fidelity *and* preserves some reuse? If the two-mode split is right, what
is the honest one-sentence framing for the trade?

**7. What breaks at fleet scale.** 733 assets for 3 pages. At 200 sites × 500 pages,
what fails first, and what would you change now to avoid rework later?

**8. What is the single biggest risk** you see that I have not asked about?

## Constraints (non-negotiable)

- No WordPress at runtime. Mechanically verified: no asset may load from the origin.
- URLs preserved byte-for-byte, trailing slashes included. Sitemap + robots emitted.
- Static export (`output: 'export'`). No server.
- Playwright is available and already used. No paid APIs; no API key required anywhere.
- This is a 72-hour interview take-home. Favour the choice that is defensible in review
  over the one that is theoretically ideal, and say which is which.

## What I want back

A ruling on each numbered question, in order, with reasoning I can act on. Where you
change my design, say what to delete. Be blunt about anything that is wrong.
