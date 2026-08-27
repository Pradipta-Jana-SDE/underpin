import * as cheerio from 'cheerio';
import { get, mapLimit } from '../util/http.js';
import { originalUrl } from './media.js';

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
const absUrl = (s, base) => { try { return new URL(s, base).toString(); } catch { return null; } };

/** Colours declared as CSS custom properties are intentional; sampled colours are guesses. */
function paletteFromCss(cssText) {
  const found = new Map();
  const varRe = /--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\))/gi;
  let m;
  while ((m = varRe.exec(cssText))) {
    const name = m[1].toLowerCase();
    const value = m[2].toLowerCase();
    const roles = [];
    if (/primary|brand|accent|main/.test(name)) roles.push('primary');
    if (/secondary/.test(name)) roles.push('secondary');
    if (/text|foreground|body/.test(name)) roles.push('text');
    if (/bg|background|surface/.test(name)) roles.push('background');
    const prev = found.get(value) ?? { hex: value, weight: 0, roles: [] };
    prev.weight += roles.length ? 3 : 1;
    prev.roles = [...new Set([...prev.roles, ...roles])];
    found.set(value, prev);
  }
  return [...found.values()].sort((a, b) => b.weight - a.weight);
}

function fontsFrom($, cssText) {
  const googleFonts = [];
  $('link[href*="fonts.googleapis.com"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    for (const m of href.matchAll(/family=([^&:]+)/g)) googleFonts.push(decodeURIComponent(m[1]).replace(/\+/g, ' '));
  });
  const faces = [...cssText.matchAll(/@font-face\s*{[^}]*font-family\s*:\s*['"]?([^;'"}]+)/gi)].map((m) => clean(m[1]));
  const stacks = [...cssText.matchAll(/font-family\s*:\s*([^;}]+)/gi)].map((m) => clean(m[1]));

  const score = new Map();
  for (const s of stacks) {
    const first = s.split(',')[0].replace(/['"]/g, '').trim();
    if (!first || /^(inherit|initial|unset|var)/i.test(first)) continue;
    score.set(first, (score.get(first) ?? 0) + 1);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  return {
    heading: googleFonts[0] ?? ranked[0] ?? null,
    body: googleFonts[1] ?? ranked[1] ?? ranked[0] ?? null,
    googleFonts: [...new Set(googleFonts)],
    webfonts: [...new Set(faces)]
  };
}

function navTree($, $scope, baseUrl) {
  const walk = ($ul, depth) => {
    const items = [];
    $ul.children('li').each((i, li) => {
      // Themes wrap the anchor in spans and divs constantly; `children` is too strict.
      const $a = $(li).find('a[href]').first();
      const href = $a.attr('href');
      const label = clean($a.text());
      if (!label) return;
      const $sub = $(li).children('ul').first();
      items.push({
        label,
        href: absUrl(href, baseUrl) ?? href ?? '#',
        order: i + 1,
        children: depth < 2 && $sub.length ? walk($sub, depth + 1) : []
      });
    });
    return items;
  };
  // Largest top-level <ul> inside the nav is almost always the real menu.
  let best = null;
  $scope.find('ul').each((_, ul) => {
    const count = $(ul).children('li').length;
    if (count >= 2 && (!best || count > best.count) && $(ul).parents('ul').length === 0) {
      best = { el: ul, count };
    }
  });
  // An empty walk means the markup did not match the <li><a> shape — fall through to
  // the anchor scan rather than returning nothing.
  if (best) {
    const fromUl = walk($(best.el), 0);
    if (fromUl.length) return fromUl;
  }

  // Mega-menu widgets (Elementor's among them) often render no <ul> at all. Fall back
  // to the header's own anchors, de-duplicated and stripped of utility links.
  const seen = new Set();
  const items = [];
  $scope.find('a[href]').each((_, a) => {
    const $a = $(a);
    // Mega-menu anchors concatenate a title and its description into one text node
    // ("Build with Editor Drag & drop…"). The first child element holds the real label.
    const $first = $a.find('h1,h2,h3,h4,h5,h6,strong,b').first();
    const childText = clean($first.text());
    const ownText = clean($a.text());
    const label = childText && childText.length <= 48 ? childText : ownText;
    const href = $a.attr('href');
    if (!label || !href || href.startsWith('#') || /^(tel:|mailto:)/i.test(href)) return;
    if (label.length > 48) return;
    if (/logo$/i.test(label)) return;
    if (/^(skip|search|cart|log ?in|sign ?in|sign ?up|menu)$/i.test(label)) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ label, href: absUrl(href, baseUrl) ?? href, order: items.length + 1, children: [] });
  });
  return items.slice(0, 12);
}

function contactFromJsonLd($) {
  const out = { phones: new Set(), emails: new Set(), addresses: new Set(), locations: [] };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== 'object') return;
        if (n['@graph']) walk(n['@graph']);
        const types = [].concat(n['@type'] ?? []);
        if (n.telephone) out.phones.add(String(n.telephone));
        if (n.email) out.emails.add(String(n.email).replace(/^mailto:/, ''));
        // Multi-location businesses emit several LocalBusiness nodes; taking the first
        // match grabs the wrong address, so collect them all.
        if (types.some((t) => /LocalBusiness|Organization|Store|Restaurant|Dentist|Plumber/i.test(t))) {
          const a = n.address ?? {};
          out.locations.push({
            name: clean(n.name ?? ''),
            address: {
              street: clean(a.streetAddress ?? ''),
              locality: clean(a.addressLocality ?? ''),
              region: clean(a.addressRegion ?? ''),
              postalCode: clean(a.postalCode ?? ''),
              country: clean(a.addressCountry?.name ?? a.addressCountry ?? '')
            },
            phone: clean(n.telephone ?? ''),
            email: clean(String(n.email ?? '').replace(/^mailto:/, '')),
            geo: n.geo?.latitude ? { lat: Number(n.geo.latitude), lng: Number(n.geo.longitude) } : null,
            hours: [],
            sourceUrl: null
          });
          if (a.streetAddress) out.addresses.add([a.streetAddress, a.addressLocality, a.postalCode].filter(Boolean).join(', '));
        }
      };
      walk(JSON.parse($(el).text()));
    } catch {}
  });
  return out;
}

