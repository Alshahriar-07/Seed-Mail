// Seed Code Mail — MIME message builder
//
// Gmail's `users.messages.send` takes a complete RFC 5322 message, base64url
// encoded. Building it here (rather than pulling in a mail library) keeps the
// serverless bundle small and dependency-free — nothing to install on a build
// host, and one fewer supply-chain surface.
//
// Correctness details that matter in practice:
//   * non-ASCII header values (subject, display names) are RFC 2047
//     encoded-words, so "Résumé — 你好" survives;
//   * bodies are UTF-8 in base64 transfer encoding, so any language works;
//   * every line ends CRLF, which is what SMTP/Gmail require;
//   * text and HTML are sent as multipart/alternative so a plain-text client
//     still shows something;
//   * attachments are multipart/mixed, base64 encoded, with the filename both
//     as `filename=` and RFC 2231 `filename*=UTF-8''…` for non-ASCII names.

const CRLF = '\r\n';
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024; // leaves room under Gmail's 25 MB limit
const MAX_ATTACHMENTS = 10;

/** A permissive but real address check (transport-level validation, not policy). */
export function isValidEmail(value) {
  const text = String(value ?? '').trim();
  return text.length >= 3 && text.length <= 254 && /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(text);
}

/**
 * Accepts `"a@b.com, c@d.com"` or `["a@b.com", "c@d.com"]` (or a mix) and
 * returns a de-duplicated array. Invalid entries are reported, never silently
 * dropped: sending to a typo the user was never told about is worse than a
 * validation error.
 */
export function parseAddressList(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,;\n]/);
  const valid = [];
  const invalid = [];
  const seen = new Set();

  raw.forEach((entry) => {
    const text = String(entry ?? '').trim().replace(/^<|>$/g, '').trim();
    if (!text) return;
    if (!isValidEmail(text)) { invalid.push(text); return; }
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    valid.push(text);
  });

  return { valid, invalid };
}

/** RFC 2047 encode a header value when it is not plain ASCII. */
export function encodeHeaderValue(value) {
  const text = String(value ?? '');
  if (!text) return '';
  // Printable ASCII with no control characters can be sent verbatim.
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** `"Name" <a@b.com>` with the display name encoded when needed. */
function formatAddress(address, displayName = '') {
  const name = String(displayName ?? '').trim();
  if (!name) return address;
  return `${encodeHeaderValue(name)} <${address}>`;
}

function wrapBase64(buffer, width = 76) {
  const encoded = Buffer.from(buffer).toString('base64');
  const lines = [];
  for (let i = 0; i < encoded.length; i += width) lines.push(encoded.slice(i, i + width));
  return lines.join(CRLF);
}

/** Best-effort plain-text rendering of an HTML body. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function part({ contentType, encoding = 'base64', body, extraHeaders = [] }) {
  const headers = [
    `Content-Type: ${contentType}`,
    ...extraHeaders,
    `Content-Transfer-Encoding: ${encoding}`,
    '',
  ];
  return headers.join(CRLF) + CRLF + body + CRLF;
}

/**
 * Build the raw message.
 *
 * @returns {{ raw: string, to: string[], cc: string[], bcc: string[],
 *             attachments: Array<{filename: string, bytes: number}> }}
 */
export function buildRawMessage({
  from,
  fromName = '',
  to = [],
  cc = [],
  bcc = [],
  subject = '',
  text = '',
  html = '',
  attachments = [],
} = {}) {
  const senderAddress = String(from ?? '').trim();
  if (!isValidEmail(senderAddress)) throw new Error('The connected Gmail address is not usable as a sender.');

  const recipients = parseAddressList(to);
  const ccList = parseAddressList(cc);
  const bccList = parseAddressList(bcc);

  // Report a typo'd address explicitly. Silently dropping it would send the
  // message to fewer people than the user believes.
  const invalidAll = [...recipients.invalid, ...ccList.invalid, ...bccList.invalid];
  if (invalidAll.length) throw new Error(`Invalid email address(es): ${invalidAll.join(', ')}`);
  if (!recipients.valid.length) throw new Error('At least one recipient is required.');

  const plain = String(text ?? '').trim() || htmlToText(html) || '';
  const rich = String(html ?? '').trim();
  const subjectHeader = subject ? String(subject) : '(no subject)';

  const prepared = [];
  let attachmentBytes = 0;
  for (const item of attachments.slice(0, MAX_ATTACHMENTS)) {
    const data = String(item?.data || '');
    if (!data) continue;
    const bytes = Buffer.from(data, 'base64');
    attachmentBytes += bytes.length;
    if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error('The attachments are too large to send (about 18 MB is the maximum).');
    }
    const filename = String(item.filename || 'attachment').slice(0, 200);
    prepared.push({
      filename,
      mimeType: String(item.mimeType || 'application/octet-stream').slice(0, 120),
      body: wrapBase64(bytes),
      bytes: bytes.length,
    });
  }

  // --- body structure -------------------------------------------------------

  const alternativeBoundary = `seedmail-alt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const textPart = part({
    contentType: 'text/plain; charset="UTF-8"',
    body: wrapBase64(Buffer.from(plain, 'utf8')),
  });
  const htmlPart = part({
    contentType: 'text/html; charset="UTF-8"',
    body: wrapBase64(Buffer.from(rich || `<pre>${plain.replace(/[<>&]/g, '')}</pre>`, 'utf8')),
  });

  const alternative = [
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    '',
    `--${alternativeBoundary}`,
    textPart,
    `--${alternativeBoundary}`,
    htmlPart,
    `--${alternativeBoundary}--`,
    '',
  ].join(CRLF);

  let body = alternative;
  if (prepared.length) {
    const mixedBoundary = `seedmail-mix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    body = [
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      '',
      `--${mixedBoundary}`,
      alternative,
      ...prepared.flatMap((file) => [
        `--${mixedBoundary}`,
        part({
          contentType: `${file.mimeType}; name="${file.filename.replace(/"/g, '')}"`,
          body: file.body,
          extraHeaders: [
            `Content-Disposition: attachment; filename="${file.filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          ],
        }),
      ]),
      `--${mixedBoundary}--`,
      '',
    ].join(CRLF);
  }

  // Gmail requires the recipients it must deliver to in the headers. Bcc is
  // included here (and stripped by Gmail before delivery) — omitting it would
  // silently fail to send to the blind-copied addresses.
  const headers = [
    `From: ${formatAddress(senderAddress, fromName)}`,
    `To: ${recipients.valid.join(', ')}`,
    ccList.valid.length ? `Cc: ${ccList.valid.join(', ')}` : '',
    bccList.valid.length ? `Bcc: ${bccList.valid.join(', ')}` : '',
    `Subject: ${encodeHeaderValue(subjectHeader)}`,
    `MIME-Version: 1.0`,
    `Date: ${new Date().toUTCString()}`,
  ].filter(Boolean);

  const message = `${headers.join(CRLF)}${CRLF}${body}`;
  return {
    raw: Buffer.from(message, 'utf8').toString('base64url'),
    to: recipients.valid,
    cc: ccList.valid,
    bcc: bccList.valid,
    attachments: prepared.map(({ filename, bytes }) => ({ filename, bytes })),
  };
}
