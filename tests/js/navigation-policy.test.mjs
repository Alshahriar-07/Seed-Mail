// Tests for desktop/lib/navigation-policy.js
//
// This is the boundary that decides what a privileged Electron window may render.
// The requirement it exists for: "open Google OAuth in the actual Windows
// system-default browser", i.e. Google's pages must never be a document in this
// window, while ordinary application navigation must be untouched.
//
// Both directions are asserted. A policy that simply refused a lot would pass a
// "Google is blocked" test while breaking the app, so every refusal is paired with
// something that must still be allowed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAllowedExternal,
  isExternalOnlyUrl,
  isTrustedNavigation,
} from '../../desktop/lib/navigation-policy.js';

const CTX = {
  cloudOrigin: 'https://mrseedmail.vercel.app',
  supabaseHost: 'jptukeybgvuehdzghxfj.supabase.co',
};

test('Google sign-in pages must never render in the application window', () => {
  for (const url of [
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=y',
    'https://accounts.google.com/v3/signin/identifier',
    'https://accounts.google.com/signin/oauth',
    'https://apis.google.com/js/api.js',
    'https://myaccount.google.com/apppasswords',
    'https://google.com/',
  ]) {
    assert.equal(isExternalOnlyUrl(url, CTX), true, `${url} is an identity page`);
    assert.equal(isTrustedNavigation(url, CTX), false, `${url} must never load in-window`);
    assert.equal(isAllowedExternal(url, CTX), true, `${url} must be openable in the real browser`);
  }
});

test('the Supabase endpoint that only redirects to Google is external-only too', () => {
  const authorize = 'https://jptukeybgvuehdzghxfj.supabase.co/auth/v1/authorize?provider=google';
  assert.equal(isExternalOnlyUrl(authorize, CTX), true);
  assert.equal(isTrustedNavigation(authorize, CTX), false,
    'a cached bundle that navigates here must not get an embedded Google page');
  assert.equal(isAllowedExternal(authorize, CTX), true);

  // But the rest of the Supabase project is a normal, trusted destination.
  const other = 'https://jptukeybgvuehdzghxfj.supabase.co/auth/v1/settings';
  assert.equal(isExternalOnlyUrl(other, CTX), false);
  assert.equal(isTrustedNavigation(other, CTX), true);
});

test('ordinary application navigation is untouched', () => {
  for (const url of [
    'https://mrseedmail.vercel.app/',
    'https://mrseedmail.vercel.app/#/inbox',
    'https://mrseedmail.vercel.app/privacy',
    'https://mrseedmail.vercel.app/api/gmail/status',
  ]) {
    assert.equal(isTrustedNavigation(url, CTX), true, `${url} must load in-window`);
    assert.equal(isExternalOnlyUrl(url, CTX), false);
  }
});

test('an unrelated host is neither trusted nor openable', () => {
  for (const url of [
    'https://evil.example/',
    'https://mrseedmail.vercel.app.evil.example/',
    'https://google.com.evil.example/',
    'https://accounts.google.com.evil.example/',
  ]) {
    assert.equal(isTrustedNavigation(url, CTX), false, `${url} must not load in-window`);
    assert.equal(isAllowedExternal(url, CTX), false, `${url} must not be opened either`);
    assert.equal(isExternalOnlyUrl(url, CTX), false);
  }
});

test('a wildcard-looking suffix cannot be used to impersonate a host', () => {
  // `endsWith('.google.com')` must not accept `evilgoogle.com` or a bare TLD.
  assert.equal(isAllowedExternal('https://evilgoogle.com/', CTX), false);
  assert.equal(isAllowedExternal('https://google.com/', CTX), true);
  // A user-content host under googleusercontent is openable (Google avatars),
  // which is the documented suffix list.
  assert.equal(isAllowedExternal('https://lh3.googleusercontent.com/a/photo.jpg', CTX), true);
});

test('non-https and malformed values are refused as navigations and as external opens', () => {
  for (const url of [
    'http://mrseedmail.vercel.app/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'not a url',
    '',
    undefined,
  ]) {
    assert.equal(isTrustedNavigation(url, CTX), false, `${String(url)} must not load in-window`);
    assert.equal(isAllowedExternal(url, CTX), false, `${String(url)} must not be handed to the OS`);
    assert.equal(isExternalOnlyUrl(url, CTX), false, `${String(url)} is not an identity page`);
  }

  // An http:// Google host is still *recognised* as an identity page — the host is
  // what matters — but it is not openable, because a plain-http authorization URL
  // is never legitimate. Both halves are asserted so neither silently changes.
  assert.equal(isExternalOnlyUrl('http://accounts.google.com/', CTX), true);
  assert.equal(isTrustedNavigation('http://accounts.google.com/', CTX), false);
  assert.equal(isAllowedExternal('http://accounts.google.com/', CTX), false);

  // `mailto:` has no host and is handled by the mail client, so it is allowed.
  assert.equal(isAllowedExternal('mailto:someone@example.com', CTX), true);
  assert.equal(isTrustedNavigation('mailto:someone@example.com', CTX), false);
});

test('an unconfigured Supabase host trusts only the application origin', () => {
  const bare = { cloudOrigin: CTX.cloudOrigin, supabaseHost: '' };
  assert.equal(isTrustedNavigation('https://mrseedmail.vercel.app/', bare), true);
  assert.equal(isTrustedNavigation('https://jptukeybgvuehdzghxfj.supabase.co/auth/v1/settings', bare), false,
    'with no project configured, a Supabase page must not be trusted by accident');
  // Google is recognised structurally, so it is still excluded from the window.
  assert.equal(isTrustedNavigation('https://accounts.google.com/', bare), false);
});
