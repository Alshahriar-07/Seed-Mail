// Tests for frontend/js/lib/email-html.js
//
// Email bodies are untrusted input. These assertions pin the two guarantees the
// reader relies on: dangerous constructs are removed, and remote content is
// blocked unless the user explicitly opts in.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEmailDocument,
  emailPlainText,
  formatBytes,
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
