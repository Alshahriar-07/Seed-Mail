// Integration tests for the trusted Gmail backend (api/gmail/*).
//
// These drive the real handlers with a fake request/response and a mocked
// network, so the properties the application depends on are actually exercised
// rather than assumed:
//
//   * a missing or invalid session is rejected, and the user id always comes
//     from the verified session — never from the request;
//   * a user with no connection is told to connect, not given fake mail;
//   * sending uses the connected account as the From address, builds a real MIME
//     message and calls Gmail's send endpoint;
//   * no response ever contains a token or the service-role key;
//   * an unconfigured server explains which variable is missing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import statusRoute from '../../api/gmail/status.js';
import connectRoute from '../../api/gmail/connect.js';
import callbackRoute from '../../api/gmail/callback.js';
import inboxRoute from '../../api/gmail/inbox.js';
import sendRoute from '../../api/gmail/send.js';
import modifyRoute from '../../api/gmail/modify.js';
import disconnectRoute from '../../api/gmail/disconnect.js';

import { encryptSecret } from '../../backend/lib/crypto.js';

// --- environment ------------------------------------------------------------

const ENV_NAMES = [
  'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI',
  'GMAIL_TOKEN_ENCRYPTION_KEY', 'APP_URL',
];

const CONFIG = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key-value',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret-value',
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
  APP_URL: 'https://mrseedmail.vercel.app',
};

function setConfig(values) {
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
}

// --- fake request / response ------------------------------------------------

function makeReq({ method = 'GET', url = '/api/gmail/status', headers = {}, body } = {}) {
  const stream = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.url = url;
  stream.headers = { host: 'mrseedmail.vercel.app', 'x-forwarded-proto': 'https', ...headers };
  return stream;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(chunk) { this.body = chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

async function call(handler, reqOptions) {
  const res = makeRes();
  await handler(makeReq(reqOptions), res);
  return res;
}

// --- mocked network ---------------------------------------------------------

const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'person@example.com' };

/**
 * Routes requests by URL. `overrides` can replace any handler for a case, and
 * every call is recorded so a test can assert what was (and was not) sent.
 */
function mockFetch(overrides = {}) {
  const calls = [];

  const defaults = {
    'auth/v1/user': () => json(USER),

    'gmail_connections': () => json([]),

    'oauth2.googleapis.com/token': () => json({
      access_token: 'access-token-value',
      expires_in: 3600,
      refresh_token: 'refresh-token-value',
    }),

    'gmail.googleapis.com/gmail/v1/users/me/profile': () => json({ emailAddress: 'person@example.com' }),

    'gmail.googleapis.com/gmail/v1/users/me/messages/send': () => json({
      id: 'gmail-message-id',
      threadId: 'gmail-thread-id',
    }),

    // Listed before the collection URL: matching is prefix-based, so the more
    // specific item endpoint has to be tested first.
    'gmail.googleapis.com/gmail/v1/users/me/messages/m1': () => json({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'hello there',
      internalDate: '1700000000000',
      payload: { headers: [{ name: 'From', value: 'Ada <ada@example.com>' }, { name: 'Subject', value: 'Hi' }] },
    }),

    'gmail.googleapis.com/gmail/v1/users/me/messages': () => json({
      messages: [{ id: 'm1', threadId: 't1' }],
      resultSizeEstimate: 1,
    }),
  };

  const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: (init.method || 'GET').toUpperCase(), body: init.body, headers: init.headers || {} });

    // A test's own handlers win over the defaults, so an override is never
    // shadowed by a broader default pattern.
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (target.includes(pattern)) {
        return typeof handler === 'function' ? handler({ url: target, init }) : handler;
      }
    }
    for (const [pattern, handler] of Object.entries(defaults)) {
      if (target.includes(pattern)) {
        return typeof handler === 'function' ? handler({ url: target, init }) : handler;
      }
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  };

  return calls;
}

const bearer = (token = 'user-access-token') => ({ authorization: `Bearer ${token}` });

