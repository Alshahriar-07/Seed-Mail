// Seed Code Mail — runtime configuration (web vs desktop)
//
// The application runs in exactly one of two places, and each one gets its
// campaign SMTP sender from a different source:
//
//   * **WEB** — the Vite build deployed to Vercel. There is no local process,
//     so the sender is the remote worker service resolved from
//     `VITE_MAIL_WORKER_URL` (see lib/worker.js). The browser never scans for,
//     starts, or talks to anything on 127.0.0.1.
//
//   * **DESKTOP** — the Windows application, where an Electron main process
//     starts a bundled SMTP worker on a loopback port and hands this page the
//     worker's address and a per-launch session token through a `contextBridge`
//     (see desktop/main.js and desktop/preload.js). The page uses that worker.
//
// This module is the single place that answers "which one am I?". Nothing else
// inspects `window` for a desktop bridge, and the bridge is only trusted when
// the value is well-formed:
//
//   * it must be an object with `isDesktop === true`;
//   * its worker URL must parse as an absolute http(s) URL whose host is
//     loopback — a desktop bridge that named a remote host would be a
//     misconfiguration, and is refused rather than used;
//   * the session token is passed through opaquely and is never rendered,
//     logged, or written to storage.
//
// An arbitrary web page cannot create this bridge: `contextBridge` is the only
// way it appears, and only the app's own preload script calls it. A page that
// simply defines `window.seedmailDesktop` is still just a web page — the main
// process never enables privileged behaviour for it, and the worker it would
// point at is a loopback service that verifies the caller's Supabase token
// independently.

/** The property the preload script installs. */
const BRIDGE_KEY = 'seedmailDesktop';

/** Loopback hostnames, for validating the desktop worker URL. */
const LOOPBACK_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isLoopbackHostname(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function rawBridge() {
  if (typeof window === 'undefined') return null;
  const value = window[BRIDGE_KEY];
  if (!value || typeof value !== 'object') return null;
  if (value.isDesktop !== true) return null;
  return value;
}

/** True when this page is running inside the Seed Code Mail desktop app. */
export function isDesktop() {
  return Boolean(rawBridge());
}

/**
 * Asks the desktop shell to open a URL in the user's default browser.
 *
 * Used for flows that deliberately belong on the deployed origin rather than in
 * the application window — notably the Google OAuth consent screen, whose
 * HttpOnly nonce cookie is only valid on the origin that started the flow. Only
 * the app's own preload installs this function, so a plain web page can never
 * reach it. Returns false when there is no desktop shell (or no handler), so a
 * caller can fall back to normal in-page navigation.
 */
export function openExternal(url) {
  const bridge = rawBridge();
  if (!bridge || typeof bridge.openExternal !== 'function') return false;
  try {
    bridge.openExternal(String(url ?? ''));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The desktop worker connection, or null when not running on the desktop.
 *
 * Returns `{ workerUrl, workerToken, appVersion, platform }`. `workerUrl` is ''
 * when the bridge is present but its address is missing or not loopback, so a
 * malformed bridge degrades to "the desktop worker is unavailable" instead of
 * being trusted.
 */
export function desktopWorker() {
  const bridge = rawBridge();
  if (!bridge) return null;

  const rawUrl = String(bridge.workerUrl || '').trim();
  let workerUrl = '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      // A desktop worker is always loopback. Anything else is a malformed
      // bridge and is refused rather than used to reach another host.
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHostname(parsed.hostname)) {
        workerUrl = rawUrl.replace(/\/+$/, '');
      }
    } catch (_) {
      workerUrl = '';
    }
  }

  return {
    workerUrl,
    workerToken: String(bridge.workerToken || ''),
    appVersion: String(bridge.appVersion || ''),
    platform: String(bridge.platform || ''),
  };
}
