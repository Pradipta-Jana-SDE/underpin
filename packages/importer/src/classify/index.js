import { PAGE_TYPE_IDS, SLUG_TOKENS, JSONLD_TYPES } from './taxonomy.js';

/**
 * Classification runs as a cost ladder, not a model.
 *
 * Stage 0 is deterministic and free and needs no REST API — WordPress bakes its own
 * body classes into rendered HTML, so `.error404` and `.home` survive a security plugin
 * blocking /wp-json entirely. Stage 1 is weighted rules. Anything still ambiguous is
 * handed to the model when one is configured, and to a human when one is not.
 *
 * Determinism matters more than cost here: a client re-auditing the same forty service
 * pages expects the same answer twice.
 */

const ACCEPT_RULE = 0.85;
const MIN_MARGIN = 0.15;

/** Stage 0 — deterministic. Returns a type or null. */
export function stage0(page, ctx) {
  const bc = ctx.bodyClass ?? '';
  if (/\berror404\b/.test(bc)) return { type: 'not_found', confidence: 1, why: ['body class .error404'] };
  if (/\bhome\b/.test(bc) && /\b(page|blog)\b/.test(bc)) return { type: 'home', confidence: 1, why: ['body class .home'] };
  if (page.path === '/' || page.path === '') return { type: 'home', confidence: 1, why: ['root path'] };
  if (/\bsearch(-results|-no-results)\b/.test(bc)) return { type: 'archive', confidence: 1, why: ['body class .search'] };
  if (/\b(archive|category|tag|date|author)\b/.test(bc) && !/\bsingle\b/.test(bc)) {
    return { type: 'archive', confidence: 0.95, why: ['body class .archive'] };
  }
  if (/\bsingle-post\b/.test(bc)) return { type: 'blog_post', confidence: 0.95, why: ['body class .single-post'] };
  if (/\bsingle-product\b/.test(bc) || /\bproduct-template\b/.test(bc)) {
    return { type: 'product', confidence: 0.95, why: ['body class .single-product'] };
  }
  return null;
}

