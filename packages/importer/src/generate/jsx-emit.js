import { VOID, RENAME, BOOLEAN, styleToObject } from '@underpin/templates/dom-tables';

/**
 * Generates readable JSX source from a captured DOM tree.
 *
 * DomTree.jsx already renders these trees correctly, but it renders them from JSON — open a
 * generated section and you find a blob, not a component. This emits the same tree as real
 * JSX text, so the migrated project holds files a developer can edit.
 *
 * The tables come from the renderer rather than being retyped. Each is a behaviour the
 * browser can see, and a copy that drifts by one entry renders correctly through one path
 * and subtly wrong through the other, with nothing failing loudly.
 *
 * ---------------------------------------------------------------------------- emission
 *
 * | input                              | emitted                                        |
 * |------------------------------------|------------------------------------------------|
 * | class="a"                          | className="a"            (RENAME, from DomTree) |
 * | style="color:red;--b:#f00"         | style={{ color: "red", "--b": "#f00" }}        |
 * | style="" / unparseable             | (prop omitted — styleToObject returned {})     |
 * | disabled="" / "disabled"           | disabled={true}                                |
 * | disabled="false"                   | disabled={false}       (DomTree.jsx's rule)     |
 * | data-x="1" / aria-label="x"        | verbatim, double-quoted (JSX allows hyphens)   |
 * | stroke-width="2"                   | strokeWidth="2"                (SVG_RENAME)    |
 * | viewBox / preserveAspectRatio      | untouched — already camelCase off the parser   |
 * | xlink:href / xmlns:xlink           | xlinkHref / xmlnsXlink            (NS_RENAME)  |
 * | @click / x-on:click / :class       | one trailing {...{"@click": "…"}} spread       |
 * | onclick="…"                        | dropped + counted   (DomTree.jsx:60's policy)  |
 * | value containing " or newline or & | name={"…"}  — a JSON-escaped JS string          |
 * | src, hoisted                       | src={content.imageSrc}                         |
 * | <img>, <br> …                      | always self-closing                (VOID)      |
 * | element with no children           | self-closing                                   |
 * | underpin-fragment                  | <>…</>            (DomTree.jsx:78-84)           |
 * | text " "                           | {' '}                                          |
 * | text equal to its trim, no {}<>&\n | raw                                            |
 * | anything else                      | {"…"}                                          |
 * | text, hoisted                      | {content.heading}                              |
 *
 * `&` has to be excluded from raw text: JSX decodes HTML entities, so a raw `&nbsp;` becomes
 * U+00A0 and `&amp;` becomes `&` — both change the DOM. Tabs and carriage returns go for the
 * same reason, since JSX rewrites tabs to spaces inside a text run.
 *
 * No JSX comments are emitted inside the markup. Capture drops comment nodes, and `{/* … *\/}`
 * produces no DOM node where an HTML comment produces one, so it could only misrepresent the
 * source. The docblock and the dropped-handler list sit outside the tree and are free.
 */

/* ------------------------------------------------------------------ tables */

/**
 * SVG presentation attributes React spells in camelCase. Separate from RENAME, which is the
 * HTML table. Anything already camelCase off the parser — viewBox, preserveAspectRatio,
 * gradientUnits — is absent on purpose: correct as captured, and an entry here could only
 * get it wrong.
 */
const SVG_RENAME = {
  'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin', 'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset', 'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-opacity': 'strokeOpacity', 'fill-rule': 'fillRule', 'fill-opacity': 'fillOpacity',
  'clip-path': 'clipPath', 'clip-rule': 'clipRule', 'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity', 'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline',
  'color-interpolation-filters': 'colorInterpolationFilters',
  'flood-color': 'floodColor', 'flood-opacity': 'floodOpacity',
  'marker-end': 'markerEnd', 'marker-mid': 'markerMid', 'marker-start': 'markerStart',
  'paint-order': 'paintOrder', 'shape-rendering': 'shapeRendering',
  'vector-effect': 'vectorEffect', 'font-family': 'fontFamily', 'font-size': 'fontSize',
  'font-weight': 'fontWeight', 'letter-spacing': 'letterSpacing',
  'word-spacing': 'wordSpacing', 'baseline-shift': 'baselineShift'
};

