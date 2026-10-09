// Seed Code Mail — safe rendering of untrusted email HTML
//
// Email bodies are attacker-controlled input: anyone can send the user a message
// containing scripts, remote tracking images, or a form that posts somewhere.
// The reader therefore never injects a message into the application DOM. It
// builds a self-contained document and shows it in an iframe with
// `sandbox=""`, which is the actual security boundary:
//
//   * `sandbox=""` blocks scripts, forms, popups, top-level navigation and
//     same-origin access, without needing to enumerate what to remove;
//   * a strict Content-Security-Policy inside the document blocks everything
//     except inline styles, so nothing can be fetched at all until the user
//     explicitly chooses "Show images";
//   * remote images are OFF by default, because a single tracking pixel reveals
//     that the message was opened, when, and from which IP.
//
// This mirrors how `frontend/js/lib/render.js` previews templates, so there is
// one rendering philosophy in the project rather than two.

const BLOCKED_TAGS = /<\/?(script|iframe|object|embed|base|form|meta|link)\b[^>]*>/gi;

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Removes constructs that are meaningless or unsafe even inside a sandbox. */
export function stripUnsafeMarkup(html) {
  return String(html ?? '').replace(BLOCKED_TAGS, '');
}

function contentSecurityPolicy(allowRemote) {
  const remote = allowRemote ? '* data:' : 'data:';
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src ${remote}`,
    `font-src ${remote}`,
    "media-src 'none'",
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * Build the document to place in `iframe[srcdoc]`.
 *
 * @param {object} options
 * @param {string} options.html       raw HTML body from Gmail
 * @param {string} options.text       plain-text body from Gmail
 * @param {boolean} options.allowRemote  load remote images (user opted in)
 */
export function buildEmailDocument({ html = '', text = '', allowRemote = false } = {}) {
  const safeHtml = stripUnsafeMarkup(html);
  const body = safeHtml.trim()
    ? safeHtml
    : `<pre class="seedmail-plain">${escapeText(text)}</pre>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(allowRemote)}">
<meta name="referrer" content="no-referrer">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #111111;
    font-size: 14px;
    line-height: 1.6;
    padding: 18px;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #111111; }
  pre.seedmail-plain { white-space: pre-wrap; font-family: inherit; margin: 0; }
  blockquote {
    margin: 0 0 0 12px; padding-left: 12px;
    border-left: 2px solid #e5e5e5; color: #525252;
  }
</style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * A readable plain-text rendering for the "Plain text" view and for search.
 * Kept here so the reader has one implementation for both.
 */
export function emailPlainText({ html = '', text = '' }) {
  if (String(text).trim()) return String(text);
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '&lt;')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Human-readable byte size for attachment rows. */
export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  // One decimal only when the value is not whole, so 2 KB does not read "2.0 KB"
  // while 1.5 MB stays precise.
  const rounded = Math.round(size * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[index]}`;
}
