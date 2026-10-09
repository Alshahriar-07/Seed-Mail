// Tests for frontend/js/lib/endpoints.js
//
// These pin the rule that caused a real production bug: a hardcoded localhost
// default was applied to every build, so the deployed site reported
// 'The send worker is not reachable. For local development, start it with
//  "python worker/main.py".' to its users.
//
// The contract now is:
//   * a loopback URL is only honoured by a page that is itself served locally;
//   * a deployed page with a loopback value gets no URL at all, plus a reason
//     the operator can act on;
//   * nothing is ever invented when no URL is configured.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isLoopbackHostname, pageIsLocal, resolveServiceUrl } from '../../frontend/js/lib/endpoints.js';

const LOCAL_PAGE = '127.0.0.1';
const REMOTE_PAGE = 'mrseedmail.vercel.app';

test('loopback hostnames are recognised, including the whole 127.0.0.0/8 range', () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.0.53', '::1', '[::1]', '0.0.0.0', '']) {
    assert.equal(isLoopbackHostname(host), true, `${host} should be loopback`);
  }
  for (const host of ['mrseedmail.vercel.app', 'seedmail-worker.onrender.com', '10.0.0.5', '128.0.0.1']) {
    assert.equal(isLoopbackHostname(host), false, `${host} should not be loopback`);
  }
});

test('pageIsLocal reflects where the page is served from', () => {
  assert.equal(pageIsLocal(LOCAL_PAGE), true);
  assert.equal(pageIsLocal('localhost'), true);
  assert.equal(pageIsLocal(REMOTE_PAGE), false);
  assert.equal(pageIsLocal(''), true, 'file:// and similar have no hostname');
});

test('a deployed page refuses a localhost worker URL and explains why', () => {
  const resolved = resolveServiceUrl('http://127.0.0.1:8765', {
    label: 'send worker (VITE_MAIL_WORKER_URL)',
    hostname: REMOTE_PAGE,
  });

  assert.equal(resolved.url, '', 'a deployed page must not use a localhost URL');
  assert.equal(resolved.source, 'stale-localhost');
  assert.equal(resolved.staleLocalhost, true);
  assert.match(resolved.problem, /points at this machine/);
  assert.match(resolved.problem, /redeploy/);
  // The old failure told production users to run Python. The config problem must
  // not repeat that instruction.
  assert.ok(!/python worker\/main\.py/.test(resolved.problem));
});

test('a locally served page may use the localhost worker URL', () => {
  const resolved = resolveServiceUrl('http://127.0.0.1:8765', { hostname: LOCAL_PAGE });
  assert.equal(resolved.url, 'http://127.0.0.1:8765');
  assert.equal(resolved.source, 'configured');
  assert.equal(resolved.problem, '');
});

test('an unset value falls back to localhost only for a local page', () => {
  const local = resolveServiceUrl('', { localDefault: 'http://127.0.0.1:8765', hostname: LOCAL_PAGE });
  assert.equal(local.url, 'http://127.0.0.1:8765');
  assert.equal(local.source, 'local-default');

  const remote = resolveServiceUrl('', { localDefault: 'http://127.0.0.1:8765', hostname: REMOTE_PAGE });
  assert.equal(remote.url, '', 'no host is invented for a deployed page');
  assert.equal(remote.source, 'unset');
  assert.equal(remote.problem, '');
});

test('a deployed page rejects a plain http:// service URL (mixed content)', () => {
  const resolved = resolveServiceUrl('http://seedmail-worker.onrender.com', { hostname: REMOTE_PAGE });
  assert.equal(resolved.url, '');
  assert.equal(resolved.source, 'insecure');
  assert.match(resolved.problem, /https/);
});

test('a valid https service URL is accepted and normalised', () => {
  const resolved = resolveServiceUrl('https://seedmail-worker.onrender.com///', { hostname: REMOTE_PAGE });
  assert.equal(resolved.url, 'https://seedmail-worker.onrender.com');
  assert.equal(resolved.source, 'configured');
  assert.equal(resolved.problem, '');
});

test('a malformed value is reported instead of silently ignored', () => {
  for (const bad of ['not a url', 'ftp://example.com', '/api']) {
    const resolved = resolveServiceUrl(bad, { label: 'service', hostname: REMOTE_PAGE });
    assert.equal(resolved.url, '', `${bad} must not be used`);
    assert.equal(resolved.source, 'invalid');
    assert.ok(resolved.problem.length > 0, `${bad} must produce a reason`);
  }
});

test('an empty local default yields an empty url rather than a guess', () => {
  const resolved = resolveServiceUrl('', { localDefault: '', hostname: LOCAL_PAGE });
  assert.equal(resolved.url, '');
  assert.equal(resolved.source, 'unset');
});
