/**
 * HTML → React attribute tables, in plain JS so both consumers can share one copy.
 *
 * They used to live in DomTree.jsx, which bare `node` cannot load
 * (ERR_UNKNOWN_FILE_EXTENSION), so generate/jsx-emit.js could not import them. Retyping
 * them would let the runtime renderer and the generated JSX drift on one attribute with
 * nothing failing loudly. A pure move — no value or order changed.
 */

export const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

/** Attributes React spells differently from HTML. */
export const RENAME = {
  class: 'className', for: 'htmlFor', srcset: 'srcSet', novalidate: 'noValidate',
  autocomplete: 'autoComplete', autofocus: 'autoFocus', tabindex: 'tabIndex',
  readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength',
  colspan: 'colSpan', rowspan: 'rowSpan', usemap: 'useMap', datetime: 'dateTime',
  enctype: 'encType', formaction: 'formAction', crossorigin: 'crossOrigin',
  referrerpolicy: 'referrerPolicy', playsinline: 'playsInline', frameborder: 'frameBorder',
  allowfullscreen: 'allowFullScreen', contenteditable: 'contentEditable',
  spellcheck: 'spellCheck', accesskey: 'accessKey', inputmode: 'inputMode'
};

export const BOOLEAN = new Set([
  'disabled','checked','selected','readOnly','required','autoFocus','multiple','muted',
  'controls','loop','autoPlay','open','hidden','noValidate','playsInline','allowFullScreen'
]);

/** Inline `style` arrives as a CSS string; React wants an object. */
export function styleToObject(css) {
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
