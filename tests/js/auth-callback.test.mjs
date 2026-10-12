// Tests for desktop/lib/auth-callback.js — the desktop OAuth return listener.
//
// This one is exercised for real (a socket on 127.0.0.1 and a genuine HTTP
// request), not by reading the source, because the properties that matter are
// behavioural:
//
//   * the code is delivered exactly once — a replay gets nothing, which is what
//     stops "duplicate callback processing";
//   * an error response is delivered as an error, never as a success;
//   * a Host that is not loopback is refused even though the request did reach
//     the loopback socket (DNS rebinding);
//   * any other path or method is refused;
//   * the listener stops on its own when the sign-in is abandoned;
//   * the fixed production URL is exactly the value that has to be allow-listed
//     in Supabase.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  AuthCallbackListener,
  CALLBACK_PATH,
  CALLBACK_PORT,
  CALLBACK_URI,
  isLoopbackHostHeader,
} from '../../desktop/lib/auth-callback.js';

/** Starts a listener on an ephemeral port and returns it with a fetcher. */
async function start(overrides = {}) {
  const deliveries = [];
  const listener = new AuthCallbackListener({
    port: 0,
    path: CALLBACK_PATH,
    ttlMs: 60_000,
    onDeliver: (payload) => deliveries.push(payload),
    ...overrides,
  });
  await listener.begin();
  const base = `http://127.0.0.1:${listener.boundPort}`;
  return {
    listener,
    deliveries,
    get: (query = '', options = {}) => fetch(`${base}${CALLBACK_PATH}${query}`, options),
  };
}

/** A raw GET with an arbitrary Host header (fetch forbids overriding Host). */
function rawGet({ port, path: requestPath, hostHeader }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('the production callback URL is one exact, allow-listable loopback URL', () => {
  assert.equal(CALLBACK_PORT, 43117);
  assert.equal(CALLBACK_PATH, '/auth/callback');
  assert.equal(CALLBACK_URI, 'http://127.0.0.1:43117/auth/callback');
  // It must not be a wildcard or a random port: Supabase validates redirect_to
  // against the project's allowed Redirect URLs, so this exact string is the one
  // the operator has to add.
  assert.ok(!CALLBACK_URI.includes('*'));
});

test('the authorization code is delivered once and the listener closes', async () => {
  const { listener, deliveries, get } = await start();

  const first = await get('?code=TEST-CODE-ONE');
  assert.equal(first.status, 200);
  assert.match(await first.text(), /Sign-in complete/);
  assert.deepEqual(deliveries, [{ code: 'TEST-CODE-ONE' }]);
  assert.equal(listener.active, false, 'the listener must not accept a second delivery');

  // A replay of the same URL cannot produce a second delivery: the socket is gone.
  await assert.rejects(() => get('?code=TEST-CODE-ONE'), 'a replayed request must not be answered');
  assert.equal(deliveries.length, 1);
});

test('the delivered page never echoes the code back to the browser', async () => {
  const { get } = await start();
  const body = await (await get('?code=SECRET-LOOKING-CODE')).text();
  assert.ok(!body.includes('SECRET-LOOKING-CODE'), 'the code must not be reflected into the page');
});

test('a Google error is delivered as an error, never as a success', async () => {
  const { deliveries, get } = await start();
  const response = await get('?error=access_denied&error_description=The+user+denied');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /could not be completed/);
  assert.deepEqual(deliveries, [{ error: 'access_denied' }]);
  assert.ok(!deliveries[0].code, 'an error response must never carry a code');
});

test('a callback with no code is reported as a failure', async () => {
  const { deliveries, get } = await start();
  await get('?state=whatever');
  assert.deepEqual(deliveries, [{ error: 'no_code' }]);
});

test('a non-loopback Host header is refused even on the loopback socket', async () => {
  const { listener, deliveries } = await start();

  // `fetch` refuses to set a Host header, so this uses a raw request: the socket
  // really is 127.0.0.1 while the header claims another name — exactly the
  // DNS-rebinding case the check exists for.
  const status = await rawGet({
    port: listener.boundPort,
    path: `${CALLBACK_PATH}?code=EVIL`,
    hostHeader: 'evil.example',
  });
  assert.equal(status, 403);
  assert.deepEqual(deliveries, [], 'a rebound request must not deliver anything');
  assert.equal(listener.active, true, 'and must not consume the listener');

  // The same request with a loopback Host is accepted, so the check is not
  // simply refusing everything.
  const okStatus = await rawGet({
    port: listener.boundPort,
    path: `${CALLBACK_PATH}?code=LEGIT`,
    hostHeader: `127.0.0.1:${listener.boundPort}`,
  });
  assert.equal(okStatus, 200);
  assert.deepEqual(deliveries, [{ code: 'LEGIT' }]);

  assert.equal(isLoopbackHostHeader('127.0.0.1:43117'), true);
  assert.equal(isLoopbackHostHeader('localhost:43117'), true);
  assert.equal(isLoopbackHostHeader('[::1]:43117'), true);
  assert.equal(isLoopbackHostHeader('evil.example'), false);
  assert.equal(isLoopbackHostHeader('127.0.0.1.evil.example'), false);
  assert.equal(isLoopbackHostHeader(''), false);
});

test('other paths and methods are refused and leave the sign-in pending', async () => {
  const listener = new AuthCallbackListener({ port: 0, ttlMs: 60_000 });
  await listener.begin();
  const base = `http://127.0.0.1:${listener.boundPort}`;

  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/auth/callback/extra`)).status, 404);
  assert.equal((await fetch(`${base}${CALLBACK_PATH}`, { method: 'POST' })).status, 404);
  assert.equal(listener.active, true, 'a wrong request must not close the listener');

  listener.stop();
});

test('begin() is idempotent, so a double-click cannot open two pending flows', async () => {
  const listener = new AuthCallbackListener({ port: 0, ttlMs: 60_000 });
  const first = await listener.begin();
  const second = await listener.begin();
  assert.equal(first.redirectUrl, second.redirectUrl);
  assert.equal(first.redirectUrl, listener.uri);
  listener.stop();
});

test('an abandoned sign-in expires instead of leaving a listener bound', async () => {
  const listener = new AuthCallbackListener({ port: 0, ttlMs: 20 });
  await listener.begin();
  assert.equal(listener.active, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(listener.active, false, 'the TTL must close it');
  assert.equal(listener.uri, '');
});

test('stop() is safe before begin() and after a delivery', async () => {
  const listener = new AuthCallbackListener({ port: 0, ttlMs: 60_000 });
  listener.stop();
  await listener.begin();
  await fetch(`http://127.0.0.1:${listener.boundPort}${CALLBACK_PATH}?code=ONE`);
  listener.stop();
  listener.stop();
  assert.equal(listener.active, false);
});
