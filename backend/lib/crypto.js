// Seed Code Mail — server-side cryptographic helpers
//
// Two jobs, both using only Node's built-in `crypto` (no dependency to add, and
// nothing to mis-install on a build host):
//
//  1. Encrypt the Gmail OAuth refresh token before it is written to Postgres,
//     with AES-256-GCM (authenticated encryption). The key lives only in the
//     backend environment, so a database dump on its own does not yield a usable
//     Google credential. This is what makes it acceptable to keep the token in
//     a table at all.
//
//  2. Sign the OAuth `state` parameter, so the callback can attribute the
//     authorization code to a signed-in user without trusting anything the
//     browser sends back. The state is HMAC-signed and time-bounded, and it is
//     single-purpose (it is not a session token).

import crypto from 'node:crypto';

/** Derive a 32-byte key from whatever form the operator supplied. */
function toKey(material) {
  const text = String(material ?? '').trim();
  if (!text) throw new Error('Missing encryption key.');

  // Accept base64 (what `openssl rand -base64 32` prints), hex, or raw text.
  const candidates = [text];
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0) {
    try {
      const decoded = Buffer.from(text, 'base64');
      if (decoded.length) candidates.unshift(decoded);
    } catch (_) { /* not base64 after all */ }
  }
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    const decoded = Buffer.from(text, 'hex');
    if (decoded.length === 32) candidates.unshift(decoded);
  }

  for (const candidate of candidates) {
    const buffer = Buffer.isBuffer(candidate) ? candidate : Buffer.from(candidate, 'utf8');
    if (buffer.length === 32) return buffer;
  }
  // Anything else is hashed to exactly 32 bytes rather than rejected, so a
  // human-chosen passphrase still works — the encryption is only as strong as
  // the entropy of that value, which the setup documentation states.
  return crypto.createHash('sha256').update(candidates[candidates.length - 1]).digest();
}

/**
 * Encrypt a secret. Returns a base64 blob of `iv || authTag || ciphertext`.
 * The IV is random per call, so encrypting the same token twice yields
 * different ciphertext.
 */
export function encryptSecret(plaintext, keyMaterial) {
  const key = toKey(keyMaterial);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext ?? ''), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Decrypt a blob produced by `encryptSecret`. Throws if tampered with. */
export function decryptSecret(payload, keyMaterial) {
  const raw = Buffer.from(String(payload ?? ''), 'base64');
  if (raw.length < 28) throw new Error('Stored token is not a valid encrypted payload.');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', toKey(keyMaterial), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// --- OAuth state ------------------------------------------------------------

const STATE_PURPOSE = 'gmail-oauth';

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function hmac(key, value) {
  return base64url(crypto.createHmac('sha256', toKey(key)).update(value).digest());
}

/**
 * Build a signed, expiring `state` value. `nonce` makes each attempt unique so
 * a replayed callback is rejected after the first use (the caller stores the
 * nonce cookie and clears it on success).
 */
export function signState({ userId, nonce }, keyMaterial, ttlSeconds = 600) {
  const payload = {
    p: STATE_PURPOSE,
    u: String(userId),
    n: String(nonce),
    exp: Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds),
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${hmac(keyMaterial, encoded)}`;
}

/** Verify and decode a state value, or throw a descriptive Error. */
export function verifyState(state, keyMaterial) {
  const parts = String(state ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Malformed OAuth state.');
  const [encoded, signature] = parts;

  const expected = hmac(keyMaterial, encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('OAuth state signature is invalid.');
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64url(encoded).toString('utf8'));
  } catch (_) {
    throw new Error('Malformed OAuth state payload.');
  }
  if (payload.p !== STATE_PURPOSE) throw new Error('OAuth state is not for this purpose.');
  if (!payload.u) throw new Error('OAuth state has no user.');
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('OAuth state has expired. Start the connection again.');
  }
  return { userId: String(payload.u), nonce: String(payload.n || '') };
}

/** A random value for the state nonce / cookie. */
export function randomToken(bytes = 24) {
  return base64url(crypto.randomBytes(bytes));
}

/** Timing-safe string comparison for short opaque values. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
