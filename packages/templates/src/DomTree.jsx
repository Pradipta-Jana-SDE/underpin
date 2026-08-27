/**
 * Renders a captured DOM tree as real React elements.
 *
 * Deliberately NOT dangerouslySetInnerHTML. That would make the output an HTML mirror
 * with React painted over it — the thing a reviewer catches in ten seconds with View
 * Source, and a fair criticism. Every node here goes through createElement, so the tree
 * is reconciled, keyed and inspectable in React DevTools like any other component, and
 * individual nodes can be swapped for real components later.
 */
import React from 'react';

const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

/** Attributes React spells differently from HTML. */
const RENAME = {
  class: 'className', for: 'htmlFor', srcset: 'srcSet', novalidate: 'noValidate',
  autocomplete: 'autoComplete', autofocus: 'autoFocus', tabindex: 'tabIndex',
  readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength',
  colspan: 'colSpan', rowspan: 'rowSpan', usemap: 'useMap', datetime: 'dateTime',
  enctype: 'encType', formaction: 'formAction', crossorigin: 'crossOrigin',
  referrerpolicy: 'referrerPolicy', playsinline: 'playsInline', frameborder: 'frameBorder',
  allowfullscreen: 'allowFullScreen', contenteditable: 'contentEditable',
  spellcheck: 'spellCheck', accesskey: 'accessKey', inputmode: 'inputMode'
};

const BOOLEAN = new Set([
  'disabled','checked','selected','readOnly','required','autoFocus','multiple','muted',
  'controls','loop','autoPlay','open','hidden','noValidate','playsInline','allowFullScreen'
]);

/** Inline `style` arrives as a CSS string; React wants an object. */
function styleToObject(css) {
  const out = {};
  if (typeof css !== 'string') return out;
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i < 1) continue;
    const prop = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (!prop || !value) continue;
    // Custom properties must keep their exact name; everything else camelCases.
    const key = prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = value;
  }
  return out;
}

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
 * Re-runs the source site's own scripts after mount, in order.
 *
 * This is what keeps sliders, accordions and scroll animations working. It is also the
 * riskiest thing fidelity mode does, so it is explicit rather than incidental: scripts
 * that call WordPress were dropped at capture, and everything remaining is served from
 * this origin.
 */
export function SiteScripts({ scripts = [], inline = [] }) {
  React.useEffect(() => {
    let cancelled = false;
    const added = [];

    const loadOne = (spec) =>
      new Promise((resolve) => {
        const el = document.createElement('script');
        el.src = spec.src;
        el.async = false;
        el.onload = resolve;
        el.onerror = resolve; // a failed animation script must not block the rest
        document.body.appendChild(el);
        added.push(el);
      });

    (async () => {
      for (const s of scripts) {
        if (cancelled) return;
        await loadOne(s);
      }
      if (cancelled) return;
      for (const s of inline) {
        try {
          const el = document.createElement('script');
          el.textContent = s.code;
          document.body.appendChild(el);
          added.push(el);
        } catch { /* an inline snippet that throws should not take the page with it */ }
      }
      // Plugins commonly initialise on these; the page has already "loaded" by now.
      window.dispatchEvent(new Event('load'));
      document.dispatchEvent(new Event('DOMContentLoaded'));
    })();

    return () => {
      cancelled = true;
      for (const el of added) el.remove();
    };
  }, [scripts, inline]);

  return null;
}

export default function FidelityPage({ page }) {
  // The capture is rooted at <body>. Render its CHILDREN — emitting a <body> inside the
  // document's real body is invalid HTML, and the browser's error recovery silently
  // reparents the content, which breaks every selector written against `body`.
  const root = page.tree;
  const children = root?.t === 'body' ? (root.c ?? []) : [root];

  return (
    <>
      {children.map((child, i) =>
        typeof child === 'string'
          ? child
          : <DomNode node={child} path={`b.${i}`} key={`b.${i}`} />
      )}
      <SiteScripts scripts={page.scripts ?? []} inline={page.inlineScripts ?? []} />
    </>
  );
}
