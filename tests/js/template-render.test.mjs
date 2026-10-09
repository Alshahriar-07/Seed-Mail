// Tests for the browser-side template renderer (frontend/js/lib/render.js).
//
// Run with:  npm test      (node --test tests/js)
//
// These cover the personalisation rules that used to be enforced by the Python
// backend, now that templates are rendered locally in the browser:
// escaping by context, URL validation, unknown-variable reporting and the
// guarantee that a saved template is never mutated.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DESIGN,
  PERSONALIZATION_VARS,
  applyDesign,
  buildPersonalizedHtml,
  cleanDesign,
  isValidEmail,
  isValidUrl,
  missingVariables,
  previewTemplate,
  substituteVariables,
  unknownVariables,
  unresolvedVariables,
  usedVariables,
} from '../../frontend/js/lib/render.js';

const TEMPLATE = '<h2>Hello {{COMPANY_NAME}},</h2>\n'
  + '<a href="{{GITHUB_URL}}">GitHub</a>\n'
  + '<p>{{SENDER_NAME}} &middot; {{SENDER_EMAIL}}</p>\n'
  + '<title>{{SUBJECT}}</title>';

test('substitutes every supported variable', () => {
  const html = buildPersonalizedHtml(TEMPLATE, null, {
    companyName: 'Acme Ltd',
    senderName: 'Sam Sender',
    senderEmail: 'sam@example.com',
    subject: 'A quick note',
    githubUrl: 'https://github.com/example',
  });

  assert.match(html, /Hello Acme Ltd,/);
  assert.match(html, /Sam Sender/);
  assert.match(html, /sam@example\.com/);
  assert.match(html, /A quick note/);
  assert.match(html, /href="https:\/\/github\.com\/example"/);
  assert.ok(!html.includes('{{'), 'no supported token should remain');
});

test('escapes values for text context', () => {
  const html = substituteVariables('<p>{{COMPANY_NAME}}</p>', {
    COMPANY_NAME: '<script>alert(1)</script> & "quoted"',
  });
  assert.ok(!html.includes('<script>'), 'a script tag must never survive substitution');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
  // In text context plain quotes are left as-is.
  assert.match(html, /"quoted"/);
});

test('escapes quotes inside tag attributes', () => {
  const html = substituteVariables('<a title="{{COMPANY_NAME}}">x</a>', {
    COMPANY_NAME: 'Evil " onmouseover="alert(1)',
  });
  assert.ok(!html.includes('onmouseover="alert(1)"'), 'attribute context must escape quotes');
  assert.match(html, /&quot;/);
});

test('URL variables are validated before being placed in an attribute', () => {
  const bad = substituteVariables('<a href="{{GITHUB_URL}}">x</a>', { GITHUB_URL: 'javascript:alert(1)' });
  assert.equal(bad, '<a href="">x</a>');

  const good = substituteVariables('<a href="{{GITHUB_URL}}">x</a>', { GITHUB_URL: 'https://github.com/ok' });
  assert.equal(good, '<a href="https://github.com/ok">x</a>');
});

test('unsupported variables are left untouched and reported', () => {
  const html = '{{COMPANY_NAME}} {{FIRST_NAME}} {{D_ACCENT}}';
  assert.deepEqual(unknownVariables(html), ['FIRST_NAME']);
  const rendered = substituteVariables(html, { COMPANY_NAME: 'Acme' });
  assert.match(rendered, /\{\{FIRST_NAME\}\}/, 'an unknown token must stay visible');
});

test('reports used, missing and unresolved variables', () => {
  assert.deepEqual(usedVariables('{{SUBJECT}} {{COMPANY_NAME}}'), ['COMPANY_NAME', 'SUBJECT']);
  assert.deepEqual(
    missingVariables('{{COMPANY_NAME}}'),
    PERSONALIZATION_VARS.filter((name) => name !== 'COMPANY_NAME'),
  );
  assert.deepEqual(
    unresolvedVariables('{{COMPANY_NAME}} {{SUBJECT}}', { COMPANY_NAME: 'Acme', SUBJECT: '   ' }),
    ['SUBJECT'],
  );
});

