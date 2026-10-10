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

// --- images ------------------------------------------------------------------
//
// Three different kinds of `<img>` reach this module and they need three
// different treatments:
//
//   1. an inline part, already resolved to a `data:` URL → always renderable;
//   2. an external `https://…` image → valid, but only loaded once the user opts
//      in (a single remote image tells the sender the message was opened);
//   3. a URL that cannot load at all — an unresolved `cid:`, or a *relative* path
//      like `/images/logo.png`. A relative address has no meaning outside the
//      sender's own web server, and inside this application it would silently
//      resolve against **our** origin: the sender's link rewritten into a broken
//      application URL, which is the defect this guards against.
//
// Category 3 is neutralised, and remote images are neutralised until the user
// asks for them, by substituting a small inline placeholder that keeps the
// element's size and explains itself on hover. Nothing else about the message is
// altered, and "Show images" re-renders the original markup so a real image is
// what the reader finally sees.

// A neutral grey picture glyph, inline so it needs no network request and is
// allowed by the document's CSP (`img-src data:`).
const PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='80' "
  + "viewBox='0 0 120 80'%3E%3Crect width='120' height='80' fill='%23f4f4f5'/%3E"
  + "%3Cpath d='M22 60l20-24 15 18 11-13 24 19z' fill='%23d4d4d8'/%3E"
  + "%3Ccircle cx='40' cy='24' r='7' fill='%23d4d4d8'/%3E%3C/svg%3E";

const IMG_TAG = /<img\b[^>]*>/gi;
// An attribute value, quoted with either style or left bare. All three forms are
// used in real mail, and a bare `src` is just as live as a quoted one — so it is
// read, not skipped.
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const IMAGE_DATA_URL = /^data:image\//i;
const SUPPORTED_IMAGE_TYPE = /^image\/(?:png|jpe?g|gif|webp|bmp|avif|tiff|svg\+xml|x-icon)$/;

function escapeAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The value of one attribute in a tag, or '' when it is absent. */
function tagAttribute(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!match) return '';
  return String(match[1] ?? match[2] ?? match[3] ?? '');
}

/** The `src` of an `<img>` tag, quoted or bare. */
function imageSrc(tag) {
  const match = String(tag).match(SRC_ATTR);
  if (!match) return '';
  return String(match[1] ?? match[2] ?? match[3] ?? '').trim();
}

/** True for an image addressed on another host (`https://`, `http://`, `//`). */
export function isRemoteImageUrl(value) {
  return /^(?:https?:)?\/\//i.test(String(value ?? '').trim());
}

/**
 * True when a message body references at least one image on a remote host, so
 * the reader can offer "Show images" only when it would actually do something.
 */
export function hasRemoteImages(html) {
  const tags = String(html ?? '').match(IMG_TAG) || [];
  return tags.some((tag) => isRemoteImageUrl(imageSrc(tag)));
}

/**
 * Builds a `data:` URL for an inline image part.
 *
 * The content type matters: a data URL carries its own MIME type, and
 * `data:application/octet-stream;base64,…` (which is what the attachment
 * download endpoint returns) is not a type a browser will render as an image —
 * resolving `cid:` to that produced a *still-broken* image, just with the correct
 * bytes. Only image types are accepted here; anything else returns '' and leaves
 * the sender's reference untouched.
 */
export function dataUrlFromBase64(mimeType, base64) {
  const type = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (!SUPPORTED_IMAGE_TYPE.test(type)) return '';
  const payload = String(base64 || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!payload) return '';
  return `data:${type};base64,${payload}`;
}

/** Replaces an image tag with a sized, self-explaining placeholder. */
function placeholderTag(tag, reason) {
  const original = tagAttribute(tag, 'src');
  const width = tagAttribute(tag, 'width');
  const height = tagAttribute(tag, 'height');
  const style = tagAttribute(tag, 'style');
  const alt = tagAttribute(tag, 'alt');
  const title = `${reason}${original ? ` — ${original}` : ''}`;

  return `<img class="seedmail-image-pending" src="${PLACEHOLDER_IMAGE}"`
    + (width ? ` width="${escapeAttribute(width)}"` : '')
    + (height ? ` height="${escapeAttribute(height)}"` : '')
    + (style ? ` style="${escapeAttribute(style)}"` : '')
    + ` alt="${escapeAttribute(alt || 'Image')}"`
    + ` title="${escapeAttribute(title)}"`
    + (original ? ` data-seedmail-original-src="${escapeAttribute(original)}"` : '')
    + '>';
}

/**
 * Substitutes a placeholder for every `<img>` that cannot be loaded in the
 * current mode. Everything else — including every valid `https://` URL when the
 * user has allowed remote content — is passed through byte for byte.
 */
export function markUnavailableImages(html, { allowRemote = false } = {}) {
  return String(html ?? '').replace(IMG_TAG, (tag) => {
    const src = imageSrc(tag);

    // Already inline bytes (an embedded part, or a data: image the sender used):
    // always renderable, and never a tracking risk.
    if (IMAGE_DATA_URL.test(src)) return tag;
    if (!src) return placeholderTag(tag, 'This image has no usable source');
    if (/^cid:/i.test(src)) {
      return placeholderTag(tag, 'This embedded image could not be read from the message');
    }
    if (isRemoteImageUrl(src)) {
      if (allowRemote) return tag;
      return placeholderTag(tag, 'Remote image not loaded yet — choose Show images');
    }
    return placeholderTag(tag, 'This image uses a relative address that cannot be loaded');
  });
}

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
  // Order matters: strip unsafe markup, resolve `cid:` to real bytes, then decide
  // what can actually be displayed in this pass.
  const cleaned = addLinkSafety(markUnavailableImages(
    resolveInlineImages(stripUnsafeMarkup(html), inlineImages),
    { allowRemote },
  ));
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
  /* A substituted placeholder (a blocked remote image, an unresolved cid:, or a
     relative URL that can never load) keeps the sender's layout instead of
     collapsing to a broken-image icon. The reason is in its title attribute. */
  img.seedmail-image-pending {
    background: #f4f4f5;
    border: 1px solid #e4e4e7;
    border-radius: 4px;
    object-fit: contain;
    min-height: 60px;
    min-width: 80px;
  }
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
