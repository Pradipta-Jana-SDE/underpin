import { BUILDER_MAPS, widgetType } from './builder-map.js';
import { extractMedia } from './media.js';
import { extractForms } from './forms.js';

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Chrome that is never page content, regardless of theme. */
const CHROME = 'header, footer, nav, aside, script, style, noscript, .screen-reader-text, ' +
  '#wpadminbar, .skip-link, .cookie-banner, .cookie-notice, #cookie-law-info-bar, .breadcrumb';

function contentRoot($, shell) {
  const candidates = [
    shell?.mainSelector,
    'main', '#main', '[role="main"]', '.site-main', '#content', '.entry-content', 'article'
  ].filter(Boolean);
  for (const sel of candidates) {
    const $el = $(sel).first();
    if ($el.length && clean($el.text()).length > 120) return $el;
  }
  return $('body');
}

/**
 * Finds section boundaries. Builder classes first (rung C-prime), then structural
 * grouping, then heading-splitting as the true fallback for bespoke themes.
 */
/** Class fragments that mark an element as a component rather than a layout wrapper. */
const COMPONENTISH = /swiper|slick|owl|carousel|splide|flickity|slider|accordion|tabs|gallery|testimonial|marquee/i;

/**
 * Descends through pure wrapper elements.
 *
 * Themes nest content several divs deep, so `root.children()` often returns a single
 * layout wrapper rather than the page's real sections. Without this, a ten-section page
 * collapses to one or two blobs and template matching downstream has nothing to work
 * with — measured on a Gutenberg site that reported two sections per page.
 */
function unwrap($, $root) {
  let $cur = $root;
  for (let depth = 0; depth < 6; depth++) {
    const $kids = $cur.children();
    if ($kids.length !== 1) break;
    const $only = $kids.first();
    const outer = clean($cur.text()).length;
    const inner = clean($only.text()).length;
    // Only descend when the child really is the whole content, not a sibling of it.
    if (inner < outer * 0.9 || inner === 0) break;
    // Unwrap LAYOUT wrappers only. Descending into a component discards the very
    // context that identifies it — stepping past a .swiper loses the fact that the
    // content inside it is one visible slide out of many.
    if (COMPONENTISH.test($only.attr('class') ?? '')) break;
    $cur = $only;
  }
  return $cur;
}

