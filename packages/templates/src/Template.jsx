/**
 * Renders a page: site chrome, the template's fixed section sequence, then the flexible
 * zone. A template is a composition, not a bespoke layout — which is what lets one
 * library serve unrelated brands.
 */
import React from 'react';
import { SECTION_COMPONENTS } from './sections/index.jsx';

function renderSection(entry, i, { media, config }) {
  const Component = SECTION_COMPONENTS[entry.slot];
  if (!Component) {
    // Should be unreachable: CI asserts every vocabulary archetype has a component.
    return null;
  }
  return (
    <Component
      key={`${entry.slot}-${i}`}
      slots={entry.slots ?? {}}
      variant={entry.variant ?? {}}
      media={media}
      config={config}
    />
  );
}

export function SiteHeader({ config }) {
  const nav = config?.navigation?.header ?? [];
  const logo = config?.brand?.logo?.default;
  return (
    <header className="u-header">
      <div className="u-header__inner">
        <a className="u-logo" href="/">
          {logo ? <img src={logo} alt={config?.name ?? 'Home'} /> : (config?.name ?? 'Home')}
        </a>
        {nav.length > 0 && (
          <nav aria-label="Main">
            <ul className="u-nav">
              {nav.slice(0, 8).map((item, i) => (
                <li key={i}><a href={item.href}>{item.label}</a></li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </header>
  );
}

export function SiteFooter({ config }) {
  const { contact = {}, name, navigation = {} } = config ?? {};
  return (
    <footer className="u-footer">
      <div className="u-footer__inner">
        <div>
          <p><strong>{name}</strong></p>
          {contact.phone && <p><a href={`tel:${String(contact.phone).replace(/[^\d+]/g, '')}`}>{contact.phone}</a></p>}
          {contact.email && <p><a href={`mailto:${contact.email}`}>{contact.email}</a></p>}
        </div>
        {(navigation.footer ?? []).length > 0 && (
          <nav aria-label="Footer">
            <ul className="u-nav" style={{ flexDirection: 'column', gap: '.4rem' }}>
              {navigation.footer.slice(0, 10).map((item, i) => (
                <li key={i}><a href={item.href}>{item.label}</a></li>
              ))}
            </ul>
          </nav>
        )}
        <small>
          © {new Date().getFullYear()} {name}. Migrated with Underpin — this site runs no WordPress.
        </small>
      </div>
    </footer>
  );
}

export function PageTemplate({ page, config, showFlexibleZoneLabel = false }) {
  const media = Object.fromEntries((page.media ?? []).map((m) => [m.id, m]));
  const placed = page.placed ?? [];
  const flexible = page.flexible ?? [];

  return (
    <>
      <SiteHeader config={config} />
      <main id="main">
        {placed.map((entry, i) => renderSection(entry, i, { media, config }))}
        {flexible.length > 0 && (
          <div className={showFlexibleZoneLabel ? 'u-flexzone' : undefined}>
            {flexible.map((entry, i) => renderSection(entry, `f${i}`, { media, config }))}
          </div>
        )}
      </main>
      <SiteFooter config={config} />
    </>
  );
}

export default PageTemplate;
