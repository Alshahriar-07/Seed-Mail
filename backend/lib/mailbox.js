// Seed Code Mail — mailbox reads (list + message detail)
//
// Gmail is the mailbox. Nothing here copies messages into Postgres; a page is
// read from Gmail on demand and only the ids travel back to the browser.
//
// Paging uses Gmail's own `nextPageToken`, so "load more" is a real continuation
// rather than a client-side slice of a fully downloaded mailbox.

import { getMessage, getMessages, listMessages, headerMap } from './gmail.js';
import { HttpError } from './http.js';

const ADDRESS_SPLIT = /\s*,\s*/;

/** Gmail's `"Name" <a@b.c>` (or bare `a@b.c`) into a structured form. */
export function parseAddress(value) {
  const text = String(value ?? '').trim();
  if (!text) return { name: '', email: '' };
  const angled = text.match(/^(.*?)<([^>]+)>\s*$/);
  if (angled) {
    return {
      name: angled[1].trim().replace(/^"|"$/g, ''),
      email: angled[2].trim(),
    };
  }
  return { name: '', email: text };
}

function parseAddressList(value) {
  return String(value ?? '')
    .split(ADDRESS_SPLIT)
    .map((entry) => parseAddress(entry))
    .filter((entry) => entry.email);
}

/** URL-safe base64 (Gmail) to UTF-8 text. */
export function decodeBase64Url(data) {
  if (!data) return '';
  const normalized = String(data).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function summarize(payload, { mailbox }) {
  // Gmail nests the RFC 5322 headers under `payload` (the MIME structure), not
  // at the top level of the message resource.
  const headers = headerMap(payload.payload);
  const labels = Array.isArray(payload?.labelIds) ? payload.labelIds : [];
  const internal = Number(payload?.internalDate || 0);
  return {
    id: String(payload?.id || ''),
    thread_id: String(payload?.threadId || ''),
    mailbox,
    snippet: String(payload?.snippet || ''),
    unread: labels.includes('UNREAD'),
    labels,
    subject: headers.subject || '',
    from: parseAddress(headers.from),
    to: parseAddressList(headers.to),
    cc: parseAddressList(headers.cc),
    date: headers.date || '',
    // Gmail's epoch milliseconds are the reliable sort/display key; the Date:
    // header is whatever the sender claimed.
    internal_date: internal ? new Date(internal).toISOString() : '',
  };
}

/**
 * One page of a mailbox. `label` is 'INBOX' or 'SENT'; `query` is passed through
 * to Gmail's own search syntax, which is what the search box uses.
 */
export async function listMailbox(token, { label, query = '', pageToken = '', maxResults = 25 } = {}) {
  const page = await listMessages(token, { label, query, pageToken, maxResults });
  const ids = page.messages.map((message) => message.id).filter(Boolean);
  const details = ids.length ? await getMessages(token, ids, { format: 'metadata' }) : [];
  const byId = new Map(details.map((item) => [String(item.id), item]));

  return {
    mailbox: label === 'SENT' ? 'sent' : 'inbox',
    // Keep Gmail's ordering even if a message vanished between list and fetch.
    messages: ids.map((id) => byId.get(id)).filter(Boolean).map((payload) => summarize(payload, { mailbox: label === 'SENT' ? 'sent' : 'inbox' })),
    next_page_token: page.nextPageToken || '',
    result_size_estimate: page.resultSizeEstimate,
  };
}

/** The value of one MIME header on a part (case-insensitive, first match). */
/** Joins body parts, dropping empty and exactly duplicated ones. */
function uniqueJoin(parts) {
  const seen = new Set();
  const unique = [];
  for (const part of parts) {
    const value = String(part || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique.join('\n').trim();
}

function headerValue(part, name) {
  const headers = Array.isArray(part?.headers) ? part.headers : [];
  const wanted = String(name).toLowerCase();
  const found = headers.find((header) => String(header?.name || '').toLowerCase() === wanted);
  return found ? String(found.value ?? '') : '';
}

const IMAGE_MIME = /^image\//i;

/**
 * Walks the MIME tree of a Gmail message payload, collecting the parts the
 * reader needs.
 *
 * Order matters here and it used to be wrong. Gmail returns an embedded picture
 * (a logo, a chart, a signature image) as a part that has **both** a
 * `Content-ID` header and a `filename` — "image001.png" is the usual one. The
 * previous classification tested `filename && attachmentId` first, so every
 * embedded image landed in `attachments` and never in `inline`; the HTML still
 * said `src="cid:image001.png"`, nothing could resolve it, and the message
 * rendered with a broken-image icon where the sender's logo was. A part is now
 * classified as inline when it is an image that carries a Content-ID (or an
 * explicit `Content-Disposition: inline`), regardless of its filename.
 */
function walkParts(part, collector) {
  if (!part) return;
  const mimeType = String(part.mimeType || '');
  const body = part.body || {};
  const filename = String(part.filename || '');
  const attachmentId = String(body.attachmentId || '');
  const data = String(body.data || '');
  const size = Number(body.size || 0);

  if (mimeType === 'text/plain' && data) {
    collector.text.push(decodeBase64Url(data));
  } else if (mimeType === 'text/html' && data) {
    collector.html.push(decodeBase64Url(data));
  } else if (attachmentId || (filename && data)) {
    const contentId = headerValue(part, 'content-id');
    const disposition = headerValue(part, 'content-disposition').toLowerCase();
    const inline = IMAGE_MIME.test(mimeType)
      && (Boolean(contentId) || disposition.startsWith('inline') || !filename);

    if (inline) {
      collector.inline.push({
        attachment_id: attachmentId,
        content_id: contentId,
        mime_type: mimeType || 'image/png',
        filename,
        size,
        // Small embedded parts arrive with their bytes already decoded in the
        // payload. Passing them on saves a second round trip through Gmail; a
        // larger one only carries its attachment id and is fetched on demand.
        data: attachmentId ? '' : data,
      });
    } else {
      collector.attachments.push({
        attachment_id: attachmentId,
        filename: filename || 'attachment',
        mime_type: mimeType || 'application/octet-stream',
        size,
      });
    }
  }

  (part.parts || []).forEach((child) => walkParts(child, collector));
}

/**
 * Full message for the reader.
 *
 * Both the HTML and the plain-text body are returned; the browser decides how to
 * render them. The HTML is never injected into the application DOM — it is shown
 * in a sandboxed, script-free frame (frontend/js/lib/email-html.js).
 */
export async function readMessage(token, id) {
  const payload = await getMessage(token, id, { format: 'full' });
  if (!payload?.id) throw new HttpError(404, 'That message no longer exists in this Gmail account.', { code: 'gmail_not_found' });

  const collector = { text: [], html: [], attachments: [], inline: [] };
  walkParts(payload.payload, collector);

  const headers = headerMap(payload.payload);
  const labels = Array.isArray(payload.labelIds) ? payload.labelIds : [];

  return {
    id: String(payload.id),
    thread_id: String(payload.threadId || ''),
    snippet: String(payload.snippet || ''),
    unread: labels.includes('UNREAD'),
    labels,
    subject: headers.subject || '',
    from: parseAddress(headers.from),
    to: parseAddressList(headers.to),
    cc: parseAddressList(headers.cc),
    reply_to: parseAddress(headers['reply-to'] || ''),
    date: headers.date || '',
    internal_date: Number(payload.internalDate || 0) ? new Date(Number(payload.internalDate)).toISOString() : '',
    body: {
      // Prefer a real plain-text part; fall back to '' so the client can derive
      // readable text from the HTML rather than showing raw markup.
      //
      // Exact duplicates are dropped: a nested multipart/alternative can repeat
      // the same body part, and concatenating both would render the message
      // twice.
      text: uniqueJoin(collector.text),
      html: uniqueJoin(collector.html),
    },
    attachments: collector.attachments,
    inline_images: collector.inline,
  };
}