function findSections($, $rootIn, builderId) {
  const $root = unwrap($, $rootIn);
  const def = builderId ? BUILDER_MAPS[builderId] : null;
  if (def) {
    const $sections = $root.find(def.sectionSelector).filter((_, el) => {
      // Nested sections are common; keep only the outermost.
      return $(el).parents(def.sectionSelector).length === 0;
    });
    if ($sections.length >= 2) return { nodes: $sections.toArray(), method: 'builder_dom' };
  }

  const $children = $root.children().filter((_, el) => clean($(el).text()).length > 20 || $(el).find('img').length);
  if ($children.length >= 3) return { nodes: $children.toArray(), method: 'structural' };

  // Heading split: group everything under each h2/h3 boundary.
  const groups = [];
  let current = [];
  $root.children().each((_, el) => {
    const $el = $(el);
    const tag = el.tagName?.toLowerCase();
    // A heading, or a block that opens with one, starts a new section.
    const opensSection =
      /^h[123]$/.test(tag ?? '') ||
      /^h[12]$/.test($el.children().first()[0]?.tagName?.toLowerCase() ?? '');
    if (opensSection && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(el);
  });
  if (current.length) groups.push(current);
  return { nodes: groups.length ? groups : [$root.toArray()[0]], method: 'heading_split' };
}


/**
 * The title of a block, when the theme did not use a heading tag.
 *
 * Real sites put card and accordion titles in divs constantly — Elementor's own FAQ
 * page holds every question in `.dsm-faq--title`, so a heading-tag-only lookup returned
 * empty for all seventy and the whole page misclassified. Falling back through title-ish
 * class names and then to the first short text block is builder-agnostic.
 */
function firstTitle($, $sec) {
  const h = clean($sec.find('h1,h2,h3,h4,h5,h6').first().text());
  if (h) return h;

  const $titleish = $sec
    .find('summary, dt, [class*="title"], [class*="heading"], [class*="question"], [class*="label"]')
    .filter((_, el) => {
      const t = clean($(el).text());
      return t.length > 0 && t.length < 200;
    })
    .first();
  if ($titleish.length) return clean($titleish.text());

  // Last resort: the first short standalone text block reads as the title.
  let found = '';
  $sec.find('p, div, span, strong').each((_, el) => {
    if (found) return;
    const $el = $(el);
    if ($el.children().length > 1) return;
    const t = clean($el.text());
    if (t.length > 2 && t.length < 160) found = t;
  });
  return found;
}

/** Coarse widget-type census for a section, using the builder's own conventions. */
function widgetCensus($, $sec, builderId) {
  const census = {};
  if (!builderId || !BUILDER_MAPS[builderId]) return census;
  const def = BUILDER_MAPS[builderId];
  $sec.find(def.widgetSelector).each((_, el) => {
    const t = widgetType(builderId, $(el), $);
    if (t && t !== 'skip') census[t] = (census[t] ?? 0) + 1;
  });
  return census;
}

/**
 * Decides the archetype from evidence, and reports how sure it is.
 *
 * Confidence is not decoration: it routes the page. Builder-derived hints start high
 * because the builder told us what the widget was; pure heuristics start low and land
 * in the human queue rather than being quietly trusted.
 */
function decideArchetype(sig) {
  const c = sig.census;
  const hi = sig.fromBuilder ? 0.82 : 0.62;
  const mid = sig.fromBuilder ? 0.75 : 0.55;

  if (sig.isFirst && sig.h1 && (sig.images >= 1 || sig.bgImage)) {
    return { archetype: 'hero', variant: { media: 'image', layout: sig.images > 1 ? 'full' : 'split' }, confidence: hi };
  }
  if (sig.isFirst && sig.h1) return { archetype: 'hero', variant: { media: 'none', layout: 'minimal' }, confidence: mid };
  if (c.hero) return { archetype: 'hero', variant: { media: 'image', layout: 'full' }, confidence: hi };

  if (c.form || sig.forms > 0) {
    if (c.map || sig.hasMap) return { archetype: 'contact_panel', variant: { layout: 'form_map' }, confidence: hi };
    return { archetype: 'form', variant: { layout: 'panel' }, confidence: hi };
  }
  if (c.map || sig.hasMap) return { archetype: 'contact_panel', variant: { layout: 'map_only' }, confidence: mid };

  if (c.testimonial) {
    return { archetype: 'testimonial', variant: { display: sig.isCarousel ? 'slider' : c.testimonial > 1 ? 'grid' : 'single' }, confidence: hi };
  }
  if (sig.blockquotes >= 1 && sig.textLength < 900) {
    return { archetype: 'testimonial', variant: { display: sig.blockquotes > 1 ? 'grid' : 'single' }, confidence: 0.5 };
  }

  if (c.faq || sig.accordions >= 2) return { archetype: 'faq', variant: { display: 'accordion' }, confidence: hi };
  if (c.pricing) return { archetype: 'pricing_table', variant: { columns: sig.repeatedBlocks || 3 }, confidence: hi };
  if (c.stat >= 2) return { archetype: 'stats_strip', variant: { layout: 'row' }, confidence: hi };
  if (c.team >= 1) return { archetype: 'team_grid', variant: { count: c.team }, confidence: hi };
  if (c.listing) return { archetype: 'content_list', variant: { display: 'grid' }, confidence: hi };

  // Order matters: "many images, almost no text" is a strictly more specific claim than
  // "repeated blocks", so a logo strip must be tested before the feature-grid rule or it
  // is always swallowed by it.
  if (sig.images >= 4 && sig.textLength < 220) {
    return { archetype: 'logo_wall', variant: { display: 'static' }, confidence: 0.6 };
  }

  if (c.feature >= 3 || (sig.repeatedBlocks >= 3 && sig.images >= 3 && sig.textLength < 2000)) {
    return { archetype: 'feature_grid', variant: { count: c.feature || sig.repeatedBlocks, iconStyle: sig.icons.length ? 'icon' : 'image' }, confidence: c.feature >= 3 ? hi : 0.55 };
  }

  if (c.cta && !c.text && sig.textLength < 400) {
    return { archetype: 'cta_band', variant: { media: sig.bgImage ? 'bg_image' : 'none' }, confidence: hi };
  }
  if (sig.links === 1 && sig.textLength < 300 && sig.headings >= 1 && sig.images === 0) {
    return { archetype: 'cta_band', variant: { media: 'none' }, confidence: 0.5 };
  }

  if (c.text_media || (sig.images === 1 && sig.textLength > 150)) {
    return { archetype: 'text_media', variant: { layout: sig.imageFirst ? 'img_left' : 'img_right' }, confidence: c.text_media ? hi : 0.58 };
  }

  return { archetype: 'rich_text', variant: {}, confidence: sig.textLength > 80 ? 0.45 : 0.3 };
}

function fillSlots(archetype, $, $sec, sig) {
  const slots = {};
  const heading = clean($sec.find('h1,h2,h3').first().text());
  if (heading) slots.heading = heading;

  switch (archetype) {
    case 'hero': {
      slots.title = clean($sec.find('h1').first().text()) || heading;
      const sub = clean($sec.find('h2, .elementor-heading-title, p').not('h1').first().text());
      if (sub && sub !== slots.title) slots.subtitle = sub.slice(0, 300);
      slots.cta = sig.ctaLinks.slice(0, 2);
      break;
    }
    case 'text_media':
      slots.body = clean($sec.text()).slice(0, 4000);
      slots.cta = sig.ctaLinks.slice(0, 1);
      break;
    case 'feature_grid':
    case 'team_grid':
    case 'logo_wall':
    case 'content_list':
    case 'product_card_grid':
      slots.items = sig.repeatedItems.slice(0, 24);
      break;
    case 'testimonial':
      slots.items = sig.quotes.slice(0, 20);
      break;
    case 'faq':
      slots.items = sig.qaPairs.slice(0, 40);
      break;
    case 'stats_strip':
      slots.items = sig.stats.slice(0, 12);
      break;
    case 'cta_band':
      slots.heading = heading;
      slots.cta = sig.ctaLinks.slice(0, 2);
      slots.subtext = clean($sec.find('p').first().text()).slice(0, 300);
      break;
    case 'form':
    case 'contact_panel':
      if (sig.formList.length) {
        slots.fields = sig.formList[0].fields;
        slots.submitLabel = sig.formList[0].submitLabel;
        slots.plugin = sig.formList[0].plugin;
      }
      if (sig.mapSrc) slots.map = sig.mapSrc;
      break;
    default:
      slots.body = clean($sec.text()).slice(0, 8000);
  }
  return slots;
}

/** Gathers every signal the archetype decision needs, in one pass over the section. */
function signals($, $sec, baseUrl, builderId, index) {
  const $c = $sec.clone();
  $c.find(CHROME).remove();
  const text = clean($c.text());

  const { media, icons, svgCount } = extractMedia($, $sec, baseUrl);
  const formList = extractForms($, $sec, baseUrl);

  // Read the anchor's own class while we have the element — re-querying by href later
  // needs CSS.escape, which does not exist in Node.
  const links = [];
  $sec.find('a[href]').each((_, el) => {
    const $a = $(el);
    const label = clean($a.text());
    const href = $a.attr('href');
    if (!label || !href || href.startsWith('#')) return;
    const cls = $a.attr('class') ?? '';
    links.push({ label, href, isButton: /\b(btn|button|cta|elementor-button)\b/i.test(cls) });
  });
  // A styled button beats a bare inline link; fall back to short links when nothing is styled.
  const buttons = links.filter((l) => l.isButton);
  const ctaLinks = (buttons.length ? buttons : links.filter((l) => l.label.length < 40)).map(
    ({ label, href }) => ({ label, href })
  );

  const quotes = [];
  const QUOTE_SEL = 'blockquote, .testimonial, [class*="testimonial"]';
  $sec
    .find(QUOTE_SEL)
    .filter((_, el) => $(el).parents(QUOTE_SEL).length === 0)
    .each((_, el) => {
    const q = clean($(el).find('p, .quote, [class*="content"]').first().text() || $(el).text());
    const author = clean($(el).find('cite, .author, [class*="author"], [class*="name"]').first().text());
    if (q) quotes.push({ quote: q.slice(0, 600), author: author || null });
  });

  const qaPairs = [];
  // Outermost matches only. `[class*="faq"]` also matches the item's own title and
  // content children (dsm-faq--title, dsm-faq--faq-content), which made each nested
  // part look like its own Q&A entry.
  const QA_SEL = '[class*="accordion"], [class*="toggle"], [class*="faq"], details';
  $sec
    .find(QA_SEL)
    .filter((_, el) => $(el).parents(QA_SEL).length === 0)
    .each((_, el) => {
    const $item = $(el);
    const q = firstTitle($, $item);
    if (!q) return;
    // Deriving the answer with another selector is a trap: on Elementor's FAQ the title
    // and the body share a `dsm-content-block` class, so `[class*="content"]` matched the
    // question and every answer came out identical to its question. Text-minus-title has
    // no such failure mode and needs no knowledge of the theme.
    const full = clean($item.text());
    const a = clean(full.startsWith(q) ? full.slice(q.length) : full);
    if (a && a !== q) qaPairs.push({ q: q.slice(0, 300), a: a.slice(0, 2000) });
  });

  // When the section IS the Q&A item (a loop-grid renders one entry per container),
  // `.find()` never sees it, because find excludes self. Treat the section itself as
  // the pair in that case.
  if (!qaPairs.length && $sec.is(QA_SEL)) {
    const q = firstTitle($, $sec);
    const full = clean($sec.text());
    const a = clean(full.startsWith(q) ? full.slice(q.length) : '');
    if (q && a) qaPairs.push({ q: q.slice(0, 300), a: a.slice(0, 2000) });
  }

  const stats = [];
  $sec.find('[class*="counter"], [class*="stat"], [class*="number"]').each((_, el) => {
    const value = clean($(el).find('[class*="number"], [class*="value"], .elementor-counter-number').first().text() || $(el).text());
    const label = clean($(el).find('[class*="title"], [class*="label"]').first().text());
    const m = /([\d.,]+\s*[%+kKmM]?)/.exec(value);
    if (m) stats.push({ value: m[1], label: label || '' });
  });

  // Repeated sibling blocks — the structural tell for grids.
  const groups = new Map();
  $sec.find('> * > *, > *').each((_, el) => {
    const sig = (el.tagName ?? '') + '|' + ($(el).attr('class') ?? '').split(/\s+/).slice(0, 2).join('.');
    groups.set(sig, (groups.get(sig) ?? 0) + 1);
  });
  const repeatedBlocks = Math.max(0, ...groups.values());

  const repeatedItems = [];
  const topSig = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topSig && topSig[1] >= 3) {
    $sec.find('> * > *, > *').each((_, el) => {
      const sig2 = (el.tagName ?? '') + '|' + ($(el).attr('class') ?? '').split(/\s+/).slice(0, 2).join('.');
      if (sig2 !== topSig[0]) return;
      const $i = $(el);
      const title = clean($i.find('h2,h3,h4,h5,strong').first().text());
      const body = clean($i.find('p').first().text());
      const img = $i.find('img').first().attr('src') ?? $i.find('img').first().attr('data-src') ?? null;
      const href = $i.find('a[href]').first().attr('href') ?? null;
      if (title || body || img) repeatedItems.push({ title, body: body.slice(0, 400), image: img, href });
    });
  }

  const mapEl = $sec.find('iframe[src*="google.com/maps"], iframe[src*="maps.google"], .elementor-widget-google_maps iframe').first();

  return {
    isFirst: index === 0,
    // Many themes never emit an <h1> on inner pages, or put it in the header. The
    // resolved title is the reliable signal that a block is introducing the page.
    title: firstTitle($, $sec),
    fromBuilder: Boolean(builderId),
    census: widgetCensus($, $sec, builderId),
    h1: $sec.find('h1').length > 0,
    headings: $sec.find('h1,h2,h3,h4').length,
    textLength: text.length,
    text,
    images: media.filter((m) => m.kind === 'image').length,
    icons,
    svgCount,
    bgImage: media.some((m) => m.source === 'background'),
    imageFirst: $sec.find('img,figure').first().index() === 0,
    links: links.length,
    ctaLinks: ctaLinks.slice(0, 4),
    blockquotes: $sec.find('blockquote').length,
    accordions: $sec.find('[class*="accordion"], [class*="toggle"], [class*="faq"], details').length,
    isCarousel:
      /swiper|slick|owl|carousel|splide|flickity/i.test($sec.attr('class') ?? '') ||
      $sec.find('.swiper, .slick-slider, .owl-carousel, .splide, [class*="carousel"]').length > 0,
    // Swiper and Slick keep only the active slide in the DOM, so a static capture sees
    // one frame. Counting slide elements is the honest measure of what we actually got.
    slideCount: $sec.find('.swiper-slide, .slick-slide, .splide__slide, [class*="-slide"]').length,
    quotes,
    qaPairs,
    stats,
    repeatedBlocks,
    repeatedItems,
    forms: formList.length,
    formList,
    hasMap: mapEl.length > 0,
    mapSrc: mapEl.attr('src') ?? null,
    media
  };
}



