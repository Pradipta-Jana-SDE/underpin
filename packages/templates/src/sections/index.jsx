/**
 * The section component library.
 *
 * One component per archetype in sections.vocabulary.json. Every component is a pure
 * function of (slots, variant) — no data fetching, no WordPress awareness, no global
 * state. All styling reads CSS custom properties emitted from the site config, which is
 * what lets the same component serve two unrelated brands.
 */
import React from 'react';

const cx = (...c) => c.filter(Boolean).join(' ');

/** Resolves a media reference to a URL. Missing media renders nothing, never a broken icon. */
function useMedia(mediaMap) {
  return (ref) => {
    if (!ref) return null;
    const m = mediaMap?.[ref];
    return m?.localPath ?? m?.originalUrl ?? (typeof ref === 'string' && ref.startsWith('http') ? ref : null);
  };
}

function Img({ src, alt = '', width, height, className, priority = false }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      width={width || undefined}
      height={height || undefined}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      className={className}
    />
  );
}

function CTAs({ items = [], tone = 'default' }) {
  const list = (items ?? []).filter((c) => c?.label && c?.href).slice(0, 2);
  if (!list.length) return null;
  return (
    <div className="u-ctas">
      {list.map((c, i) => (
        <a key={i} href={c.href} className={cx('u-btn', i === 0 ? 'u-btn--primary' : 'u-btn--ghost', tone === 'inverted' && 'u-btn--on-dark')}>
          {c.label}
        </a>
      ))}
    </div>
  );
}