/** Seed a stored connection row for USER. */
function connectionRow(overrides = {}) {
  return {
    user_id: USER.id,
    gmail_email: 'person@example.com',
    scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose',
    token_ciphertext: encryptSecret('refresh-token-value', CONFIG.GMAIL_TOKEN_ENCRYPTION_KEY),
    key_version: 1,
    status: 'connected',
    last_error: '',
    connected_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- tests ------------------------------------------------------------------

test('an unconfigured server reports exactly which variables are missing', async () => {
  setConfig({});
  mockFetch();
  const res = await call(statusRoute, { headers: bearer() });
  const payload = res.json();

  assert.equal(res.statusCode, 200, 'status must be reachable so the UI can explain the problem');
  assert.equal(payload.configured, false);
  assert.equal(payload.connection, null);
  assert.ok(payload.configuration.problems.some((problem) => problem.includes('GOOGLE_CLIENT_ID')));
  assert.ok(payload.configuration.problems.some((problem) => problem.includes('GMAIL_TOKEN_ENCRYPTION_KEY')));
});

test('a request without a bearer token is rejected with 401', async () => {
  setConfig(CONFIG);
  mockFetch();
  const res = await call(statusRoute, { headers: {} });
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error, /not signed in|missing/i);
});

test('an invalid session is rejected by Supabase, not trusted locally', async () => {
  setConfig(CONFIG);
  mockFetch({ 'auth/v1/user': () => new Response('{}', { status: 401 }) });
  const res = await call(inboxRoute, { headers: bearer('stale-token') });
  assert.equal(res.statusCode, 401);
});

test('status reports a disconnected account without inventing a mailbox', async () => {
  setConfig(CONFIG);
  mockFetch();
  const payload = (await call(statusRoute, { headers: bearer() })).json();

  assert.equal(payload.configured, true);
  assert.equal(payload.connection.connected, false);
  assert.equal(payload.connection.email, '');
  assert.equal(payload.connection.capabilities.send, false);
});

test('status reports the connected address and granted scopes, and never a token', async () => {
  setConfig(CONFIG);
  mockFetch({ gmail_connections: () => new Response(JSON.stringify([connectionRow()]), { status: 200 }) });
  const res = await call(statusRoute, { headers: bearer() });
  const payload = res.json();

  assert.equal(payload.connection.connected, true);
  assert.equal(payload.connection.email, 'person@example.com');
  assert.equal(payload.connection.capabilities.send, true);
  assert.ok(!res.body.includes('refresh-token-value'), 'the refresh token must never be returned');
  assert.ok(!res.body.includes('service-role-key-value'));
});

test('the inbox page reads real messages through Gmail', async () => {
  setConfig(CONFIG);
  const calls = mockFetch({
    'gmail_connections': () => new Response(JSON.stringify([connectionRow()]), { status: 200 }),
    'gmail.googleapis.com/gmail/v1/users/me/messages/m1': () => new Response(JSON.stringify({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'hello there',
      internalDate: '1700000000000',
      payload: { headers: [{ name: 'From', value: 'Ada <ada@example.com>' }, { name: 'Subject', value: 'Hi' }] },
    }), { status: 200 }),
  });

  const res = await call(inboxRoute, { url: '/api/gmail/inbox', headers: bearer() });
  const payload = res.json();

  assert.equal(res.statusCode, 200);
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].subject, 'Hi');
  assert.equal(payload.messages[0].from.email, 'ada@example.com');
  assert.equal(payload.messages[0].unread, true);
  assert.ok(calls.some((entry) => entry.url.includes('labelIds=INBOX')));
});

test('an inbox request with no connection tells the user to connect', async () => {
  setConfig(CONFIG);
  mockFetch();
  const res = await call(inboxRoute, { headers: bearer() });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'gmail_not_connected');
});

