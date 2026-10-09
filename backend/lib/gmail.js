// Seed Code Mail — Gmail API and Google OAuth 2.0 client
//
// Plain `fetch` against Google's documented REST endpoints. No Google SDK is
// bundled: the API surface needed here is small, and a smaller serverless
// function is a faster, less fragile one.
//
// Credential flow (nothing here is ever sent to the browser):
//   authorization code  ->  refresh token (stored ENCRYPTED in Postgres)
//                       ->  short-lived access token (used, then discarded)
//
// A refresh token is a long-lived credential. It is encrypted before storage
// (backend/lib/crypto.js) and only ever decrypted inside a request handler.

import {
  GMAIL_SCOPES,
  googleClientId,
  googleClientSecret,
  redirectUri,
} from './config.js';
import { HttpError } from './http.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

const REQUEST_TIMEOUT_MS = 20000;

async function googleFetch(url, init = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new HttpError(504, 'Gmail did not respond in time.', { code: 'gmail_timeout' });
    }
    throw new HttpError(502, 'Gmail could not be reached.', { code: 'gmail_unreachable' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn Google's error body into a message that is safe and useful, and that
 * distinguishes "quota exceeded" from "the user revoked access" — the Compose
 * and Inbox screens report these differently.
 */
function gmailError(status, body) {
  const error = body?.error;
  const reason = body?.error?.errors?.[0]?.reason || error?.status || '';
  const message = error?.message || '';
  const lowered = `${reason} ${message}`.toLowerCase();

  if (status === 401) {
    return new HttpError(401, 'Gmail authorization expired or was revoked. Reconnect your Gmail account.', {
      code: 'gmail_reauth_required',
    });
  }
  if (status === 403 && /quota|rate|limit/.test(lowered)) {
    return new HttpError(429, 'Gmail rate limit or daily quota reached. Try again later.', {
      code: 'gmail_quota',
    });
  }
  if (status === 403) {
    return new HttpError(403, 'Gmail refused the request. The connected account may lack the required permission.', {
      code: 'gmail_forbidden',
    });
  }
  if (status === 404) {
    return new HttpError(404, 'That message no longer exists in this Gmail account.', { code: 'gmail_not_found' });
  }
  return new HttpError(status >= 500 ? 502 : status, 'Gmail rejected the request.', {
    code: 'gmail_error',
  });
}

// --- OAuth ------------------------------------------------------------------

/** The Google consent URL the browser is redirected to. */
export function buildAuthorizeUrl({ state, origin, loginHint = '' }) {
  const clientId = googleClientId();
  const redirect = redirectUri(origin);
  if (!clientId || !redirect) throw new Error('Google OAuth is not configured.');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    // access_type=offline + prompt=consent is what yields a refresh token, which
    // is what makes reading/sending possible later without the user present.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${GOOGLE_AUTH}?${params.toString()}`;
}

/** Exchange an authorization code for tokens. `origin` keys the redirect URI. */
export async function exchangeCode(code, origin) {
  const body = new URLSearchParams({
    code: String(code),
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    redirect_uri: redirectUri(origin),
    grant_type: 'authorization_code',
  });
  const response = await googleFetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // A failed exchange is a configuration/consent problem, not a Gmail one.
    throw new HttpError(400, 'Google rejected the authorization code. Check the OAuth client configuration and try connecting again.', {
      code: 'oauth_exchange_failed',
    });
  }
  return {
    accessToken: payload.access_token || '',
    refreshToken: payload.refresh_token || '',
    expiresIn: Number(payload.expires_in || 0),
    scopes: String(payload.scope || '').split(/\s+/).filter(Boolean),
  };
}

/** Mint a fresh access token from a stored refresh token. */
export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: String(refreshToken),
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    grant_type: 'refresh_token',
  });
  const response = await googleFetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // `invalid_grant` means the user revoked access (or the token expired) —
    // the connection is dead and the UI must ask for reconnection, not retry.
    const reason = String(payload?.error || '');
    if (reason === 'invalid_grant') {
      throw new HttpError(401, 'Gmail access was revoked or expired. Reconnect your Gmail account.', {
        code: 'gmail_reauth_required',
      });
    }
    throw new HttpError(502, 'Could not obtain a Gmail access token.', { code: 'gmail_token_failed' });
  }
  return { accessToken: payload.access_token || '', expiresIn: Number(payload.expires_in || 0) };
}

