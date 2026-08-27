/**
 * Form extraction.
 *
 * A form is not content — it is a contract that must be re-pointed at a new endpoint,
 * because no WordPress backend exists after migration. Extracting the field schema
 * without providing a destination ships a dead button that looks fine until someone
 * clicks it.
 *
 * Label reliability differs sharply by plugin, so we record WHICH tier produced each
 * label rather than pretending they are equally trustworthy.
 */
const PLUGINS = [
  { id: 'cf7', match: '.wpcf7-form, form.wpcf7-form' },
  { id: 'gravity', match: 'form[id^="gform_"], .gform_wrapper form' },
  { id: 'wpforms', match: '.wpforms-form' },
  { id: 'ninja', match: '.nf-form-layout, form.ninja-forms-form' },
  { id: 'formidable', match: '.frm_forms form' },
  { id: 'elementor', match: '.elementor-form' }
];

const humanise = (name) =>
  (name || '')
    .replace(/^(your|the)[-_]/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

function labelFor($, $input, $form) {
  const idAttr = $input.attr('id');

  // Tier 1: proper for/id association. Gravity, WPForms and Elementor Forms do this
  // by default and are near-perfect.
  if (idAttr) {
    const $lab = $form.find(`label[for="${idAttr.replace(/"/g, '\\"')}"]`);
    if ($lab.length && $lab.text().trim()) {
      return { label: $lab.text().trim().replace(/\s*\*$/, ''), tier: 'for_attr' };
    }
  }

  // Tier 2: a wrapping label, or the nearest preceding text. Contact Form 7 only
  // produces association when the site author wrote it by hand, so most CF7 forms
  // land here.
  const $wrap = $input.closest('label');
  if ($wrap.length) {
    const text = $wrap.clone().find('input,select,textarea').remove().end().text().trim();
    if (text) return { label: text.replace(/\s*\*$/, ''), tier: 'positional' };
  }
  const $prev = $input.closest('.wpcf7-form-control-wrap, p, div').prev();
  const prevText = $prev.text?.().trim();
  if (prevText && prevText.length < 80) return { label: prevText.replace(/\s*\*$/, ''), tier: 'positional' };

  // Tier 3: last resort — flagged so a reviewer knows it was invented from the name.
  return { label: humanise($input.attr('name')) || 'Field', tier: 'humanised_name' };
}

export function extractForms($, $scope, baseUrl) {
  const forms = [];
  $scope.find('form').each((_, el) => {
    const $form = $(el);
    // Skip search and login forms — they are navigation, not lead capture.
    if ($form.attr('role') === 'search' || $form.find('input[name="s"]').length) return;
    if ($form.attr('action')?.includes('wp-login')) return;

    const plugin = PLUGINS.find((p) => $form.is(p.match) || $form.closest(p.match).length)?.id ?? 'unknown';

    const fields = [];
    $form.find('input, select, textarea').each((__, f) => {
      const $f = $(f);
      const type = ($f.attr('type') ?? (f.tagName === 'select' ? 'select' : f.tagName === 'textarea' ? 'textarea' : 'text')).toLowerCase();
      const name = $f.attr('name');
      if (!name) return;
      if (['submit', 'button', 'hidden'].includes(type)) return;
      // CF7 and Gravity both ship honeypots; migrating them serves no purpose.
      if (/honeypot|_wpcf7|gform_|^_/i.test(name)) return;

      const { label, tier } = labelFor($, $f, $form);
      const options =
        f.tagName === 'select'
          ? $f.find('option').map((___, o) => $(o).text().trim()).get().filter(Boolean)
          : [];

      fields.push({
        name,
        label,
        type,
        required: $f.is('[required]') || /wpcf7-validates-as-required|gfield_contains_required/.test($f.attr('class') ?? ''),
        options,
        labelConfidence: tier
      });
    });

    if (!fields.length) return;

    const submit = $form.find('input[type=submit], button[type=submit], button:not([type])').first();
    forms.push({
      plugin,
      // Recorded for audit only. It points at a WordPress endpoint that will not exist.
      originalAction: $form.attr('action') ?? null,
      method: ($form.attr('method') ?? 'post').toLowerCase(),
      submitLabel: (submit.attr('value') || submit.text().trim() || 'Submit').slice(0, 60),
      honeypot: $form.find('[name*="honeypot"], .wpcf7-honeypot').length > 0,
      captcha: $form.find('.g-recaptcha, [data-sitekey], .h-captcha').length > 0 ? 'recaptcha' : null,
      fields,
      // Ninja Forms renders its fields client-side, so a static parse sees nothing.
      requiresRender: plugin === 'ninja' && fields.length === 0
    });
  });
  return forms;
}