test('connect returns a Google consent URL and a state cookie', async () => {
  setConfig(CONFIG);
  mockFetch();
  const res = await call(connectRoute, { method: 'POST', headers: bearer(), body: {} });

  assert.equal(res.statusCode, 200);
  const url = new URL(res.json().url);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), CONFIG.GOOGLE_CLIENT_ID);
  assert.equal(url.searchParams.get('access_type'), 'offline', 'offline access is what yields a refresh token');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.ok(url.searchParams.get('state'));
  assert.ok(!url.searchParams.get('scope').includes('https://mail.google.com/'), 'the broadest scope is never requested');
  assert.match(res.headers['set-cookie'], /seedmail_oauth_nonce=/);
  assert.match(res.headers['set-cookie'], /HttpOnly/);
});

test('connect refuses to start when Google OAuth is not configured', async () => {
  setConfig({ ...CONFIG, GOOGLE_CLIENT_ID: '' });
  mockFetch();
  const res = await call(connectRoute, { method: 'POST', headers: bearer(), body: {} });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().details.google_client_id_set, false);
});

test('a callback with a forged state is refused and sends no token anywhere', async () => {
  setConfig(CONFIG);
  mockFetch();
  const res = await call(callbackRoute, {
    url: '/api/gmail/callback?code=abc&state=forged.signature',
    headers: { cookie: 'seedmail_oauth_nonce=n1' },
  });

  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /gmail_error=state/);
  assert.ok(!res.headers.location.includes('code='), 'the authorization code must not be forwarded to the app');
});

test('a callback without its nonce cookie is refused', async () => {
  setConfig(CONFIG);
  mockFetch();
  const res = await call(callbackRoute, {
    url: '/api/gmail/callback?code=abc&state=x.y',
    headers: {},
  });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /gmail_error=state/);
});

test('send submits a MIME message from the connected address', async () => {
  setConfig(CONFIG);
  const calls = mockFetch({
    'gmail_connections': () => new Response(JSON.stringify([connectionRow()]), { status: 200 }),
  });

  const res = await call(sendRoute, {
    method: 'POST',
    headers: bearer(),
    body: { to: 'first@example.com', cc: 'second@example.com', subject: 'Hello', html: '<p>Body</p>' },
  });
  const payload = res.json();

  assert.equal(res.statusCode, 200);
  assert.equal(payload.message_id, 'gmail-message-id');
  assert.equal(payload.saved_as_draft, false);
  assert.equal(payload.from, 'person@example.com');

  const sendCall = calls.find((entry) => entry.url.includes('/messages/send'));
  assert.ok(sendCall, 'Gmail send must be called');
  const decoded = Buffer.from(JSON.parse(sendCall.body).raw, 'base64url').toString('utf8');
  assert.match(decoded, /^From: person@example\.com$/m);
  assert.match(decoded, /^To: first@example\.com$/m);
  assert.match(decoded, /^Cc: second@example\.com$/m);
  assert.match(decoded, /^Subject: Hello$/m);
  assert.ok(!JSON.stringify(sendCall.headers).includes('refresh-token-value'));
});

