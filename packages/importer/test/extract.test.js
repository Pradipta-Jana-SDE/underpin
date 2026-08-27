import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractSections } from '../src/extract/sections.js';
import { extractMedia, originalUrl, parseSrcset } from '../src/extract/media.js';
import { extractForms } from '../src/extract/forms.js';
import { widgetType, detectBuilderFromHtml } from '../src/extract/builder-map.js';
import { isArchetype } from '@underpin/vocabulary';

const load = (html) => cheerio.load(`<html><body><main>${html}</main></body></html>`);
const run = (html, opts) => extractSections(load(html), 'https://x.test/p/', opts);

// ---------------------------------------------------------------- coalescing

test('a run of single-image blocks becomes one logo_wall, not six sections', () => {
  const logos = Array.from({ length: 6 }, (_, i) => `<div class="cell"><img src="/l${i}.png" alt="Brand ${i}"></div>`).join('');
  const { sections } = run(logos);
  assert.equal(sections.length, 1, 'six logos should coalesce into one section');
  assert.equal(sections[0].archetype, 'logo_wall');
  assert.equal(sections[0].slots.items.length, 6);
});

test('repeated title+body+image cards become one feature_grid carrying every item', () => {
  const cards = Array.from({ length: 4 }, (_, i) =>
    `<div class="card"><img src="/i${i}.png"><h3>Feature ${i}</h3><p>${'body text '.repeat(8)}</p></div>`
  ).join('');
  const { sections } = run(cards);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].archetype, 'feature_grid');
  assert.equal(sections[0].slots.items.length, 4, 'no card may be dropped in the merge');
  assert.ok(sections[0].slots.items.every((i) => i.title), 'every merged item keeps its title');
});

// ------------------------------------------------------- FAQ, builder-agnostic

test('questions are detected by the "?" pattern, not by plugin class names', () => {
  // Elementor's own FAQ page uses a custom widget with no accordion markup at all,
  // and puts the question in a div rather than a heading tag.
  const qa = [
    ['What is Elementor?', 'Elementor is a website builder for WordPress.'],
    ['Does it work with all themes?', 'It works with themes that respect WordPress standards.'],
    ['Does it work with plugins?', 'It works with almost all plugins.'],
    ['Can I edit blog posts?', 'Yes, you can edit any post.']
  ]
    .map(([q, a]) => `<div class="item"><div class="thing--title">${q}</div><div class="thing--body">${a}</div></div>`)
    .join('');
  const { sections } = run(qa);
  const faq = sections.find((s) => s.archetype === 'faq');
  assert.ok(faq, `expected a faq section, got ${sections.map((s) => s.archetype).join(', ')}`);
  assert.equal(faq.slots.items.length, 4);
  assert.equal(faq.slots.items[0].q, 'What is Elementor?');
  assert.ok(
    faq.slots.items.every((i) => i.a && i.a !== i.q),
    'every answer must be present and distinct from its question'
  );
});

// ------------------------------------------------------------------- integrity

test('every emitted archetype exists in the shared vocabulary', () => {
  const { sections } = run('<h1>Title</h1><p>Body copy that is long enough to register as content.</p>');
  for (const s of sections) assert.ok(isArchetype(s.archetype), `emitted unknown archetype ${s.archetype}`);
});

test('carousels are flagged as incomplete rather than scored as whole', () => {
  // Swiper keeps only the active slide in the DOM. Capturing one frame and reporting
  // success is the silent-loss failure this flag exists to prevent.
  const html = '<div class="swiper testimonial"><blockquote>Only slide rendered</blockquote></div>';
  const { sections } = run(html);
  assert.ok(sections.some((s) => s.incompleteCapture), 'carousel must be flagged');
});

// ----------------------------------------------------------------------- media

test('lazy-loaded images are read from data attributes, not the placeholder src', () => {
  const $ = load('<img src="/placeholder.gif" data-src="/real-photo.jpg" alt="Real">');
  const { media } = extractMedia($, $('main'), 'https://x.test/');
  assert.ok(media.some((m) => m.originalUrl.endsWith('/real-photo.jpg')), 'must prefer data-src');
  assert.ok(!media.some((m) => m.originalUrl.includes('placeholder')), 'must not keep the placeholder');
});

