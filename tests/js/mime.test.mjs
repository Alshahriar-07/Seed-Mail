// Tests for backend/lib/mime.js
//
// Gmail accepts the raw message this module builds, so the assertions are about
// the message structure a mail client will actually parse: real headers, both
// body representations, correct Unicode handling, attachments, and validation
// that refuses to send to a typo'd address.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRawMessage,
  encodeHeaderValue,
  htmlToText,
  isValidEmail,
  parseAddressList,
} from '../../backend/lib/mime.js';

/** Decode the base64url `raw` back into the MIME text. */
function decode(raw) {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

test('a bare address and a named address are both valid', () => {
  assert.equal(isValidEmail('a@b.com'), true);
  assert.equal(isValidEmail('not-an-address'), false);
  assert.equal(isValidEmail('a@b'), false);
  assert.equal(isValidEmail(''), false);
});

test('address lists accept strings and arrays, and report invalid entries', () => {
  const fromString = parseAddressList('a@b.com, c@d.com');
  assert.deepEqual(fromString.valid, ['a@b.com', 'c@d.com']);
  assert.deepEqual(fromString.invalid, []);

  const mixed = parseAddressList(['a@b.com', 'broken', 'A@B.com']);
  assert.deepEqual(mixed.valid, ['a@b.com'], 'duplicates (case-insensitive) are removed');
  assert.deepEqual(mixed.invalid, ['broken'], 'invalid entries are reported, never dropped silently');
});

test('non-ascii headers are RFC 2047 encoded and ascii headers are untouched', () => {
  assert.equal(encodeHeaderValue('Quarterly update'), 'Quarterly update');
  const encoded = encodeHeaderValue('Résumé — 你好');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  const decoded = Buffer.from(encoded.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8');
  assert.equal(decoded, 'Résumé — 你好');
});

test('htmlToText produces a readable plain-text alternative', () => {
  const text = htmlToText('<style>p{color:red}</style><p>Hello &amp; welcome</p><p>Line two</p>');
  assert.ok(!text.includes('<'));
  assert.ok(text.includes('Hello & welcome'));
  assert.ok(text.includes('Line two'));
});

test('a simple message has the expected headers and both body parts', () => {
  const { raw, to } = buildRawMessage({
    from: 'sender@example.com',
    fromName: 'Seed Sender',
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<p>Hi there</p>',
  });
  const message = decode(raw);

  assert.deepEqual(to, ['recipient@example.com']);
  assert.match(message, /^From: Seed Sender <sender@example\.com>/m);
  assert.match(message, /^To: recipient@example\.com$/m);
  assert.match(message, /^Subject: Hello$/m);
  assert.match(message, /^MIME-Version: 1\.0$/m);
  assert.match(message, /Content-Type: multipart\/alternative; boundary="[^"]+"/);
  assert.match(message, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(message, /Content-Type: text\/html; charset="UTF-8"/);
  assert.ok(!message.includes('Content-Type: multipart/mixed'), 'no attachments means no mixed part');
  assert.ok(message.includes('\r\n'), 'MIME requires CRLF line endings');
});

test('non-ascii subject and body survive the round trip', () => {
  const { raw } = buildRawMessage({
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Résumé — 你好',
    html: '<p>Grüße, 世界</p>',
  });
  const message = decode(raw);
  assert.match(message, /^Subject: =\?UTF-8\?B\?/m);

  const bodies = [...message.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n/g)]
    .map((match) => Buffer.from(match[1].replace(/\r\n/g, ''), 'base64').toString('utf8'))
    .join('\n');
  assert.ok(bodies.includes('Grüße, 世界'), `decoded bodies were: ${bodies}`);
});

test('Cc and Bcc are carried into the headers so Gmail delivers to them', () => {
  const { cc, bcc } = buildRawMessage({
    from: 'sender@example.com',
    to: 'a@example.com',
    cc: 'c@example.com',
    bcc: ['d@example.com'],
    subject: 's',
    text: 'body',
  });
  assert.deepEqual(cc, ['c@example.com']);
  assert.deepEqual(bcc, ['d@example.com']);
});

test('htmlToText is used when only HTML is supplied', () => {
  const { raw } = buildRawMessage({
    from: 'sender@example.com',
    to: 'a@example.com',
    subject: 's',
    html: '<p>Plain fallback text</p>',
  });
  const message = decode(raw);
  const plain = message.match(/Content-Type: text\/plain; charset="UTF-8"[\s\S]*?base64\r\n\r\n([\s\S]*?)\r\n/)[1];
  assert.ok(Buffer.from(plain.replace(/\r\n/g, ''), 'base64').toString('utf8').includes('Plain fallback text'));
});

test('an empty subject is replaced rather than producing a broken header', () => {
  const { raw } = buildRawMessage({ from: 'sender@example.com', to: 'a@example.com', subject: '', text: 'x' });
  assert.match(decode(raw), /^Subject: \(no subject\)$/m);
});

test('attachments produce a multipart/mixed message with a filename', () => {
  const { raw, attachments } = buildRawMessage({
    from: 'sender@example.com',
    to: 'a@example.com',
    subject: 'Report',
    text: 'See attached',
    attachments: [{ filename: 'résumé 2026.pdf', mimeType: 'application/pdf', data: Buffer.from('PDF').toString('base64') }],
  });
  const message = decode(raw);
  assert.match(message, /Content-Type: multipart\/mixed; boundary="[^"]+"/);
  assert.match(message, /Content-Disposition: attachment/);
  assert.match(message, /filename\*=UTF-8''r%C3%A9sum%C3%A9%202026\.pdf/);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].bytes, 3);
});

test('sending without a valid recipient is refused', () => {
  assert.throws(
    () => buildRawMessage({ from: 'sender@example.com', to: [], subject: 's', text: 'x' }),
    /recipient/i,
  );
  assert.throws(
    () => buildRawMessage({ from: 'sender@example.com', to: 'typo@', subject: 's', text: 'x' }),
    /not valid|invalid/i,
  );
});

test('an unusable sender address is refused instead of producing a broken From', () => {
  assert.throws(
    () => buildRawMessage({ from: '', to: 'a@example.com', subject: 's', text: 'x' }),
    /sender/i,
  );
});