/** Stage 1 — weighted rules over independent signal families. */
export function stage1(page, ctx) {
  const scores = Object.fromEntries(PAGE_TYPE_IDS.map((t) => [t, 0]));
  const why = Object.fromEntries(PAGE_TYPE_IDS.map((t) => [t, []]));
  const add = (type, n, reason) => {
    if (scores[type] === undefined) return;
    scores[type] += n;
    why[type].push(reason);
  };

  const path = page.path.toLowerCase();
  const slug = (page.slug ?? '').toLowerCase();
  const h1 = String(page.sections?.[0]?.slots?.title ?? page.sections?.[0]?.slots?.heading ?? '').toLowerCase();
  const title = (page.seo?.title ?? '').toLowerCase();
  const segs = path.split('/').filter(Boolean);

  // --- URL and slug tokens
  // A one-segment path whose whole name IS the token ("/about-us/") is about as
  // certain as this gets without structured data; a token buried deeper is weaker.
  const isIndexPath = segs.length === 1;
  for (const [type, patterns] of Object.entries(SLUG_TOKENS)) {
    // `service` is handled below, because /services/ and /services/x/ mean different things.
    if (type === 'service' && /^(services|solutions|treatments)$/.test(segs[0] ?? '')) continue;
    for (const re of patterns) {
      if (re.test(path)) {
        add(type, isIndexPath ? 0.8 : 0.5, `path matches ${re}`);
        break;
      }
      if (re.test(slug)) { add(type, 0.4, `slug matches ${re}`); break; }
    }
  }

  // A single segment that names a section is the index; deeper is a child of it.
  if (segs.length === 1 && /^(services|solutions|treatments)$/.test(segs[0])) add('service_index', 0.85, 'single-segment services path');
  if (segs.length >= 2 && /^(services|solutions|treatments)$/.test(segs[0])) add('service', 0.85, `child of /${segs[0]}/`);
  if (segs.length >= 2 && /^(locations|branches|stores)$/.test(segs[0])) add('location', 0.5, `child of /${segs[0]}/`);
  if (segs.length >= 2 && /^(blog|news|articles|insights)$/.test(segs[0])) add('blog_post', 0.45, `child of /${segs[0]}/`);
  if (segs.length >= 2 && /^(portfolio|projects|work|case-studies)$/.test(segs[0])) add('case_study', 0.4, `child of /${segs[0]}/`);
  // Dated permalinks are the classic WordPress post shape.
  if (/\/\d{4}\/\d{2}\//.test(path)) add('blog_post', 0.5, 'dated permalink');

  // --- Headline text
  for (const [type, patterns] of Object.entries(SLUG_TOKENS)) {
    for (const re of patterns) {
      const plain = new RegExp(re.source.replace(/-/g, '[ -]'), 'i');
      if (h1 && plain.test(h1)) { add(type, 0.3, `h1 mentions ${re.source}`); break; }
      if (title && plain.test(title)) { add(type, 0.15, `title mentions ${re.source}`); break; }
    }
  }

  // --- JSON-LD: high precision, low recall
  const schema = page.seo?.schemaTypes ?? [];
  for (const [type, types] of Object.entries(JSONLD_TYPES)) {
    const hit = types.filter((t) => schema.includes(t));
    if (hit.length) add(type, 0.55, `JSON-LD ${hit.join(', ')}`);
  }

  // --- Structural evidence from the extracted sections
  const arche = (page.sections ?? []).map((s) => s.archetype);
  const has = (a) => arche.includes(a);
  const count = (a) => arche.filter((x) => x === a).length;

  if (has('form') || has('contact_panel')) add('contact', 0.35, 'form or contact panel present');
  if (has('contact_panel') && (page.sections ?? []).some((s) => s.slots?.map)) add('location', 0.3, 'map embed present');
  if (count('faq') >= 1) add('faq', 0.4, 'FAQ section present');
  if (has('pricing_table')) add('pricing', 0.45, 'pricing table present');
  if (has('team_grid')) add('team', 0.45, 'team grid present');
  if (count('testimonial') >= 2) add('testimonials', 0.3, 'multiple testimonial sections');
  if (has('content_list') && segs.length <= 1) add('blog_index', 0.3, 'content list at top level');
  if (has('product_card_grid')) add('product_index', 0.4, 'product grid present');
  if (has('logo_wall') && has('hero') && segs.length === 0) add('home', 0.3, 'homepage shape');

  // Legal pages are unusually text-dense and link-poor.
  const textOnly = arche.length > 0 && arche.every((a) => a === 'rich_text');
  if (textOnly && (page.links?.internal?.length ?? 0) < 8) add('legal', 0.2, 'dense unstyled text, few links');

  // A page absent from the primary navigation with a single CTA is a campaign landing page.
  if (ctx.navPaths && !ctx.navPaths.has(page.path) && count('cta_band') >= 1 && arche.length <= 4) {
    add('landing', 0.25, 'not in nav, single CTA');
  }

  const ranked = Object.entries(scores)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!ranked.length) return { type: 'generic', confidence: 0.2, why: ['no signal matched'], ranked: [] };

  const [topType, topScore] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  const confidence = Math.min(0.95, topScore);
  const margin = topScore - second;

  return {
    type: topType,
    confidence: Number(confidence.toFixed(2)),
    margin: Number(margin.toFixed(2)),
    why: why[topType].slice(0, 4),
    ranked: ranked.slice(0, 4).map(([t, v]) => ({ type: t, score: Number(v.toFixed(2)) }))
  };
}

/**
 * Classifies one page through the ladder.
 * `llm` is optional — without it, low-confidence pages route to the human queue rather
 * than being guessed at.
 */
export async function classifyPage(page, ctx = {}, llm = null) {
  const s0 = stage0(page, ctx);
  if (s0) return { ...s0, decidedBy: 'rule', stage: 0, ranked: [] };

  const s1 = stage1(page, ctx);
  if (s1.confidence >= ACCEPT_RULE && (s1.margin ?? 1) >= MIN_MARGIN) {
    return { ...s1, decidedBy: 'rule', stage: 1 };
  }

  if (llm?.available) {
    const out = await llm.classifyPage(page, s1.ranked);
    if (out && out.confidence >= 0.9) {
      return { type: out.type, confidence: out.confidence, why: [out.rationale], decidedBy: 'llm', stage: 2, ranked: s1.ranked };
    }
  }

  // Below the bar: keep the best guess but mark it for a human. Never silently trust it.
  return { ...s1, decidedBy: 'rule', stage: 3, needsReview: true };
}

