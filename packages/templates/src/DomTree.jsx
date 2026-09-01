'use client';
// Required. Without it the App Router treats this as a Server Component, useEffect never
// runs, and SiteScripts silently injects nothing — the page renders correctly but every
// animation, carousel and lazy image stays dead. Nothing errors; it just does not work.

/**
 * Renders a captured DOM tree as real React elements.
 *
 * Not dangerouslySetInnerHTML, which would make the output an HTML mirror with React
 * painted over it. Every node goes through createElement, so the tree is reconciled, keyed
 * and inspectable in DevTools, and individual nodes can become real components later.
 */
import React from 'react';

// The tables live in a plain-JS sibling so the importer's JSX codegen can import the same
// copy — bare `node` cannot load this file, and two hand-maintained copies would drift.
import { VOID, RENAME, BOOLEAN, styleToObject } from './dom-tables.js';

function toProps(attrs = {}, key) {
  const props = { key };
  for (const [rawName, rawValue] of Object.entries(attrs)) {
    const name = RENAME[rawName] ?? rawName;
    if (name === 'style') { props.style = styleToObject(rawValue); continue; }
    // Event handler attributes are dropped: React cannot take a string here, and an
    // inline onclick from the source page has no business executing in the new site.
    if (/^on[a-z]/i.test(name)) continue;
    if (BOOLEAN.has(name)) { props[name] = rawValue !== 'false'; continue; }
    // data-* and aria-* pass through verbatim; React accepts them as written.
    props[name] = rawValue;
  }
  return props;
}

export function DomNode({ node, path = '0' }) {
  if (node == null) return null;
  if (typeof node === 'string') return node;

  const tag = node.t;
  if (!tag) return null;

  // Synthetic wrapper used to group a run of sibling nodes into one component. It exists
  // only in the data model — emitting it would add an element the source never had and
  // shift every :nth-child count after it.
  if (tag === 'underpin-fragment') {
    return (node.c ?? []).map((child, i) =>
      typeof child === 'string'
        ? child
        : React.createElement(DomNode, { node: child, path: `${path}.${i}`, key: `${path}.${i}` })
    );
  }

  const props = toProps(node.a, path);

  if (VOID.has(tag)) return React.createElement(tag, props);

  const children = (node.c ?? []).map((child, i) => (
    typeof child === 'string'
      ? child
      : React.createElement(DomNode, { node: child, path: `${path}.${i}`, key: `${path}.${i}` })
  ));

  return React.createElement(tag, props, children.length ? children : null);
}

/**
 * Re-runs the source site's own scripts after mount, in order — what keeps sliders,
 * accordions and scroll animations working. Also the riskiest thing fidelity mode does, so
 * it is explicit: WordPress-calling scripts were dropped at capture and the rest is served
 * from this origin.
 */
export function SiteScripts({ scripts = [] }) {
  React.useEffect(() => {
    let cancelled = false;
    const added = [];

    // A page that looks right but ran none of its scripts is the failure nobody notices
    // until a carousel does not move. The counter lets a verifier read the answer off the
    // live page instead of guessing.
    const stats = { total: scripts.length, ran: 0, failed: 0 };
    window.__underpin = stats;

    const runExternal = (src) =>
      new Promise((resolve) => {
        const el = document.createElement('script');
        el.src = src;
        el.async = false;
        el.onload = () => { stats.ran++; resolve(); };
        // A single failed animation script must not stall the rest of the chain.
        el.onerror = () => { stats.failed++; resolve(); };
        document.body.appendChild(el);
        added.push(el);
      });

    const runInline = (code) => {
      try {
        const el = document.createElement('script');
        el.textContent = code;
        document.body.appendChild(el);
        added.push(el);
        stats.ran++;
      } catch {
        /* a snippet that throws should not take the page with it */
        stats.failed++;
      }
    };

    (async () => {
      // Strict document order, awaiting each external before continuing. WordPress
      // prints a plugin's config object in an inline script immediately before the
      // bundle that reads it — running all externals first and inlines afterwards boots
      // every bundle with its config undefined.
      for (const s of scripts) {
        if (cancelled) return;
        if (s.kind === 'external') await runExternal(s.src);
        else runInline(s.code);
      }
      if (cancelled) return;
      // Plugins commonly initialise on these; both have long since fired by now.
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
      window.dispatchEvent(new Event('load'));
    })();

    return () => {
      cancelled = true;
      for (const el of added) el.remove();
    };
  }, [scripts]);

  return null;
}

export default function FidelityPage({ page }) {
  // The capture is rooted at <body>. Render its CHILDREN — emitting a <body> inside the
  // document's real body is invalid HTML, and the browser's error recovery silently
  // reparents the content, which breaks every selector written against `body`.
  const root = page.tree;
  const children = root?.t === 'body' ? (root.c ?? []) : [root];

  // Scripts are rendered by the route, not here — the componentised branch needs them
  // too, and having both render them would load all 44 twice.
  return (
    <>
      {children.map((child, i) =>
        typeof child === 'string'
          ? child
          : <DomNode node={child} path={`b.${i}`} key={`b.${i}`} />
      )}
    </>
  );
}
