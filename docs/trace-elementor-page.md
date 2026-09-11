# End-to-end trace: one Elementor service page

Hero + icon grid + testimonial slider + Contact Form 7 + Google Map.
Four things break. The fidelity score as originally specified catches one.

## 1. Icon grid -> icons vanish, no error
Elementor renders icon-box graphics as icon-font `<i>` tags or CSS masks, not
`<img>`. A media extractor keyed on `img[src]` never looks there. Nothing was
technically wrong, so nothing is flagged.
FIX: detect icon-font classes and CSS `mask-image`/background as media sources.

## 2. Testimonial slider -> N-1 testimonials disappear silently  [WORST]
Swiper/Slick keep only the active slide in the DOM. One Playwright capture sees
one frame. No exception, no low-confidence flag - the DOM legitimately held one
slide. The required-slot check then sees "testimonial: present" and scores fine.
This is a SCORING BLIND SPOT, not an extraction bug: the score conflates
structural presence with content completeness.
FIX: drive carousels before capture, or read slide data from the init config.

## 3. Contact form -> schema extracted, nowhere to submit
Field schema comes out correctly. Reuse triage correctly rejects CF7 markup
because no POST target exists post-migration. Structurally a success,
functionally dead, invisible until someone clicks submit.
FIX: bundled default Worker endpoint validating against the same Zod schema.

## 4. Google Map -> preserved in DOM, broken on screen
Iframe survives intact; its API key is referrer-locked to the old domain. New
domain, grey "for development purposes only" box. Nothing in the coverage terms
checks whether an embed WORKS.
FIX: post-build functional check + "requires key re-scoping" in the report.

## Net
Most testimonials lost, icons lost, dead form, broken map - and three of four go
unreported. Every fix is small. Finding them required tracing the page instead
of trusting the diagram.