function Section({ children, tone = 'default', width = 'contained', className, id }) {
  return (
    <section id={id} className={cx('u-section', `u-tone-${tone}`, className)}>
      <div className={cx('u-inner', width === 'full' && 'u-inner--full', width === 'wide' && 'u-inner--wide')}>
        {children}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ archetypes */

export function Hero({ slots = {}, variant = {}, media }) {
  const m = useMedia(media);
  const img = m(slots.media ?? slots.image);
  const split = variant.layout === 'split' && img;
  return (
    <Section tone={variant.tone ?? 'default'} className={cx('u-hero', split && 'u-hero--split')}>
      <div className="u-hero__copy">
        {slots.eyebrow && <p className="u-eyebrow">{slots.eyebrow}</p>}
        <h1 className="u-h1">{slots.title || slots.heading}</h1>
        {slots.subtitle && <p className="u-lede">{slots.subtitle}</p>}
        <CTAs items={slots.cta} />
      </div>
      {img && (
        <div className="u-hero__media">
          <Img src={img} alt={slots.mediaAlt ?? ''} priority />
        </div>
      )}
    </Section>
  );
}

export function TextMedia({ slots = {}, variant = {}, media }) {
  const m = useMedia(media);
  const img = m(slots.image ?? slots.media);
  const reversed = variant.layout === 'img_left';
  return (
    <Section className={cx('u-textmedia', reversed && 'u-textmedia--rev', !img && 'u-textmedia--solo')}>
      <div className="u-textmedia__copy">
        {slots.heading && <h2 className="u-h2">{slots.heading}</h2>}
        {slots.body && <div className="u-prose">{paragraphs(slots.body)}</div>}
        <CTAs items={slots.cta} />
      </div>
      {img && <div className="u-textmedia__media"><Img src={img} alt="" /></div>}
    </Section>
  );
}

export function FeatureGrid({ slots = {}, variant = {}, media }) {
  const m = useMedia(media);
  const items = slots.items ?? [];
  if (!items.length) return null;
  const cols = Math.min(4, Math.max(2, variant.count ?? (items.length >= 4 ? 3 : items.length)));
  return (
    <Section className="u-features">
      {slots.heading && <h2 className="u-h2 u-center">{slots.heading}</h2>}
      <ul className="u-grid" style={{ '--cols': cols }}>
        {items.map((it, i) => (
          <li key={i} className="u-card">
            {m(it.image) && <Img src={m(it.image)} alt="" className="u-card__img" />}
            {it.title && <h3 className="u-h3">{it.href ? <a href={it.href}>{it.title}</a> : it.title}</h3>}
            {it.body && <p className="u-muted">{it.body}</p>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function Testimonial({ slots = {}, variant = {}, media }) {
  const m = useMedia(media);
  const items = slots.items ?? [];
  if (!items.length) return null;
  return (
    <Section tone="surface" className="u-testimonials">
      {slots.heading && <h2 className="u-h2 u-center">{slots.heading}</h2>}
      <ul className={cx('u-grid', items.length === 1 && 'u-grid--one')} style={{ '--cols': Math.min(3, items.length) }}>
        {items.map((t, i) => (
          <li key={i} className="u-quote">
            <blockquote>{t.quote}</blockquote>
            {(t.author || t.photo) && (
              <figcaption className="u-quote__by">
                {m(t.photo) && <Img src={m(t.photo)} alt="" className="u-avatar" />}
                <span>
                  {t.author}
                  {t.role && <em className="u-muted"> · {t.role}</em>}
                </span>
              </figcaption>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function CTABand({ slots = {}, variant = {} }) {
  return (
    <Section tone="primary" className="u-ctaband">
      <div>
        <h2 className="u-h2">{slots.heading}</h2>
        {slots.subtext && <p className="u-lede">{slots.subtext}</p>}
      </div>
      <CTAs items={slots.cta} tone="inverted" />
    </Section>
  );
}

export function FAQ({ slots = {} }) {
  const items = (slots.items ?? []).filter((i) => i.q);
  if (!items.length) return null;
  return (
    <Section className="u-faq">
      {slots.heading && <h2 className="u-h2">{slots.heading}</h2>}
      <div className="u-faq__list">
        {items.map((it, i) => (
          // <details> gives keyboard support and open/close semantics with no JS at all,
          // which matters because there is no runtime to hydrate an accordion.
          <details key={i} className="u-faq__item">
            <summary>{it.q}</summary>
            <div className="u-prose">{paragraphs(it.a)}</div>
          </details>
        ))}
      </div>
    </Section>
  );
}

export function PricingTable({ slots = {} }) {
  const tiers = slots.tiers ?? slots.items ?? [];
  if (!tiers.length) return null;
  return (
    <Section className="u-pricing">
      {slots.heading && <h2 className="u-h2 u-center">{slots.heading}</h2>}
      <ul className="u-grid" style={{ '--cols': Math.min(4, tiers.length) }}>
        {tiers.map((t, i) => (
          <li key={i} className="u-card u-tier">
            {t.badge && <span className="u-badge">{t.badge}</span>}
            <h3 className="u-h3">{t.name ?? t.title}</h3>
            {t.price && <p className="u-price">{t.price}</p>}
            {Array.isArray(t.features) && (
              <ul className="u-ticks">{t.features.map((f, j) => <li key={j}>{f}</li>)}</ul>
            )}
            <CTAs items={t.cta ? [t.cta] : []} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function StatsStrip({ slots = {} }) {
  const items = slots.items ?? [];
  if (!items.length) return null;
  return (
    <Section tone="surface" className="u-stats">
      <ul className="u-grid" style={{ '--cols': Math.min(4, items.length) }}>
        {items.map((s, i) => (
          <li key={i}>
            <span className="u-stat__value">{s.value}</span>
            <span className="u-muted">{s.label}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function LogoWall({ slots = {}, media }) {
  const m = useMedia(media);
  const items = (slots.items ?? []).filter((i) => m(i.image));
  if (!items.length) return null;
  return (
    <Section tone="surface" className="u-logos">
      {slots.heading && <p className="u-eyebrow u-center">{slots.heading}</p>}
      <ul className="u-logos__row">
        {items.map((l, i) => (
          <li key={i}>
            {l.href ? <a href={l.href}><Img src={m(l.image)} alt={l.alt ?? ''} /></a> : <Img src={m(l.image)} alt={l.alt ?? ''} />}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function TeamGrid({ slots = {}, variant = {}, media }) {
  const m = useMedia(media);
  const items = slots.items ?? [];
  if (!items.length) return null;
  return (
    <Section className="u-team">
      {slots.heading && <h2 className="u-h2 u-center">{slots.heading}</h2>}
      <ul className="u-grid" style={{ '--cols': Math.min(4, variant.count ?? items.length) }}>
        {items.map((p, i) => (
          <li key={i} className="u-card u-person">
            {m(p.photo ?? p.image) && <Img src={m(p.photo ?? p.image)} alt="" className="u-person__photo" />}
            <h3 className="u-h3">{p.name ?? p.title}</h3>
            {p.role && <p className="u-muted">{p.role}</p>}
            {p.bio && <p className="u-muted">{p.bio}</p>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function ContactPanel({ slots = {}, variant = {}, config }) {
  const showForm = variant.layout !== 'map_only' && (slots.fields?.length || variant.layout === 'form_only');
  const showMap = variant.layout !== 'form_only' && slots.map;
  return (
    <Section className="u-contact">
      <div className="u-contact__grid">
        <div>
          {slots.heading && <h2 className="u-h2">{slots.heading}</h2>}
          <ContactDetails config={config} slots={slots} />
        </div>
        {showForm && <FormSection slots={slots} config={config} bare />}
        {showMap && (
          <div className="u-contact__map">
            <iframe src={slots.map} title="Map" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
          </div>
        )}
      </div>
    </Section>
  );
}

function ContactDetails({ config, slots }) {
  const phone = slots.phone ?? config?.contact?.phone;
  const email = slots.email ?? config?.contact?.email;
  const address = slots.address;
  if (!phone && !email && !address) return null;
  return (
    <address className="u-address">
      {address && <p>{address}</p>}
      {phone && <p><a href={`tel:${String(phone).replace(/[^\d+]/g, '')}`}>{phone}</a></p>}
      {email && <p><a href={`mailto:${email}`}>{email}</a></p>}
    </address>
  );
}

/**
 * The form.
 *
 * There is no WordPress backend after migration, so the original action is dead. The
 * form posts to the endpoint in site config; when none is set it degrades to a mailto
 * so the demo never ships a button that silently does nothing.
 */
export function FormSection({ slots = {}, config, bare = false }) {
  const fields = slots.fields ?? [];
  if (!fields.length) return null;
  const endpoint = config?.integrations?.formsEndpoint;
  const fallbackMail = config?.contact?.email;
  const action = endpoint ?? (fallbackMail ? `mailto:${fallbackMail}` : undefined);

  const body = (
    <form className="u-form" action={action} method={endpoint ? 'post' : 'get'} encType={endpoint ? undefined : 'text/plain'}>
      {slots.heading && !bare && <h2 className="u-h2">{slots.heading}</h2>}
      {fields.map((f, i) => {
        const id = `f-${i}-${f.name}`;
        const common = { id, name: f.name, required: f.required, className: 'u-input' };
        return (
          <div key={i} className="u-field">
            <label htmlFor={id}>
              {f.label}
              {f.required && <span aria-hidden="true"> *</span>}
            </label>
            {f.type === 'textarea' ? (
              <textarea {...common} rows={5} />
            ) : f.type === 'select' ? (
              <select {...common}>
                {(f.options ?? []).map((o, j) => <option key={j} value={o}>{o}</option>)}
              </select>
            ) : (
              <input {...common} type={f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text'} />
            )}
          </div>
        );
      })}
      <button type="submit" className="u-btn u-btn--primary">{slots.submitLabel ?? 'Send'}</button>
      {!endpoint && (
        <p className="u-form__note">
          No form endpoint is configured for this site yet, so this form opens a mail client.
          Set <code>integrations.formsEndpoint</code> in site.config to post it instead.
        </p>
      )}
    </form>
  );
  return bare ? body : <Section className="u-formsection">{body}</Section>;
}

export function ContentList({ slots = {}, variant = {}, media }) {
  const m = useMedia(media);
  const items = slots.items ?? [];
  if (!items.length) return null;
  return (
    <Section className="u-list">
      {slots.heading && <h2 className="u-h2">{slots.heading}</h2>}
      <ul className={cx('u-grid', variant.display === 'list' && 'u-grid--rows')} style={{ '--cols': 3 }}>
        {items.map((it, i) => (
          <li key={i} className="u-card">
            {m(it.image) && <Img src={m(it.image)} alt="" className="u-card__img" />}
            <h3 className="u-h3">{it.href ? <a href={it.href}>{it.title}</a> : it.title}</h3>
            {it.date && <p className="u-muted"><time>{it.date}</time></p>}
            {it.excerpt && <p className="u-muted">{it.excerpt}</p>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function ProductCardGrid({ slots = {}, variant = {}, media }) {
  const m = useMedia(media);
  const items = slots.items ?? [];
  if (!items.length) return null;
  return (
    <Section className="u-products">
      {slots.heading && <h2 className="u-h2">{slots.heading}</h2>}
      <ul className="u-grid" style={{ '--cols': Math.min(4, variant.count ?? 3) }}>
        {items.map((p, i) => (
          <li key={i} className="u-card">
            {m(p.image) && <Img src={m(p.image)} alt="" className="u-card__img" />}
            <h3 className="u-h3">{p.href ? <a href={p.href}>{p.title}</a> : p.title}</h3>
            {/* Static catalogue: price shown, no cart. Checkout was decided at scope. */}
            {variant.priceDisplay !== 'hide' && p.price && <p className="u-price">{p.price}</p>}
            {variant.priceDisplay === 'enquire' && <a className="u-btn u-btn--ghost" href="/contact/">Enquire</a>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function RichText({ slots = {} }) {
  if (!slots.body && !slots.heading) return null;
  return (
    <Section className="u-rich">
      {slots.heading && <h2 className="u-h2">{slots.heading}</h2>}
      <div className="u-prose">{paragraphs(slots.body)}</div>
    </Section>
  );
}

/** Splits extracted plain text into paragraphs without trusting source HTML. */
function paragraphs(text) {
  if (!text) return null;
  if (typeof text !== 'string') return null;
  return text
    .split(/\n{2,}|(?<=\.)\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 60)
    .map((p, i) => <p key={i}>{p}</p>);
}

export const SECTION_COMPONENTS = {
  hero: Hero,
  text_media: TextMedia,
  feature_grid: FeatureGrid,
  testimonial: Testimonial,
  cta_band: CTABand,
  faq: FAQ,
  pricing_table: PricingTable,
  stats_strip: StatsStrip,
  logo_wall: LogoWall,
  team_grid: TeamGrid,
  contact_panel: ContactPanel,
  content_list: ContentList,
  product_card_grid: ProductCardGrid,
  form: FormSection,
  rich_text: RichText
};