/** Archetypes whose whole purpose is to hold a list. */
const COLLECTION_ARCHETYPES = new Set([
  'feature_grid', 'logo_wall', 'team_grid', 'content_list', 'testimonial', 'faq', 'stats_strip', 'product_card_grid'
]);

/**
 * A collection archetype with an empty items array means the classifier believed it saw
 * a grid but the extractor recovered nothing from it — the page keeps a section and
 * loses its content. Downgrade to a shape that actually carries the text instead.
 */
function guardEmptyCollection(section, sig, $, $sec) {
  if (!COLLECTION_ARCHETYPES.has(section.archetype)) return section;
  const items = section.slots?.items;
  if (Array.isArray(items) && items.length > 0) return section;

  const body = clean($sec.text());
  const archetype = sig.images >= 1 && body.length > 80 ? 'text_media' : 'rich_text';
  return {
    ...section,
    archetype,
    variant: archetype === 'text_media' ? { layout: 'img_right' } : {},
    // Lowered deliberately: we know the first read was wrong, so a human should look.
    confidence: Math.min(section.confidence, 0.45),
    slots: { heading: sig.title || undefined, body: body.slice(0, 8000) }
  };
}

const COLLECTIBLE = new Set(['rich_text', 'text_media', 'feature_grid', 'logo_wall', 'testimonial', 'faq']);

