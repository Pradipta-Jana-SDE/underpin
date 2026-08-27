/**
 * Rung C-prime: builder-aware DOM boundaries.
 *
 * Page builders emit stable structural classes in the RENDERED DOM whether or not
 * their content survives the REST API. Elementor alone is 32.67% of WordPress sites;
 * with WPBakery and Divi that is ~47% of the fleet handing us section boundaries AND
 * type hints for free, from a lookup table rather than a widget parser.
 *
 * Deliberately shallow: boundaries and type hints only. Deep widget semantics are weeks
 * of work per builder and would not survive the first theme that customises them.
 */
export const BUILDER_MAPS = {
  elementor: {
    detect: (html) => /elementor-kit-\d+|\/plugins\/elementor\//i.test(html),
    sectionSelector: '.elementor-section, .elementor-top-section, [data-element_type="container"]',
    widgetSelector: '.elementor-widget',
    typeAttr: 'data-widget_type',
    // data-widget_type looks like "image-box.default" — we match on the part before the dot.
    normaliseType: (raw) => (raw ?? '').split('.')[0],
    types: {
      heading: 'heading',
      'theme-site-title': 'heading',
      'text-editor': 'text',
      'theme-post-content': 'text',
      image: 'image',
      'theme-site-logo': 'image',
      'image-box': 'text_media',
      'icon-box': 'feature',
      'icon-list': 'feature',
      testimonial: 'testimonial',
      'testimonial-carousel': 'testimonial',
      reviews: 'testimonial',
      'call-to-action': 'cta',
      button: 'cta',
      counter: 'stat',
      'progress-bar': 'stat',
      accordion: 'faq',
      toggle: 'faq',
      tabs: 'faq',
      'price-table': 'pricing',
      'price-list': 'pricing',
      form: 'form',
      posts: 'listing',
      portfolio: 'listing',
      'image-gallery': 'gallery',
      'image-carousel': 'gallery',
      'google_maps': 'map',
      'social-icons': 'social',
      'nav-menu': 'nav',
      video: 'video'
    }
  },

  divi: {
    detect: (html) => /\/themes\/Divi\/|et_pb_section|et_divi_builder/i.test(html),
    sectionSelector: '.et_pb_section',
    widgetSelector: '[class*="et_pb_"][class*="_module"], .et_pb_module',
    typeAttr: null,
    // Divi encodes the module in a class token: et_pb_blurb, et_pb_testimonial, ...
    typeFromClass: /\bet_pb_([a-z_]+?)(?:_\d+)?\b/,
    types: {
      text: 'text',
      image: 'image',
      blurb: 'feature',
      testimonial: 'testimonial',
      cta: 'cta',
      button: 'cta',
      contact_form: 'form',
      number_counter: 'stat',
      circle_counter: 'stat',
      accordion: 'faq',
      toggle: 'faq',
      tabs: 'faq',
      pricing_tables: 'pricing',
      blog: 'listing',
      portfolio: 'listing',
      gallery: 'gallery',
      slider: 'gallery',
      map: 'map',
      team_member: 'team',
      social_media_follow: 'social',
      video: 'video',
      fullwidth_header: 'hero'
    }
  },

  wpbakery: {
    detect: (html) => /js_composer|wpb-js-composer/i.test(html),
    sectionSelector: '.vc_row',
    widgetSelector: '.wpb_column > .vc_column-inner > .wpb_wrapper > *, .wpb_content_element',
    typeAttr: null,
    typeFromClass: /\b(?:wpb_|vc_)([a-z_]+)\b/,
    types: {
      text_column: 'text',
      single_image: 'image',
      wpb_single_image: 'image',
      cta3: 'cta',
      btn: 'cta',
      call_to_action: 'cta',
      toggle: 'faq',
      tta_accordion: 'faq',
      tta_tabs: 'faq',
      gallery: 'gallery',
      images_carousel: 'gallery',
      gmaps: 'map',
      separator: 'skip',
      empty_space: 'skip'
    }
  },

  beaver_builder: {
    detect: (html) => /fl-builder|bb-plugin/i.test(html),
    sectionSelector: '.fl-row',
    widgetSelector: '.fl-module',
    typeAttr: null,
    typeFromClass: /\bfl-module-([a-z-]+)\b/,
    types: {
      'rich-text': 'text',
      heading: 'heading',
      photo: 'image',
      'callout': 'feature',
      'testimonials': 'testimonial',
      'cta': 'cta',
      button: 'cta',
      accordion: 'faq',
      'pricing-table': 'pricing',
      'contact-form': 'form',
      'post-grid': 'listing',
      gallery: 'gallery',
      map: 'map'
    }
  },

  bricks: {
    detect: (html) => /brxe-|data-bricks/i.test(html),
    sectionSelector: 'section.brxe-section, .brxe-container',
    widgetSelector: '[class*="brxe-"]',
    typeAttr: null,
    // Bricks names the element directly: brxe-heading, brxe-accordion, ...
    typeFromClass: /\bbrxe-([a-z-]+)\b/,
    types: {
      heading: 'heading',
      text: 'text',
      'text-basic': 'text',
      image: 'image',
      'icon-box': 'feature',
      testimonials: 'testimonial',
      accordion: 'faq',
      'pricing-tables': 'pricing',
      form: 'form',
      'posts': 'listing',
      slider: 'gallery',
      map: 'map',
      team: 'team',
      counter: 'stat'
    }
  },

  gutenberg: {
    detect: (html) => /wp-block-/i.test(html),
    // Core blocks carry no section wrapper by default, so we treat top-level groups
    // and covers as boundaries and fall back to heading-splitting elsewhere.
    sectionSelector: '.wp-block-group, .wp-block-cover, .wp-block-columns',
    widgetSelector: '[class*="wp-block-"]',
    typeAttr: null,
    typeFromClass: /\bwp-block-([a-z-]+)\b/,
    types: {
      heading: 'heading',
      paragraph: 'text',
      image: 'image',
      cover: 'hero',
      'media-text': 'text_media',
      quote: 'testimonial',
      pullquote: 'testimonial',
      buttons: 'cta',
      button: 'cta',
      table: 'pricing',
      gallery: 'gallery',
      'latest-posts': 'listing',
      'query': 'listing',
      embed: 'embed',
      details: 'faq',
      columns: 'columns',
      group: 'group'
    }
  }
};

export function detectBuilderFromHtml(html) {
  // Gutenberg markup appears on nearly every modern site; only claim it when
  // no dedicated page builder is present.
  for (const [id, def] of Object.entries(BUILDER_MAPS)) {
    if (id === 'gutenberg') continue;
    if (def.detect(html)) return id;
  }
  return BUILDER_MAPS.gutenberg.detect(html) ? 'gutenberg' : null;
}

/** Resolve a widget element's coarse type hint using the builder's own conventions. */
export function widgetType(builderId, $el, $) {
  const def = BUILDER_MAPS[builderId];
  if (!def) return null;

  if (def.typeAttr) {
    const raw = $el.attr(def.typeAttr);
    if (raw) {
      const key = def.normaliseType ? def.normaliseType(raw) : raw;
      return def.types[key] ?? null;
    }
  }
  if (def.typeFromClass) {
    const classes = ($el.attr('class') ?? '').split(/\s+/);
    for (const c of classes) {
      const m = def.typeFromClass.exec(c);
      if (m?.[1] && def.types[m[1]]) return def.types[m[1]];
    }
  }
  return null;
}
