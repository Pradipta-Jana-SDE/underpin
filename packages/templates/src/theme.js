/**
 * Turns the extracted brand into CSS custom properties.
 *
 * Every visual decision in the component library reads from these tokens, so re-skinning
 * a site for a different brand is a different token block and nothing else. That is what
 * makes one template library serve many sites — the acceptance criterion that fights
 * hardest with per-site visual fidelity.
 */
const FALLBACK = {
  primary: '#1f2937',
  secondary: '#4b5563',
  accent: '#2563eb',
  text: '#111827',
  muted: '#6b7280',
  bg: '#ffffff',
  surface: '#f7f8fa',
  border: '#e5e7eb'
};

const isColor = (v) => typeof v === 'string' && /^(#|rgb|hsl)/i.test(v.trim());

/** Relative luminance, for deciding readable foregrounds rather than guessing. */
export function luminance(hex) {
  const m = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec((hex ?? '').trim());
  if (!m) return 1;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function readableOn(bg) {
  return luminance(bg) > 0.45 ? '#111827' : '#ffffff';
}

const fontStack = (name, fallback) =>
  name ? `"${String(name).replace(/"/g, '')}", ${fallback}` : fallback;

export function buildTheme(siteIr) {
  const c = siteIr?.brand?.colors ?? {};
  const f = siteIr?.brand?.fonts ?? {};

  // A near-white or near-black "primary" is almost always a text or background colour
  // that frequency analysis mistook for the brand. Fall back rather than theme the whole
  // site in black.
  const pickBrand = (v) => {
    if (!isColor(v)) return null;
    const l = luminance(v);
    return l > 0.92 || l < 0.03 ? null : v;
  };

  const primary = pickBrand(c.primary) ?? pickBrand(c.accent) ?? pickBrand(c.secondary) ?? FALLBACK.accent;
  const accent = pickBrand(c.accent) ?? primary;

  return {
    '--u-primary': primary,
    '--u-primary-fg': readableOn(primary),
    '--u-accent': accent,
    '--u-accent-fg': readableOn(accent),
    '--u-text': isColor(c.text) ? c.text : FALLBACK.text,
    '--u-muted': FALLBACK.muted,
    '--u-bg': isColor(c.background) ? c.background : FALLBACK.bg,
    '--u-surface': FALLBACK.surface,
    '--u-border': FALLBACK.border,
    '--u-font-heading': fontStack(f.heading, 'system-ui, -apple-system, Segoe UI, sans-serif'),
    '--u-font-body': fontStack(f.body ?? f.heading, 'system-ui, -apple-system, Segoe UI, sans-serif'),
    '--u-radius': '10px',
    '--u-maxw': '1140px'
  };
}

export function themeToCss(theme) {
  return `:root{\n${Object.entries(theme).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`;
}
