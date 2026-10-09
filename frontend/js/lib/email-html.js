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
const ANCHOR_OPEN = /<a\b([^>]*)>/gi;
// An inline event handler, e.g. `onclick="…"` or `onerror='…'`.
const EVENT_HANDLER_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
// Attributes that can carry a URL, and the schemes that must never be honoured.
const URL_ATTR = /\s+(href|src|action|formaction|xlink:href|background)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|file)\s*:/i;
const DANGEROUS_DATA = /^data\s*:\s*text\/html/i;
const NAMED_ENTITIES = { colon: ':', tab: '\t', newline: '\n', 'NewLine': '\n' };

/**
 * Decodes just enough to compare a URL's scheme the way a browser would.
 *
 * A scheme can be disguised with character references (`java&#x73;cript:`) or
 * with the whitespace and control characters a browser strips before resolving a
 * URL (`java\tscript:`). Testing the raw attribute value would miss both, so the
 * value is normalised first - only for the comparison; the attribute itself is
 * never rewritten.
 */
function decodeForSchemeTest(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (match, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (match, decimal) => safeChar(Number(decimal)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[\u0000-\u0020]/g, '');
}

function safeChar(codePoint) {
  try {
    return String.fromCodePoint(codePoint);
  } catch (_) {
    return '';
  }
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Removes constructs that are meaningless or unsafe even inside a sandbox.
 *
 * This is defence in depth, not the security boundary - the boundary is the
 * sandboxed, script-free frame the document is rendered in. Stripping here
 * means a dangerous construct cannot become live if that boundary is ever
 * loosened, and it removes the two things a sandbox alone leaves behind:
 *
 *   * inline event-handler attributes (`onclick`, `onerror`, ...), which are
 *     inert without allow-scripts but are still executable content;
 *   * URL-bearing attributes whose scheme is `javascript:`, `vbscript:`,
 *     `file:` or a `data:text/html` payload. The attribute is dropped rather
 *     than rewritten, so the element keeps its text and the sender's meaning is
 *     not replaced with a link to somewhere else.
 *
 * Everything else is left exactly as sent: real https links (including their
 * full query string), tables, styles, images and formatting.
 */
export function stripUnsafeMarkup(html) {
  let cleaned = String(html ?? '').replace(BLOCKED_TAGS, '');
  cleaned = cleaned.replace(EVENT_HANDLER_ATTR, '');
  cleaned = cleaned.replace(URL_ATTR, (match, name, rawValue) => {
    const quote = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue[0] : '';
    const value = quote ? rawValue.slice(1, -1) : rawValue;
    // A leading colon is not a valid scheme either, so it is stripped before the
    // comparison rather than being allowed to hide a dangerous one behind it.
    const probe = decodeForSchemeTest(value).replace(/^[:\s]+/, '');
    if (DANGEROUS_SCHEME.test(probe) || DANGEROUS_DATA.test(probe)) return '';
    return match;
  });
  return cleaned;
}

/**
 * Normalises a Content-ID for comparison.
 *
 * Gmail returns inline parts with a `Content-ID` header (`<logo@example>`), and
 * the HTML refers to it as `cid:logo@example`. Angle brackets, whitespace and
 * case are all inconsistent between senders, so both sides are normalised
 * before they are matched.
 */
export function normaliseContentId(value) {
  return String(value ?? '').trim().replace(/^<|>$/g, '').replace(/^cid:/i, '').toLowerCase();
}

/**
 * Resolves `src="cid:…"` references to the inline part's bytes.
 *
 * Without this, an embedded image is a broken image icon: the browser cannot
 * fetch `cid:` itself, and the content address is meaningless outside the mail
 * store. The bytes come from the message payload (the backend already returns
 * `inline_images`, each with the Gmail attachment id it can be fetched by), and
 * are inlined as a data URL. Nothing outside the message is contacted, so an
 * embedded image is not a tracking risk and does not wait for the reader to
 * choose "Show images".
 *
 * @param {string} html
 * @param {Record<string, string>} inlineImages  content id (or attachment id) → data URL
 */
export function resolveInlineImages(html, inlineImages = {}) {
  const source = String(html ?? '');
  if (!source || !Object.keys(inlineImages).length) return source;

  const lookup = new Map();
  for (const [key, value] of Object.entries(inlineImages)) {
    if (!value) continue;
    lookup.set(normaliseContentId(key), value);
  }

  // Only the src attribute is touched: a `cid:` reference written anywhere else
  // (in a link, in text) is left exactly as the sender wrote it.
  return source.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(["']?)cid:([^"'\s]+)\2/gi,
    (match, prefix, quote, contentId) => {
      const resolved = lookup.get(normaliseContentId(contentId));
      if (!resolved) return match;
      return `${prefix}${quote}${resolved}${quote}`;
    },
  );
}

/**
 * Makes links safe to click without altering where they point.
 *
 * The reader shows a message in `iframe sandbox="allow-popups
 * allow-popups-to-escape-sandbox"`, which permits a user-initiated link to open
 * in a new tab while still blocking scripts, forms and top-level navigation. For
 * that to be safe the new tab must not keep a handle on this page, so every
 * anchor gets `rel="noopener noreferrer"` and an explicit `target="_blank"`.
 *
 * The href is copied byte for byte - no rewriting, no truncating, no stripping
 * of query parameters - because a confirmation link is only useful intact.
 */
export function addLinkSafety(html) {
  return String(html ?? '').replace(ANCHOR_OPEN, (match, attributes) => {
    let next = String(attributes || '');
    if (!/\btarget\s*=/.test(next)) next += ' target="_blank"';
    if (/\brel\s*=/.test(next)) {
      next = next.replace(/\brel\s*=\s*(["'])([^"']*)\1/i, (whole, quote, value) => {
        const tokens = new Set(String(value).split(/\s+/).filter(Boolean));
        tokens.add('noopener');
        tokens.add('noreferrer');
        return `rel=${quote}${[...tokens].join(' ')}${quote}`;
      });
    } else {
      next += ' rel="noopener noreferrer"';
    }
    return `<a${next}>`;
  });
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
export function buildEmailDocument({ html = '', text = '', allowRemote = false, inlineImages = {} } = {}) {
  const cleaned = addLinkSafety(resolveInlineImages(stripUnsafeMarkup(html), inlineImages));
  const body = cleaned.trim()
    ? cleaned
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
  /* A broken image (an unresolved cid: reference, or a remote image the user has
     not opted into) otherwise collapses to nothing and the surrounding text
     shifts. Give it a visible placeholder box instead. */
  img:not([src]), img[src=""] { min-height: 18px; min-width: 24px; outline: 1px dashed #d4d4d4; }
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