/**
 * Merges runs of structurally similar adjacent sections into one collection section.
 *
 * Modern builders emit each card, logo or FAQ row as its own top-level container, so a
 * boundary-based split alone reports a six-logo strip as six sections and a FAQ page as
 * seventy-one. Repeated sibling structure is a collection, not N sections — and getting
 * this wrong wrecks template matching downstream, because the page fingerprint is the
 * ordered list of archetypes.
 */
function similarSiblings(a, b) {
  if (!COLLECTIBLE.has(a.archetype) || !COLLECTIBLE.has(b.archetype)) return false;
  const A = a._merge, B = b._merge;
  if (!A || !B) return false;
  if (A.mediaCount !== B.mediaCount) return false;
  if (A.isQA !== B.isQA) return false;
  const lo = Math.min(A.textLength, B.textLength) || 1;
  const hi = Math.max(A.textLength, B.textLength) || 1;
  return hi / lo <= 6;
}

function mergeRun(run, order) {
  const m = run.map((s) => s._merge);
  const avgText = m.reduce((a, x) => a + x.textLength, 0) / run.length;
  const everyHasOneImage = m.every((x) => x.mediaCount === 1);
  // Majority, not unanimity: one card in sixty missing a heading should not reclassify
  // the whole collection.
  const withHeading = m.filter((x) => x.heading);
  const mostHaveHeading = withHeading.length >= Math.ceil(run.length * 0.8);

  let archetype, variant, items;

  // A question mark is a better FAQ detector than any plugin class. Elementor's own
  // FAQ page uses a custom widget with no accordion markup at all, so class-based
  // detection missed 61 questions; this catches them on any markup, any builder.
  const questionish =
    mostHaveHeading && withHeading.filter((x) => /\?\s*$/.test(x.heading)).length >= Math.ceil(withHeading.length * 0.6);

  if ((m.every((x) => x.isQA) || questionish) && mostHaveHeading) {
    archetype = 'faq';
    variant = { display: 'accordion' };
    items = run
      .flatMap((s) =>
        // A section may already carry parsed pairs; prefer those over re-deriving.
        Array.isArray(s.slots.items) && s.slots.items.length
          ? s.slots.items
          : [
              (() => {
                const q = s._merge.heading;
                const body = String(s.slots.body ?? s._merge.text ?? '');
                return { q, a: clean(body.startsWith(q) ? body.slice(q.length) : body).slice(0, 2000) };
              })()
            ]
      )
      // A question with no answer is a page heading that got swept in, not a FAQ entry.
      .filter((it) => it.q && (it.a || /\?\s*$/.test(it.q)));
  } else if (everyHasOneImage && avgText < 60) {
    archetype = 'logo_wall';
    variant = { display: 'static' };
    items = run.map((s) => ({ image: s.mediaRefs[0] ?? null, alt: s._merge.heading || '', href: s._merge.linkHref }));
  } else if (run.every((s) => s.archetype === 'testimonial')) {
    archetype = 'testimonial';
    variant = { display: 'grid' };
    items = run.flatMap((s) => s.slots.items ?? [{ quote: String(s.slots.body ?? '').slice(0, 600), author: null }]);
  } else {
    archetype = 'feature_grid';
    variant = { count: run.length, iconStyle: everyHasOneImage ? 'image' : 'icon' };
    items = run.map((s) => {
      const title = s._merge.heading;
      const body = String(s.slots.body ?? s._merge.text ?? '');
      return {
        title,
        body: clean(body.startsWith(title) ? body.slice(title.length) : body).slice(0, 400),
        image: s.mediaRefs[0] ?? null,
        href: s._merge.linkHref
      };
    });
  }

  return {
    id: `sec_${order}`,
    order,
    archetype,
    variant,
    // Merging is structural evidence in its own right: N identical siblings is a much
    // stronger signal than any single one of them was.
    confidence: Number(Math.min(0.85, Math.max(...run.map((s) => s.confidence)) + 0.2).toFixed(2)),
    decidedBy: run.some((s) => s.decidedBy === 'builder_map') ? 'builder_map' : 'rule',
    slots: { items },
    mediaRefs: run.flatMap((s) => s.mediaRefs),
    style: null,
    sourceSelector: run[0].sourceSelector,
    incompleteCapture: run.some((s) => s.incompleteCapture)
  };
}


