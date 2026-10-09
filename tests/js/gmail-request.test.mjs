// Tests for the Gmail request construction in backend/lib/gmail.js
//
// The bug these pin: `metadataHeaders` is a REPEATED query parameter in the
// Gmail API. It was passed as an array to `new URLSearchParams(object)`, which
// produces one comma-joined value - a header-name filter matching nothing - so a
// list page could return no `From` and no `Subject` with a 200 status and no
// error at all. That is the "sender names and subjects are missing" symptom, at
// its source rather than in CSS.
//
// `fetch` is stubbed here, so the URL the module builds is inspected directly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildQuery, getMessages, getMessage, listMessages, modifyMessage } from '../../backend/lib/gmail.js';

/** Runs `fn` with a stubbed global fetch and returns every requested URL. */
async function captureUrls(fn) {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'message-1', payload: { headers: [] }, messages: [] }),
    };
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return urls;
}

test('buildQuery repeats a key once per array entry', () => {
  const query = buildQuery({ metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] });
  assert.equal((query.match(/metadataHeaders=/g) || []).length, 5);
  assert.equal(
    query,
    'metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date',
  );
  assert.ok(!query.includes('%2C'), 'a comma-joined single value is exactly the bug');
});

test('buildQuery omits empty values instead of sending key=', () => {
  assert.equal(buildQuery({ q: '', pageToken: '', labelIds: 'INBOX' }), 'labelIds=INBOX');
  assert.equal(buildQuery({ q: undefined, pageToken: null }), '');
  assert.equal(buildQuery({}), '');
  assert.equal(buildQuery(undefined), '');
});

test('buildQuery still encodes ordinary values', () => {
  assert.equal(buildQuery({ q: 'from:boss newer_than:7d' }), 'q=from%3Aboss+newer_than%3A7d');
});

test('a metadata list request asks for each header separately', async () => {
  const urls = await captureUrls(() => getMessages('token', ['abc']));
  assert.equal(urls.length, 1);
  const url = new URL(urls[0]);
  assert.equal(url.pathname, '/gmail/v1/users/me/messages/abc');
  assert.equal(url.searchParams.get('format'), 'metadata');
  assert.deepEqual(
    url.searchParams.getAll('metadataHeaders'),
    ['From', 'To', 'Cc', 'Subject', 'Date'],
  );
});

test('each message in a batch gets its own request, and a 404 is skipped', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('/messages/missing')) {
      return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'present', payload: {} }) };
  };
  try {
    const rows = await getMessages('token', ['present', 'missing']);
    assert.equal(rows.length, 1, 'one unreadable message must not break the page');
    assert.equal(seen.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('a full message request carries no metadata filter', async () => {
  const urls = await captureUrls(() => getMessage('token', 'xyz'));
  const url = new URL(urls[0]);
  assert.equal(url.searchParams.get('format'), 'full');
  assert.equal(url.searchParams.get('metadataHeaders'), null);
});

test('list, modify and page tokens build the documented requests', async () => {
  const listUrls = await captureUrls(() => listMessages('token', {
    label: 'INBOX', query: 'is:unread', pageToken: 'PAGE-2', maxResults: 500,
  }));
  const list = new URL(listUrls[0]);
  assert.equal(list.searchParams.get('labelIds'), 'INBOX');
  assert.equal(list.searchParams.get('q'), 'is:unread');
  assert.equal(list.searchParams.get('pageToken'), 'PAGE-2');
  assert.equal(list.searchParams.get('maxResults'), '50', 'page size is clamped to Gmail’s maximum');

  const modifyUrls = await captureUrls(() => modifyMessage('token', 'id-1', { removeLabelIds: ['UNREAD'] }));
  const modify = new URL(modifyUrls[0]);
  assert.equal(modify.pathname, '/gmail/v1/users/me/messages/id-1/modify');
});