test('an invalid sender email resolves to empty instead of leaking', () => {
  // Validation happens when a personalized document is built, exactly like the
  // original server-side renderer.
  assert.equal(buildPersonalizedHtml('<p>{{SENDER_EMAIL}}</p>', null, { senderEmail: 'not-an-email' }), '<p></p>');
  assert.equal(
    buildPersonalizedHtml('<p>{{SENDER_EMAIL}}</p>', null, { senderEmail: 'ok@example.com' }),
    '<p>ok@example.com</p>',
  );
});

test('design tokens are replaced and defaults fill the gaps', () => {
  const rendered = applyDesign(
    '<table style="background:{{D_CONTAINER_BG}}"><td style="color:{{D_PRIMARY_TEXT}}">hi</td></table>',
    { container_bg: '#FF0000', primary_text: '' },
  );
  assert.match(rendered, /background:#FF0000/);
  assert.match(rendered, new RegExp(`color:${DEFAULT_DESIGN.primary_text}`));
});

test('cleanDesign rejects unsafe values and keeps valid ones', () => {
  const cleaned = cleanDesign({
    container_bg: 'javascript:alert(1)',
    font_size: '16',
    logo_url: 'javascript:alert(1)',
    button_label: 'Open',
  });
  assert.equal(cleaned.container_bg, DEFAULT_DESIGN.container_bg, 'a non-colour must be rejected');
  assert.equal(cleaned.font_size, DEFAULT_DESIGN.font_size, 'a size without a unit must be rejected');
  assert.equal(cleaned.logo_url, DEFAULT_DESIGN.logo_url, 'a non-http(s) asset URL must be rejected');
  assert.equal(cleaned.button_label, 'Open');

  const accepted = cleanDesign({ container_bg: '#0A0A0A', font_size: '18px', logo_url: 'https://cdn.example/logo.png' });
  assert.equal(accepted.container_bg, '#0A0A0A');
  assert.equal(accepted.font_size, '18px');
  assert.equal(accepted.logo_url, 'https://cdn.example/logo.png');
});

test('rendering never mutates the source template', () => {
  const source = TEMPLATE;
  buildPersonalizedHtml(source, { container_bg: '#000000' }, { companyName: 'Acme' });
  assert.equal(source, TEMPLATE);
});

test('one recipient cannot leak into another render', () => {
  const first = buildPersonalizedHtml('<p>{{COMPANY_NAME}}</p>', null, { companyName: 'First Co' });
  const second = buildPersonalizedHtml('<p>{{COMPANY_NAME}}</p>', null, { companyName: 'Second Co' });
  assert.equal(first, '<p>First Co</p>');
  assert.equal(second, '<p>Second Co</p>');
});

test('previewTemplate mirrors the editor contract', () => {
  const result = previewTemplate({ html: '<p>{{COMPANY_NAME}}: {{SUBJECT}}</p>', subject: 'Hi' });
  assert.equal(result.empty, false);
  assert.match(result.html, /Example Company: Hi/);
  assert.deepEqual(result.unknown_variables, []);
  // COMPANY_NAME falls back to the placeholder and SUBJECT was supplied, so
  // nothing is unresolved; the unused variables are reported as missing.
  assert.deepEqual(result.unresolved_variables, []);
  assert.deepEqual(
    result.missing_variables,
    PERSONALIZATION_VARS.filter((name) => !['COMPANY_NAME', 'SUBJECT'].includes(name)),
  );
});

test('an empty document reports empty and renders nothing', () => {
  const result = previewTemplate({ html: '   ' });
  assert.equal(result.empty, true);
  assert.equal(result.html.trim(), '');
});

test('email and URL validation', () => {
  assert.ok(isValidEmail('a@b.co'));
  assert.ok(!isValidEmail('a@b'));
  assert.ok(isValidUrl('https://example.com/x'));
  assert.ok(!isValidUrl('ftp://example.com'));
});