/**
 * Promotes the opening section to a hero.
 *
 * This runs after coalescing, not during classification: before the merge, the first
 * card of a six-card grid is also "the first section", and an eager hero rule claims it
 * and breaks the grid apart. After the merge, position 1 genuinely is the top of the
 * page. Collections are left alone — a grid opening a page is a grid, not a hero.
 */
function promoteHero(sections) {
  const first = sections[0];
  if (!first || first.archetype === 'hero') return sections;
  if (COLLECTION_ARCHETYPES.has(first.archetype)) return sections;

  const title = first.slots?.heading ?? first.slots?.title;
  if (!title || String(title).length > 120) return sections;

  const body = String(first.slots?.body ?? '');
  const hasMedia = first.mediaRefs.length > 0;
  // A wall of prose under a heading is an article opening, not a hero.
  if (!hasMedia && body.length > 600) return sections;

  sections[0] = {
    ...first,
    archetype: 'hero',
    variant: { media: hasMedia ? 'image' : 'none', layout: hasMedia ? 'split' : 'minimal' },
    confidence: Math.min(0.7, first.confidence + 0.1),
    slots: {
      title: String(title),
      subtitle: body ? body.slice(0, 300) : undefined,
      cta: first.slots?.cta ?? []
    }
  };
  return sections;
}

