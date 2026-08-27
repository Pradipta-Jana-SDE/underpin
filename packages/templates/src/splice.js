/**
 * Puts hoisted content back into a captured section tree.
 *
 * Lives here rather than in the importer because generated sites import it at runtime:
 * each section component holds its structure in one JSON file and its editable text and
 * media in another, and this is what rejoins them. Keeping a second copy in the importer
 * would let the two drift, and a drift here silently changes the rendered DOM.
 */
const MEDIA_ATTRS = {
  img: ['src', 'srcset', 'alt'],
  a: ['href'],
  video: ['src', 'poster'],
  source: ['src', 'srcset']
};

const isEl = (n) => n && typeof n === 'object' && typeof n.t === 'string';

export function spliceContent(tree, content, base = 's') {
  const { text = {}, media = {} } = content ?? {};

  const walk = (node, path) => {
    if (!isEl(node)) return node;

    const attrs = MEDIA_ATTRS[node.t];
    const a = { ...node.a };
    if (attrs) {
      for (const name of attrs) {
        const key = `${path}@${name}`;
        if (key in media) a[name] = media[key];
      }
    }

    if (node.c === undefined) return { ...node, a };

    const c = node.c.map((child, i) => {
      const childPath = `${path}.${i}`;
      if (typeof child === 'string') return childPath in text ? text[childPath] : child;
      return walk(child, childPath);
    });

    return { ...node, a, c };
  };

  return walk(tree, base);
}

export default spliceContent;
