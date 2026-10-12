// Tests for the canonical-origin guard in frontend/js/lib/endpoints.js
//
// The defect this pins is the "signed in at Google, signed out in the app" state:
//
//   * the application was reachable on more than one Vercel hostname — the
//     production domain and a team-scoped deployment host such as
//     `seedmail-<team>.vercel.app`;
//   * a deployment host can sit behind Vercel Deployment Protection;
//   * `redirectTo` was built from `window.location.origin`, so a sign-in started
//     on that host asked Google to return to a URL Vercel answers with its own
//     login wall. The authorisation code was never delivered to the SPA, so the
//     Supabase account was created while no browser session existed.
//
// Two properties matter and are asserted separately: the guard must move a
// deployment hostname onto the canonical origin, and it must NOT move anything
// else — a wrong redirect on localhost or on a real domain would be worse than
// the bug it fixes.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CANONICAL_ORIGIN,
  canonicalRedirectFor,
} from '../../frontend/js/lib/endpoints.js';

const PROD = 'https://mrseedmail.vercel.app';

test('a Vercel deployment hostname is moved to the canonical production origin', () => {
  // The reported host shape: <project>-<team>.vercel.app
  assert.equal(
    canonicalRedirectFor({
      hostname: 'seedmail-alshahriar911s-projects.vercel.app',
      pathname: '/',
      hash: '#/login',
    }),
    `${PROD}/#/login`,
  );

  // A preview deployment for a branch.
  assert.equal(
    canonicalRedirectFor({ hostname: 'seedmail-git-main-team.vercel.app', pathname: '/' }),
    `${PROD}/`,
  );

  // The production host itself is already canonical: no move, so no loop.
  assert.equal(canonicalRedirectFor({ hostname: 'mrseedmail.vercel.app', pathname: '/' }), '');
});

test('the query string is never carried over, so a foreign OAuth code is not replayed', () => {
  // The function has no query input at all: a query on the wrong origin can only
  // hold a single-use `code` or an `error` that belongs to that origin.
  const target = canonicalRedirectFor({
    hostname: 'seedmail-alshahariar911s-projects.vercel.app',
    pathname: '/',
    hash: '#/login',
  });
  assert.equal(target, `${PROD}/#/login`);
  assert.ok(!target.includes('?'), 'no query string may be carried to the canonical origin');
});

test('a non-deployment host is left exactly where it is', () => {
  // Local development: `npm run dev` must keep working on 127.0.0.1.
  assert.equal(canonicalRedirectFor({ hostname: '127.0.0.1', pathname: '/', hash: '#/inbox' }), '');
  assert.equal(canonicalRedirectFor({ hostname: 'localhost', pathname: '/' }), '');
  assert.equal(canonicalRedirectFor({ hostname: '::1', pathname: '/' }), '');

  // A custom domain, an internal hostname or a file:// page is authoritative.
  assert.equal(canonicalRedirectFor({ hostname: 'mail.example.com', pathname: '/' }), '');
  assert.equal(canonicalRedirectFor({ hostname: 'seedmail.internal', pathname: '/' }), '');
  assert.equal(canonicalRedirectFor({ hostname: '', pathname: '/' }), '');
});

test('the configured site URL wins, and an unusable one falls back to the built-in domain', () => {
  assert.equal(
    canonicalRedirectFor({
      configured: 'https://mail.example.com',
      hostname: 'seedmail-alshahariar911s-projects.vercel.app',
      pathname: '/',
    }),
    'https://mail.example.com/',
  );

  // A typo in VITE_SITE_URL must not disable the guard (nor produce an http://, a
  // javascript: or a relative redirect).
  for (const broken of ['', 'not a url', 'http://mrseedmail.vercel.app', 'javascript:alert(1)']) {
    assert.equal(
      canonicalRedirectFor({
        configured: broken,
        hostname: 'seedmail-alshahariar911s-projects.vercel.app',
        pathname: '/',
      }),
      `${PROD}/`,
      `a broken VITE_SITE_URL (${JSON.stringify(broken)}) must fall back, not disable or leak`,
    );
  }

  // When even the fallback is unusable, nothing is redirected at all.
  assert.equal(
    canonicalRedirectFor({
      configured: 'nonsense',
      defaultOrigin: 'http://example.com',
      hostname: 'seedmail-alshahariar911s-projects.vercel.app',
      pathname: '/',
    }),
    '',
  );
});

test('the path and hash route are preserved so the user lands where they were', () => {
  assert.equal(
    canonicalRedirectFor({
      hostname: 'seedmail-preview-team.vercel.app',
      pathname: '/privacy',
      hash: '',
    }),
    `${PROD}/privacy`,
  );
  assert.equal(
    canonicalRedirectFor({
      hostname: 'seedmail-preview-team.vercel.app',
      pathname: '/',
      hash: '#/inbox/18f2c0',
    }),
    `${PROD}/#/inbox/18f2c0`,
  );
});

test('the built-in canonical origin is the production domain the rest of the build uses', () => {
  assert.equal(DEFAULT_CANONICAL_ORIGIN, PROD);
});