/**
 * Namespaced attributes. A colon in a JSX prop name is a syntax error, so one `xlink:href`
 * in one icon fails the whole generated file — and real themes ship these by the hundred
 * inside sprite sheets.
 */
const NS_RENAME = {
  'xlink:href': 'xlinkHref', 'xlink:title': 'xlinkTitle', 'xlink:role': 'xlinkRole',
  'xlink:show': 'xlinkShow', 'xlink:type': 'xlinkType', 'xlink:actuate': 'xlinkActuate',
  'xml:lang': 'xmlLang', 'xml:space': 'xmlSpace', 'xml:base': 'xmlBase',
  'xmlns:xlink': 'xmlnsXlink'
};

/** A prop name that can be written bare in JSX. Hyphens are legal; colons and sigils are not. */
const JSX_PROP = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/** A bare JS identifier — used for style keys and content bindings. */
const JS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Text safe to emit unquoted. See the `&` note in the module docblock. */
const RAW_TEXT = /^[^{}<>&\n\r\t]+$/;

const isEl = (n) => n && typeof n === 'object' && typeof n.t === 'string';

/** RENAME, then the two codegen-only tables. The three are disjoint and the result is idempotent. */
function renameAttr(name) {
  return RENAME[name] ?? SVG_RENAME[name] ?? NS_RENAME[name] ?? name;
}

/* --------------------------------------------------------------- attributes */

