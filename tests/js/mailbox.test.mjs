// Tests for backend/lib/mailbox.js — the Gmail message → reader payload step.
//
// The bug these pin: Gmail returns an embedded picture as a MIME part that has
// BOTH a `Content-ID` header and a `filename` ("image001.png" is the usual one).
// The previous classification tested `filename && attachmentId` first, so every
// embedded image was filed as an attachment and the `inline_images` list came
// back empty. The HTML still referred to `src="cid:image001.png"`, nothing could
// resolve it, and the message rendered with a broken-image icon where the
// sender's logo or chart belonged.
//
// `fetch` is stubbed, so the parsing is exercised without a network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeBase64Url, parseAddress, readMessage } from '../../backend/lib/mailbox.js';

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Runs `fn` with `payload` served as the Gmail message response. */
async function withMessage(payload, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = original;
  }
}

/** A realistic Gmail `format=full` payload: alternative body + inline image + file. */
function gmailPayload(overrides = {}) {
  return {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Your report is ready',
    internalDate: '1700000000000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Google Business Profile <noreply@google.com>' },
        { name: 'To', value: 'person@example.com, second@example.com' },
        { name: 'Cc', value: 'copy@example.com' },
        { name: 'Subject', value: 'Your monthly report' },
        { name: 'Date', value: 'Tue, 14 Nov 2023 22:13:20 +0000' },
      ],
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('Plain body') } },
            { mimeType: 'text/html', body: { data: b64url('<p>HTML body <img src="cid:logo@google" alt="Logo"></p>') } },
          ],
        },
        {
          // Exactly the shape that used to be misclassified: an embedded image
          // with both a filename and a Content-ID.
          mimeType: 'image/png',
          filename: 'image001.png',
          headers: [
            { name: 'Content-ID', value: '<logo@google>' },
            { name: 'Content-Disposition', value: 'inline; filename="image001.png"' },
          ],
          body: { attachmentId: 'ATT-INLINE', size: 2048 },
        },
        {
          mimeType: 'application/pdf',
          filename: 'report.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }],
          body: { attachmentId: 'ATT-PDF', size: 90000 },
        },
      ],
    },
    ...overrides,
  };
}

test('base64url decoding handles Gmail’s alphabet and padding', () => {
  assert.equal(decodeBase64Url(b64url('hello world')), 'hello world');
  assert.equal(decodeBase64Url(''), '');
  // Values whose base64 uses `+` and `/` must survive the URL-safe swap
  // (`-` and `_`), which is what Gmail actually sends.
  assert.equal(decodeBase64Url('Pj4+'), '>>>');
  assert.equal(decodeBase64Url('Pj4-'), '>>>');
  assert.equal(decodeBase64Url('Pz8/'), '???');
  assert.equal(decodeBase64Url('Pz8_'), '???');
});

test('an address header becomes a structured name/email pair', () => {
  assert.deepEqual(parseAddress('Ada Lovelace <ada@example.com>'), { name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.deepEqual(parseAddress('"Quoted, Name" <q@example.com>'), { name: 'Quoted, Name', email: 'q@example.com' });
  assert.deepEqual(parseAddress('bare@example.com'), { name: '', email: 'bare@example.com' });
  assert.deepEqual(parseAddress(''), { name: '', email: '' });
});

test('an embedded image with a Content-ID is inline, not an attachment', async () => {
  const message = await withMessage(gmailPayload(), () => readMessage('token', 'm1'));

  assert.equal(message.inline_images.length, 1, 'the embedded logo must be offered as an inline image');
  const inline = message.inline_images[0];
  assert.equal(inline.content_id, '<logo@google>');
  assert.equal(inline.attachment_id, 'ATT-INLINE');
  assert.equal(inline.mime_type, 'image/png', 'the MIME type is required to build a renderable data URL');
  assert.equal(inline.size, 2048);

  assert.deepEqual(
    message.attachments.map((file) => file.filename),
    ['report.pdf'],
    'an embedded image must not also be listed as a downloadable attachment',
  );
});

test('both body representations are returned and the HTML keeps its cid: reference', async () => {
  const message = await withMessage(gmailPayload(), () => readMessage('token', 'm1'));

  assert.equal(message.body.text, 'Plain body');
  assert.match(message.body.html, /<img src="cid:logo@google"/);
});

test('headers, labels and the reliable timestamp are carried through', async () => {
  const message = await withMessage(gmailPayload(), () => readMessage('token', 'm1'));

  assert.equal(message.subject, 'Your monthly report');
  assert.equal(message.from.name, 'Google Business Profile');
  assert.equal(message.from.email, 'noreply@google.com');
  assert.deepEqual(message.to.map((entry) => entry.email), ['person@example.com', 'second@example.com']);
  assert.deepEqual(message.cc.map((entry) => entry.email), ['copy@example.com']);
  assert.equal(message.unread, true);
  assert.equal(message.internal_date, new Date(1700000000000).toISOString());
  assert.equal(message.date, 'Tue, 14 Nov 2023 22:13:20 +0000');
});

test('a nested alternative does not repeat the body twice', async () => {
  const duplicated = gmailPayload();
  const html = b64url('<p>Only once</p>');
  duplicated.payload.parts[0].parts = [
    { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/html', body: { data: html } },
    ] },
    { mimeType: 'text/html', body: { data: html } },
  ];
  const message = await withMessage(duplicated, () => readMessage('token', 'm1'));
  assert.equal((message.body.html.match(/Only once/g) || []).length, 1);
});

test('an inline part delivered with its bytes needs no second request', async () => {
  const direct = gmailPayload();
  direct.payload.parts[1] = {
    mimeType: 'image/gif',
    filename: 'pixel.gif',
    headers: [{ name: 'Content-ID', value: '<pixel@example>' }],
    body: { data: 'R0lGODlhAQABAAAAACw=', size: 32 },
  };
  // The recorder hands over its live array, which is filled while the request
  // runs — so it is kept by reference and read after the await.
  const callLog = [];
  const message = await withMessage(direct, (urls) => {
    callLog.push(urls);
    return readMessage('token', 'm1');
  });

  const inline = message.inline_images[0];
  assert.equal(inline.attachment_id, '');
  assert.equal(inline.data, 'R0lGODlhAQABAAAAACw=', 'the bytes come back with the part');
  assert.equal(callLog[0].length, 1, 'only the message itself is fetched');
});

test('a read message reports unread false', async () => {
  const read = gmailPayload({ labelIds: ['INBOX'] });
  const message = await withMessage(read, () => readMessage('token', 'm1'));
  assert.equal(message.unread, false);
});

test('a message that no longer exists fails with a clear 404 rather than an empty body', async () => {
  await withMessage({}, async () => {
    await assert.rejects(
      () => readMessage('token', 'gone'),
      (error) => error.status === 404 && error.code === 'gmail_not_found',
    );
  });
});
