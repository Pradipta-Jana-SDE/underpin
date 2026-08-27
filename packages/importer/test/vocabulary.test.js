import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHETYPE_IDS, archetype, isArchetype, BUILDER_TYPE_MAP,
  CAROUSEL_ARCHETYPES, FALLBACK_ARCHETYPE, requiredSlots
} from '@underpin/vocabulary';
import { ArchetypeId } from '@underpin/schema';

test('vocabulary is the single source of truth for the schema enum', () => {
  // If these ever diverge, a section could validate in one layer and not another.
  assert.deepEqual([...ArchetypeId.options].sort(), [...ARCHETYPE_IDS].sort());
});

test('unknown archetypes throw loudly rather than degrading silently', () => {
  assert.throws(() => archetype('not_a_real_section'), /Unknown section archetype/);
  assert.equal(isArchetype('hero'), true);
  assert.equal(isArchetype('nope'), false);
});

test('every builder mapping points at an archetype that exists', () => {
  for (const [builderType, id] of Object.entries(BUILDER_TYPE_MAP)) {
    assert.ok(isArchetype(id), `${builderType} maps to unknown archetype "${id}"`);
  }
});

test('carousel archetypes are declared — the render pass must drive these', () => {
  // Swiper/Slick keep only the active slide in the DOM; capturing one frame loses N-1
  // testimonials with no error raised. The vocabulary flags which sections need driving.
  assert.ok(CAROUSEL_ARCHETYPES.includes('testimonial'));
});

test('there is exactly one fallback archetype', () => {
  assert.equal(FALLBACK_ARCHETYPE, 'rich_text');
  assert.deepEqual(requiredSlots('rich_text'), ['body']);
});