export async function classifyAll(pages, ctx = {}, llm = null) {
  const navPaths = new Set((ctx.nav ?? []).map((n) => { try { return new URL(n.href).pathname; } catch { return n.href; } }));
  const out = [];
  for (const page of pages) {
    const r = await classifyPage(page, { ...ctx, navPaths, bodyClass: ctx.bodyClasses?.[page.url] ?? '' }, llm);
    out.push({ url: page.url, path: page.path, ...r });
  }
  return out;
}

/**
 * Classifies a URL without fetching it.
 *
 * The page picker has to group thousands of URLs before anything is extracted — the
 * whole point of choosing pages is to avoid crawling the ones nobody wants. Path shape
 * and slug tokens carry most of the signal for that, and being wrong here is cheap: the
 * operator sees the grouping and corrects it by ticking a box.
 */
export function classifyUrlOnly(url, ctx = {}) {
  let path;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return { type: 'generic', confidence: 0, section: null };
  }

  const segs = path.split('/').filter(Boolean);
  const slug = segs[segs.length - 1] ?? '';
  const first = segs[0] ?? '';

  if (segs.length === 0) return { type: 'home', confidence: 1, section: null, why: 'root path' };

  // Structure beats keywords. A post at /blog/constant-contact-vs-mailchimp/ is a blog
  // post, not a contact page — but slug-token matching happily calls it one, and on a
  // 3,000-URL site that scatters the entire blog across every other group. Where the URL
  // states its section, that is the answer and slug tokens do not get a vote.
  const SECTION = {
    blog: 'blog_post', news: 'blog_post', articles: 'blog_post',
    insights: 'blog_post', resources: 'blog_post', post: 'blog_post',
    services: 'service', solutions: 'service', treatments: 'service',
    locations: 'location', branches: 'location', stores: 'location',
    products: 'product', product: 'product', shop: 'product',
    portfolio: 'case_study', 'case-studies': 'case_study', work: 'case_study',
    team: 'team', careers: 'careers', jobs: 'careers'
  };
  if (segs.length >= 2 && SECTION[first]) {
    return { type: SECTION[first], confidence: 0.85, section: `/${first}/`, why: `under /${first}/` };
  }
  if (segs.length === 1 && SECTION[first]) {
    const idx = { service: 'service_index', product: 'product_index', blog_post: 'blog_index' };
    return { type: idx[SECTION[first]] ?? SECTION[first], confidence: 0.85, section: null, why: `section index /${first}/` };
  }

  const stub = { path, slug, seo: { title: '', schemaTypes: [] }, sections: [], links: { internal: [] } };
  const r = stage1(stub, ctx);

  if (/\/\d{4}\/\d{2}\//.test(path)) {
    return { type: 'blog_post', confidence: 0.6, section: null, why: 'dated permalink' };
  }
  // A single-segment path naming itself is trustworthy; anything deeper without a known
  // section is grouped by its own prefix instead of guessed at.
  if (r.confidence >= 0.6 && segs.length === 1) return { ...r, section: null };
  if (segs.length >= 2) {
    return { type: 'generic', confidence: 0.2, section: `/${first}/`, why: `grouped by /${first}/` };
  }
  return r.confidence >= 0.5 ? { ...r, section: null } : { type: 'generic', confidence: r.confidence, section: null, why: 'no strong URL signal' };
}

/** Groups a URL inventory by page type, ready for the picker. */
export function groupUrlsByType(urls, ctx = {}) {
  const groups = new Map();
  for (const url of urls) {
    const { type, confidence, section } = classifyUrlOnly(url, ctx);
    // An unrecognised but repeated URL section is a more honest grouping than calling
    // three hundred pages "generic" — the operator can see what they are.
    const key = type === 'generic' && section ? `section${section}` : type;
    if (!groups.has(key)) groups.set(key, []);
    let path = url;
    try { path = new URL(url).pathname; } catch {}
    groups.get(key).push({ url, path, confidence });
  }

  // Present the types a migration actually cares about first; the long tail after.
  const PRIORITY = ['home', 'service_index', 'service', 'about', 'location', 'contact',
                    'team', 'pricing', 'faq', 'testimonials', 'gallery', 'case_study',
                    'careers', 'blog_index', 'blog_post', 'product_index', 'product',
                    'legal', 'archive', 'landing', 'generic'];

  return [...groups.entries()]
    .map(([type, pages]) => ({
      type,
      count: pages.length,
      pages: pages.sort((a, b) => a.path.localeCompare(b.path))
    }))
    .sort((a, b) => {
      const ai = PRIORITY.indexOf(a.type);
      const bi = PRIORITY.indexOf(b.type);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
}
