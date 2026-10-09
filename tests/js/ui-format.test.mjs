// Tests for frontend/js/ui.js icon markup + list date formatting.
//
// Two defects these pin, both of which were invisible from the outside:
//
//   1. lucide v1 REPLACES the `<i data-lucide>` host element with an `<svg>`.
//      The size fixup looked for `i[data-lucide] > svg`, which stopped matching,
//      so every icon silently rendered at the library default (24px) instead of
//      the 14-20px the UI asks for. `icon()` now emits a `ui-icon` class that
//      survives the replacement, and CSS targets that class rather than the host
//      tag.
//   2. The mailbox list printed a full date and time in every row, spending
//      ~140px on a column that needs ~50px.

import test from 'node:test';
import assert from 'node:assert/strict';

import { icon, formatDate, formatListDate, escapeHtml } from '../../frontend/js/ui.js';

test('icon() emits a class that survives lucide replacing the host element', () => {
  const html = icon('panel-left-close', 18);
  assert.match(html, /class="ui-icon"/, 'the class is the CSS hook for both states');
  assert.match(html, /data-lucide="panel-left-close"/);
  assert.match(html, /data-size="18"/, 'the requested size must be carried onto the replacement');
  assert.match(html, /aria-hidden="true"/, 'a decorative icon must not be announced');
});

test('icon() defaults to 18px and escapes the name', () => {
  assert.match(icon('mail'), /data-size="18"/);
  assert.ok(!icon('"><script>').includes('<script>'), 'an icon name is attribute-escaped');
});

test('the picker defines exactly one reason for the hook', () => {
  // If this ever changes to a bare tag selector, the icon sizing silently
  // regresses - so the hook is asserted here rather than left to CSS review.
  const css = ['frontend/css/mail.css', 'frontend/css/components.css'];
  return Promise.all(css.map(async (file) => {
    const { readFileSync } = await import('node:fs');
    const path = new URL(`../../${file}`, import.meta.url);
    const text = readFileSync(path, 'utf8');
    assert.ok(!/(^|[\s,>])i\s*\{/m.test(text.replace(/\/\*[\s\S]*?\*\//g, '')), `${file} must not style the icon by its tag`);
  }));
});

test('formatListDate is compact and consistent', () => {
  // Built from LOCAL date parts on purpose: the function compares calendar days
  // in the reader's own timezone, which is what a user sees. A fixed UTC literal
  // would make this test depend on the machine's timezone.
  const now = new Date(2026, 9, 9, 18, 0, 0);

  const today = formatListDate(new Date(now.getTime() - 3 * 3600_000).toISOString(), now);
  assert.match(today, /3:00|15:00/, 'same-day messages show a time');
  assert.ok(today.length <= 10, `expected a short time label, got "${today}"`);

  const thisYear = formatListDate(new Date(2026, 0, 15, 9, 0, 0).toISOString(), now);
  assert.match(thisYear, /Jan\s*15/, 'same-year messages show day and month');
  assert.ok(!thisYear.includes(':'), 'no time is shown for another day');
  assert.ok(thisYear.length <= 12, `expected a short label, got "${thisYear}"`);

  const older = formatListDate(new Date(2025, 5, 4, 9, 0, 0).toISOString(), now);
  assert.match(older, /2025/, 'a different year is spelled out');
});

test('formatListDate degrades without throwing on missing or invalid input', () => {
  assert.equal(formatListDate(''), '');
  assert.equal(formatListDate(null), '');
  assert.equal(formatListDate('not a date'), 'not a date');
});

test('formatDate still prints the full timestamp for a message header', () => {
  const full = formatDate('2026-10-09T14:14:00.000Z');
  assert.match(full, /2026/, 'the message header keeps the year');
  assert.equal(formatDate(''), '—');
});

test('escapeHtml covers the attribute-breaking characters', () => {
  assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});