function coalesce(sections) {
  const out = [];
  let i = 0;
  while (i < sections.length) {
    let j = i + 1;
    while (j < sections.length && similarSiblings(sections[i], sections[j])) j++;
    const run = sections.slice(i, j);
    if (run.length >= 3) out.push(mergeRun(run, out.length + 1));
    else for (const s of run) out.push({ ...s, id: `sec_${out.length + 1}`, order: out.length + 1 });
    i = j;
  }
  return promoteHero(
    out.map((s) => {
      const { _merge, ...rest } = s;
      return rest;
    })
  );
}

/** Splits a page into typed, slot-filled, confidence-scored sections. */
export function extractSections($, baseUrl, { builderId = null, shell = null } = {}) {
  const $root = contentRoot($, shell);
  const $work = $root.clone();
  $work.find(CHROME).remove();

  const { nodes, method } = findSections($, $work, builderId);
  const sections = [];
  const allMedia = new Map();
  let order = 0;

  for (const node of nodes) {
    const $sec = Array.isArray(node) ? $(node).parent().length ? $('<div>').append($(node).clone()) : $('<div>') : $(node);
    const sig = signals($, $sec, baseUrl, builderId, order);
    if (sig.textLength < 15 && sig.images === 0 && !sig.forms) continue;

    const decided = decideArchetype(sig);
    for (const m of sig.media) allMedia.set(m.id, m);

    const base = {
      id: `sec_${order + 1}`,
      order: order + 1,
      archetype: decided.archetype,
      variant: decided.variant,
      confidence: Number(decided.confidence.toFixed(2)),
      decidedBy: sig.fromBuilder && Object.keys(sig.census).length ? 'builder_map' : 'rule',
      slots: fillSlots(decided.archetype, $, $sec, sig),
      mediaRefs: sig.media.map((m) => m.id),
      style: null,
      sourceSelector: $sec.attr('class') ? `.${String($sec.attr('class')).split(/\s+/)[0]}` : undefined,
      _merge: {
        textLength: sig.textLength,
        mediaCount: sig.media.length,
        heading: firstTitle($, $sec),
        // Carried so the merge pass can derive content regardless of which slots the
        // individual archetype happened to fill.
        text: sig.text.slice(0, 4000),
        isQA: sig.accordions > 0 || sig.qaPairs.length > 0,
        linkHref: sig.ctaLinks[0]?.href ?? null
      },
      // Swiper/Slick keep only the active slide in the DOM. A static parse sees one
      // frame and silently loses the rest — flag it rather than scoring it as complete.
      incompleteCapture: sig.isCarousel && sig.slideCount <= 1
    };
    sections.push(guardEmptyCollection(base, sig, $, $sec));
    order++;
  }

  return { sections: coalesce(sections), media: [...allMedia.values()], boundaryMethod: method };
}
