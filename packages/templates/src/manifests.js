/**
 * The template library.
 *
 * A template is an ordered composition of section archetypes plus a manifest declaring
 * which slots are required. Templates are deliberately NOT derived from any one demo
 * site: if they were, "reusable across multiple websites" would be unfalsifiable. These
 * sequences are the common shapes of small-business marketing sites.
 *
 * `required: true` marks a section the template cannot render meaningfully without —
 * it drives S_slot in the matcher and the underflow warning in the report.
 */
export const TEMPLATES = [
  {
    id: 'HomeClassic',
    label: 'Home — hero, services, proof',
    pageType: 'home',
    sections: [
      { archetype: 'hero', variant: { media: 'image', layout: 'split' }, required: true },
      { archetype: 'feature_grid', variant: { count: 3 }, required: true },
      { archetype: 'text_media', variant: { layout: 'img_right' }, required: false },
      { archetype: 'stats_strip', variant: { layout: 'row' }, required: false },
      { archetype: 'testimonial', variant: { display: 'grid' }, required: false },
      { archetype: 'logo_wall', variant: { display: 'static' }, required: false },
      { archetype: 'cta_band', variant: { media: 'none' }, required: true }
    ]
  },
  {
    id: 'HomeLocal',
    label: 'Home — local service business',
    pageType: 'home',
    sections: [
      { archetype: 'hero', variant: { media: 'image', layout: 'full' }, required: true },
      { archetype: 'feature_grid', variant: { count: 4 }, required: true },
      { archetype: 'testimonial', variant: { display: 'slider' }, required: false },
      { archetype: 'contact_panel', variant: { layout: 'form_map' }, required: false },
      { archetype: 'cta_band', variant: { media: 'bg_image' }, required: false }
    ]
  },
  {
    id: 'ServiceSplitHero',
    label: 'Service — split hero, features, FAQ',
    pageType: 'service',
    sections: [
      { archetype: 'hero', variant: { media: 'image', layout: 'split' }, required: true },
      { archetype: 'text_media', variant: { layout: 'img_right' }, required: true },
      { archetype: 'feature_grid', variant: { count: 3 }, required: false },
      { archetype: 'faq', variant: { display: 'accordion' }, required: false },
      { archetype: 'cta_band', variant: { media: 'none' }, required: true }
    ]
  },
  {
    id: 'ServiceLongForm',
    label: 'Service — long-form editorial',
    pageType: 'service',
    sections: [
      { archetype: 'hero', variant: { media: 'none', layout: 'minimal' }, required: true },
      { archetype: 'rich_text', variant: {}, required: true },
      { archetype: 'text_media', variant: { layout: 'img_left' }, required: false },
      { archetype: 'stats_strip', variant: { layout: 'row' }, required: false },
      { archetype: 'testimonial', variant: { display: 'single' }, required: false },
      { archetype: 'cta_band', variant: { media: 'none' }, required: true }
    ]
  },
  {
    id: 'ServiceIndex',
    label: 'Services index — grid of services',
    pageType: 'service_index',
    sections: [
      { archetype: 'hero', variant: { media: 'none', layout: 'minimal' }, required: true },
      { archetype: 'feature_grid', variant: { count: 6 }, required: true },
      { archetype: 'cta_band', variant: { media: 'none' }, required: false }
    ]
  },
  {
    id: 'AboutStory',
    label: 'About — story and team',
    pageType: 'about',
    sections: [
      { archetype: 'hero', variant: { media: 'image', layout: 'split' }, required: true },
      { archetype: 'text_media', variant: { layout: 'img_left' }, required: true },
      { archetype: 'stats_strip', variant: { layout: 'row' }, required: false },
      { archetype: 'team_grid', variant: { count: 4 }, required: false },
      { archetype: 'cta_band', variant: { media: 'none' }, required: false }
    ]
  },
  {
    id: 'LocationCard',
    label: 'Location — NAP, map, hours',
    pageType: 'location',
    sections: [
      { archetype: 'hero', variant: { media: 'image', layout: 'split' }, required: true },
      { archetype: 'contact_panel', variant: { layout: 'form_map' }, required: true },
      { archetype: 'text_media', variant: { layout: 'img_right' }, required: false },
      { archetype: 'faq', variant: { display: 'accordion' }, required: false }
    ]
  },
  {
    id: 'ContactSimple',
    label: 'Contact — form and details',
    pageType: 'contact',
    sections: [
      { archetype: 'hero', variant: { media: 'none', layout: 'minimal' }, required: true },
      { archetype: 'contact_panel', variant: { layout: 'form_map' }, required: true }
    ]
  },
  {
    id: 'FaqAccordion',
    label: 'FAQ — accordion list',
    pageType: 'faq',
    sections: [
      { archetype: 'hero', variant: { media: 'none', layout: 'minimal' }, required: true },
      { archetype: 'faq', variant: { display: 'accordion' }, required: true },
      { archetype: 'cta_band', variant: { media: 'none' }, required: false }
    ]
  },
  {
    id: 'PricingTiers',
    label: 'Pricing — tiers and FAQ',
    pageType: 'pricing',
    sections: [
      { archetype: 'hero', variant: { media: 'none', layout: 'minimal' }, required: true },
      { archetype: 'pricing_table', variant: { columns: 3 }, required: true },
      { archetype: 'faq', variant: { display: 'accordion' }, required: false },
      { archetype: 'cta_band', variant: { media: 'none' }, required: false }
    ]
  },
  {
    id: 'TeamGridPage',
    label: 'Team — people grid',
    pageType: 'team',
    sections: [
      { archetype: 'hero', variant: { media: 'none', layout: 'minimal' }, required: true },
      { archetype: 'team_grid', variant: { count: 6 }, required: true },
      { archetype: 'cta_band', variant: { media: 'none' }, required: false }
    ]
  },
  {
    id: 'ArticlePost',
    label: 'Blog post — article',
    pageType: 'blog_post',
    sections: [
      { archetype: 'hero', variant: { media: 'image', layout: 'minimal' }, required: true },
      { archetype: 'rich_text', variant: {}, required: true },
      { archetype: 'cta_band', variant: { media: 'none' }, required: false }
    ]
  },
  {
    id: 'BlogIndexGrid',
    label: 'Blog index — teaser grid',
    pageType: 'blog_index',
    sections: [
      { archetype: 'hero', variant: { media: 'none', layout: 'minimal' }, required: true },
      { archetype: 'content_list', variant: { display: 'grid' }, required: true }
    ]
  },
  {
    id: 'LegalDocument',
    label: 'Legal — plain document',
    pageType: 'legal',
    sections: [
      { archetype: 'hero', variant: { media: 'none', layout: 'minimal' }, required: false },
      { archetype: 'rich_text', variant: {}, required: true }
    ]
  },
  {
    // The catch-all. It must never report a mismatch: it is what a page falls back to
    // when nothing else fits, so nothing in it can be mandatory. Everything renders
    // through the flexible zone in source order.
    id: 'GenericPage',
    label: 'Generic — flexible content',
    pageType: 'generic',
    sections: [
      { archetype: 'hero', variant: { media: 'none', layout: 'minimal' }, required: false },
      { archetype: 'rich_text', variant: {}, required: false }
    ]
  }
];

// A flexible zone renders sections the fixed sequence has no slot for, in source order,
// using their own archetype component. Without it every page longer than its template
// spills into the leftover bucket and blocks the build — which is not "content migrated
// accurately", it is content migrated into a warning.
for (const t of TEMPLATES) if (t.hasFlexibleZone === undefined) t.hasFlexibleZone = true;

export const TEMPLATES_BY_ID = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));

export function templatesForType(pageType) {
  const exact = TEMPLATES.filter((t) => t.pageType === pageType);
  if (exact.length) return exact;
  // Never leave a page without a candidate — GenericPage has a flexible zone.
  return TEMPLATES.filter((t) => t.pageType === 'generic');
}