/**
 * Derives the shell (header/footer) by intersecting DOM across a stratified sample.
 *
 * Sampling the first N crawled pages undercounts template variety, and single-digit
 * samples false-positive on any block merely reused site-wide — a CTA banner on eight
 * of ten pages is not the shell.
 */
export async function deriveShell(urls, sampleSize = 8) {
  const stratified = [];
  const seenDepth = new Set();
  for (const u of urls) {
    const depth = new URL(u).pathname.split('/').filter(Boolean).length;
    const key = `${depth}`;
    if (!seenDepth.has(key) || stratified.length < sampleSize) {
      seenDepth.add(key);
      stratified.push(u);
    }
    if (stratified.length >= sampleSize) break;
  }

  const fingerprints = await mapLimit(stratified, async (u) => {
    const res = await get(u);
    if (!res.ok) return null;
    const $ = cheerio.load(res.text);
    const sig = (el) => {
      const cls = ($(el).attr('class') ?? '').split(/\s+/).filter((c) => !/\d/.test(c)).slice(0, 3).join('.');
      return `${el.tagName}${$(el).attr('id') ? '#' + $(el).attr('id') : ''}${cls ? '.' + cls : ''}`;
    };
    return {
      header: $('body').children().slice(0, 3).map((_, el) => sig(el)).get(),
      footer: $('body').children().slice(-3).map((_, el) => sig(el)).get(),
      headerSel: $('header, [role="banner"], #masthead').first().length
        ? sig($('header, [role="banner"], #masthead').first()[0]) : null,
      footerSel: $('footer, [role="contentinfo"], #colophon').first().length
        ? sig($('footer, [role="contentinfo"], #colophon').first()[0]) : null
    };
  }, 3);

  const valid = fingerprints.filter(Boolean);
  const mode = (arr) => {
    const c = new Map();
    for (const v of arr.filter(Boolean)) c.set(v, (c.get(v) ?? 0) + 1);
    const [best] = [...c.entries()].sort((a, b) => b[1] - a[1]);
    return best ? { value: best[0], ratio: best[1] / valid.length } : { value: null, ratio: 0 };
  };

  const h = mode(valid.map((f) => f.headerSel));
  const f = mode(valid.map((f) => f.footerSel));

  return {
    headerSelector: h.ratio >= 0.75 ? h.value : null,
    footerSelector: f.ratio >= 0.75 ? f.value : null,
    derivedFromNPages: valid.length,
    method: 'stratified_dom_intersection',
    threshold: 0.75,
    confidence: Number(Math.min(h.ratio, f.ratio).toFixed(2))
  };
}

