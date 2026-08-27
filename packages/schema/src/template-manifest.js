import { z } from 'zod';
import { ARCHETYPE_IDS } from '@underpin/vocabulary';

/**
 * A template is a manifest plus a React component. The manifest is what the matcher
 * scores against; the component only ever receives typed props.
 */
export const TemplateManifest = z.object({
  id: z.string(),
  label: z.string(),
  pageType: z.string(),
  /** Ordered archetype sequence — the template's own fingerprint. */
  sections: z.array(
    z.object({
      archetype: z.enum(ARCHETYPE_IDS),
      variant: z.record(z.string(), z.unknown()).default({}),
      required: z.boolean().default(false)
    })
  ),
  /** Where unmatched content lands so nothing is silently lost. */
  hasFlexibleZone: z.boolean().default(true)
});

export function templateFingerprint(manifest) {
  return manifest.sections.map((s) => s.archetype);
}

export function requiredArchetypes(manifest) {
  return manifest.sections.filter((s) => s.required).map((s) => s.archetype);
}
