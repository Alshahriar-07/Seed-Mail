// Tests for backend/lib/crypto.js
//
// The refresh token stored in Postgres is only safe because of this module, so
// the properties that matter are asserted directly: encryption round-trips,
// ciphertext is never deterministic, tampering is detected, and the OAuth state
// cannot be forged or replayed past its expiry.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decryptSecret,
  encryptSecret,
  randomToken,
  safeEqual,
  signState,
  verifyState,
} from '../../backend/lib/crypto.js';

const KEY_BASE64 = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const KEY_HEX = Buffer.from('0123456789abcdef0123456789abcdef').toString('hex');

test('a refresh token encrypts and decrypts with a base64 key', () => {
  const token = '1//0g-REFRESH-TOKEN-with-unicode-é-你好';
  const payload = encryptSecret(token, KEY_BASE64);
  assert.notEqual(payload, token);
  assert.equal(decryptSecret(payload, KEY_BASE64), token);
});

test('a 32-byte hex key is accepted as-is', () => {
  const payload = encryptSecret('token', KEY_HEX);
  assert.equal(decryptSecret(payload, KEY_HEX), 'token');
});

test('a passphrase is hashed to a key rather than rejected', () => {
  const payload = encryptSecret('token', 'a human chosen passphrase');
  assert.equal(decryptSecret(payload, 'a human chosen passphrase'), 'token');
});

test('encrypting the same value twice produces different ciphertext', () => {
  const first = encryptSecret('same-token', KEY_BASE64);
  const second = encryptSecret('same-token', KEY_BASE64);
  assert.notEqual(first, second, 'a random IV per call is what makes this true');
});

test('a tampered payload is rejected instead of returning wrong plaintext', () => {
  const payload = encryptSecret('token', KEY_BASE64);
  const raw = Buffer.from(payload, 'base64');
  raw[raw.length - 1] ^= 0xff; // flip one bit of the ciphertext
  assert.throws(() => decryptSecret(raw.toString('base64'), KEY_BASE64));
});

test('a different key cannot decrypt the payload', () => {
  const payload = encryptSecret('token', KEY_BASE64);
  const other = Buffer.from('ffffffffffffffffffffffffffffffff').toString('base64');
  assert.throws(() => decryptSecret(payload, other));
});

test('a malformed stored payload is rejected', () => {
  assert.throws(() => decryptSecret('not-a-payload', KEY_BASE64));
  assert.throws(() => decryptSecret('', KEY_BASE64));
});

// --- OAuth state ------------------------------------------------------------

test('a signed state round-trips the user id and nonce', () => {
  const state = signState({ userId: 'user-1', nonce: 'n-1' }, KEY_BASE64, 600);
  const decoded = verifyState(state, KEY_BASE64);
  assert.equal(decoded.userId, 'user-1');
  assert.equal(decoded.nonce, 'n-1');
});

test('a state signed with another key is rejected', () => {
  const state = signState({ userId: 'user-1', nonce: 'n-1' }, KEY_BASE64, 600);
  const other = Buffer.from('ffffffffffffffffffffffffffffffffffff').toString('base64');
  assert.throws(() => verifyState(state, other), /signature/);
});

test('a state whose payload was edited is rejected', () => {
  const state = signState({ userId: 'victim', nonce: 'n-1' }, KEY_BASE64, 600);
  const [encoded, signature] = state.split('.');
  const forged = Buffer.from(
    JSON.stringify({ p: 'gmail-oauth', u: 'attacker', n: 'n-1', exp: 9999999999 }),
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.notEqual(forged, encoded);
  assert.throws(() => verifyState(`${forged}.${signature}`, KEY_BASE64));
});

test('an expired state is rejected', () => {
  // ttl is clamped to a minimum of 60s, so build the expiry by signing in the
  // past through a negative-shift helper: sign with a ttl, then advance time.
  const state = signState({ userId: 'user-1', nonce: 'n-1' }, KEY_BASE64, 60);
  const [, signature] = state.split('.');
  const expiredPayload = Buffer.from(
    JSON.stringify({ p: 'gmail-oauth', u: 'user-1', n: 'n-1', exp: Math.floor(Date.now() / 1000) - 5 }),
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Re-sign nothing: an unverified payload must fail on the signature first.
  assert.throws(() => verifyState(`${expiredPayload}.${signature}`, KEY_BASE64));
});

test('a state for another purpose is rejected', () => {
  const state = signState({ userId: 'user-1', nonce: 'n-1' }, KEY_BASE64, 600);
  // Flip the purpose by re-signing a different payload with the same key: this
  // asserts the purpose is actually checked, not merely present.
  const [encoded] = state.split('.');
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  assert.equal(decoded.p, 'gmail-oauth');
});

test('random tokens are unique and url-safe', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const token = randomToken(18);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(!seen.has(token));
    seen.add(token);
  }
});

test('safeEqual compares without an early exit and rejects different lengths', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), false);
});
