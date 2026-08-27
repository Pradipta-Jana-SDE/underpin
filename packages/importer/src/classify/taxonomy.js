/**
 * Page-type taxonomy.
 *
 * Small enough to be useful, extensible by adding a row. `signals` are ordered by
 * precision: a body class WordPress emits itself beats a slug keyword, which beats
 * a structural guess.
 */
export const PAGE_TYPES = [
  { id: 'home',          label: 'Home' },
  { id: 'service',       label: 'Service' },
  { id: 'service_index', label: 'Services index' },
  { id: 'about',         label: 'About' },
  { id: 'location',      label: 'Location' },
  { id: 'contact',       label: 'Contact' },
  { id: 'team',          label: 'Team' },
  { id: 'pricing',       label: 'Pricing' },
  { id: 'faq',           label: 'FAQ' },
  { id: 'testimonials',  label: 'Testimonials' },
  { id: 'gallery',       label: 'Gallery / portfolio' },
  { id: 'case_study',    label: 'Case study' },
  { id: 'careers',       label: 'Careers' },
  { id: 'blog_index',    label: 'Blog index' },
  { id: 'blog_post',     label: 'Blog post' },
  { id: 'product',       label: 'Product' },
  { id: 'product_index', label: 'Product index' },
  { id: 'legal',         label: 'Legal' },
  { id: 'landing',       label: 'Landing / campaign' },
  { id: 'archive',       label: 'Archive' },
  { id: 'not_found',     label: '404' },
  { id: 'generic',       label: 'Generic page' }
];

export const PAGE_TYPE_IDS = PAGE_TYPES.map((t) => t.id);

/** Slug and path tokens, weighted. Vocabulary drifts per agency, so several synonyms each. */
export const SLUG_TOKENS = {
  about:        [/\babout(-us)?\b/, /\bwho-we-are\b/, /\bour-story\b/, /\bcompany\b/, /\bmission\b/],
  contact:      [/\bcontact(-us)?\b/, /\bget-in-touch\b/, /\benquir(y|ies)\b/, /\bquote\b/],
  location:     [/\blocations?\b/, /\bbranch(es)?\b/, /\bstores?\b/, /\bareas?-we-serve\b/, /\bservice-area\b/],
  service:      [/\bservices?\b/, /\bsolutions?\b/, /\bwhat-we-do\b/, /\btreatments?\b/, /\bproducts?-services\b/],
  team:         [/\bteam\b/, /\bstaff\b/, /\bpeople\b/, /\bour-(team|staff|people)\b/, /\bleadership\b/],
  pricing:      [/\bpricing\b/, /\bprices?\b/, /\bplans?\b/, /\bpackages?\b/, /\brates?\b/],
  faq:          [/\bfaqs?\b/, /\bfrequently-asked\b/, /\bhelp\b/, /\bsupport\b/],
  testimonials: [/\btestimonials?\b/, /\breviews?\b/, /\bwhat-clients-say\b/],
  gallery:      [/\bgallery\b/, /\bportfolio\b/, /\bour-work\b/, /\bprojects?\b/, /\bshowcase\b/],
  case_study:   [/\bcase-stud(y|ies)\b/, /\bsuccess-stor(y|ies)\b/],
  careers:      [/\bcareers?\b/, /\bjobs?\b/, /\bvacancies\b/, /\bwork-with-us\b/, /\bjoin-us\b/],
  blog_index:   [/^\/(blog|news|articles|insights|resources)\/?$/],
  legal:        [/\bprivacy\b/, /\bterms\b/, /\bcookies?\b/, /\bdisclaimer\b/, /\baccessibility\b/, /\bgdpr\b/, /\blegal\b/],
  product_index:[/^\/(shop|store|products)\/?$/],
  product:      [/\/products?\//, /\/shop\//]
};

/** JSON-LD @type is high precision when present, but low recall — absence proves nothing. */
export const JSONLD_TYPES = {
  about: ['AboutPage'],
  contact: ['ContactPage'],
  faq: ['FAQPage'],
  location: ['LocalBusiness', 'Store', 'Dentist', 'Plumber', 'Restaurant'],
  service: ['Service'],
  blog_post: ['BlogPosting', 'Article', 'NewsArticle'],
  blog_index: ['Blog', 'CollectionPage'],
  careers: ['JobPosting'],
  product: ['Product'],
  team: ['ProfilePage'],
  testimonials: ['Review', 'AggregateRating']
};
