// Tests for frontend/js/lib/avatar.js
//
// The avatar defects these pin:
//   * the account chip only ever showed a hardcoded first letter, and a real
//     profile picture (when the account has one) was never displayed;
//   * Gmail sender avatars did not exist at all.
//
// The invariant that matters most is the fallback: an avatar must never end up as
// an empty circle or a broken-image icon, and it must never point at an image URL
// nobody supplied.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  avatarInner,
  avatarMarkup,
  personInitials,
  refreshAvatars,
  safeImageUrl,
} from '../../frontend/js/lib/avatar.js';

// --- a minimal fake element, enough for refreshAvatars ----------------------

function fakeImage({ complete = false, naturalWidth = 1 } = {}) {
  const classes = new Set();
  const host = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    has: (name) => classes.has(name),
  };
  const listeners = {};
  const node = {
    dataset: {},
    complete,
    naturalWidth,
    removed: false,
    addEventListener(type, handler) { listeners[type] = handler; },
    closest() { return host; },
    remove() { this.removed = true; },
    fire(type) { listeners[type]?.(); },
  };
  return { host, node, listeners };
}

const rootOf = (...nodes) => ({ querySelectorAll: () => nodes });

// --- initials ---------------------------------------------------------------

test('a display name yields two initials', () => {
  assert.equal(personInitials('Nadia Okonkwo', 'nadia@example.com'), 'NO');
  assert.equal(personInitials('Ada', ''), 'AD');
  assert.equal(personInitials('  grace   hopper  ', ''), 'GH');
  assert.equal(personInitials('J-P. Sartre', ''), 'JP');
});

test('an address alone yields one letter, never the domain', () => {
  assert.equal(personInitials('', 'ada@example.com'), 'A');
  assert.equal(personInitials('', 'zoe.q@example.com'), 'Z', 'the local part only, never the domain');
  assert.equal(personInitials(undefined, 'x+tag@example.com'), 'X');
});

test('a nameless, addressless avatar degrades to a question mark', () => {
  assert.equal(personInitials('', ''), '?');
  assert.equal(personInitials(null, null), '?');
});

// --- image sources ----------------------------------------------------------

test('only an https, data:image or root-relative source is accepted', () => {
  assert.equal(safeImageUrl('https://lh3.googleusercontent.com/a/photo.jpg'), 'https://lh3.googleusercontent.com/a/photo.jpg');
  assert.equal(safeImageUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(safeImageUrl('/favicon.svg'), '/favicon.svg');
  // An `http:` picture on an https page is mixed content, and a javascript: or
  // protocol-relative value must never reach an attribute.
  assert.equal(safeImageUrl('http://example.com/a.png'), '');
  assert.equal(safeImageUrl('//example.com/a.png'), '');
  assert.equal(safeImageUrl('javascript:alert(1)'), '');
  assert.equal(safeImageUrl(''), '');
  assert.equal(safeImageUrl(undefined), '');
});

// --- markup -----------------------------------------------------------------

test('avatar markup always contains the initials fallback', () => {
  const markup = avatarMarkup({ name: 'Nadia Okonkwo', email: 'nadia@example.com' }, { size: 34 });
  assert.match(markup, /class="avatar avatar-sender/);
  assert.match(markup, /avatar-initials[^>]*>NO</);
  assert.match(markup, /--avatar-size:34px/);
  assert.ok(!markup.includes('<img'), 'no picture is invented when none was supplied');
  assert.match(markup, /aria-label="Nadia Okonkwo"/);
});

test('a supplied picture is rendered on top of its own fallback', () => {
  const markup = avatarMarkup(
    { name: 'Nadia Okonkwo', email: 'nadia@example.com', src: 'https://lh3.googleusercontent.com/a/photo.jpg' },
    { kind: 'account' },
  );
  assert.match(markup, /class="avatar avatar-account has-image"/);
  assert.match(markup, /data-avatar-image/);
  assert.match(markup, /src="https:\/\/lh3\.googleusercontent\.com\/a\/photo\.jpg"/);
  assert.match(markup, /referrerpolicy="no-referrer"/);
  assert.match(markup, /avatar-initials[^>]*>NO</, 'the fallback stays in the DOM');
});

test('a rejected source falls back to initials rather than an empty circle', () => {
  const markup = avatarMarkup({ name: '', email: 'ada@example.com', src: 'javascript:alert(1)' });
  assert.ok(!markup.includes('<img'));
  assert.match(markup, />A</);
});

test('a name is escaped before it reaches an attribute', () => {
  const markup = avatarMarkup({ name: '"><script>alert(1)</script>', email: 'x@example.com' });
  assert.ok(!/<script/i.test(markup), 'the injected tag is never emitted as markup');
  assert.match(markup, /aria-label="&quot;&gt;&lt;script&gt;/, 'the value is entity-escaped');
});

test('avatarInner matches the markup the topbar element consumes', () => {
  const inner = avatarInner({ name: 'Ada Lovelace', email: '' }, { src: 'https://cdn.example/a.png' });
  assert.match(inner, /data-avatar-image/);
  assert.match(inner, /avatar-initials[^>]*>AL</);
});

// --- load-failure handling --------------------------------------------------

test('a picture that fails to load degrades to its initials', () => {
  const { host, node } = fakeImage();
  refreshAvatars(rootOf(node));

  assert.equal(node.dataset.avatarWired, '1');
  node.fire('error');

  assert.equal(host.has('is-broken'), true);
  assert.equal(host.has('has-image'), false);
  assert.equal(node.removed, true, 'the broken image element is removed');
});

test('a picture that already failed is caught on the way in', () => {
  const { host, node } = fakeImage({ complete: true, naturalWidth: 0 });
  refreshAvatars(rootOf(node));
  assert.equal(host.has('is-broken'), true);
  assert.equal(node.removed, true);
});

test('an image still loading is left alone', () => {
  const { host, node } = fakeImage({ complete: false, naturalWidth: 0 });
  refreshAvatars(rootOf(node));
  assert.equal(host.has('is-broken'), false);
  assert.equal(node.removed, false);
});

test('wiring is idempotent, so re-rendering does not stack handlers', () => {
  const { node, listeners } = fakeImage();
  const root = rootOf(node);
  refreshAvatars(root);
  const first = listeners.error;
  refreshAvatars(root);
  assert.equal(listeners.error, first, 'the handler is attached exactly once');
});
