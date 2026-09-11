# Capability fingerprinting and scope negotiation

## The principle
Marking a WooCommerce or membership site "ineligible" is the wrong call. It is
almost never true that NONE of the site should migrate. A plumbing company with
a 40-page service site and a 12-product parts shop should migrate the 40 pages
and make a DECISION about the 12. Refusing the whole site to avoid the hard part
is a tool failing its user.

So: detect capability, then ask. Never guess on anything with a business
consequence. Never silently drop a subsystem.

Scope runs BEFORE extraction. Crawling 142 product pages and then discovering
nobody wanted them wastes the most expensive part of the pipeline.

## Detection fingerprints

  WooCommerce      body.woocommerce | /wp-json/wc/v3/ | woocommerce-* handles
                   | /cart/ /checkout/ /my-account/ | product_cat in sitemap
  Login/membership /wp-login.php | mepr-* | Restrict Content | WC Memberships
                   | logged-in body class | 302 to login on protected paths
  LMS              learndash | lifterlms | tutor-* | /courses/ /lessons/
  Booking          bookly | amelia | calendly embeds | appointment CPTs
  Multilingual     wpml-* | polylang | hreflang alternates | /es/ /fr/ prefixes
  Blog/archives    body.blog | /category/ /tag/ | /page/2/ | Article JSON-LD
  Forms            wpcf7 | gform_ | wpforms- | ninja-forms
  Search           ?s= results template | search form in header
  Embeds           maps | chat | review platforms | booking iframes

## Three things that make it more than a wizard

1. EVERY OPTION CARRIES ITS CONSEQUENCE, and unavailable options are SHOWN as
   unavailable. "Rebuild auth" appears greyed out rather than hidden, because a
   user who wanted it needs to learn the system won't do it - from the tool, now,
   not from a surprise at review.

2. THE ANSWERS BECOME A CONTRACT. migration.plan.json feeds every later stage and
   is reprinted at the top of the final report, so the migration is judged against
   what was agreed rather than an unstated ideal. An excluded section is a
   decision on the record, not a gap.

3. EXCLUDED URLS STILL GET A DISPOSITION. Dropping /shop/* without emitting 410
   Gone or a redirect leaves 142 indexed URLs pointing at nothing. Exclusion is a
   ROUTING decision, not a deletion. This is a hard deploy gate.

## Default dispositions
  WooCommerce   -> static catalogue (browse + Enquire CTA, no cart)
  Membership    -> exclude and proxy; public teasers migrate, Sign in -> old host
  WPML          -> migrate all locales where paths are clean, emit hreflang
  Blog          -> posts + archives with static pagination
  Search        -> client-side index, or disabled AND the box removed
                   (never left present and dead)

## Explicitly unavailable, and said out loud
  - Headless WooCommerce (cart/checkout/accounts) - a 6-12 week engagement
  - Rebuilding authentication - gated content stays on WordPress
