// Tests for frontend/js/lib/shortcuts.js
//
// Keyboard shortcuts are easy to get wrong in ways that annoy users rather than
// break loudly: a key that fires while they are typing, or one that steals a
// browser shortcut. These tests pin the two rules that matter, plus the mapping
// itself.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isTypingTarget, listAction, readerAction } from '../../frontend/js/lib/shortcuts.js';

const field = { tagName: 'INPUT' };
const body = { tagName: 'BODY' };

test('typing targets are recognised, including contenteditable', () => {
  for (const el of [
    { tagName: 'input' },
    { tagName: 'TEXTAREA' },
    { tagName: 'select' },
    { tagName: 'div', isContentEditable: true },
  ]) {
    assert.equal(isTypingTarget(el), true);
  }
  assert.equal(isTypingTarget(body), false);
  assert.equal(isTypingTarget(null), false);
});

test('a shortcut never fires while the user is typing', () => {
  assert.equal(readerAction({ key: 'e', target: field }), '');
  assert.equal(listAction({ key: 'j', target: field }), '');
});

test('a shortcut never fires with a browser modifier', () => {
  assert.equal(readerAction({ key: 'r', target: body, ctrlKey: true }), '');
  assert.equal(readerAction({ key: 'r', target: body, metaKey: true }), '');
  assert.equal(readerAction({ key: 'r', target: body, altKey: true }), '');
  assert.equal(listAction({ key: 'c', target: body, ctrlKey: true }), '');
});

test('the reader maps the Gmail keys', () => {
  assert.equal(readerAction({ key: 'u', target: body }), 'back');
  assert.equal(readerAction({ key: 'Escape', target: body }), 'back');
  assert.equal(readerAction({ key: 'r', target: body }), 'reply');
  assert.equal(readerAction({ key: 'f', target: body }), 'forward');
  assert.equal(readerAction({ key: 'e', target: body }), 'archive');
  assert.equal(readerAction({ key: '#', target: body }), 'delete');
  assert.equal(readerAction({ key: 'Delete', target: body }), 'delete');
  assert.equal(readerAction({ key: 'i', target: body }), 'toggle-read');
  assert.equal(readerAction({ key: 'j', target: body }), 'newer');
  assert.equal(readerAction({ key: 'k', target: body }), 'older');
});

test('an unmapped reader key does nothing', () => {
  for (const key of ['x', 'Enter', 'Tab', 'F5', '/']) {
    assert.equal(readerAction({ key, target: body }), '', `${key} should be ignored`);
  }
});

test('the list maps movement, open, compose, refresh and search', () => {
  assert.equal(listAction({ key: 'j', target: body }), 'next');
  assert.equal(listAction({ key: 'k', target: body }), 'previous');
  assert.equal(listAction({ key: 'Enter', target: body }), 'open');
  assert.equal(listAction({ key: 'o', target: body }), 'open');
  assert.equal(listAction({ key: 'c', target: body }), 'compose');
  assert.equal(listAction({ key: 'g', target: body }), 'refresh');
  assert.equal(listAction({ key: '/', target: body }), 'search');
});

test('an unmapped list key does nothing', () => {
  for (const key of ['e', 'r', 'Delete', 'Escape']) {
    assert.equal(listAction({ key, target: body }), '', `${key} should be ignored`);
  }
});
