// Guard for "Continue with Google" and the boundary between authentication and
// Gmail authorization.
//
// auth.js is a browser module and cannot be imported by the Node test runner
// without a DOM, so the invariants are asserted against the source — the same
// approach as tests/js/mail-reader.test.mjs.
//
// The security property that matters here: Google *sign-in* authenticates the
// account only. It must not request Gmail scopes or offline access, because
// Supabase keeps provider tokens in the browser session and a Gmail refresh
// token must only ever live encrypted on the server
// (backend/lib/connection.js → saveConnection). Gmail access is a separate,
// server-side OAuth grant (frontend/js/mail-common.js → startConnect).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const AUTH = readFileSync(path.join(ROOT, 'frontend', 'js', 'auth.js'), 'utf8');
const CSS = readFileSync(path.join(ROOT, 'frontend', 'css', 'auth.css'), 'utf8');

test('Continue with Google authenticates the account, and only the account', () => {
  assert.match(AUTH, /export async function signInWithGoogle\(/, 'signInWithGoogle must exist');
  assert.match(AUTH, /signInWithOAuth\(\{/, 'it must use the Supabase OAuth helper');
  assert.match(AUTH, /provider: 'google'/, 'the provider must be Google');

  // The identity grant must not smuggle in Gmail access.
  assert.ok(!/gmail\.(readonly|send|modify|compose)/.test(AUTH),
    'Gmail scopes must not be requested at sign-in; Gmail access is a separate grant');
  assert.ok(!/access_type|provider_refresh_token|provider_token/.test(AUTH),
    'offline access and provider tokens must never touch the browser session');
});

test('the Google button is offered on both the sign-in and sign-up screens', () => {
  assert.match(AUTH, /id="auth-google"/, 'the button must exist in the markup');
  assert.match(AUTH, /#auth-google/, 'and it must be queried when binding');
  const binds = AUTH.match(/bindGoogle\(container,/g) || [];
  assert.ok(binds.length >= 2, 'a new user must be able to use it too, so both screens bind it');
  assert.match(CSS, /\.auth-divider/, 'the divider between Google and the email form must be styled');
});