function emitStyle(css) {
  // styleToObject is the renderer's own parser, so a style that renders one way at runtime
  // cannot render another way in the generated source.
  const entries = Object.entries(styleToObject(css));
  if (!entries.length) return null;
  const body = entries
    .map(([k, v]) => `${JS_IDENT.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(', ');
  return `{{ ${body} }}`;
}

function emitAttrValue(value) {
  const v = String(value);
  // A quote ends the literal, a newline is not allowed inside one, and `&` would be decoded
  // as an HTML entity. The expression form sidesteps all three.
  if (/["\n\r&]/.test(v)) return `{${JSON.stringify(v)}}`;
  return `"${v}"`;
}

function emitAttrs(node, path, ctx) {
  const parts = [];
  const spread = [];

  for (const [rawName, rawValue] of Object.entries(node.a ?? {})) {
    const name = renameAttr(rawName);

    // Hoisted first: it is the only case that changes where the value comes from rather
    // than how it is spelled, and hoisting only ever applies to src/srcset/alt/href/poster.
    const bound = ctx.bind.get(`${path}@${rawName}`);
    if (bound) { parts.push(`${name}={content.${bound}}`); continue; }

    if (name === 'style') {
      const style = emitStyle(rawValue);
      if (style) parts.push(`style=${style}`);
      continue;
    }

    // React cannot take a string handler, and an inline onclick written for WordPress has
    // no business executing in the new site. DomTree.jsx:60 drops these; so do we, but we
    // count them, because a silently dropped behaviour is the one a client notices.
    if (/^on[a-z]/i.test(name)) {
      ctx.warnings.droppedHandlers += 1;
      ctx.warnings.handlers.push({ path, tag: node.t, attr: rawName });
      continue;
    }

    if (BOOLEAN.has(name)) { parts.push(`${name}={${rawValue !== 'false'}}`); continue; }

    // Alpine.js (`@click`, `x-on:click`, `:class`) and anything else colon- or sigil-named.
    // One spread rather than one per attribute: React forwards unknown lowercase props to
    // the DOM unchanged, so the attribute survives and the file still parses.
    if (!JSX_PROP.test(name)) { spread.push([name, rawValue]); continue; }

    parts.push(`${name}=${emitAttrValue(rawValue)}`);
  }

  if (spread.length) {
    ctx.warnings.spreadAttributes += spread.length;
    parts.push(`{...{${spread.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(String(v))}`).join(', ')}}}`);
  }
  return parts;
}

/* --------------------------------------------------------------------- text */

function emitText(value, path, ctx, prevWasRaw) {
  const bound = ctx.bind.get(path);
  if (bound) return { text: `{content.${bound}}`, raw: false };
  // Capture collapses a whitespace-only text node to a single space. JSX deletes a
  // whitespace-only line outright, so this one has to be an expression to survive.
  if (value === ' ') return { text: `{' '}`, raw: false };
  // Two raw text siblings on consecutive lines are joined by JSX into ONE child with a
  // space between them. Forcing the second into expression form keeps the child count.
  if (!prevWasRaw && value === value.trim() && RAW_TEXT.test(value)) return { text: value, raw: true };
  return { text: `{${JSON.stringify(value)}}`, raw: false };
}

/* ----------------------------------------------------------------- elements */

/** Past this the open tag goes one attribute per line. Elementor class lists run to 300 chars. */
const WRAP_AT = 100;

function emitNode(node, path, ctx, depth) {
  const pad = ' '.repeat(depth * ctx.indent);

  // Synthetic wrapper for a run of siblings. It exists only in the data model — emitting it
  // would add an element the source never had and shift every :nth-child after it.
  if (node.t === 'underpin-fragment') {
    const kids = emitChildren(node, path, ctx, depth + 1);
    return kids.length ? `${pad}<>\n${kids.join('\n')}\n${pad}</>` : `${pad}<></>`;
  }

  const attrs = emitAttrs(node, path, ctx);
  const oneLine = `${pad}<${node.t}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
  const wrapped = oneLine.length > WRAP_AT && attrs.length > 1;
  // A wrapped open tag ends on its own line, so the `>` or `/>` that closes it sits at the
  // element's own indent — the shape a developer would have typed.
  const open = wrapped
    ? `${pad}<${node.t}\n${attrs.map((a) => `${pad}${' '.repeat(ctx.indent)}${a}`).join('\n')}\n${pad}`
    : oneLine;
  const selfClose = wrapped ? `${open}/>` : `${open} />`;

  const kids = node.c ?? [];
  // A void tag's children are not rendered by the DOM either; dropping them here matches
  // DomTree.jsx:88, which passes no children to createElement for a void tag.
  if (VOID.has(node.t) || kids.length === 0) return selfClose;

  // One text child stays on one line. This is the single biggest readability win in the
  // output — headings and links are most of a page and they read as hand-written.
  if (kids.length === 1 && typeof kids[0] === 'string' && !wrapped) {
    return `${open}>${emitText(kids[0], `${path}.0`, ctx, false).text}</${node.t}>`;
  }

  return `${open}>\n${emitChildren(node, path, ctx, depth + 1).join('\n')}\n${pad}</${node.t}>`;
}

function emitChildren(node, path, ctx, depth) {
  const pad = ' '.repeat(depth * ctx.indent);
  const out = [];
  let prevWasRaw = false;
  (node.c ?? []).forEach((child, i) => {
    const childPath = `${path}.${i}`;
    if (typeof child === 'string') {
      const { text, raw } = emitText(child, childPath, ctx, prevWasRaw);
      out.push(pad + text);
      prevWasRaw = raw;
    } else if (isEl(child)) {
      out.push(emitNode(child, childPath, ctx, depth));
      prevWasRaw = false;
    }
  });
  return out;
}

function newWarnings() {
  return { droppedHandlers: 0, handlers: [], spreadAttributes: 0 };
}

/**
 * Emits one captured node as JSX source.
 *
 * `path` must be the same base the content was hoisted with — hoistContent's paths are
 * what `bind` is keyed by, and a mismatched base silently emits no bindings at all rather
 * than failing.
 */
export function emitJsx(node, { path = 's', bind = new Map(), indent = 2, depth = 0, warnings = newWarnings() } = {}) {
  if (typeof node === 'string') {
    const text = ' '.repeat((depth + 1) * indent) + emitText(node, path, { bind, indent, warnings }, false).text;
    // A section whose whole tree is one text node — a rendered XML feed, say — would emit a
    // bare expression where markup is expected, and nothing downstream could parse it back.
    // A fragment renders no DOM node, so wrapping is free and keeps "a component returns
    // markup" true everywhere.
    if (depth === 0) return `${'<>'}\n${text}\n</>`;
    return text;
  }
  if (!isEl(node)) return '';
  return emitNode(node, path, { bind, indent, warnings }, depth);
}

/* ------------------------------------------------------------- content module */

/** Semantic name for a hoisted text node, keyed by the tag that contains it. */
const TEXT_IDENT = {
  h1: 'heading', h2: 'subheading', h3: 'subheading', h4: 'subheading',
  h5: 'subheading', h6: 'subheading',
  p: 'body', li: 'body', span: 'body', div: 'body', blockquote: 'body',
  a: 'linkLabel', button: 'linkLabel'
};

/** Semantic name for a hoisted attribute, keyed by `<tag>@<attr>`. */
const MEDIA_IDENT = {
  'img@src': 'imageSrc', 'img@alt': 'imageAlt', 'img@srcset': 'imageSrcSet',
  'a@href': 'linkHref', 'video@src': 'videoSrc', 'video@poster': 'videoPoster',
  'source@src': 'sourceSrc', 'source@srcset': 'sourceSrcSet'
};

/**
 * Assigns a content identifier to every hoisted value, in document order.
 *
 * Semantic names (`heading`, `imageSrc`) rather than path dumps (`s_3_1_src`) — the content
 * module is the file a non-developer opens. Collisions take numeric suffixes in document
 * order, so the third heading is `heading3` on every run and the migration stays diffable.
 *
 * Media attributes are decided by membership in the hoist map, never a local copy of
 * MEDIA_ATTRS: there are already two copies of that table and a third would drift.
 */
function bindIdentifiers(tree, base, content) {
  const text = content?.text ?? {};
  const media = content?.media ?? {};
  const bind = new Map();
  const identifiers = {};
  const used = new Map();

  const take = (stem) => {
    const n = (used.get(stem) ?? 0) + 1;
    used.set(stem, n);
    return n === 1 ? stem : `${stem}${n}`;
  };

  const walk = (node, path) => {
    if (!isEl(node)) return;
    for (const attr of Object.keys(node.a ?? {})) {
      const key = `${path}@${attr}`;
      if (!(key in media)) continue;
      const id = take(MEDIA_IDENT[`${node.t}@${attr}`] ?? 'media');
      bind.set(key, id);
      identifiers[id] = media[key];
    }
    (node.c ?? []).forEach((child, i) => {
      const childPath = `${path}.${i}`;
      if (typeof child === 'string') {
        if (!(childPath in text)) return;
        const id = take(TEXT_IDENT[node.t] ?? 'text');
        bind.set(childPath, id);
        identifiers[id] = text[childPath];
      } else {
        walk(child, childPath);
      }
    });
  };

  walk(tree, base);
  return { bind, identifiers };
}

/**
 * The hoist base used for this part. componentizePage uses `s.id`, but a caller can hoist
 * with anything, so read it back off the keys — guessing wrong emits a component with no
 * bindings and no error at all.
 */
function hoistBase(part) {
  const key = Object.keys(part.content?.text ?? {})[0] ?? Object.keys(part.content?.media ?? {})[0];
  return key ? key.split(/[.@]/)[0] : (part.id ?? 's');
}

function contentModuleSource(name, identifiers) {
  const entries = Object.entries(identifiers);
  const body = entries.length
    ? `{\n${entries.map(([k, v]) => `  ${JS_IDENT.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`
    : '{}';

  return `/**
 * Content for ${name}.
 *
 * These values are safe to edit — they are the words and media of the section, and nothing
 * here affects its markup. The markup is real JSX in ./${name}.jsx.
 *
 * Renaming a key means renaming it in the JSX too: the two files are matched by name, not
 * by position, so a rename on one side leaves \`undefined\` on the other.
 */
const content = ${body};

export default content;
`;
}

/**
 * Emits the source of one section component and its content module.
 *
 * `part` is one element of componentizePage()'s output. `key` is the page the section
 * belongs to and is used only for the path in the docblock — the content import is a
 * sibling either way.
 */
export function emitSectionModule(part, { key = '', chrome = false, indent = 2 } = {}) {
  const name = part.name;
  const base = hoistBase(part);
  const { bind, identifiers } = bindIdentifiers(part.tree, base, part.content);
  const warnings = newWarnings();

  // `null` rather than nothing: a section that decomposed to no element still has to be
  // importable, or page.jsx breaks on a missing file. A section whose whole tree is one
  // text node — a browser-rendered XML feed — cannot be emitted as bare markup, and a
  // fragment renders no DOM node, so wrapping costs nothing.
  const tree = typeof part.tree === 'string' ? { t: 'underpin-fragment', a: {}, c: [part.tree] } : part.tree;
  const markup = emitJsx(tree, { path: base, bind, indent, depth: 2, warnings }) || '    null';

  const counts = {
    text: Object.keys(part.content?.text ?? {}).length,
    media: Object.keys(part.content?.media ?? {}).length
  };

  const where = key ? `components/pages/${key}/${name}.jsx` : `${name}.jsx`;
  const notes = [
    ` * Markup is real JSX — edit it directly. Text and media live in the content module`,
    ` * beside it (${counts.text} text, ${counts.media} media).`
  ];
  if (chrome) {
    notes.push(' *');
    notes.push(' * This section is page chrome: it renders on every page of the site, so an edit here');
    notes.push(' * is a site-wide edit.');
  }
  if (warnings.droppedHandlers) {
    // Reported here, not beside the element: JSX children have no line-comment syntax
    // (`// note` there is a text node) and block comments are barred by the rule above.
    // One list at the top is also the form a developer can act on.
    notes.push(' *');
    notes.push(` * ${warnings.droppedHandlers} inline handler${warnings.droppedHandlers === 1 ? '' : 's'} from the source page ${warnings.droppedHandlers === 1 ? 'was' : 'were'} dropped; React cannot take a`);
    notes.push(' * string handler and the original targets do not exist here. Re-add as real props:');
    for (const h of warnings.handlers) notes.push(` *   ${h.path}  <${h.tag} ${h.attr}>`);
  }

  const jsx = `${bind.size ? `import content from './${name}.content.js';\n\n` : ''}/**
 * ${name}
 *
${notes.join('\n')}
 *
 * A Server Component by design — no client directive at the top. This is markup with no
 * hooks, no state and no event handlers, so a client boundary here would ship JavaScript
 * for nothing. The source site's own interactivity is replayed by SiteScripts on the route,
 * which is where that boundary belongs.
 *
 * Generated from a captured page into ${where}.
 */
export default function ${name}() {
  return (
${markup}
  );
}
`;

  return { jsx, content: contentModuleSource(name, identifiers), bindings: bind, identifiers, warnings };
}

/* --------------------------------------------------------------------- parse */

/**
 * Re-parses emitted JSX back into a {t,a,c} tree.
 *
 * Not react-dom/server: the importer is plain ESM with no build step and neither react nor
 * jsdom installed, so proving the output correct would mean bolting a JSX toolchain onto
 * the tool whose whole pitch is not needing one. The independent backstop is the Playwright
 * node-count and text-coverage score against the real built page.
 *
 * A hand-written forward scanner over exactly the grammar this module emits:
 *
 *   Fragment := '<>' Child* '</>'
 *   Element  := '<' Tag Attr* ('/>' | '>' Child* '</' Tag '>')
 *   Attr     := Name '=' ('"' chars '"' | '{' Expr '}') | '{...' ObjectLiteral '}'
 *   Expr     := 'true' | 'false' | StringLiteral | 'content.' Ident | ObjectLiteral
 *   Child    := Element | Fragment | '{' StringLiteral '}' | '{' 'content.' Ident '}' | RawText
 *
 * It throws on anything else, on purpose. A parse failure IS a parity failure — the
 * generated file would not have compiled — so checkParity catches it rather than letting
 * the scanner be lenient and report a false pass.
 */
export function parseEmittedJsx(source, { content = {} } = {}) {
  const src = String(source ?? '');
  let i = 0;

  const fail = (msg) => {
    const line = src.slice(0, i).split('\n').length;
    throw new Error(`${msg} at line ${line} (offset ${i}): ${JSON.stringify(src.slice(i, i + 40))}`);
  };

  // A whole generated module or a bare markup fragment. The module has exactly one
  // `return (`, and it always precedes the markup, so the first match is the right one.
  const ret = /\breturn\s*\(/.exec(src);
  if (ret) i = ret.index + ret[0].length;

  const ws = () => { while (i < src.length && /\s/.test(src[i])) i += 1; };
  const eat = (lit) => { if (!src.startsWith(lit, i)) return false; i += lit.length; return true; };

  const readName = (re) => {
    const m = re.exec(src.slice(i));
    if (!m) fail('expected a name');
    i += m[0].length;
    return m[0];
  };

  /**
   * A plain quoted JSX attribute, read verbatim. JSX attribute values are not JS string
   * literals — the backslash in `pattern="\d"` is literal, as in HTML. Reading them through
   * the JS string reader ate it, so every `<input pattern>` failed parity and fell back to
   * the runtime renderer. On elementor.com that was the only fallback in 1,044 sections.
   */
  const readAttrLiteral = () => {
    const quote = src[i];
    if (quote !== '"' && quote !== "'") fail('expected a quoted attribute value');
    const end = src.indexOf(quote, i + 1);
    if (end < 0) fail('unterminated attribute value');
    const raw = src.slice(i + 1, end);
    i = end + 1;
    // The emitter only ever writes `&quot;` into this position, and only for a `"` it
    // could not otherwise represent; JSX decodes it back on the way in.
    return raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  };

  const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
  const readString = () => {
    const quote = src[i];
    if (quote !== '"' && quote !== "'") fail('expected a string literal');
    i += 1;
    let out = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        const esc = src[i + 1];
        i += 2;
        if (esc === 'u') {
          if (src[i] === '{') {
            const end = src.indexOf('}', i);
            if (end < 0) fail('unterminated \\u{…} escape');
            out += String.fromCodePoint(parseInt(src.slice(i + 1, end), 16));
            i = end + 1;
          } else {
            out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16));
            i += 4;
          }
        } else if (esc === 'x') {
          out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16));
          i += 2;
        } else {
          out += ESCAPES[esc] ?? esc;
        }
        continue;
      }
      if (ch === quote) { i += 1; return out; }
      if (ch === '\n') fail('newline inside a string literal');
      out += ch;
      i += 1;
    }
    return fail('unterminated string literal');
  };

  /** `{ a: "1", "--b": "2" }` → ordered [key, value] pairs. Values are only ever strings here. */
  const readObject = () => {
    if (!eat('{')) fail('expected {');
    const pairs = [];
    ws();
    if (eat('}')) return pairs;
    for (;;) {
      ws();
      const key = src[i] === '"' || src[i] === "'" ? readString() : readName(/^[A-Za-z_$][A-Za-z0-9_$]*/);
      ws();
      if (!eat(':')) fail('expected : in an object literal');
      ws();
      if (src[i] !== '"' && src[i] !== "'") fail('object literal values must be string literals');
      pairs.push([key, readString()]);
      ws();
      if (eat(',')) { ws(); if (eat('}')) return pairs; continue; }
      if (eat('}')) return pairs;
      fail('expected , or } in an object literal');
    }
  };

  const readBinding = () => {
    i += 'content.'.length;
    const id = readName(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    // An identifier the content module does not define renders as `undefined` in the real
    // app. Treating it as a hard failure is the point of the gate.
    if (!(id in content)) fail(`content.${id} is not defined in the content module`);
    return content[id];
  };

  /** The `{ … }` after `=` on an attribute. */
  const readAttrExpr = () => {
    if (!eat('{')) fail('expected {');
    ws();
    let value;
    if (src.startsWith('true', i)) { i += 4; value = true; }
    else if (src.startsWith('false', i)) { i += 5; value = false; }
    else if (src.startsWith('content.', i)) value = readBinding();
    else if (src[i] === '"' || src[i] === "'") value = readString();
    else if (src[i] === '{') value = readObject();
    else fail('unsupported attribute expression');
    ws();
    if (!eat('}')) fail('expected } closing an attribute expression');
    return value;
  };

  const readAttrs = () => {
    const a = {};
    for (;;) {
      ws();
      if (src.startsWith('/>', i) || src[i] === '>') return a;
      if (src.startsWith('{...', i)) {
        i += 4;
        ws();
        for (const [k, v] of readObject()) a[k] = v;
        ws();
        if (!eat('}')) fail('expected } closing a spread');
        continue;
      }
      const name = readName(/^[A-Za-z_$][A-Za-z0-9_$-]*/);
      ws();
      if (!eat('=')) fail(`attribute ${name} has no value; this emitter always writes one`);
      ws();
      a[name] = src[i] === '{' ? readAttrExpr() : readAttrLiteral();
    }
  };

  /**
   * JSX text semantics, which are not HTML's: tabs become spaces, leading and trailing
   * whitespace goes from any line touching a newline, whitespace-only lines vanish, and the
   * rest joins with single spaces. Babel's cleanJSXElementLiteralChild — and the reason the
   * emitter is so careful about what it writes raw.
   */
  const cleanText = (raw) => {
    const lines = raw.split(/\r\n|\n|\r/);
    let lastNonEmpty = 0;
    for (let n = 0; n < lines.length; n += 1) if (/[^ \t]/.test(lines[n])) lastNonEmpty = n;
    let out = '';
    for (let n = 0; n < lines.length; n += 1) {
      let line = lines[n].replace(/\t/g, ' ');
      if (n !== 0) line = line.replace(/^ +/, '');
      if (n !== lines.length - 1) line = line.replace(/ +$/, '');
      if (!line) continue;
      out += n === lastNonEmpty ? line : `${line} `;
    }
    return out;
  };

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const decode = (s) =>
    s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[body.toLowerCase()] ?? whole;
    });

  const readChildren = (closer) => {
    const kids = [];
    for (;;) {
      if (i >= src.length) fail(`unexpected end of source; expected ${closer}`);
      if (src.startsWith('</', i)) {
        if (!src.startsWith(closer, i)) fail(`expected ${closer}`);
        i += closer.length;
        return kids;
      }
      if (src[i] === '<') { kids.push(readNode()); continue; }
      if (src[i] === '{') {
        i += 1;
        ws();
        let value;
        if (src.startsWith('content.', i)) value = readBinding();
        else if (src[i] === '"' || src[i] === "'") value = readString();
        else fail('a child expression must be a string literal or a content binding');
        ws();
        if (!eat('}')) fail('expected } closing a child expression');
        kids.push(value);
        continue;
      }
      const start = i;
      while (i < src.length && src[i] !== '<' && src[i] !== '{') i += 1;
      if (i === start) fail('made no progress reading text');
      const text = cleanText(src.slice(start, i));
      if (text) kids.push(decode(text));
    }
  };

  function readNode() {
    if (!eat('<')) fail('expected <');
    if (eat('>')) return { t: 'underpin-fragment', a: {}, c: readChildren('</>') };

    const tag = readName(/^[A-Za-z][A-Za-z0-9-]*/);
    const a = readAttrs();
    if (eat('/>')) return { t: tag, a, c: [] };
    if (!eat('>')) fail(`expected > or /> closing <${tag}`);
    return { t: tag, a, c: readChildren(`</${tag}>`) };
  }

  ws();
  if (src[i] !== '<') fail('expected the markup to start with <');
  const tree = readNode();
  ws();
  return tree;
}

