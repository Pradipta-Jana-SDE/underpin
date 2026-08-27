/**
 * Capability signatures.
 *
 * Each capability is detected from several independent sources so a single false
 * negative (a security plugin stripping the generator meta, say) does not hide a
 * whole subsystem. `weight` contributes to a confidence score; `hard: true` means
 * the signal is on its own conclusive.
 */
export const CAPABILITIES = [
  {
    id: 'woocommerce',
    label: 'WooCommerce',
    restNamespaces: ['wc/v3', 'wc/v2', 'wc/store'],
    bodyClasses: ['woocommerce', 'woocommerce-page', 'woocommerce-js'],
    assetPatterns: [/\/plugins\/woocommerce\//i, /woocommerce[-.]?(inline|blocks|layout)/i],
    paths: ['/cart/', '/checkout/', '/my-account/', '/shop/'],
    urlPatterns: [/\/product\//i, /\/product-category\//i, /[?&]post_type=product/i],
    jsonld: ['Product', 'Offer'],
    hardSignals: ['restNamespaces', 'paths']
  },
  {
    id: 'membership',
    label: 'Login / membership',
    restNamespaces: ['mp/v1', 'rcp/v1', 'wc/v3/memberships'],
    bodyClasses: ['logged-in', 'mepr-', 'rcp-', 'memberpress'],
    assetPatterns: [/memberpress|\/mepr/i, /restrict-content/i, /paid-memberships-pro|\/pmpro/i, /wp-members/i],
    // NOT /wp-login.php — that exists on every WordPress install and proves nothing.
    paths: ['/login/', '/account/', '/members/', '/register/'],
    urlPatterns: [/\/members?\//i, /\/account\//i],
    hardSignals: ['assetPatterns']
  },
  {
    id: 'lms',
    label: 'Courses / LMS',
    restNamespaces: ['ldlms/v2', 'llms/v1', 'tutor/v1'],
    bodyClasses: ['learndash', 'lifterlms', 'tutor-'],
    assetPatterns: [/sfwd-lms|learndash/i, /lifterlms/i, /tutor(-|\/)/i],
    paths: ['/courses/', '/lessons/'],
    urlPatterns: [/\/courses?\//i, /\/lessons?\//i, /\/quiz(zes)?\//i],
    jsonld: ['Course'],
    hardSignals: ['restNamespaces']
  },
  {
    id: 'booking',
    label: 'Booking / scheduling',
    restNamespaces: ['bookly/v1', 'amelia/v1'],
    bodyClasses: ['bookly', 'amelia'],
    assetPatterns: [/bookly/i, /ameliabooking|\/amelia/i, /calendly/i, /simply-schedule/i, /booking-?calendar/i],
    paths: ['/booking/', '/book-now/', '/appointments/'],
    hardSignals: []
  },
  {
    id: 'multilingual',
    label: 'Multilingual',
    restNamespaces: ['wpml/v1', 'pll/v1'],
    bodyClasses: ['translatepress', 'wpml-'],
    assetPatterns: [/sitepress-multilingual|wpml/i, /polylang/i, /translatepress/i, /weglot/i],
    paths: [],
    urlPatterns: [/^\/(es|fr|de|it|pt|nl|ru|zh|ja|ar|hi)\//i],
    hardSignals: ['hreflang']
  },
  {
    id: 'blog',
    label: 'Blog / archives',
    restNamespaces: [],
    bodyClasses: ['blog', 'archive', 'category', 'single-post'],
    assetPatterns: [],
    paths: ['/blog/', '/news/'],
    urlPatterns: [/\/category\//i, /\/tag\//i, /\/page\/\d+\//i, /\/\d{4}\/\d{2}\//],
    jsonld: ['Article', 'BlogPosting'],
    hardSignals: []
  },
  {
    id: 'forms',
    label: 'Forms',
    restNamespaces: ['contact-form-7/v1', 'gf/v2'],
    bodyClasses: [],
    assetPatterns: [/contact-form-7|\/wpcf7/i, /gravityforms|\/gform/i, /wpforms/i, /ninja-forms|\/nf-/i, /formidable|\/frm_/i],
    paths: ['/contact/'],
    hardSignals: ['assetPatterns']
  },
  {
    id: 'search',
    label: 'Site search',
    restNamespaces: [],
    bodyClasses: ['search-results', 'search-no-results'],
    assetPatterns: [/relevanssi/i, /searchwp/i],
    paths: [],
    hardSignals: []
  },
  {
    id: 'embeds',
    label: 'Third-party embeds',
    restNamespaces: [],
    bodyClasses: [],
    assetPatterns: [
      /google\.com\/maps|maps\.googleapis/i,
      /tawk\.to|intercom|drift\.com|crisp\.chat|livechat/i,
      /birdeye|podium|trustpilot|yotpo/i,
      /youtube\.com\/embed|player\.vimeo/i
    ],
    paths: [],
    hardSignals: []
  }
];

/** Page-builder fingerprints. Also a classification signal — builders correlate with block patterns. */
export const BUILDERS = [
  { id: 'elementor', match: [/elementor-kit-\d+/i, /\/plugins\/elementor\//i, /elementor-frontend/i] },
  { id: 'divi', match: [/\/themes\/Divi\//i, /et_pb_section|et-db/i, /et_divi_builder/i] },
  { id: 'wpbakery', match: [/js_composer/i, /wpb-js-composer/i, /vc_row/i] },
  { id: 'beaver_builder', match: [/fl-builder/i, /bb-plugin/i] },
  { id: 'bricks', match: [/brxe-/i, /data-bricks/i, /\/themes\/bricks\//i] },
  { id: 'oxygen', match: [/oxygen-builder|ct_section/i] },
  { id: 'gutenberg', match: [/wp-block-|\/wp-includes\/css\/dist\/block-library/i] }
];
