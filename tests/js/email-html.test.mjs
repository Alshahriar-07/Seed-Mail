// Tests for frontend/js/lib/email-html.js
//
// Email bodies are untrusted input. These assertions pin the two guarantees the
// reader relies on: dangerous constructs are removed, and remote content is
// blocked unless the user explicitly opts in.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addLinkSafety,
  buildEmailDocument,
  emailPlainText,
  formatBytes,
  normaliseContentId,
  resolveInlineImages,
  stripUnsafeMarkup,
} from '../../frontend/js/lib/email-html.js';

test('script, iframe, object, embed, base and form markup is stripped', () => {
  const dirty = `
    <p>hello</p>
    <script>alert(1)</script>
    <iframe src="https://evil.example"></iframe>
    <object data="x"></object>
    <embed src="y">
    <base href="https://evil.example/">
    <form action="https://evil.example"><input name="a"></form>`;
  const clean = stripUnsafeMarkup(dirty);
  assert.ok(!/<script/i.test(clean));
  assert.ok(!/<iframe/i.test(clean));
  assert.ok(!/<object/i.test(clean));
  assert.ok(!/<embed/i.test(clean));
  assert.ok(!/<base/i.test(clean));
  assert.ok(!/<form/i.test(clean));
  assert.ok(clean.includes('<p>hello</p>'), 'legitimate content is preserved');
});

test('remote images are blocked by default', () => {
  const doc = buildEmailDocument({ html: '<img src="https://tracker.example/pixel.gif">' });
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /img-src data:/);
  assert.ok(!doc.includes('img-src * data:'), 'a wildcard image source must not be the default');
  assert.match(doc, /default-src 'none'/);
  assert.match(doc, /script-src 'none'/);
  assert.match(doc, /form-action 'none'/);
  assert.match(doc, /<meta name="referrer" content="no-referrer">/);
});

test('remote images are allowed only when explicitly requested', () => {
  const doc = buildEmailDocument({ html: '<img src="https://cdn.example/logo.png">', allowRemote: true });
  assert.match(doc, /img-src \* data:/);
  assert.match(doc, /script-src 'none'/, 'scripts stay blocked even with images allowed');
});

test('a plain-text-only message is rendered in a pre block, escaped', () => {
  const doc = buildEmailDocument({ text: 'a < b & c > d' });
  assert.ok(doc.includes('a &lt; b &amp; c &gt; d'));
  assert.ok(!doc.includes('a < b'));
});

test('an empty message still produces a valid document', () => {
  const doc = buildEmailDocument({});
  assert.match(doc, /^<!DOCTYPE html>/);
  assert.ok(doc.includes('</html>'));
});

test('emailPlainText prefers a real plain-text part and falls back to HTML', () => {
  assert.equal(emailPlainText({ text: 'plain wins', html: '<p>html</p>' }), 'plain wins');
  assert.ok(emailPlainText({ html: '<p>derived</p>' }).includes('derived'));
});

test('formatBytes describes attachment sizes without inventing one', () => {
  assert.equal(formatBytes(0), '—');
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(1024 * 1024 * 3), '3 MB');
});

// --- inline (cid:) images ----------------------------------------------------
// A `cid:` reference means nothing to a browser, so an embedded image used to
// render as a broken-image icon. The bytes are already in the message payload
// (the backend returns `inline_images`), so they are resolved to a data URL.

test('a cid: image resolves to the inline part it names', () => {
  const html = '<p>logo: <img src="cid:logo-part-1" alt="Logo" width="80"></p>';
  const resolved = resolveInlineImages(html, { 'logo-part-1': 'data:image/png;base64,AAAA' });
  assert.match(resolved, /src="data:image\/png;base64,AAAA"/);
  assert.ok(!resolved.includes('cid:'), 'nothing should be left for the browser to fetch');
  assert.match(resolved, /alt="Logo"/, 'other attributes are untouched');
});

test('content ids are matched across the forms senders actually use', () => {
  const variants = ['<Logo@Example.com>', 'logo@example.com', 'cid:logo@example.com', ' CID:logo@example.com '];
  const map = {};
  for (const key of variants) map[key] = 'data:image/png;base64,ZZZ';
  for (const key of variants) {
    assert.equal(normaliseContentId(key), 'logo@example.com', `${key} should normalise`);
  }
  const html = '<img src="cid:<LOGO@EXAMPLE.COM>"><img src=\'cid:logo@example.com\'>';
  const resolved = resolveInlineImages(html, map);
  assert.equal((resolved.match(/data:image\/png;base64,ZZZ/g) || []).length, 2);
});