/* -------------------------------------------------------------------- parity */

/**
 * Reduces an attribute map to the props React would actually see. Both sides of a parity
 * check go through it: the question is whether React gets the same props, not whether the
 * strings match — `class="a"` and `className="a"` are the same page. Order mirrors
 * DomTree.jsx's toProps exactly (style, handler drop, booleans) so the two cannot disagree.
 */
export function normalizeAttrs(attrs = {}) {
  const out = {};
  for (const [rawName, rawValue] of Object.entries(attrs)) {
    const name = renameAttr(rawName);

    if (name === 'style') {
      // Ordered pairs, not an object: duplicate CSS declarations are order-sensitive, and
      // deepEqual on objects does not compare key order. An empty style is dropped rather
      // than kept as {} — the emitter omits the prop, and React renders neither.
      const pairs = Array.isArray(rawValue)
        ? rawValue.map(([k, v]) => [k, String(v)])
        : Object.entries(styleToObject(rawValue));
      if (pairs.length) out.style = pairs;
      continue;
    }

    if (/^on[a-z]/i.test(name)) continue;

    if (BOOLEAN.has(name)) {
      out[name] = typeof rawValue === 'boolean' ? rawValue : rawValue !== 'false';
      continue;
    }

    out[name] = typeof rawValue === 'number' ? String(rawValue) : rawValue;
  }
  return out;
}

