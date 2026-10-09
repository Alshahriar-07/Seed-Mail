// Seed Code Mail — OAuth 2.0 start/finish helpers
//
// The authorization-code flow, split so both endpoints share exactly one
// implementation of the state/nonce handling:
//
//   connect  → sign a `state` (user id + nonce + expiry) and plant the nonce in
//              an HttpOnly cookie, then hand the browser Google's consent URL.
//   callback → check the state signature AND the cookie nonce, exchange the
//              code, store the encrypted refresh token, clear the cookie.
//
// The cookie is the standard double-submit protection: an attacker who can
// forge a callback URL cannot read the cookie, so the nonce will not match.

import { googleClientId, googleClientSecret, redirectUri, tokenEncryptionKey } from './config.js';
import { randomToken, signState, verifyState } from './crypto.js';
import { HttpError, notConfigured } from './http.js';
import { buildAuthorizeUrl } from './gmail.js';

const COOKIE_NAME = 'seedmail_oauth_nonce';
const STATE_TTL_SECONDS = 600;

export function stateCookieName() {
  return COOKIE_NAME;
}

/** Read one cookie value from the request headers. */
export function readCookie(req, name) {
  const header = String(req.headers?.cookie || '');
  for (const part of header.split(';')) {
    const [key, ...rest] = part.split('=');
    if (key && key.trim() === name) return rest.join('=').trim();
  }
  return '';
}

function cookieAttributes(origin) {
  const secure = /^https:/i.test(String(origin || ''));
  // SameSite=Lax (not Strict): the callback arrives as a top-level navigation
  // from accounts.google.com, and Strict would withhold the cookie there.
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

/** Clears the nonce cookie after the callback (success or failure). */
export function clearStateCookie(origin) {
  const secure = /^https:/i.test(String(origin || ''));
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/**
 * Everything the connect endpoint needs: the consent URL plus the nonce cookie.
 * Throws a `notConfigured` error naming the exact missing variables, which the
 * UI turns into a setup card rather than an opaque failure.
 */
export function googleOAuthConfigured(user, origin) {
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret) {
    throw notConfigured(
      'Google sign-in is not configured on the server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Vercel project environment.',
      { google_client_id_set: Boolean(clientId), google_client_secret_set: Boolean(clientSecret) },
    );
  }
  if (!tokenEncryptionKey()) {
    throw notConfigured(
      'Gmail tokens cannot be encrypted at rest. Set GMAIL_TOKEN_ENCRYPTION_KEY in the Vercel project environment.',
      { gmail_token_encryption_key_set: false },
    );
  }
  const redirect = redirectUri(origin);
  if (!redirect) {
    throw notConfigured('No OAuth redirect URI is available. Set GOOGLE_OAUTH_REDIRECT_URI.', {});
  }

  const nonce = randomToken(18);
  const state = signState({ userId: user.id, nonce }, tokenEncryptionKey(), STATE_TTL_SECONDS);
  return {
    url: buildAuthorizeUrl({ state, origin }),
    cookie: `${COOKIE_NAME}=${nonce}; ${cookieAttributes(origin)}`,
  };
}

/** Verify the state AND the cookie nonce. Returns the user id. */
export function verifyCallbackState(state, cookieNonce) {
  const key = tokenEncryptionKey();
  if (!key) {
    throw notConfigured('GMAIL_TOKEN_ENCRYPTION_KEY is not set, so a connection cannot be stored.', {});
  }

  let decoded;
  try {
    decoded = verifyState(state, key);
  } catch (error) {
    throw new HttpError(400, String(error.message || 'The authorization request could not be verified.'), {
      code: 'invalid_state',
    });
  }

  if (!decoded.nonce || decoded.nonce !== String(cookieNonce || '').trim()) {
    throw new HttpError(400, 'The authorization request did not match this browser session. Start the connection again.', {
      code: 'state_mismatch',
    });
  }
  return decoded.userId;
}
