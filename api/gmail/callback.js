// GET /api/gmail/callback
//
// The URL registered as an "Authorised redirect URI" on the Google Cloud OAuth
// client. Google navigates the browser here with `?code=…&state=…`, so this
// endpoint is necessarily unauthenticated — the signed `state` plus the
// HttpOnly nonce cookie are what prove the request belongs to the user who
// started the flow.
//
// The refresh token obtained here is encrypted before it is stored. It is never
// placed in the redirect URL, a response body, a log, or browser storage.

import { appUrl, GMAIL_SCOPES } from '../../backend/lib/config.js';
import { saveConnection } from '../../backend/lib/connection.js';
import { exchangeCode, getProfile } from '../../backend/lib/gmail.js';
import { appRedirect, HttpError, requestOrigin, requireMethod, sendRedirect } from '../../backend/lib/http.js';
import { clearStateCookie, readCookie, stateCookieName, verifyCallbackState } from '../../backend/lib/oauth.js';

// Short, non-secret codes the SPA translates into a message. A raw Google error
// never reaches the URL.
const ERROR_CODES = {
  access_denied: 'denied',
  invalid_state: 'state',
  state_mismatch: 'state',
};

function fail(res, origin, code) {
  res.setHeader('Set-Cookie', clearStateCookie(origin));
  return appRedirect(res, appUrl(origin), '/profile', { gmail_error: ERROR_CODES[code] || 'failed' });
}

export default async function handler(req, res) {
  try {
    requireMethod(req, 'GET');
    const origin = requestOrigin(req);
    const url = new URL(req.url, origin || 'http://localhost');
    const params = url.searchParams;

    // The user declined the consent screen (or Google returned an error).
    if (params.get('error')) {
      return fail(res, origin, params.get('error'));
    }

    const code = params.get('code') || '';
    const state = params.get('state') || '';
    if (!code || !state) {
      return fail(res, origin, 'invalid_state');
    }

    const userId = verifyCallbackState(state, readCookie(req, stateCookieName()));

    const tokens = await exchangeCode(code, origin);
    let email = '';
    try {
      // Ask Gmail which account this token belongs to, rather than trusting a
      // value echoed back in the URL.
      ({ emailAddress: email } = await getProfile(tokens.accessToken));
    } catch (_) {
      email = ''; // the address is display metadata; the connection still works
    }

    await saveConnection({
      userId,
      email,
      scopes: tokens.scopes.length ? tokens.scopes : GMAIL_SCOPES,
      refreshToken: tokens.refreshToken,
      accessAlready: true,
    });

    res.setHeader('Set-Cookie', clearStateCookie(origin));
    return appRedirect(res, appUrl(origin), '/profile', { gmail: 'connected' });
  } catch (error) {
    const origin = requestOrigin(req);
    const code = error instanceof HttpError ? error.code : 'failed';
    if (code === 'no_refresh_token') {
      res.setHeader('Set-Cookie', clearStateCookie(origin));
      return appRedirect(res, appUrl(origin), '/profile', { gmail_error: 'no_refresh_token' });
    }
    if (appUrl(origin)) return fail(res, origin, code);
    // No app URL to return to: report plainly rather than redirecting nowhere.
    sendRedirect(res, '/');
  }
}