/** Builds the site-level IR: brand, navigation, footer, contact, locations, shell. */
export async function extractBranding(origin, urls) {
  const home = await get(origin + '/');
  const $ = cheerio.load(home.text ?? '');

  // Pull the first few stylesheets so custom properties and @font-face are visible.
  const sheets = $('link[rel="stylesheet"][href]')
    .map((_, el) => absUrl($(el).attr('href'), origin))
    .get()
    .filter(Boolean)
    .slice(0, 6);
  const cssParts = await mapLimit(sheets, async (u) => (await get(u, { accept: 'text/css' })).text ?? '', 3);
  const inline = $('style').map((_, el) => $(el).text()).get().join('\n');
  const cssText = inline + '\n' + cssParts.join('\n');

  const palette = paletteFromCss(cssText);
  const pick = (role) => palette.find((p) => p.roles.includes(role))?.hex ?? null;

  const $header = $('header, [role="banner"], #masthead').first();
  const $footer = $('footer, [role="contentinfo"], #colophon').first();

  // Logo resolution.
  //
  // Two traps here, both hit on real sites. og:image is a social share image — on
  // elementor.com it is a photograph of a person, and using it as the logo put a
  // stranger's face in the header of every page. And `[class*="logo"] img` is too
  // broad: any ancestor container with "logo" somewhere in its class tree drags in
  // whatever image it happens to wrap. A missing logo is better than a confidently
  // wrong one — SiteHeader falls back to the site name as text.
  const looksLikeLogo = (u) => !!u && (/logo|brand|mark|icon/i.test(u) || /\.svg(\?|$)/i.test(u));

  // Image candidates are scoped to the header. Searching the whole document found
  // tripadvisor.svg on kinsta.com — a CLIENT logo from a logo wall, not the site's own.
  // <head> link tags stay document-wide because they are unambiguous by definition.
  const $chrome = $header.length ? $header : $('[role="banner"], #masthead, .site-header').first();
  const inChrome = (sel) => ($chrome.length ? $chrome.find(sel).first().attr('src') : undefined);

  const logoCandidates = [
    { source: 'wp_custom_logo', url: $('.custom-logo').first().attr('src'), trusted: true },
    { source: 'logo_img_class', url: inChrome('img[class*="logo" i]'), trusted: true },
    { source: 'logo_alt_text', url: inChrome('img[alt*="logo" i]'), trusted: true },
    { source: 'apple_touch_icon', url: $('link[rel="apple-touch-icon"]').attr('href'), trusted: true },
    { source: 'icon_link', url: $('link[rel="icon"], link[rel="shortcut icon"]').first().attr('href'), trusted: true },
    // Only accept the loose container match when the file itself reads as a logo.
    { source: 'header_img', url: inChrome('img'), trusted: false }
  ].filter((c) => c.url && (c.trusted || looksLikeLogo(c.url)));

  const chosenLogo = logoCandidates[0] ?? null;
  const logo = chosenLogo?.url ?? null;
  const logoSource = chosenLogo?.source ?? 'not_found';

  const contact = contactFromJsonLd($);

  // Fall back to tel:/mailto: links when the site emits no structured data.
  $('a[href^="tel:"]').each((_, el) => contact.phones.add($(el).attr('href').replace('tel:', '').trim()));
  $('a[href^="mailto:"]').each((_, el) => contact.emails.add($(el).attr('href').replace('mailto:', '').trim()));

  const shell = await deriveShell(urls.slice(0, 40).map((u) => u.loc ?? u), 8);

  const sources = {
    colors: palette.length ? 'css_custom_properties' : 'none',
    fonts: $('link[href*="fonts.googleapis.com"]').length ? 'google_fonts_link' : 'computed_stacks',
    logo: logoSource,
    contact: contact.locations.length ? 'jsonld' : 'link_scrape'
  };

  return {
    siteUrl: origin,
    siteName: clean($('meta[property="og:site_name"]').attr('content') ?? $('title').text().split(/[|\-–]/)[0]),
    detectedBuilder: null,
    restReachable: false,
    pluginFingerprint: [],
    brand: {
      colors: {
        primary: pick('primary') ?? palette[0]?.hex ?? null,
        secondary: pick('secondary') ?? palette[1]?.hex ?? null,
        accent: palette[2]?.hex ?? null,
        text: pick('text'),
        background: pick('background'),
        palette: palette.slice(0, 16)
      },
      fonts: fontsFrom($, cssText),
      logo: {
        default: logo ? originalUrl(absUrl(logo, origin)) : null,
        darkVariant: null,
        favicon: absUrl($('link[rel="icon"], link[rel="shortcut icon"]').first().attr('href'), origin),
        appleTouchIcon: absUrl($('link[rel="apple-touch-icon"]').attr('href'), origin)
      },
      radii: { button: null, card: null },
      sources
    },
    nav: {
      primary: navTree($, $header.length ? $header : $('nav').first(), origin),
      source: 'dom_parse',
      confidence: $header.length ? 0.8 : 0.5
    },
    footer: {
      columns: [],
      legalLinks: [],
      socialLinks: $footer
        .find('a[href*="facebook"], a[href*="instagram"], a[href*="twitter"], a[href*="linkedin"], a[href*="youtube"]')
        .map((_, el) => {
          const href = $(el).attr('href');
          return { platform: /facebook|instagram|twitter|linkedin|youtube/.exec(href)?.[0] ?? 'link', href };
        })
        .get()
    },
    contact: {
      phones: [...contact.phones].slice(0, 8),
      emails: [...contact.emails].slice(0, 8),
      addresses: [...contact.addresses].slice(0, 12)
    },
    locations: contact.locations.slice(0, 40),
    shell,
    generatedAt: new Date().toISOString()
  };
}
