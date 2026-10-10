// Regression guard for the email-reading experience.
//
// Real defects these pin, all of which were visible from the outside:
//
//   * the reader was a large `openModal` with its own scroll area, so a message
//     was read inside a box, inside the page — the "large modal with nested
//     scrolling" complaint;
//   * the browser Back button did nothing, because opening a message was not a
//     navigation at all;
//   * coming back from a message lost the Inbox search, because the list was
//     re-rendered from scratch with no memory of it.
//
// mail-common.js is a browser module (it touches the DOM through ui.js and calls
// app.js), so it cannot be imported by the Node test runner without a DOM. As
// with tests/js/app-shell.test.mjs, the invariants are asserted against the
// source: they are about *structure and ordering*, which is what was wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

const MAIL_COMMON = read('frontend', 'js', 'mail-common.js');
const INBOX = read('frontend', 'js', 'inbox.js');
const SENT = read('frontend', 'js', 'sent.js');
const MAIL_CSS = read('frontend', 'css', 'mail.css');
const APP = read('frontend', 'js', 'app.js');
const INDEX = read('frontend', 'index.html');

test('the reader is a route, not a modal', () => {
  assert.ok(!/openModal/.test(MAIL_COMMON), 'the email reader must not use the modal helper');
  assert.match(MAIL_COMMON, /export async function renderReader\(/, 'renderReader must exist');
  assert.match(MAIL_COMMON, /export async function renderMailbox\(/, 'the list and the reader are separate layouts');

  // Opening a message is a navigation, so Back returns to the list.
  assert.match(MAIL_COMMON, /navigate\(mailbox, \[button\.dataset\.open\]\)/,
    'a row click must navigate to the message route');
  assert.match(MAIL_COMMON, /id="reader-back"/, 'the reading view has an explicit Back control');
  assert.match(MAIL_COMMON, /navigate\(mailbox\)\)/, 'Back returns to the mailbox route');
});

test('both mailboxes wire the message id from the route params', () => {
  for (const [name, source] of [['inbox', INBOX], ['sent', SENT]]) {
    assert.match(source, /params = \[\]/, `${name} must accept route params`);
    assert.match(source, /renderReader\(container, \{ mailbox: '[a-z]+', messageId \}\)/,
      `${name} must render the reader for a message id`);
  }
});

test('the list marks the message that was read last', () => {
  assert.match(MAIL_COMMON, /const lastOpened = \{ inbox: '', sent: '' \}/,
    'the highlight is per mailbox');
  assert.match(MAIL_COMMON, /lastOpened\[mailbox\] = button\.dataset\.open/,
    'opening a message records it');
  assert.match(MAIL_COMMON, /const current = lastOpened\[mailbox\] === message\.id/);
  assert.match(MAIL_COMMON, /\$\{current \? 'is-current' : ''\}/, 'and the row carries the class');
  assert.match(MAIL_CSS, /\.mail-row\.is-current\s*\{/, 'the class must have a visible treatment');
});

test('the list remembers the search per mailbox', () => {
  assert.match(MAIL_COMMON, /const lastQuery = \{ inbox: '', sent: '' \}/,
    'search memory is per mailbox, so folder and query cannot leak into each other');
  assert.match(MAIL_COMMON, /lastQuery\[mailbox\] = query/, 'running a search must be remembered');
  assert.match(MAIL_COMMON, /let query = lastQuery\[mailbox\]/, 'the list must restore that search on return');
  assert.match(MAIL_COMMON, /value="\$\{escapeHtml\(query\)\}"/, 'and the input must show it');
});

test('the message body keeps every security boundary while being shown full width', () => {
  // The sandbox attribute is read from the markup, not from the source text: the
  // surrounding comment names the tokens that are deliberately absent, so a
  // substring search over the file would pass for the wrong reason.
  const sandboxes = [...MAIL_COMMON.matchAll(/\bsandbox="([^"]*)"/g)].map((match) => match[1]);
  assert.ok(sandboxes.includes('allow-popups allow-popups-to-escape-sandbox'),
    'the reader frame must be sandboxed with exactly the popup permissions');
  for (const value of sandboxes) {
    for (const token of ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-top-navigation']) {
      assert.ok(!value.includes(token), `${token} must never be granted to a message`);
    }
  }
  assert.match(MAIL_COMMON, /buildEmailDocument\(\{/, 'the body still goes through the sanitising document builder');
  assert.match(MAIL_COMMON, /referrerpolicy="no-referrer"/);
});

test('remote images stay opt-in and the reason is explained', () => {
  assert.match(MAIL_COMMON, /let allowRemote = false/, 'remote content starts blocked');
  assert.match(MAIL_COMMON, /id="reader-images"/, 'there is an explicit way to allow it');
  assert.match(MAIL_COMMON, /hasRemoteImages\(/, 'the control is only offered when it would do something');
  assert.match(MAIL_COMMON, /sender will be able to see that you opened it/,
    'the confirmation says what loading remote content reveals');
});

test('destructive actions are gated on the scope that can actually perform them', () => {
  assert.match(MAIL_COMMON, /capabilities\?\.modify === true/, 'archive/delete/unread need gmail.modify');
  assert.match(MAIL_COMMON, /gmail\.archive\(message\.id\)/);
  assert.match(MAIL_COMMON, /gmail\.trash\(message\.id\)/);
  assert.match(MAIL_COMMON, /Move this message to the Trash\?/, 'deleting asks first and says what it does');
  assert.match(MAIL_COMMON, /id="reader-reply"/);
  assert.match(MAIL_COMMON, /id="reader-forward"/);
});

test('the reading view fills the main area and is full-screen on mobile', () => {
  assert.match(MAIL_CSS, /\.view\.view-reader\s*\{[^}]*min-height: calc\(100vh - var\(--topbar-h\)\)/s,
    'the reader must occupy the available height rather than a fixed 52vh box');
  assert.match(MAIL_CSS, /\.reader-frame\s*\{[^}]*flex: 1/s, 'the frame fills the space it is given');
  assert.match(MAIL_CSS, /@media \(max-width: 900px\)\s*\{[\s\S]*?\.view\.view-reader\s*\{[^}]*min-height: calc\(100dvh - var\(--topbar-h\)\)/,
    'on mobile the message is the whole screen');
  assert.match(MAIL_COMMON, /container\.classList\.add\('view-reader'\)/);
  assert.match(MAIL_COMMON, /classList\.remove\('view-reader'\)/, 'and the class is cleaned up on leaving');
});

test('the account avatar uses the signed-in user, not a hardcoded one', () => {
  assert.match(APP, /avatarUrl\(\)/, 'the picture comes from the session');
  assert.match(APP, /avatarInner\(\{ name, email \}, \{ src: picture \}\)/);
  assert.match(APP, /refreshAvatars\(avatar\)/, 'a failed picture degrades instead of breaking');
  assert.match(APP, /safeImageUrl\(avatarUrl\(\)\)/, 'an unusable URL is rejected before it reaches the DOM');
  assert.match(INDEX, /id="profile-avatar"/, 'the topbar element the avatar renders into must exist');
});

test('sender avatars are initials, because Gmail exposes no sender photo', () => {
  assert.match(MAIL_COMMON, /avatarMarkup\(\{ name: person\.name, email: person\.email \}/,
    'inbox rows and the message header share one avatar implementation');
  const avatarLib = read('frontend', 'js', 'lib', 'avatar.js');
  assert.ok(!/gravatar|googleusercontent|\.jpg\?/i.test(avatarLib),
    'no avatar URL may be constructed from an address');
});
