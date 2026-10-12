// Guard for the desktop Google sign-in flow.
//
// The defects these pin:
//
//   * the Windows application rendered Google's sign-in pages inside its own
//     window, so the person's real Chrome/Edge Google session was unavailable and
//     they had to sign in to Google again from scratch;
//   * the callback had no way back into the application, so a completed Google
//     login left the app signed out even though Supabase showed the new user.
//
// frontend/js/auth.js, frontend/js/lib/runtime.js and the desktop shell are not
// importable by the Node test runner as a unit (DOM / Electron), so the
// invariants are asserted against the source — the same approach as
// tests/js/mail-reader.test.mjs and tests/js/desktop-runtime.test.mjs. They are
// about *structure and boundaries*: which URL is handed to the operating system,
// where the code is exchanged, and what may cross the IPC bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

const AUTH = read('frontend', 'js', 'auth.js');
const RUNTIME = read('frontend', 'js', 'lib', 'runtime.js');
const APP = read('frontend', 'js', 'app.js');
const PRELOAD = read('desktop', 'preload.js');
const MAIN = read('desktop', 'main.js');
const CALLBACK = read('desktop', 'lib', 'auth-callback.js');

test('Google authorization is opened by the operating system, never in the app window', () => {
  assert.match(AUTH, /skipBrowserRedirect: true/,
    'the URL must be returned to the page instead of navigating the window');
  assert.match(AUTH, /openExternal\(url\)/, 'the page hands that URL to the shell');
  assert.match(AUTH, /isDesktop\(\)\) return signInWithGoogleInBrowser\(\)/,
    'the desktop path is separate from the web path');

  // The shell must treat identity pages as external-only: a navigation to Google
  // (or to the Supabase endpoint that only 302s to it) opens in the real browser.
  // The rules themselves are asserted directly in navigation-policy.test.mjs;
  // here it is the wiring that matters — the window's guard uses them, and the
  // blocked case opens externally rather than being dropped.
  assert.match(MAIN, /const \{[\s\S]*?isTrustedNavigation: policyTrustsNavigation[\s\S]*?\} = require\('\.\/lib\/navigation-policy\.js'\)/,
    'the window must use the tested policy module, not an inline copy');
  assert.match(MAIN, /function hardenWindow\(win\)/);
  assert.match(MAIN, /const guard = \(event, url\) => \{\n    if \(isTrustedNavigation\(url\)\) \{/, 'navigations are gated by the policy');
  assert.match(MAIN, /win\.webContents\.on\('will-redirect', guard\)/,
    'the redirect chain is gated too, so a hop to Google cannot slip through');
  assert.match(MAIN, /if \(isAllowedExternal\(url\)\) shell\.openExternal\(url\);/,
    'a refused identity navigation opens in the real browser instead of being dropped');
});

test('the returned code is exchanged in the app, where the PKCE verifier lives', () => {
  assert.match(AUTH, /exchangeCodeForSession\(code\)/,
    'the exchange must use Supabase own helper, not a hand-built token request');
  // No token or code may be parsed out of a URL or written to storage by the app.
  assert.ok(!/localStorage\.setItem\([^)]*(code|token)/i.test(AUTH),
    'the application must not persist a code or token itself');
  assert.ok(!/JSON\.parse\(atob|jwtDecode|decodeURIComponent\(.*id_token/i.test(AUTH),
    'no manual token decoding');
});

test('a failed or cancelled sign-in is reported instead of looking like a success', () => {
  assert.match(AUTH, /desktopAuthError = /, 'a desktop failure must be remembered for the UI');
  assert.match(AUTH, /export function desktopAuthErrorMessage\(\)/);
  assert.match(AUTH, /notify\('AUTH_ERROR', currentSession\)/,
    'the UI must be told, so the sign-in screen can explain it');
  assert.match(APP, /event === 'AUTH_ERROR'/, 'and the shell must act on it');
  assert.match(AUTH, /export function callbackErrorMessage\(\)/,
    'a web callback that produced no session must be explained too');
  assert.match(AUTH, /const initialError = urlError \|\| desktopAuthErrorMessage\(\) \|\| callbackErrorMessage\(\)/,
    'the sign-in screen shows the most specific reason it has');
});

test('one-shot OAuth parameters are cleared only after the callback has been processed', () => {
  assert.match(AUTH, /function stripCallbackParams\(\)/);
  // Order is the whole point: supabase-js reads the code while it initialises, so
  // stripping first would break the exchange; not stripping at all lets a refresh
  // replay a spent code.
  const bootstrap = AUTH.slice(AUTH.indexOf('export async function bootstrapAuth'));
  const awaitSession = bootstrap.indexOf('const result = await withTimeout');
  const stripCall = bootstrap.indexOf('  stripCallbackParams();');
  assert.ok(awaitSession !== -1 && stripCall !== -1 && stripCall > awaitSession,
    'the cleanup must run after the session restore, not before it');
  // Exactly one *call* site, and it is the one above: anything at module scope
  // would strip the code before supabase-js could read it, breaking every login.
  const calls = AUTH.match(/^\s*stripCallbackParams\(\);/gm) || [];
  assert.equal(calls.length, 1, 'stripCallbackParams() has exactly one call site');
  assert.ok(AUTH.indexOf(calls[0]) > AUTH.indexOf('export async function bootstrapAuth'),
    'and that call site is inside bootstrapAuth, not at module load');
});

test('the desktop bridge is origin-gated and exposes only the auth it must', () => {
  assert.match(PRELOAD, /const unavailable = \(\) => Promise\.resolve\(\{ ok: false, error: 'untrusted-frame' \}\)/,
    'an untrusted frame gets an inert stand-in, not a live handler');
  assert.match(PRELOAD, /beginAuthCallback: trusted \?/, 'auth IPC is gated on the trusted origin');
  assert.match(PRELOAD, /onAuthCallback: trusted/, 'the callback subscription is gated too');
  assert.match(MAIN, /function isTrustedFrame\(event\)/, 'the main process re-checks independently');
  assert.match(MAIN, /if \(!isTrustedFrame\(event\)\) return \{ ok: false, error: 'untrusted-frame' \}/,
    'and refuses the auth IPC for anything else');
});

test('the shell wires the loopback listener to the application window only', () => {
  // The listener's own behaviour (bind, Host check, single delivery, TTL) is
  // covered for real in tests/js/auth-callback.test.mjs. Here the wiring is what
  // matters: the exact allow-listable URL, and the code going to this window.
  assert.match(MAIN, /const AUTH_CALLBACK_URI = CALLBACK_URI;/,
    'the redirect URL comes from the listener module, not a second literal');
  assert.match(CALLBACK, /const CALLBACK_URI = `http:\/\/127\.0\.0\.1:\$\{CALLBACK_PORT\}\$\{CALLBACK_PATH\}`;/,
    'the redirect URL must be an exact loopback URL that can be allow-listed verbatim');
  assert.match(MAIN, /mainWindow\.webContents\.send\('seedmail:auth:callback', payload\)/,
    'the code is delivered to the application window');
  assert.match(MAIN, /if \(mainWindow && !mainWindow\.isDestroyed\(\)\)/,
    'and not to a window that has gone away');
  assert.match(MAIN, /stopAuthCallbackServer\(\);\n  \/\/ Stops only the worker/, 'shutdown closes it');
  assert.match(CALLBACK, /server\.listen\(this\.port, '127\.0\.0\.1'/,
    'bound to loopback only');
  assert.match(CALLBACK, /function isLoopbackHostHeader/, 'the Host header is checked (DNS rebinding)');
  assert.match(CALLBACK, /const CALLBACK_TTL_MS = 5 \* 60 \* 1000/, 'an unfinished sign-in expires');
});

test('no authorization code, state or token is ever written to a log', () => {
  for (const [name, source] of [['main.js', MAIN], ['auth.js', AUTH], ['runtime.js', RUNTIME], ['auth-callback.js', CALLBACK]]) {
    const logLines = source
      .split('\n')
      .filter((line) => /log\(|console\.(log|error|warn)/.test(line));
    for (const line of logLines) {
      assert.ok(!/\bcode\b\s*[,)]|\$\{code\}|searchParams\.get\('code'\)\s*\)/.test(line),
        `${name}: a log line must not interpolate an authorization code: ${line.trim()}`);
      assert.ok(!/access_token|refresh_token|code_verifier/.test(line),
        `${name}: a log line must not name a credential: ${line.trim()}`);
    }
  }
});

test('the shell keeps its security posture while doing external OAuth', () => {
  assert.match(MAIN, /contextIsolation: true/);
  assert.match(MAIN, /nodeIntegration: false/);
  assert.match(MAIN, /sandbox: true/);
  assert.match(MAIN, /webSecurity: true/);
  assert.ok(!/webSecurity: false|nodeIntegration: true|contextIsolation: false/.test(MAIN),
    'nothing may be weakened to make a redirect work');
});

test('the page validates the redirect URL it is handed before using it', () => {
  assert.match(RUNTIME, /export async function beginDesktopAuth\(\)/);
  assert.match(RUNTIME, /parsed\.protocol !== 'http:' \|\| !isLoopbackHostname\(parsed\.hostname\)/,
    'a bridge naming a remote callback host is refused rather than used as a redirect target');
  assert.match(RUNTIME, /export function onDesktopAuthCallback\(handler\)/);
  assert.match(AUTH, /if \(!started\?\.redirectUrl\)/,
    'and a missing bridge stops the desktop sign-in instead of falling back to an in-window redirect');
});
