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

function walkParts(part, collector) {
  if (!part) return;
  const mimeType = String(part.mimeType || '');
  const body = part.body || {};
  const filename = String(part.filename || '');

  if (filename && body.attachmentId) {
    collector.attachments.push({
      attachment_id: String(body.attachmentId),
      filename,
      mime_type: mimeType || 'application/octet-stream',
      size: Number(body.size || 0),
    });
  } else if (mimeType === 'text/plain' && body.data) {
    collector.text.push(decodeBase64Url(body.data));
  } else if (mimeType === 'text/html' && body.data) {
    collector.html.push(decodeBase64Url(body.data));
  } else if (mimeType.startsWith('image/') && body.attachmentId) {
    // Inline images are attachments too; the reader resolves them on demand.
    collector.inline.push({
      attachment_id: String(body.attachmentId),
      content_id: String(part.headers?.find?.((h) => String(h.name).toLowerCase() === 'content-id')?.value || ''),
      mime_type: mimeType,
      size: Number(body.size || 0),
    });
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
      text: collector.text.join('\n').trim(),
      html: collector.html.join('\n').trim(),
    },
    attachments: collector.attachments,
    inline_images: collector.inline,
  };
}
