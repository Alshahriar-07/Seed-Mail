'use strict';

// Seed Code Mail — what the desktop window may load, and what it must not.
//
// The window is privileged: it has a preload that can reach the local worker and
// the OAuth callback bridge. So the set of documents it may render is a security
// boundary, not a convenience, and it is defined here as three pure functions so
// it can be tested directly instead of only read.
//
// Three outcomes for a URL:
//
//   1. **identity page** (Google's sign-in pages, or the Supabase endpoint that
//      only redirects to Google) — NEVER rendered in this window, always opened in
//      the user's own browser. An application window has its own cookie jar, so an
//      embedded Google sign-in cannot see the person's existing Chrome/Edge
//      session, and rendering a third-party identity page inside a privileged
//      shell is more attack surface for no benefit. See desktop/main.js.
//   2. **application page** (the deployed site, and the Supabase project for
//      anything that is not the handshake) — may load in-window.
//   3. **anything else** — refused as a navigation; if it is a plain https/mailto
//      link it is handed to the operating system instead.
//
// The functions take the deployment's own values (`cloudOrigin`, `supabaseHost`)
// rather than reading configuration, so they are deterministic and testable.

/** Hosts `openExternal` and popups may reach beyond the application. */
const EXTERNAL_HOST_SUFFIXES = ['.google.com', '.googleusercontent.com'];

function hostOf(rawUrl) {
  try {
    return new URL(String(rawUrl)).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * True for a URL that must never be rendered inside the application window.
 *
 * `https://<project>.supabase.co/auth/v1/authorize` is included because it exists
 * only to redirect the browser to Google: if it were loaded in-window, Google's
 * sign-in page would be the next thing the window renders.
 */
function isExternalOnlyUrl(rawUrl, { supabaseHost = '' } = {}) {
  const host = hostOf(rawUrl);
  if (!host) return false;
  if (host === 'google.com' || host.endsWith('.google.com')) return true;
  if (supabaseHost && host === String(supabaseHost).toLowerCase()) {
    try {
      return new URL(String(rawUrl)).pathname.startsWith('/auth/v1/authorize');
    } catch (_) {
      return false;
    }
  }
  return false;
}

/** True when the window may itself navigate to `rawUrl` (https only). */
function isTrustedNavigation(rawUrl, { cloudOrigin = '', supabaseHost = '' } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch (_) {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (isExternalOnlyUrl(rawUrl, { supabaseHost })) return false;
  if (cloudOrigin && url.origin === cloudOrigin) return true;
  // `about:blank` and any other non-network document is not a trusted page.
  const host = url.hostname.toLowerCase();
  return Boolean(host) && Boolean(supabaseHost) && host === String(supabaseHost).toLowerCase();
}

/** True when a URL is safe to hand to the operating system's browser. */
function isAllowedExternal(rawUrl, { cloudOrigin = '', supabaseHost = '' } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch (_) {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'mailto:') return false;
  // A `mailto:` link has no host to check and is handled by the mail client, so
  // it is allowed by protocol. Without this the earlier `mailto:` allowance was
  // dead code: it fell through to the host-suffix test against an empty host.
  if (url.protocol === 'mailto:') return true;
  // Identity pages are *only* ever opened externally.
  if (isExternalOnlyUrl(rawUrl, { supabaseHost })) return true;
  if (isTrustedNavigation(rawUrl, { cloudOrigin, supabaseHost })) return true;
  const host = url.hostname.toLowerCase();
  return Boolean(host) && EXTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

module.exports = {
  EXTERNAL_HOST_SUFFIXES,
  isAllowedExternal,
  isExternalOnlyUrl,
  isTrustedNavigation,
};