test('icon fonts are captured — otherwise feature grids silently lose their icons', () => {
  const $ = load('<div><i class="fas fa-wrench"></i><i class="eicon-shield"></i></div>');
  const { icons } = extractMedia($, $('main'), 'https://x.test/');
  assert.ok(icons.length >= 1, 'icon-font glyphs are content and must be recorded');
});

test('WordPress generated sizes resolve back to the original file', () => {
  assert.equal(originalUrl('https://x.test/a/photo-1024x768.jpg'), 'https://x.test/a/photo.jpg');
  assert.equal(originalUrl('https://x.test/a/photo-scaled.jpg'), 'https://x.test/a/photo.jpg');
  assert.equal(originalUrl('https://i0.wp.com/x.test/a/photo.jpg?w=600'), 'https://x.test/a/photo.jpg');
});

// ----------------------------------------------------------------------- forms

test('form fields are extracted with the label tier recorded', () => {
  const $ = load(`
    <form class="wpcf7-form" action="/wp-json/contact-form-7/v1/x/feedback" method="post">
      <label for="n">Your Name</label><input id="n" name="your-name" type="text" required>
      <span class="wpcf7-form-control-wrap"><input name="your-email" type="email"></span>
      <input type="submit" value="Send Message">
    </form>`);
  const [form] = extractForms($, $('main'), 'https://x.test/');
  assert.equal(form.plugin, 'cf7');
  assert.equal(form.submitLabel, 'Send Message');
  const named = form.fields.find((f) => f.name === 'your-name');
  assert.equal(named.label, 'Your Name');
  assert.equal(named.labelConfidence, 'for_attr', 'a real for/id pair is the trustworthy tier');
  assert.equal(named.required, true);
  // The original action points at a WordPress route that will not exist post-migration.
  assert.ok(form.originalAction.includes('wp-json'));
});

test('search forms are not mistaken for lead capture', () => {
  const $ = load('<form role="search"><input name="s" type="search"><input type="submit"></form>');
  assert.equal(extractForms($, $('main'), 'https://x.test/').length, 0);
});

// --------------------------------------------------------------------- builder

test('builder detection prefers a real page builder over ubiquitous Gutenberg markup', () => {
  assert.equal(detectBuilderFromHtml('<div class="wp-block-group elementor-kit-9">'), 'elementor');
  assert.equal(detectBuilderFromHtml('<div class="wp-block-group">'), 'gutenberg');
  assert.equal(detectBuilderFromHtml('<div class="plain">'), null);
});

test('elementor widget types map through data-widget_type', () => {
  const $ = load('<div class="elementor-widget" data-widget_type="icon-box.default"></div>');
  assert.equal(widgetType('elementor', $('.elementor-widget'), $), 'feature');
});

test('divi widget types map through class tokens', () => {
  const $ = load('<div class="et_pb_module et_pb_testimonial"></div>');
  assert.equal(widgetType('divi', $('.et_pb_module'), $), 'testimonial');
});

test('srcset parsing survives commas inside the URL', () => {
  // Cloudflare Image Resizing puts its options in the path: /cdn-cgi/image/f=auto,w=632/
  // Splitting on every comma shredded these and every download 404'd.
  const ss =
    'https://x.test/cdn-cgi/image/f=auto,w=632/wp-content/uploads/a-632x360.webp 632w, ' +
    'https://x.test/cdn-cgi/image/f=auto,w=1688/wp-content/uploads/a-1688x960.webp 1688w';
  const parsed = parseSrcset(ss);
  assert.equal(parsed.length, 2, 'two candidates, not four fragments');
  assert.ok(parsed.every((c) => c.url.startsWith('https://x.test/cdn-cgi/')), 'URLs must stay intact');
  assert.equal(parsed[1].width, 1688);
});

test('CDN resize wrappers unwrap to the full-resolution original', () => {
  assert.equal(
    originalUrl('https://x.test/cdn-cgi/image/f=auto,w=632/wp-content/uploads/a-632x360.webp'),
    'https://x.test/wp-content/uploads/a.webp'
  );
});
