import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTemplates, mapToTemplate, scoreTemplate } from '../src/match/index.js';
import { stage0, stage1 } from '../src/classify/index.js';
import { TEMPLATES, TEMPLATES_BY_ID, templatesForType } from '@underpin/templates/manifests';
import { isArchetype } from '@underpin/vocabulary';

const sec = (archetype, slots = {}) => ({
  id: archetype, order: 1, archetype, variant: {}, confidence: 0.8,
  decidedBy: 'rule', slots, mediaRefs: [], incompleteCapture: false
});
const page = (archetypes, extra = {}) => ({
  path: '/p/', slug: 'p', seo: { title: '', schemaTypes: [] },
  links: { internal: [] }, sections: archetypes.map((a) => sec(a)), ...extra
});

test('every template section references a real archetype', () => {
  for (const t of TEMPLATES)
    for (const s of t.sections)
      assert.ok(isArchetype(s.archetype), `${t.id} references unknown archetype ${s.archetype}`);
});

test('the catch-all template can never report a mismatch', () => {
  // GenericPage is where a page lands when nothing else fits. If it had required
  // sections it would flag the very pages it exists to rescue.
  const generic = TEMPLATES_BY_ID.GenericPage;
  assert.equal(generic.sections.filter((s) => s.required).length, 0);
  assert.equal(generic.hasFlexibleZone, true);
  const r = scoreTemplate(page(['faq', 'logo_wall']), generic);
  assert.equal(r.missingRequired.length, 0);
});

test('every page type resolves to at least one candidate template', () => {
  for (const type of ['home', 'service', 'about', 'location', 'contact', 'nonsense_type'])
    assert.ok(templatesForType(type).length > 0, `${type} has no candidate template`);
});

test('the matcher discriminates between two templates of the same page type', () => {
  // The brief asks for multiple service templates and a recommendation. If both scored
  // the same the recommendation would be arbitrary.
  const splitHero = page(['hero', 'text_media', 'feature_grid', 'faq', 'cta_band']);
  const ranked = rankTemplates(splitHero, 'service');
  assert.equal(ranked[0].templateId, 'ServiceSplitHero');
  assert.ok(
    ranked[0].confidence - ranked[1].confidence >= 15,
    `expected a clear winner, got ${ranked[0].confidence} vs ${ranked[1].confidence}`
  );
});

test('a long-form service page prefers the long-form template', () => {
  const longForm = page(['hero', 'rich_text', 'text_media', 'stats_strip', 'testimonial', 'cta_band']);
  assert.equal(rankTemplates(longForm, 'service')[0].templateId, 'ServiceLongForm');
});

test('extra sections render in the flexible zone rather than blocking the build', () => {
  const busy = page(['hero', 'text_media', 'faq', 'logo_wall', 'stats_strip', 'team_grid']);
  const m = mapToTemplate(busy, 'ServiceSplitHero');
  assert.equal(m.leftover.length, 0, 'a template with a flexible zone must not orphan content');
  assert.ok(m.flexible.length > 0, 'the spare sections must actually be placed somewhere');
  const accounted = m.placed.length + m.flexible.length;
  assert.equal(accounted, busy.sections.length, 'every source section must be accounted for');
});

test('no section is ever silently dropped, whatever template is forced', () => {
  const busy = page(['hero', 'text_media', 'faq', 'logo_wall', 'stats_strip', 'pricing_table']);
  for (const t of TEMPLATES) {
    const m = mapToTemplate(busy, t.id);
    const accounted = m.placed.length + m.flexible.length + m.leftover.length;
    assert.equal(accounted, busy.sections.length, `${t.id} lost ${busy.sections.length - accounted} section(s)`);
  }
});

test('a missing required section is named, not just scored', () => {
  const thin = page(['rich_text']);
  const r = scoreTemplate(thin, TEMPLATES_BY_ID.ContactSimple);
  assert.ok(r.missingRequired.includes('hero'));
  assert.ok(r.missingRequired.includes('contact_panel'));
  assert.ok(r.confidence < 60, 'a page missing every required section must not score well');
});

// ------------------------------------------------------------------- classify

test('stage 0 is deterministic and survives a blocked REST API', () => {
  // body_class() output is baked into rendered HTML by the theme, so these hold even
  // when a security plugin has taken /wp-json offline entirely.
  assert.equal(stage0(page([]), { bodyClass: 'error404 wp-theme-x' }).type, 'not_found');
  assert.equal(stage0({ ...page([]), path: '/' }, { bodyClass: '' }).type, 'home');
  assert.equal(stage0(page([]), { bodyClass: 'single-post postid-4' }).type, 'blog_post');
  assert.equal(stage0(page([]), { bodyClass: 'page page-id-9' }), null, 'an ordinary page falls through to stage 1');
});

test('services index and a service child are told apart', () => {
  const idx = stage1({ ...page(['hero', 'feature_grid']), path: '/services/', slug: 'services' }, {});
  const child = stage1({ ...page(['hero', 'text_media']), path: '/services/roof-repair/', slug: 'roof-repair' }, {});
  assert.equal(idx.type, 'service_index');
  assert.equal(child.type, 'service');
});

test('an unrecognisable page is routed to review, not guessed at', () => {
  const r = stage1({ ...page(['rich_text']), path: '/xyzzy/', slug: 'xyzzy' }, {});
  assert.ok(r.confidence < 0.85, 'must not claim confidence it has not earned');
});
