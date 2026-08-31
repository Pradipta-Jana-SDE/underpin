import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { captureSite, MENU_CSS } from '../capture/index.js';
import { mirrorAssets, rewriteTree } from './assets.js';
import { componentizePage, describeSection, applyLlmNames } from './componentize.js';
import { emitSectionModule, checkParity, emitJsx } from './jsx-emit.js';
import { hoistDecision } from './chrome.js';
import { spliceContent } from '@underpin/templates/splice';
import { resolveTargets, describeTargets } from './targets.js';

const require = createRequire(import.meta.url);
const templatePkgDir = join(dirname(require.resolve('@underpin/templates/manifests')), '..');

const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };

/**
 * JSON escaped to pure ASCII.
 *
 * Captured markup and inline scripts carry emoji, and WordPress's own emoji-settings
 * script contains unpaired surrogates. JSON.stringify emits those verbatim, which is
 * invalid JSON to a strict parser — the bundler then fails at build time with an
 * unreadable "Unexpected token" pointing into a minified chunk. Escaping every non-ASCII
 * code unit sidesteps the whole class of problem.
 */
const asciiJson = (o) =>
  JSON.stringify(o).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const contentKey = (path) =>
  (path === '/' ? 'index' : path.replace(/^\/|\/$/g, '').replace(/\//g, '__')).replace(/[^a-z0-9_.-]/gi, '-') || 'index';

/**
 * <link rel> values that describe the WordPress install rather than the site.
 *
 * Every one of these points a client at an editing endpoint that no longer exists, and
 * `api.w.org` in particular advertises the REST API of an install we have just migrated
 * away from.
 */
const DENY_REL = /^(EditURI|wlwmanifest|pingback|profile|https:\/\/api\.w\.org\/|alternate-json)$/i;

/**
 * Clears the previous build out of the app directory before writing a new one.
 *
 * Generation writes file by file, so anything the last run produced and this one does not
 * simply stays. Two ways that bites: a page dropped from the selection keeps its JSON and
 * ships in the zip, and — worse — switching modes leaves the previous mode's `out/` on
 * disk, where `verify` reads it and cheerfully reports the old export as current. That is
 * the stale-artefact bug this project already fixed once for the report; it applies with
 * more force to the export itself.
 *
 * node_modules survives: the dependencies are the same three every time and reinstalling
 * them on every build would make iterating unbearable.
 */
function resetAppDir(outDir) {
  for (const entry of ['app', 'components', 'content', 'public', '.next', 'out', 'package.json', 'next.config.mjs', 'README.md', 'site.config.json']) {
    rmSync(join(outDir, entry), { recursive: true, force: true });
  }
}

/** Nodes in a captured subtree. Text nodes are not counted — they are not DOM elements. */
const countNodes = (n) => (!n || typeof n === 'string' ? 0 : 1 + (n.c ?? []).reduce((s, c) => s + countNodes(c), 0));

/**
 * Fidelity mode: reproduce the original page exactly, in React, with no WordPress.
 *
 * Where template mode asks "what does this page MEAN", fidelity mode asks "what does
 * this page LOOK like" and keeps the answer verbatim — the rendered DOM, the site's own
 * stylesheets, and the scripts that drive its animations, all re-hosted locally.
 */
export async function generateFidelitySite({ outDir, siteUrl, plan, urls, limit = null, mediaLimit, componentize = false, virgin = true, layoutHoist = true, llm = null, onProgress }) {
  const origin = new URL(siteUrl).origin;
  const resolved = resolveTargets(plan, { urls, limit });
  const targets = resolved.urls;

  resetAppDir(outDir);

  onProgress?.({ type: 'stage', label: `Rendering ${describeTargets(resolved)} in a real browser` });
  const { pages, assets, failures } = await captureSite(targets, {
    origin,
    virgin,
    onProgress: (done, total, url) => onProgress?.({ type: 'progress', done, total, url })
  });

  // og:image and friends live in <head>, not the DOM tree, so the page-level sweep never
  // sees them — they would ship pointing at the WordPress origin and fail the
  // origin-independence check outright.
  const headImages = [];
  for (const p of pages) {
    for (const m of p.head?.meta ?? []) {
      const isImage =
        m.property === 'og:image' || m.name === 'twitter:image' || m.name === 'msapplication-TileImage';
      if (isImage && m.content && /^https?:\/\//.test(m.content)) {
        headImages.push({ url: m.content.split('#')[0], kind: 'image' });
      }
    }
  }
  for (const h of headImages) if (!assets.some((a) => a.url === h.url)) assets.push(h);

  // srcset alternates: the browser requests exactly one width and ignores the others, so
  // the response listener never sees them and they ship pointing at the source origin.
  const known = new Set(assets.map((a) => a.url));
  const sweepSrcset = (node, base) => {
    if (!node || typeof node === 'string') return;
    for (const key of ['srcset', 'data-srcset', 'data-lazy-srcset', 'imagesrcset']) {
      const raw = node.a?.[key];
      if (!raw) continue;
      for (const part of String(raw).split(/,(?=\s*(?:https?:\/\/|\/\/|\/))/)) {
        const candidate = part.trim().split(/\s+/)[0];
        if (!candidate || candidate.startsWith('data:')) continue;
        try {
          const abs = new URL(candidate, base).toString().split('#')[0];
          if (!known.has(abs)) { known.add(abs); assets.push({ url: abs, kind: 'image' }); }
        } catch { /* malformed candidate */ }
      }
    }
    (node.c ?? []).forEach((c) => sweepSrcset(c, base));
  };
  for (const p of pages) sweepSrcset(p.tree, p.url);

  onProgress?.({ type: 'stage', label: `Mirroring ${assets.length} assets (CSS, fonts, images, scripts)` });
  const capped = mediaLimit ? assets.slice(0, mediaLimit) : assets;
  const { localByUrl, failures: assetFailures, downloaded } = await mirrorAssets(capped, outDir, {
    origin,
    onProgress: (n, total) => onProgress?.({ type: 'assets', done: n, total })
  });

  onProgress?.({ type: 'stage', label: 'Rewriting references and emitting the React site' });

  const routes = [];
  const warnings = [];
  const prepared = [];
  for (const p of pages) {
    rewriteTree(p.tree, localByUrl, p.url);

    const localFor = (raw) => {
      try { return localByUrl.get(new URL(raw, p.url).toString().split('#')[0]) ?? null; }
      catch { return null; }
    };

    const rewriteCss = (css) =>
      css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (whole, ref) => {
        const r = ref.trim();
        if (!r || r.startsWith('data:')) return whole;
        const local = localFor(r);
        return local ? `url("${local}")` : whole;
      });

    // One ordered list preserving the document's original link/style interleaving, so the
    // cascade resolves the same way it did on the source page.
    const sheets = (p.sheets ?? [])
      .map((sh) =>
        sh.kind === 'link'
          ? (localFor(sh.href) ? { kind: 'link', href: localFor(sh.href) } : null)
          : (sh.css?.trim() ? { kind: 'inline', css: rewriteCss(sh.css) } : null)
      )
      .filter(Boolean);

    // One ordered list, externals and inlines interleaved exactly as the source document
    // had them. An external whose file could not be mirrored is dropped rather than left
    // pointing at the origin.
    const scripts = (p.scriptsOrdered ?? [])
      .map((sc) => {
        if (sc.kind === 'external') {
          const l = localFor(sc.src);
          return l ? { kind: 'external', src: l } : null;
        }
        const code = sc.code?.trim();
        return code ? { kind: 'inline', code } : null;
      })
      .filter(Boolean);

    // <head> links were captured from the start and never emitted, which cost the export
    // its canonical, its hreflang alternates and its favicon — and made the seo_canonical
    // acceptance check fail on every fidelity build.
    const links = (p.head?.links ?? [])
      .filter((l) => l.rel && !DENY_REL.test(l.rel))
      // A wp-json alternate is a live reference to the old install: it fails the
      // origin-independence check and tells a crawler WordPress is still the source.
      .filter((l) => !/\/wp-json\//i.test(l.href ?? ''))
      .map((l) => {
        if (!l.href) return l;
        const local = localFor(l.href);
        if (local) return { ...l, href: local };
        // Anything still on the source origin is reduced to a path this site serves. A
        // canonical naming the WordPress origin tells Google the migration did not happen.
        try {
          const u = new URL(l.href, p.url);
          if (u.origin === origin) return { ...l, href: u.pathname + u.search };
        } catch { /* leave a malformed href alone */ }
        return l;
      });

    const head = {
      ...p.head,
      links,
      meta: (p.head?.meta ?? []).map((m) =>
        m.content && /^https?:\/\//.test(m.content) && localFor(m.content)
          ? { ...m, content: localFor(m.content) }
          : m
      )
    };

    // JSON-LD is data, not markup — it passes through verbatim.
    const jsonLd = (p.jsonLd ?? []).slice(0, 6);

    // Last in the cascade, and only when this page actually has a captured menu — an
    // unconditional rule would hide nothing and still be a rule someone has to explain.
    if (p.captureDiagnostics?.menus?.panels) {
      sheets.push({ kind: 'inline', css: MENU_CSS });
    }

    const doc = {
      path: p.path,
      url: p.url,
      title: p.title,
      lang: p.lang,
      bodyClass: p.bodyClass,
      htmlClass: p.htmlClass,
      head,
      jsonLd,
      sheets,
      scripts,
      tree: p.tree,
      mode: 'fidelity'
    };
    // Final sweep at the string level. Builders park absolute URLs inside JSON-encoded
    // attributes (Elementor's data-settings) and inline scripts, where a tree walk over
    // parsed attributes never reaches them — they survive as \\/-escaped strings. Matching
    // both forms in one pass is the only rewrite that cannot be defeated by a shape
    // nobody anticipated. Same lesson as template mode's rewriteUrls, one layer deeper.
    const rewriteEscaped = (json) =>
      json.replace(/https?:(?:\\\/\\\/|\/\/)[^"'\s\\)]+/g, (match) => {
        const plain = match.replace(/\\\//g, '/').split('#')[0];
        const local = localByUrl.get(plain);
        if (!local) return match;
        // Preserve the escaping style the original used.
        return match.includes('\\/') ? local.replace(/\//g, '\\/') : local;
      });

    const key = contentKey(p.path);

    // Componentisation is deferred to a second pass. Whether the header and footer can be
    // hoisted into the shared layout is a question about ALL the pages being built, and it
    // cannot be answered while looking at one of them.
    if (componentize) {
      const parts = componentizePage(doc);
      prepared.push({ key, path: p.path, parts, rewriteEscaped });
      doc.componentized = parts.map((p2) => ({ id: p2.id, name: p2.name, kind: p2.kind, items: p2.itemCount }));
    }

    write(join(outDir, 'content', 'pages', `${key}.json`), rewriteEscaped(asciiJson(doc)));

    // Counts travel with the route so the report can describe the build without reopening
    // every page JSON — those are the largest files in the export.
    routes.push({
      path: p.path,
      url: p.url,
      key,
      title: p.title,
      componentized: componentize,
      sections: doc.componentized?.length ?? 0,
      nodes: countNodes(p.tree),
      sheets: sheets.length,
      scripts: scripts.length,
      capture: p.captureDiagnostics ?? null
    });
  }

  if (componentize && llm?.available) {
    onProgress?.({ type: 'stage', label: `Naming sections with ${llm.model}` });
    for (const page of prepared) {
      const flat = [];
      const walk = (list) => { for (const x of list) { flat.push(x); if (x.children) walk(x.children); } };
      walk(page.parts);
      const names = await llm.nameSections(flat.map(describeSection));
      if (names) applyLlmNames(page.parts, names, page.parts.unique);
      else warnings.push({ kind: 'llm_declined', key: page.key, detail: 'kept the rule-derived names' });
    }
  }

  const emitted = componentize ? emitComponents(outDir, prepared, { layoutHoist, warnings }) : null;
  if (emitted) {
    for (const r of routes) r.sections = emitted.sectionsByKey[r.key] ?? r.sections;
  }

  const redirects = (plan.excludedUrls ?? []).map((e) => ({
    from: new URL(e.url).pathname, policy: e.policy, reason: e.reason
  }));
  write(join(outDir, 'content', 'routes.json'), JSON.stringify(routes, null, 2));
  write(join(outDir, 'content', 'redirects.json'), JSON.stringify(redirects, null, 2));

  scaffoldFidelityApp(outDir, { siteUrl, routes, origin, componentize, layout: emitted?.layout ?? null });

  // A roll-up the report can read without reopening every page. `unmerged` counts nodes
  // whose structure shifted between the two capture passes — a lazy image inside one of
  // those keeps its placeholder, so it is reported rather than left to be noticed later.
  const captureDiagnostics = {
    virgin,
    merged: routes.reduce((a, r) => a + (r.capture?.merged ?? 0), 0),
    unmerged: routes.reduce((a, r) => a + (r.capture?.unmergedTotal ?? 0), 0),
    byPath: Object.fromEntries(routes.map((r) => [r.path, {
      merged: r.capture?.merged ?? 0,
      unmerged: r.capture?.unmergedTotal ?? 0,
      animation: r.capture?.animation ?? null
    }]))
  };

  return {
    mode: 'fidelity',
    componentize,
    parity: emitted?.parity ?? null,
    chrome: emitted?.chrome ?? null,
    captureDiagnostics,
    targets: { count: targets.length, source: resolved.source },
    routes,
    media: { total: assets.length, downloaded, skipped: 0, failed: assetFailures },
    captureFailures: failures,
    warnings
  };
}

/**
 * One section, as a thin wrapper around the renderer that already works.
 *
 * Deliberately not generated JSX source. Re-deriving the attribute renaming, boolean
 * props and style parsing a second time as codegen is where this project would quietly
 * become a much larger one — and the existing renderer already measures 99.8% visual on
 * a static page. What the client asked for — small, named, ordered, editable files — is
 * delivered by the composition in Page.jsx and the content JSON beside each section.
 */
/**
 * Emits every page's section components, and the shared layout when one is warranted.
 *
 * Each section becomes real JSX source a developer can open and edit, with its text and
 * media in a content module beside it. That reverses this project's earlier decision to
 * wrap the runtime renderer instead — a decision that was correct while nothing could
 * prove generated markup matched the capture, and is wrong now that something can.
 *
 * The gate is per section, and it fails safe: emitted JSX is re-parsed and compared against
 * the tree it came from, and a section that does not round-trip is written as a renderer
 * wrapper instead. So the worst outcome of a codegen bug is a file that is less pleasant to
 * edit — never a page that renders differently from the original.
 */
function emitComponents(outDir, prepared, { layoutHoist = true, warnings = [] } = {}) {
  const decision = layoutHoist
    ? hoistDecision(prepared.map(({ key, path, parts }) => ({ key, path, parts })))
    : {
        header: { hoist: false, reason: 'per-page: --no-layout-hoist' },
        footer: { hoist: false, reason: 'per-page: --no-layout-hoist' }
      };

  // Only a TOP-LEVEL chrome section can be hoisted, and that is a correctness rule rather
  // than a limitation: a header nested inside a page wrapper is not a body child, so
  // rendering it from app/layout.jsx would move it outside that wrapper and change the DOM.
  // hoistDecision only ever sees top-level parts, which is what keeps that true.
  const hoisted = new Map(); // role -> { name, part, key }
  for (const [role, name] of [['header', 'SiteHeader'], ['footer', 'SiteFooter']]) {
    if (!decision[role]?.hoist) continue;
    const src = prepared.find((pg) => pg.key === decision[role].from) ?? prepared[0];
    const part = src?.parts.find((x) => x.name === name);
    if (part) hoisted.set(role, { name, part, key: src.key });
  }

  const parity = { sections: 0, ok: 0, fallbacks: [] };
  const sectionsByKey = {};

  /**
   * A parent component: its own wrapper element, with child components inside it.
   *
   * The wrapper is emitted with a single marker child, then the marker line is replaced by
   * the child tags at that indentation. Going through the ordinary emitter rather than
   * hand-writing a tag means the wrapper's attributes get the same conversion and the same
   * parity check as everything else — the marker is simply what the check is run against.
   */
  const composeParent = (part, childNames) => {
    const marker = 'UNDERPIN_CHILD_SLOTS';
    const shell = { t: part.tree.t, a: part.tree.a, c: [marker] };
    const jsx = emitJsx(shell, { path: part.id });
    const check = checkParity(shell, jsx, {}, { path: part.id });
    if (!check.ok) return null;

    // Split on the marker, not on the line holding it: a short wrapper is emitted inline
    // as `<div ...>MARKER</div>`, and replacing that whole line would take the tags with it.
    const idx = jsx.indexOf(marker);
    if (idx < 0) return null;
    const open = jsx.slice(0, idx).replace(/\s+$/, '');
    const close = jsx.slice(idx + marker.length).replace(/^\s+/, '');
    const body = [open, ...childNames.map((n) => `  <${n} />`), close].join('\n');

    const imports = childNames.map((n) => `import ${n} from './${n}.jsx';`).join('\n');
    return `${imports}

/**
 * ${part.name}
 *
 * A parent: this file is the wrapper element the original page had, and the sections
 * inside it are their own components. The wrapper is kept rather than skipped — removing
 * an element that always rendered is how a layout breaks in a way nobody sees in review.
 */
export default function ${part.name}() {
  return (
${body.split('\n').map((l) => (l ? '    ' + l : l)).join('\n')}
  );
}
`;
  };

  /** One section to disk, as JSX when it round-trips and as a wrapper when it does not. */
  const emitOne = (part, { key, dir, depth, chrome, rewrite = (x) => x }) => {
    parity.sections++;
    const expected = spliceContent(part.tree, part.content, part.id);

    let result = null;
    try {
      if (part.children?.length) {
        // Compose BEFORE emitting the children. If the wrapper does not round-trip, this
        // section is emitted whole instead — and children written first would then be
        // orphaned files that nothing imports.
        const composed = composeParent(part, part.children.map((c) => c.name));
        if (composed) {
          for (const child of part.children) emitOne(child, { key, dir, depth, chrome: false, rewrite });
          parity.ok++;
          write(join(dir, `${part.name}.jsx`), rewrite(composed));
          return;
        }
        parity.fallbacks.push({ key, id: part.id, name: part.name, at: part.id, reason: 'wrapper element did not round-trip' });
      }

      const mod = emitSectionModule(part, { key, chrome });
      const check = checkParity(expected, mod.jsx, mod.identifiers, { path: part.id });
      if (check.ok) result = mod;
      else parity.fallbacks.push({ key, id: part.id, name: part.name, at: check.at, reason: check.reason });
    } catch (err) {
      parity.fallbacks.push({ key, id: part.id, name: part.name, at: part.id, reason: String(err?.message ?? err) });
    }

    if (result) {
      parity.ok++;
      write(join(dir, `${part.name}.jsx`), rewrite(result.jsx));
      if (result.content) write(join(dir, `${part.name}.content.js`), rewrite(result.content));
      return;
    }

    // The safe path. It needs the tree and content as JSON beside it, which is why those
    // files are written here rather than for every section.
    const back = '../'.repeat(depth);
    write(join(outDir, 'content', 'sections', key, `${part.id}.tree.json`), rewrite(asciiJson(part.tree)));
    write(join(outDir, 'content', 'sections', key, `${part.id}.content.json`), rewrite(asciiJson(part.content)));
    write(join(dir, `${part.name}.jsx`), fallbackSectionComponent(part, key, back));
  };

  for (const [role, entry] of hoisted) {
    emitOne(entry.part, {
      key: entry.key,
      dir: join(outDir, 'components', 'layout'),
      depth: 2,
      chrome: true,
      rewrite: prepared.find((pg) => pg.key === entry.key)?.rewriteEscaped
    });
    warnings.push({ kind: 'chrome_hoisted', role, name: entry.name, from: entry.key });
  }

  for (const page of prepared) {
    const dir = join(outDir, 'components', 'pages', page.key);
    // A hoisted section renders from the layout instead; leaving it in the page as well
    // would emit the header twice.
    const hoistedNames = new Set([...hoisted.values()].map((h) => h.name));
    const own = page.parts.filter((part) => !hoistedNames.has(part.name));

    for (const part of own) {
      emitOne(part, { key: page.key, dir, depth: 3, chrome: false, rewrite: page.rewriteEscaped });
    }
    write(join(dir, 'Page.jsx'), pageComponent(own, page.key));
    sectionsByKey[page.key] = own.length;
  }

  for (const f of parity.fallbacks) warnings.push({ kind: 'jsx_parity', ...f });

  return {
    parity,
    chrome: decision,
    layout: [...hoisted.entries()].map(([role, h]) => ({ role, name: h.name })),
    sectionsByKey
  };
}

/**
 * The safety net: a section whose generated JSX did not round-trip.
 *
 * Not the design any more — the design is real source, above. This renders the captured
 * subtree through the runtime walker, which is exactly what every section used to do, so a
 * fallback still produces the correct DOM. It is reported rather than silent, because a
 * build that quietly stops emitting editable components has stopped delivering the thing
 * that was asked for.
 */
function fallbackSectionComponent(part, key, back = '../../../') {
  return `'use client';
import { DomNode } from '${back}components/runtime/DomTree.jsx';
import { spliceContent } from '${back}components/runtime/splice.js';
import tree from '${back}content/sections/${key}/${part.id}.tree.json';
import content from '${back}content/sections/${key}/${part.id}.content.json';

/**
 * ${part.name}
 *
 * Structure: content/sections/${key}/${part.id}.tree.json  (markup — edit with care)
 * Content:   content/sections/${key}/${part.id}.content.json  (${part.counts.text} text, ${part.counts.media} media — safe to edit)
 */
export default function ${part.name}() {
  return <DomNode node={spliceContent(tree, content, '${part.id}')} path="${part.id}" />;
}
`;
}

/** The page: an ordered composition of its sections, and nothing else. */
function pageComponent(parts, key) {
  const imports = parts.map((p) => `import ${p.name} from './${p.name}.jsx';`).join('\n');
  const body = parts.map((p) => `      <${p.name} />`).join('\n');
  return `${imports}

/**
 * Page: /${key === 'index' ? '' : key.replace(/__/g, '/') + '/'}
 *
 * Sections render in source order. Adding, removing or reordering them changes the DOM —
 * which is fine when you mean it, and the reason the original order is preserved here.
 */
export default function Page() {
  return (
    <>
${body}
    </>
  );
}
`;
}

/**
 * Files the generated app needs at runtime, copied in rather than depended on.
 *
 * The alternative was a `file:` dependency back into this monorepo, which made the export
 * installable only from inside the repo that produced it and forced the zip exporter to
 * vendor a package tree just to make the archive work elsewhere. Copying makes "the
 * generated app depends only on next and react" a fact you can check with one grep instead
 * of a claim in a README. They are copied from the packaged source at generation time, so
 * they cannot drift by hand.
 */
const RUNTIME_FILES = [
  ['src/DomTree.jsx', 'components/runtime/DomTree.jsx'],
  ['src/dom-tables.js', 'components/runtime/dom-tables.js'],
  ['src/splice.js', 'components/runtime/splice.js']
];

function scaffoldFidelityApp(outDir, { siteUrl, routes, origin, componentize = false, layout = null }) {
  const host = new URL(siteUrl).host;

  for (const [from, to] of RUNTIME_FILES) {
    const src = readFileSync(join(templatePkgDir, from), 'utf8');
    write(join(outDir, to),
      `// Generated from @underpin/templates/${from} — edit the generator, not this copy.\n` +
      `// Regenerate with: underpin build <url> --mode fidelity\n` + src);
  }

  write(join(outDir, 'package.json'), JSON.stringify({
    name: `site-${host.replace(/[^a-z0-9-]/gi, '-')}`,
    private: true, version: '1.0.0',
    scripts: { dev: 'next dev', build: 'next build', start: 'npx serve out' },
    dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' }
  }, null, 2));

  write(join(outDir, 'next.config.mjs'), `/** @type {import('next').NextConfig} */
export default {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  // The captured markup is the source site's own; Next's built-in checks have nothing
  // useful to say about it and would only fail the build on someone else's HTML.
  eslint: { ignoreDuringBuilds: true },
  // This subtree is deliberately imperative: the site's own scripts mutate the DOM React
  // rendered. StrictMode's double-invoke exists to catch effects that are not idempotent
  // — ours is not, by design, and double-invoking would initialise all 44 scripts twice
  // in 'next dev'. Off for fidelity apps only; template mode keeps the default.
  reactStrictMode: false
};
`);

  const chrome = layout ?? [];
  const header = chrome.find((c) => c.role === 'header');
  const footer = chrome.find((c) => c.role === 'footer');
  const chromeImports = chrome.map((c) => `import ${c.name} from '../components/layout/${c.name}.jsx';`).join('\n');
  const chromeNote = chrome.length
    ? `\n\n  // ${chrome.map((c) => c.name).join(' and ')} render here rather than inside each page:
  // they are byte-identical across every migrated page, so one copy is the honest
  // representation. Anything that differed per page stayed per page — a shared header
  // that quietly loses its active-nav state is a bug a client sees on day one.`
    : '';

  write(join(outDir, 'app', 'layout.jsx'), `${chromeImports}${chromeImports ? '\n\n' : ''}export const metadata = {
  title: ${JSON.stringify(host)},
  // Change this to wherever the site will actually live. Relative canonicals and og:image
  // paths resolve against it, so leaving it pointed at the source origin would publish
  // canonicals naming the site this one replaced.
  metadataBase: new URL(${JSON.stringify(origin)})
};

export default function RootLayout({ children }) {
  // The captured page sets html/body classes from an inline script at render time.
  // React never declares those attributes here, so it has nothing to reconcile — the
  // suppression is belt and braces for the externally-mutated case.${chromeNote}
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
${header ? `        <${header.name} />\n` : ''}        {children}
${footer ? `        <${footer.name} />\n` : ''}      </body>
    </html>
  );
}
`);

  write(join(outDir, 'app', '[[...slug]]', 'page.jsx'), `${componentize ? "import { SiteScripts } from '../../components/runtime/DomTree.jsx';" : "import FidelityPage, { SiteScripts } from '../../components/runtime/DomTree.jsx';"}
import routes from '../../content/routes.json';

const load = (key) => require(\`../../content/pages/\${key}.json\`);

export function generateStaticParams() {
  return routes.map((r) => ({ slug: r.path === '/' ? [] : r.path.replace(/^\\/|\\/$/g, '').split('/') }));
}

function routeFor(slug) {
  const path = !slug || slug.length === 0 ? '/' : '/' + slug.join('/') + '/';
  return routes.find((r) => r.path === path) ?? routes.find((r) => r.path === path.replace(/\\/$/, ''));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const route = routeFor(slug);
  if (!route) return {};
  const page = load(route.key);
  const get = (sel) => page.head?.meta?.find(sel)?.content;
  const links = page.head?.links ?? [];
  const rel = (r) => links.filter((l) => String(l.rel ?? '').toLowerCase() === r);

  const icons = [...rel('icon'), ...rel('shortcut icon')].map((l) => ({ url: l.href, sizes: l.sizes, type: l.type }));
  const apple = rel('apple-touch-icon').map((l) => ({ url: l.href, sizes: l.sizes }));
  const languages = Object.fromEntries(rel('alternate').filter((l) => l.hreflang).map((l) => [l.hreflang, l.href]));

  return {
    title: page.title,
    description: get((m) => m.name === 'description'),
    alternates: {
      // Resolved against metadataBase in layout.jsx. A canonical still naming the old
      // WordPress origin tells a crawler the migration never happened.
      canonical: rel('canonical')[0]?.href ?? route.path,
      languages: Object.keys(languages).length ? languages : undefined
    },
    icons: icons.length || apple.length ? { icon: icons, apple } : undefined,
    openGraph: {
      title: get((m) => m.property === 'og:title'),
      description: get((m) => m.property === 'og:description'),
      images: get((m) => m.property === 'og:image') ? [get((m) => m.property === 'og:image')] : undefined
    }
  };
}

export default async function Page({ params }) {
  const { slug } = await params;
  const route = routeFor(slug);
  if (!route) return null;
  const page = load(route.key);
${componentize ? "  const PageSections = require(`../../components/pages/${route.key}/Page.jsx`).default;\n" : ''}
  return (
    <>
      {/* Runs before the stylesheets so the class is on <body> the moment the cascade
          resolves. WordPress themes scope heavily to body classes; without this the page
          background only paints the inner content and the real body shows through. */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            'document.body.className=' + JSON.stringify(page.bodyClass || '') + ';' +
            'document.documentElement.className=' + JSON.stringify(page.htmlClass || '') + ';'
        }}
      />

      {/* React 19 only hoists these into <head> when precedence is set; without it all
          of them stay in <body> and most of the site renders unstyled. A shared
          precedence keeps render order === original document order, and <style> needs an
          href as its dedup key. */}
      {page.sheets.map((sheet, i) =>
        sheet.kind === 'link' ? (
          <link key={i} rel="stylesheet" href={sheet.href} precedence="site" />
        ) : (
          <style
            key={i}
            href={'inline-' + i}
            precedence="site"
            dangerouslySetInnerHTML={{ __html: sheet.css }}
          />
        )
      )}

      {/* Connection hints only. preload is deliberately NOT emitted: every preloadable
          asset on this page is mirrored under /assets, and a preload still naming the
          source origin would re-introduce the runtime dependency on WordPress that the
          origin-independence check exists to catch. */}
      {(page.head?.links ?? [])
        .filter((l) => /^(preconnect|dns-prefetch)$/i.test(l.rel))
        .map((l, i) => <link key={'h' + i} rel={l.rel} href={l.href} crossOrigin={l.crossorigin} />)}

      {/* Structured data is data, not markup — verbatim is correct here. */}
      {(page.jsonLd ?? []).map((block, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: block }} />
      ))}

      {/* Componentised builds compose named per-section files; the single-blob build
          renders the whole captured tree through one renderer. Both produce the same
          DOM — that equivalence is the acceptance test. */}
      ${componentize ? '<PageSections />' : '<FidelityPage page={page} />'}
      <SiteScripts scripts={page.scripts ?? []} />
    </>
  );
}
`);

  write(join(outDir, 'app', 'sitemap.js'), `import routes from '../content/routes.json';
export const dynamic = 'force-static';
export default function sitemap() {
  return routes.map((r) => ({ url: new URL(r.path, ${JSON.stringify(origin)}).toString(), lastModified: new Date() }));
}
`);
  write(join(outDir, 'app', 'robots.js'), `export const dynamic = 'force-static';
export default function robots() {
  return { rules: [{ userAgent: '*', allow: '/' }], sitemap: ${JSON.stringify(origin + '/sitemap.xml')} };
}
`);

  write(join(outDir, 'README.md'), `# ${host} — fidelity migration

Reproduces the original design exactly, in React, with **no WordPress at runtime**.

    npm install && npm run build   # static export to ./out

The rendered DOM, the site's own stylesheets and its animation scripts were captured
from a real browser and re-hosted under \`public/assets\`. Every node renders through
\`React.createElement\` — this is a real component tree, not an innerHTML blob.

**Trade-off:** nothing here is shared with other migrated sites. Fidelity mode and
template mode are opposite ends of the same dial; see the project README.
`);
}