test('send refuses an invalid recipient before contacting Gmail', async () => {
  setConfig(CONFIG);
  const calls = mockFetch({
    'gmail_connections': () => new Response(JSON.stringify([connectionRow()]), { status: 200 }),
  });
  const res = await call(sendRoute, {
    method: 'POST',
    headers: bearer(),
    body: { to: 'typo@', subject: 'Hello', text: 'Body' },
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /invalid/i);
  assert.ok(!calls.some((entry) => entry.url.includes('/messages/send')), 'Gmail must not be called at all');
});

test('send refuses an empty body', async () => {
  setConfig(CONFIG);
  mockFetch({ 'gmail_connections': () => new Response(JSON.stringify([connectionRow()]), { status: 200 }) });
  const res = await call(sendRoute, {
    method: 'POST',
    headers: bearer(),
    body: { to: 'a@example.com', subject: 'Hello' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'empty_body');
});

test('a revoked refresh token becomes a reconnect request, not a crash', async () => {
  setConfig(CONFIG);
  mockFetch({
    'gmail_connections': () => new Response(JSON.stringify([connectionRow()]), { status: 200 }),
    'oauth2.googleapis.com/token': () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
  });
  const res = await call(inboxRoute, { headers: bearer() });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'gmail_reauth_required');
});

test('modify requires an explicit read flag and reports Gmail failure honestly', async () => {
  setConfig(CONFIG);
  const calls = mockFetch({
    'gmail_connections': () => new Response(JSON.stringify([connectionRow()]), { status: 200 }),
    '/modify': () => new Response(JSON.stringify({ error: { message: 'Insufficient Permission' } }), { status: 403 }),
  });

  const invalid = await call(modifyRoute, { method: 'POST', headers: bearer(), body: { id: 'm1' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, 'invalid_body');

  const forbidden = await call(modifyRoute, { method: 'POST', headers: bearer(), body: { id: 'm1', read: true } });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().code, 'gmail_forbidden');
  assert.ok(calls.some((entry) => entry.url.includes('/m1/modify')));
});

test('archive and trash perform real Gmail changes, and an unknown action is refused', async () => {
  setConfig(CONFIG);
  const calls = mockFetch({
    'gmail_connections': () => new Response(JSON.stringify([connectionRow()]), { status: 200 }),
    '/m1/modify': () => new Response(JSON.stringify({ id: 'm1' }), { status: 200 }),
    '/m1/trash': () => new Response(JSON.stringify({ id: 'm1', labelIds: ['TRASH'] }), { status: 200 }),
  });

  const archived = await call(modifyRoute, { method: 'POST', headers: bearer(), body: { id: 'm1', action: 'archive' } });
  assert.equal(archived.statusCode, 200);
  assert.equal(archived.json().action, 'archive');
  const modifyCall = calls.find((entry) => entry.url.includes('/m1/modify'));
  assert.deepEqual(
    JSON.parse(modifyCall.body),
    { addLabelIds: [], removeLabelIds: ['INBOX'] },
    'archiving removes the INBOX label — a real change in Gmail',
  );

  const trashed = await call(modifyRoute, { method: 'POST', headers: bearer(), body: { id: 'm1', action: 'trash' } });
  assert.equal(trashed.statusCode, 200);
  assert.ok(
    calls.some((entry) => entry.method === 'POST' && entry.url.includes('/m1/trash')),
    'deleting moves the message to Gmail’s Trash',
  );

  const unknown = await call(modifyRoute, { method: 'POST', headers: bearer(), body: { id: 'm1', action: 'delete-forever' } });
  assert.equal(unknown.statusCode, 400, 'an unimplemented action must not silently succeed');
  assert.equal(unknown.json().code, 'invalid_body');
});

test('a Gmail quota error is reported as a rate limit, not a generic failure', async () => {
  setConfig(CONFIG);
  mockFetch({
    'gmail_connections': () => new Response(JSON.stringify([connectionRow()]), { status: 200 }),
    '/messages/send': () => new Response(JSON.stringify({
      error: { message: 'User-rate limit exceeded', errors: [{ reason: 'rateLimitExceeded' }] },
    }), { status: 403 }),
  });
  const res = await call(sendRoute, {
    method: 'POST',
    headers: bearer(),
    body: { to: 'a@example.com', subject: 's', text: 'b' },
  });
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().code, 'gmail_quota');
});

test('disconnect removes the connection without touching any other data', async () => {
  setConfig(CONFIG);
  const calls = mockFetch({
    'gmail_connections': () => new Response(JSON.stringify([connectionRow()]), { status: 200 }),
  });
  const res = await call(disconnectRoute, { method: 'POST', headers: bearer(), body: {} });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.ok(calls.some((entry) => entry.method === 'DELETE' && entry.url.includes('gmail_connections')));
  assert.ok(calls.some((entry) => entry.url.includes('oauth2.googleapis.com/revoke')), 'the grant is revoked at Google too');
  assert.ok(
    !calls.some((entry) => /campaigns|recipients|email_history|profiles|user_settings/.test(entry.url)),
    'disconnecting a mailbox must not delete application data',
  );
});