/** Revoke the refresh token at Google (best effort), then the caller deletes it. */
export async function revokeToken(token) {
  try {
    await googleFetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch (_) {
    // Revocation is best-effort: the local record is removed regardless, so a
    // network blip cannot leave the user unable to disconnect.
  }
}

// --- Gmail REST -------------------------------------------------------------

async function gmailRequest(path, { token, method = 'GET', body, query } = {}) {
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  const response = await googleFetch(`${GMAIL_API}${path}${search}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return {};
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw gmailError(response.status, payload);
  return payload;
}

function headerMap(payload) {
  const map = {};
  (payload?.headers || []).forEach((header) => {
    const name = String(header?.name || '').toLowerCase();
    if (name) map[name] = String(header?.value ?? '');
  });
  return map;
}

/** List message ids for a label (INBOX / SENT), with Gmail's own page tokens. */
export async function listMessages(token, { label, query = '', pageToken = '', maxResults = 25 } = {}) {
  const payload = await gmailRequest('/users/me/messages', {
    token,
    query: {
      labelIds: label,
      maxResults: String(Math.min(Math.max(1, Number(maxResults) || 25), 50)),
      q: query,
      pageToken,
    },
  });
  return {
    messages: Array.isArray(payload?.messages) ? payload.messages : [],
    nextPageToken: payload?.nextPageToken || '',
    resultSizeEstimate: Number(payload?.resultSizeEstimate || 0),
  };
}

/** Metadata for a batch of ids (one request per id; Gmail has no batch GET here). */
export async function getMessages(token, ids, { format = 'metadata' } = {}) {
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return await gmailRequest(`/users/me/messages/${encodeURIComponent(id)}`, {
          token,
          query: {
            format,
            metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
          },
        });
      } catch (error) {
        // One unreadable message (deleted mid-list) must not break the page.
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      }
    }),
  );
  return results.filter(Boolean);
}

/** Full message, including body parts and attachment metadata. */
export async function getMessage(token, id, { format = 'full' } = {}) {
  return gmailRequest(`/users/me/messages/${encodeURIComponent(id)}`, {
    token,
    query: { format },
  });
}

/** Mark read/unread by adding or removing the UNREAD label. */
export async function modifyMessage(token, id, { addLabelIds = [], removeLabelIds = [] }) {
  return gmailRequest(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
    token,
    method: 'POST',
    body: { addLabelIds, removeLabelIds },
  });
}

/** Send a pre-built raw MIME message. Returns Gmail's message id. */
export async function sendMessage(token, raw, { threadId = '' } = {}) {
  const payload = await gmailRequest('/users/me/messages/send', {
    token,
    method: 'POST',
    body: threadId ? { raw, threadId } : { raw },
  });
  return { id: String(payload?.id || ''), threadId: String(payload?.threadId || ''), labelIds: payload?.labelIds || [] };
}

/** Save a message as a Gmail draft rather than sending it. */
export async function createDraft(token, raw, { threadId = '' } = {}) {
  const message = threadId ? { raw, threadId } : { raw };
  const payload = await gmailRequest('/users/me/drafts', {
    token,
    method: 'POST',
    body: { message },
  });
  return { id: String(payload?.id || ''), messageId: String(payload?.message?.id || '') };
}

/** Download one attachment's bytes (returned to the browser as base64). */
export async function getAttachment(token, messageId, attachmentId) {
  const payload = await gmailRequest(
    `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { token },
  );
  return {
    data: String(payload?.data || '').replace(/-/g, '+').replace(/_/g, '/'),
    size: Number(payload?.size || 0),
  };
}

/** The connected account's address, straight from Gmail (authoritative). */
export async function getProfile(token) {
  const payload = await gmailRequest('/users/me/profile', { token });
  return { emailAddress: String(payload?.emailAddress || ''), messagesTotal: Number(payload?.messagesTotal || 0) };
}

export { headerMap };
