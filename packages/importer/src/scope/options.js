/**
 * Disposition menus.
 *
 * Two rules govern this file:
 *  1. Every option states its consequence. The operator should never have to guess
 *     what "exclude" does to 142 indexed URLs.
 *  2. Things the system will not do are listed as `unavailable`, not omitted. Someone
 *     who wanted rebuilt authentication needs to learn that here — from the tool, now —
 *     rather than discovering it at review.
 */
export const OPTION_SETS = {
  woocommerce: (d) => ({
    question: `WooCommerce — ${d.detected.products ?? 0} product URLs, cart and checkout detected`,
    options: [
      {
        value: 'static_catalogue',
        label: 'Static catalogue',
        detail: 'Products browse-only with an Enquire CTA. No cart, no checkout, no stock.',
        recommended: true,
        urlPolicy: { '/product/*': 'migrate', '/products/*': 'migrate', '/cart/*': '410', '/checkout/*': '410', '/my-account/*': '410' }
      },
      {
        value: 'external_checkout',
        label: 'Catalogue + external checkout',
        detail: 'Products migrate; Buy links point at Shopify/Stripe. Needs a destination URL.',
        urlPolicy: { '/product/*': 'migrate', '/products/*': 'migrate', '/cart/*': 'redirect', '/checkout/*': 'redirect' }
      },
      {
        value: 'keep_on_wordpress',
        label: 'Leave the shop on WordPress',
        detail: 'Shop stays put (e.g. shop.example.com) and the React site links to it. Nothing shop-side changes.',
        urlPolicy: { '/product/*': 'proxy_to_legacy', '/cart/*': 'proxy_to_legacy', '/checkout/*': 'proxy_to_legacy', '/my-account/*': 'proxy_to_legacy' }
      },
      {
        value: 'exclude',
        label: 'Exclude the shop entirely',
        detail: 'Shop URLs emit 410 Gone so search engines drop them cleanly. Never a bare 404.',
        urlPolicy: { '/product/*': '410', '/products/*': '410', '/cart/*': '410', '/checkout/*': '410', '/my-account/*': '410' }
      }
    ],
    unavailable: [
      { label: 'Headless commerce (working cart, checkout, accounts)', why: 'A 6–12 week engagement on its own. Out of scope for this system.' }
    ]
  }),

  membership: (d) => ({
    question: `Login / membership — ${d.evidence[0] ?? 'gated area detected'}`,
    options: [
      {
        value: 'keep_on_wordpress',
        label: 'Leave gated content on WordPress',
        detail: 'Public teasers migrate. "Sign in" links to the existing host. Members are unaffected.',
        recommended: true,
        urlPolicy: { '/members/*': 'proxy_to_legacy', '/account/*': 'proxy_to_legacy', '/login/*': 'proxy_to_legacy' }
      },
      {
        value: 'exclude',
        label: 'Exclude gated areas',
        detail: 'Member URLs emit 410. Only use when the membership is being retired.',
        urlPolicy: { '/members/*': '410', '/account/*': '410' }
      }
    ],
    unavailable: [
      { label: 'Rebuild authentication in React', why: 'Auth, sessions and entitlements are a separate project. This system will not fake them.' }
    ]
  }),

  lms: (d) => ({
    question: `Courses / LMS — ${d.detected.courses ?? 0} course URLs detected`,
    options: [
      { value: 'keep_on_wordpress', label: 'Leave courses on WordPress', detail: 'Marketing pages migrate; course delivery and progress stay where they work.', recommended: true, urlPolicy: { '/courses/*': 'proxy_to_legacy', '/lessons/*': 'proxy_to_legacy' } },
      { value: 'migrate', label: 'Migrate course landing pages only', detail: 'Public course descriptions become static pages. Enrolment links out.', urlPolicy: { '/courses/*': 'migrate', '/lessons/*': 'proxy_to_legacy' } },
      { value: 'exclude', label: 'Exclude', detail: 'Course URLs emit 410.', urlPolicy: { '/courses/*': '410', '/lessons/*': '410' } }
    ],
    unavailable: [{ label: 'Migrate learner progress and quiz state', why: 'Stateful data with no static equivalent.' }]
  }),

  booking: () => ({
    question: 'Booking / scheduling widget detected',
    options: [
      { value: 'migrate', label: 'Preserve the embed', detail: 'Widget carried across verbatim and functionally checked at build. Third-party keys may need re-scoping to the new domain.', recommended: true, urlPolicy: {} },
      { value: 'exclude', label: 'Remove booking', detail: 'Widget dropped and its CTA removed, so no dead button ships.', urlPolicy: {} }
    ],
    unavailable: []
  }),

  multilingual: (d) => ({
    question: (() => {
      const shown = d.detected.locales ?? [];
      const total = d.detected.localeCount ?? shown.length;
      const more = total > shown.length ? `, +${total - shown.length} more` : '';
      return `Multilingual — ${total} locales: ${shown.join(', ')}${more}`;
    })(),
    options: [
      { value: 'migrate_all', label: 'Migrate every locale', detail: 'Locale paths preserved byte-for-byte and hreflang re-emitted from the locale map.', recommended: true, urlPolicy: {} },
      { value: 'default_only', label: 'Default locale only', detail: 'Other locales flagged as phase two. Their URLs must still be routed, not dropped.', urlPolicy: {} }
    ],
    unavailable: [{ label: 'Machine-translate missing pages', why: 'Content decisions belong to the client, not the migrator.' }]
  }),

  blog: (d) => ({
    question: `Blog / archives — ${d.detected.posts ?? 0} matching URLs`,
    options: [
      { value: 'migrate_all', label: 'Posts, archives and pagination', detail: 'Category and tag archives become static pages; /page/N/ URLs are generated so pagination keeps resolving.', recommended: true, urlPolicy: {} },
      { value: 'default_only', label: 'Posts only', detail: 'Archive and pagination URLs redirect to the blog index rather than 404.', urlPolicy: { '/category/*': 'redirect', '/tag/*': 'redirect' } },
      { value: 'exclude', label: 'Exclude the blog', detail: 'Post URLs emit 410. Consider the backlink loss first.', urlPolicy: { '/category/*': '410', '/tag/*': '410' } }
    ],
    unavailable: []
  }),

  search: () => ({
    question: 'Site search detected',
    options: [
      { value: 'migrate', label: 'Client-side search index', detail: 'A static index is generated at build. Works offline, no server.', recommended: true, urlPolicy: {} },
      { value: 'exclude', label: 'Remove search', detail: 'The search box is removed too — never left present and dead.', urlPolicy: { '/?s=*': 'redirect' } }
    ],
    unavailable: [{ label: 'Live server-side search', why: 'There is no runtime backend by design.' }]
  })
};

export function optionsFor(capability) {
  const build = OPTION_SETS[capability.id];
  return build ? build(capability) : null;
}

export function recommendedFor(capability) {
  const set = optionsFor(capability);
  if (!set) return null;
  return set.options.find((o) => o.recommended) ?? set.options[0];
}