const trunc = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

function diff(expected, actual, path) {
  const expectedIsText = typeof expected === 'string';
  const actualIsText = typeof actual === 'string';
  if (expectedIsText || actualIsText) {
    // Text compares verbatim. Trimming here would hide exactly the whitespace bug this
    // module exists to prevent.
    if (expected !== actual) {
      return { at: path, expected: trunc(expected), actual: trunc(actual), reason: 'text differs' };
    }
    return null;
  }

  if (!isEl(expected) || !isEl(actual)) {
    return { at: path, expected: trunc(expected), actual: trunc(actual), reason: 'node is missing' };
  }
  if (expected.t !== actual.t) {
    return { at: path, expected: trunc(expected.t), actual: trunc(actual.t), reason: 'tag differs' };
  }

  const ea = normalizeAttrs(expected.a);
  const aa = normalizeAttrs(actual.a);
  for (const name of [...new Set([...Object.keys(ea), ...Object.keys(aa)])].sort()) {
    const ev = ea[name];
    const av = aa[name];
    const same = name === 'style'
      ? JSON.stringify(ev ?? null) === JSON.stringify(av ?? null)
      : ev === av;
    if (!same) {
      return { at: `${path}@${name}`, expected: trunc(ev), actual: trunc(av), reason: `attribute ${name} differs` };
    }
  }

  const ec = expected.c ?? [];
  const ac = actual.c ?? [];
  if (ec.length !== ac.length) {
    return { at: path, expected: trunc(`${ec.length} children`), actual: trunc(`${ac.length} children`), reason: 'child count differs' };
  }
  for (let n = 0; n < ec.length; n += 1) {
    const d = diff(ec[n], ac[n], `${path}.${n}`);
    if (d) return d;
  }
  return null;
}

