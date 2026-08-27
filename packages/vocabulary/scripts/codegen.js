#!/usr/bin/env node
/**
 * Generates TypeScript types from sections.vocabulary.json.
 *
 * This is the mechanism that turns vocabulary drift into a build-time error:
 * every layer imports these types, so renaming or removing an archetype breaks
 * the consumers' build instead of silently going stale.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const vocab = JSON.parse(readFileSync(join(root, 'sections.vocabulary.json'), 'utf8'));

const q = (s) => JSON.stringify(s);
const union = (arr) => (arr.length ? arr.map(q).join(' | ') : 'never');

const variantType = (variants) => {
  const entries = Object.entries(variants ?? {});
  if (!entries.length) return 'Record<string, never>';
  const fields = entries.map(([k, v]) => {
    const t = v === 'int' ? 'number' : Array.isArray(v) ? union(v) : 'string';
    return `    ${k}?: ${t};`;
  });
  return `{\n${fields.join('\n')}\n  }`;
};

const lines = [];
lines.push('// GENERATED FILE — do not edit.');
lines.push('// Source: sections.vocabulary.json · regenerate with `npm run build -w @underpin/vocabulary`');
lines.push('');
lines.push(`export type ArchetypeId =\n  | ${vocab.archetypes.map((a) => q(a.id)).join('\n  | ')};`);
lines.push('');
lines.push('export interface ArchetypeVariants {');
for (const a of vocab.archetypes) lines.push(`  ${q(a.id)}: ${variantType(a.variants)};`);
lines.push('}');
lines.push('');
lines.push('/** A section as it appears in the page IR, discriminated on `archetype`. */');
lines.push('export type Section = {');
lines.push('  [K in ArchetypeId]: {');
lines.push('    id: string;');
lines.push('    order: number;');
lines.push('    archetype: K;');
lines.push('    variant: ArchetypeVariants[K];');
lines.push('    confidence: number;');
lines.push("    decidedBy: 'builder_map' | 'rule' | 'llm' | 'human';");
lines.push('    slots: Record<string, unknown>;');
lines.push('    mediaRefs?: string[];');
lines.push('    style?: SectionStyle;');
lines.push('    sourceSelector?: string;');
lines.push('  };');
lines.push('}[ArchetypeId];');
lines.push('');
lines.push('/** The seven computed properties we keep. Deliberately small — see docs/decisions.md #13. */');
lines.push('export interface SectionStyle {');
lines.push('  bgColor: string | null;');
lines.push('  bgImage: string | null;');
lines.push('  textColor: string | null;');
lines.push("  textAlign: 'left' | 'center' | 'right' | null;");
lines.push('  containerWidth: number | null;');
lines.push('  paddingBlock: { top: number; bottom: number } | null;');
lines.push('  isDark: boolean;');
lines.push('}');
lines.push('');
lines.push('export interface Vocabulary {');
lines.push('  version: number;');
lines.push('  archetypes: Array<{');
lines.push('    id: ArchetypeId;');
lines.push('    label: string;');
lines.push('    component: string;');
lines.push('    variants?: Record<string, string[] | "int">;');
lines.push('    slots?: { required?: string[]; optional?: string[] };');
lines.push('    detect?: {');
lines.push('      position?: string;');
lines.push('      builderTypes?: string[];');
lines.push('      heuristics?: string[];');
lines.push('      jsonld?: string[];');
lines.push('      pluginMarkup?: string[];');
lines.push('      requiresCapability?: string;');
lines.push('    };');
lines.push('    carousel?: boolean;');
lines.push('    isFallback?: boolean;');
lines.push('  }>;');
lines.push('}');
lines.push('');

mkdirSync(join(root, 'src/generated'), { recursive: true });
const out = join(root, 'src/generated/vocabulary.d.ts');
writeFileSync(out, lines.join('\n'));

// Also emit a plain-JS enum guard the runtime can import without a TS build.
const runtime = `// GENERATED FILE — do not edit. Source: sections.vocabulary.json
export const ARCHETYPE_IDS = ${JSON.stringify(vocab.archetypes.map((a) => a.id))};
export const COMPONENT_BY_ARCHETYPE = ${JSON.stringify(
  Object.fromEntries(vocab.archetypes.map((a) => [a.id, a.component])),
  null,
  2
)};
`;
writeFileSync(join(root, 'src/generated/vocabulary.js'), runtime);

console.log(`vocabulary codegen: ${vocab.archetypes.length} archetypes -> src/generated/`);