test('an inline part that could not be fetched is left as the sender wrote it', () => {
  const html = '<img src="cid:unknown-part">';
  assert.equal(resolveInlineImages(html, { other: 'data:image/png;base64,AAAA' }), html);
  assert.equal(resolveInlineImages(html, {}), html);
});

test('only the img src attribute is touched, never a link or text', () => {
  const html = '<a href="cid:not-a-link">text cid:inline</a>';
  assert.equal(resolveInlineImages(html, { 'not-a-link': 'data:image/png;base64,AAAA' }), html);
});

// --- links -------------------------------------------------------------------

test('every anchor gets target and rel so a new tab cannot reach back', () => {
  const html = '<a href="https://example.com/x">a</a><a href="https://example.com/y" rel="nofollow">b</a>';
  const safe = addLinkSafety(html);
  assert.equal((safe.match(/target="_blank"/g) || []).length, 2);
  assert.equal((safe.match(/noopener/g) || []).length, 2);
  assert.equal((safe.match(/noreferrer/g) || []).length, 2);
  assert.match(safe, /rel="nofollow noopener noreferrer"/, 'an existing rel keeps its own tokens');
});

test('a confirmation link keeps every character of its query string', () => {
  const href = 'https://app.example.com/verify?token=eyJhbGciOiJIUzI1NiJ9.abc&amp;redirect=%2Fdashboard%3Ftab%3Dsettings&amp;utm_source=email';
  const safe = addLinkSafety(`<a href="${href}">Confirm</a>`);
  assert.ok(safe.includes(href), 'the URL must survive byte for byte - no rewriting, no truncation');
});

test('an anchor inside the whole document keeps its href and gains the attributes', () => {
  const document = buildEmailDocument({
    html: '<a href="https://example.com/verify?token=abc123">Confirm your address</a>',
  });
  assert.match(document, /href="https:\/\/example\.com\/verify\?token=abc123"/);
  assert.match(document, /rel="noopener noreferrer"/);
  assert.match(document, /<base target="_blank">/);
});

// --- dangerous markup --------------------------------------------------------

test('inline event handlers are removed', () => {
  const dirty = '<p onclick="steal()">a</p><img src="cid:x" onerror="steal()"><body onload="steal()">';
  const clean = stripUnsafeMarkup(dirty);
  assert.ok(!/onclick/i.test(clean));
  assert.ok(!/onerror/i.test(clean));
  assert.ok(!/onload/i.test(clean));
  assert.match(clean, /<p>a<\/p>/, 'the element and its text stay');
});

test('javascript:, vbscript: and data:text/html URLs are dropped, https is not', () => {
  const dirty = '<a href="javascript:alert(1)">a</a><a href="VBSCRIPT:msgbox">b</a>'
    + '<a href="data:text/html;base64,PHNjcmlwdD4=">c</a><a href="https://example.com/ok?x=1">d</a>'
    + '<img src="data:image/png;base64,AAAA">';
  const clean = stripUnsafeMarkup(dirty);
  assert.ok(!/javascript:/i.test(clean));
  assert.ok(!/vbscript:/i.test(clean));
  assert.ok(!/data:text\/html/i.test(clean));
  assert.match(clean, /href="https:\/\/example\.com\/ok\?x=1"/, 'a legitimate link is untouched');
  assert.match(clean, /src="data:image\/png;base64,AAAA"/, 'an image data URL stays');
  assert.match(clean, />a<\/a>/, 'the link text remains even when its target is dropped');
});

test('an obfuscated scheme is still caught', () => {
  const clean = stripUnsafeMarkup('<a href="java&#x73;cript:alert(1)">x</a><a href="&colon;javascript:alert(1)">y</a>');
  assert.ok(!/&#x73;cript|javascript:/i.test(clean));
});

test('rendering the reader document strips handlers and keeps something readable', () => {
  const document = buildEmailDocument({
    html: '<div onclick="x()"><p>Hello</p></div>',
    text: 'Hello',
  });
  assert.ok(!/onclick/i.test(document));
  assert.match(document, /<p>Hello<\/p>/);
});

test('a message with only a plain-text part still renders without an HTML body', () => {
  const document = buildEmailDocument({ text: 'line one\nline two & <tags>' });
  assert.match(document, /<pre class="seedmail-plain">/);
  assert.match(document, /line one/);
  assert.ok(!document.includes('<tags>'), 'plain text must stay escaped');
});
