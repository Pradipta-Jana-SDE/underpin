import { TEMPLATES_BY_ID, templatesForType } from '@underpin/templates/manifests';

/** Multiset counts of archetypes. */
const census = (list) => {
  const c = {};
  for (const a of list) c[a] = (c[a] ?? 0) + 1;
  return c;
};

/**
 * Weighted Jaccard over archetype multisets. Required sections count double, because
 * missing the one section a template is built around matters more than missing a
 * decorative logo strip.
 */
function setScore(pageArche, tpl) {
  const p = census(pageArche);
  const t = census(tpl.sections.map((s) => s.archetype));
  const required = new Set(tpl.sections.filter((s) => s.required).map((s) => s.archetype));

  // With a flexible zone the template can absorb anything the page has spare, so scoring
  // over the union would punish a template for the page being long — which is not a
  // mismatch. Score over the template's own shape instead: how much of what this
  // template is FOR can the page actually supply.
  const keys = tpl.hasFlexibleZone
    ? new Set(Object.keys(t))
    : new Set([...Object.keys(p), ...Object.keys(t)]);

  let inter = 0;
  let union = 0;
  for (const k of keys) {
    const w = required.has(k) ? 2 : 1;
    inter += w * Math.min(p[k] ?? 0, t[k] ?? 0);
    union += w * Math.max(p[k] ?? 0, t[k] ?? 0);
  }
  return union === 0 ? 0 : inter / union;
}

/** Fraction of the template's required archetypes the page can actually supply. */
function slotScore(pageArche, tpl) {
  const required = tpl.sections.filter((s) => s.required).map((s) => s.archetype);
  if (!required.length) return 1;
  const available = census(pageArche);
  const need = census(required);
  let satisfied = 0;
  for (const [a, n] of Object.entries(need)) satisfied += Math.min(available[a] ?? 0, n);
  return satisfied / required.length;
}

/**
 * Order agreement via inversion count over the matched subsequence.
 *
 * A cheap penalty rather than full sequence alignment: weighted Jaccard plus the
 * required-slot check already carries most of the signal, and hand-tuning a
 * substitution matrix is bioinformatics-grade machinery for a fifteen-tag vocabulary.
 */
function orderScore(pageArche, tpl) {
  const tplOrder = new Map();
  tpl.sections.forEach((s, i) => {
    if (!tplOrder.has(s.archetype)) tplOrder.set(s.archetype, i);
  });
  const positions = pageArche.map((a) => tplOrder.get(a)).filter((x) => x !== undefined);
  if (positions.length < 2) return 1;

  let inversions = 0;
  for (let i = 0; i < positions.length; i++)
    for (let j = i + 1; j < positions.length; j++) if (positions[i] > positions[j]) inversions++;

  const max = (positions.length * (positions.length - 1)) / 2;
  return max === 0 ? 1 : 1 - inversions / max;
}

export function scoreTemplate(page, tpl) {
  const arche = page.sections.map((s) => s.archetype);
  const sSet = setScore(arche, tpl);
  const sSlot = slotScore(arche, tpl);
  const sOrder = orderScore(arche, tpl);
  const score = 0.55 * sSet + 0.3 * sSlot + 0.15 * sOrder;

  return {
    templateId: tpl.id,
    label: tpl.label,
    confidence: Math.round(100 * score),
    breakdown: {
      set: Number(sSet.toFixed(3)),
      slot: Number(sSlot.toFixed(3)),
      order: Number(sOrder.toFixed(3))
    },
    // Named so the reviewer sees WHY, not just a number.
    missingRequired: [
      ...new Set(
        tpl.sections
          .filter((s) => s.required && !arche.includes(s.archetype))
          .map((s) => s.archetype)
      )
    ]
  };
}

/** Ranks every template registered for the page's type. */
export function rankTemplates(page, pageType) {
  const candidates = templatesForType(pageType);
  return candidates.map((t) => scoreTemplate(page, t)).sort((a, b) => b.confidence - a.confidence);
}

/**
 * Maps a page's sections into a chosen template's slots.
 *
 * Two rules the acceptance criteria depend on:
 *  - Underflow fills what exists and never fabricates; the shortfall is reported.
 *  - Overflow keeps the first N in source order and routes the remainder to a leftover
 *    bucket that is never deleted. Silently dropping content fails "content and images
 *    are migrated accurately", so the bucket blocks the production build until reviewed.
 */
export function mapToTemplate(page, templateId) {
  const tpl = TEMPLATES_BY_ID[templateId];
  if (!tpl) throw new Error(`Unknown template "${templateId}"`);

  const pool = page.sections.map((s, i) => ({ ...s, _i: i, _used: false }));
  const placed = [];
  const warnings = [];

  for (const slot of tpl.sections) {
    const match = pool.find((s) => !s._used && s.archetype === slot.archetype);
    if (match) {
      match._used = true;
      placed.push({
        slot: slot.archetype,
        variant: { ...slot.variant, ...match.variant },
        from: match.id,
        confidence: match.confidence,
        slots: match.slots,
        mediaRefs: match.mediaRefs,
        incompleteCapture: match.incompleteCapture
      });
    } else if (slot.required) {
      warnings.push({ kind: 'underflow', slot: slot.archetype, detail: `template requires ${slot.archetype}, page has none` });
    }
  }

  const spare = pool.filter((s) => !s._used);

  // Extras land in the flexible zone and still render, in source order. Only a template
  // with no flexible zone sends them to the leftover bucket, which blocks the build.
  const flexible = tpl.hasFlexibleZone
    ? spare.map((s) => ({
        slot: s.archetype,
        variant: s.variant,
        from: s.id,
        confidence: s.confidence,
        slots: s.slots,
        mediaRefs: s.mediaRefs,
        incompleteCapture: s.incompleteCapture,
        inFlexibleZone: true
      }))
    : [];

  const leftover = (tpl.hasFlexibleZone ? [] : spare)
    .map((s) => ({
      sourceOrder: s.order,
      reason: `no ${s.archetype} slot in ${templateId}`,
      html: '',
      text: typeof s.slots.body === 'string' ? s.slots.body.slice(0, 4000) : JSON.stringify(s.slots).slice(0, 4000),
      archetype: s.archetype,
      reviewed: false
    }));

  if (leftover.length) {
    warnings.push({ kind: 'overflow', count: leftover.length, detail: `${leftover.length} section(s) had nowhere to go` });
  }
  if (flexible.length) {
    warnings.push({ kind: 'flexible', count: flexible.length, detail: `${flexible.length} section(s) render in the flexible zone` });
  }

  return { templateId, placed, flexible, leftover, warnings };
}

/** Runs matching across every classified page. */
export function matchAll(pages, classifications) {
  const byUrl = new Map(classifications.map((c) => [c.url, c]));
  return pages.map((page) => {
    const cls = byUrl.get(page.url);
    const pageType = cls?.type ?? 'generic';
    const ranked = rankTemplates(page, pageType);
    const chosen = ranked[0];
    const mapping = mapToTemplate(page, chosen.templateId);
    return {
      url: page.url,
      path: page.path,
      pageType,
      pageTypeConfidence: cls?.confidence ?? 0,
      pageTypeNeedsReview: Boolean(cls?.needsReview),
      chosen: chosen.templateId,
      matchConfidence: chosen.confidence,
      alternatives: ranked.slice(1, 3),
      breakdown: chosen.breakdown,
      missingRequired: chosen.missingRequired,
      flexible: mapping.flexible.length,
      leftover: mapping.leftover,
      warnings: mapping.warnings
    };
  });
}
