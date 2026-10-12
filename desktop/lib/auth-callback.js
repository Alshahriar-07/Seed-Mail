'use strict';

// Seed Code Mail — the desktop OAuth return listener.
//
// Google sign-in happens in the user's own browser (see desktop/main.js), so the
// authorisation `code` comes back over the network rather than into this window.
// This module owns the one thing that receives it.
//
// Why a fixed loopback URL and not a random port: Supabase validates `redirect_to`
// against the project's allowed Redirect URLs, so a port that changes every launch
// could never be allow-listed. One exact URL — `http://127.0.0.1:43117/auth/callback`
// — can be added once and checked in the URL audit.
//
// What makes it safe to be a plain HTTP listener:
//
//   * it binds to **127.0.0.1 only**, so nothing outside this machine can reach it;
//   * the **Host header** must be a loopback name as well, so a hostname that merely
//     resolves to 127.0.0.1 (DNS rebinding) cannot deliver a code;
//   * only `GET /auth/callback` is answered — every other path is a 404 and every
//     other method a 404;
//   * it is **closed before the code is handed on**, so a replay cannot produce a
//     second delivery (the code is single-use at Supabase anyway);
//   * it **expires** (TTL) so an abandoned sign-in cannot leave a listener bound;
//   * it never logs, stores or returns the code itself — the code is passed to the
//     caller's `onDeliver` and the browser only ever sees a fixed page.
//
// The code is not a credential by itself: exchanging it requires the PKCE code
// verifier, which never leaves the application window's own storage.

const http = require('node:http');

/** The loopback port and path Supabase must be allowed to redirect to. */
const CALLBACK_PORT = 43117;
const CALLBACK_PATH = '/auth/callback';
const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

/** An unfinished sign-in must not leave a listener bound. */
const CALLBACK_TTL_MS = 5 * 60 * 1000;

/**
 * True for a Host header that can only have come from this machine.
 *
 * `[::1]:port` is why this does not simply split on ':': an IPv6 literal contains
 * colons of its own, so splitting first would read the host as `[` and reject a
 * legitimate loopback callback (the bug this function was extracted with). The
 * bracketed form is unwrapped first, and only a real host name is compared.
 */
function isLoopbackHostHeader(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return false;
  const bracket = raw.indexOf(']');
  const host = raw.startsWith('[') && bracket !== -1
    ? raw.slice(1, bracket)
    : raw.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** The page the browser is left on. Deliberately static: no OAuth value is echoed. */
function callbackPage({ ok }) {
  const title = ok ? 'Sign-in complete' : 'Sign-in could not be completed';
  const message = ok
    ? 'You are signed in. You can close this tab and return to Seed Code Mail.'
    : 'Seed Code Mail did not receive a usable sign-in response. Close this tab and try again from the application.';
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${title} \u00b7 Seed Code Mail</title><style>`
    + 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f8f6;'
    + 'color:#1a1a19;font-family:"Inter","Segoe UI",system-ui,sans-serif}'
    + '.c{width:min(440px,90vw);background:#fff;border:1px solid #e4e4df;border-radius:14px;padding:32px}'
    + 'h1{margin:0 0 8px;font-size:19px}p{margin:0;font-size:14px;line-height:1.6;color:#5c5c57}'
    + `</style></head><body><main class="c"><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

class AuthCallbackListener {
  /**
   * @param {object} [options]
   * @param {number} [options.port]    0 for an ephemeral port (tests)
   * @param {string} [options.path]
   * @param {number} [options.ttlMs]
   * @param {(payload: {code?: string, error?: string}) => void} [options.onDeliver]
   * @param {(line: string) => void} [options.onLog]
   */
  constructor({
    port = CALLBACK_PORT,
    path: callbackPath = CALLBACK_PATH,
    ttlMs = CALLBACK_TTL_MS,
    onDeliver = () => {},
    onLog = () => {},
  } = {}) {
    this.port = port;
    this.path = callbackPath;
    this.ttlMs = ttlMs;
    this.onDeliver = onDeliver;
    this.onLog = onLog;
    this.server = null;
    this.boundPort = 0;
    this.timer = null;
  }

  /** True while the listener is accepting requests. */
  get active() {
    return Boolean(this.server);
  }

  /** The exact URL to use as `redirectTo`, or '' when not listening. */
  get uri() {
    if (!this.boundPort) return '';
    return `http://127.0.0.1:${this.boundPort}${this.path}`;
  }

  /**
   * Starts the listener. Idempotent: a second call while it is running returns the
   * same URL instead of opening a second socket, so a double-click cannot produce
   * two pending flows.
   */
  async begin() {
    if (this.server) return { ok: true, redirectUrl: this.uri };

    const server = http.createServer((req, res) => this._handle(req, res));

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(this.port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve();
      });
    });

    // `port: 0` binds an ephemeral port; the real one is only known now.
    const address = server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : this.port;
    this.server = server;
    this.timer = setTimeout(() => this.stop(), this.ttlMs);
    this.onLog(`[auth] waiting for the Google return on ${this.uri}`);
    return { ok: true, redirectUrl: this.uri };
  }

  /** Closes the listener. Safe to call more than once, and from any state. */
  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    if (server) {
      try {
        server.close();
      } catch (_) {
        // Already closed, or never listening; nothing to undo.
      }
    }
  }

  _handle(req, res) {
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    let url;
    try {
      url = new URL(String(req.url || '/'), 'http://127.0.0.1');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }

    if (req.method !== 'GET' || url.pathname !== this.path) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code') || '';
    const error = url.searchParams.get('error')
      || url.searchParams.get('error_description')
      || (code ? '' : 'no_code');

    // Close first: this delivery is the one and only one for this sign-in.
    this.stop();

    try {
      this.onDeliver(code ? { code } : { error });
    } catch (_) {
      // A failing consumer must not turn a completed sign-in into a 500 page.
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(callbackPage({ ok: Boolean(code) }));
  }
}

module.exports = {
  AuthCallbackListener,
  CALLBACK_PORT,
  CALLBACK_PATH,
  CALLBACK_URI,
  CALLBACK_TTL_MS,
  callbackPage,
  isLoopbackHostHeader,
};