/**
 * The gate: does the emitted source parse back into the tree it came from? Never throws —
 * a scanner failure is a parity failure, and a gate that throws is one the caller wraps in
 * its own try/catch.
 */
export function checkParity(expectedTree, jsxSource, contentObject = {}, { path = 's' } = {}) {
  let actual;
  try {
    actual = parseEmittedJsx(jsxSource, { content: contentObject });
  } catch (err) {
    return { ok: false, at: path, expected: trunc(expectedTree?.t ?? expectedTree), actual: null, reason: `emitted source did not parse: ${err.message}` };
  }

  // A fragment root is a wrapper that never reaches the DOM, so compare what it holds. It
  // can appear on either side: on the expected side for a coalesced run of siblings, and on
  // the actual side when a bare text root was wrapped so it could be emitted as markup.
  const unwrap = (n) => (n?.t === 'underpin-fragment' && (n.c ?? []).length === 1 ? n.c[0] : n);
  let expected = expectedTree;
  if (expectedTree?.t === 'underpin-fragment' && actual?.t === 'underpin-fragment') {
    expected = { t: 'underpin-fragment', a: {}, c: expectedTree.c ?? [] };
  } else if (actual?.t === 'underpin-fragment' && expectedTree?.t !== 'underpin-fragment') {
    actual = unwrap(actual);
  }

  const d = diff(expected, actual, path);
  return d ? { ok: false, ...d } : { ok: true };
}
