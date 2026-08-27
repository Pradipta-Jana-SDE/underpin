import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** @type {import('./generated/vocabulary.js').Vocabulary} */
export const vocabulary = require('../sections.vocabulary.json');

export const ARCHETYPE_IDS = Object.freeze(vocabulary.archetypes.map((a) => a.id));

const byId = new Map(vocabulary.archetypes.map((a) => [a.id, a]));

/** Look up an archetype definition. Throws on unknown ids — drift must be loud. */
export function archetype(id) {
  const found = byId.get(id);
  if (!found) {
    throw new Error(
      `Unknown section archetype "${id}". Known: ${ARCHETYPE_IDS.join(', ')}. ` +
        `Add it to sections.vocabulary.json — every layer reads from that one file.`
    );
  }
  return found;
}

export function isArchetype(id) {
  return byId.has(id);
}

/** The archetype used when nothing else matches. */
export const FALLBACK_ARCHETYPE = vocabulary.archetypes.find((a) => a.isFallback)?.id ?? 'rich_text';

/** Archetypes whose content hides in a carousel — the render pass must drive these before capture. */
export const CAROUSEL_ARCHETYPES = Object.freeze(
  vocabulary.archetypes.filter((a) => a.carousel).map((a) => a.id)
);

/** Archetypes only valid when a capability was detected and kept in scope. */
export function archetypesRequiring(capabilityId) {
  return vocabulary.archetypes.filter((a) => a.detect?.requiresCapability === capabilityId).map((a) => a.id);
}

/**
 * Builder widget type -> archetype id. Built from the vocabulary's own detect.builderTypes,
 * so a builder mapping can never reference an archetype that does not exist.
 * Keys look like "elementor:icon-box.default".
 */
export const BUILDER_TYPE_MAP = Object.freeze(
  Object.fromEntries(
    vocabulary.archetypes.flatMap((a) => (a.detect?.builderTypes ?? []).map((bt) => [bt, a.id]))
  )
);

/** Required slot paths for an archetype, e.g. ["items[].title"]. */
export function requiredSlots(id) {
  return archetype(id).slots?.required ?? [];
}

export function optionalSlots(id) {
  return archetype(id).slots?.optional ?? [];
}
