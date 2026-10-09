// Seed Code Mail — Gmail connection lifecycle
//
// Everything that turns a stored, encrypted refresh token into a usable access
// token lives here, so no route handler has to know how the credential is kept.

import { GMAIL_SCOPES, SCOPE_REQUIREMENTS, tokenEncryptionKey } from './config.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { HttpError, notConfigured } from './http.js';
import { refreshAccessToken } from './gmail.js';
import { getConnection, touchConnection, upsertConnection, deleteConnection } from './supabase.js';

export { deleteConnection, upsertConnection };

function encryptionKey() {
  const key = tokenEncryptionKey();
  if (!key) {
    throw notConfigured(
      'Gmail connections cannot be stored: GMAIL_TOKEN_ENCRYPTION_KEY is not set in the Vercel project environment.',
      { gmail_token_encryption_key_set: false },
    );
  }
  return key;
}

/**
 * Connection status for the UI. Never returns the (encrypted or plain) token,
 * and never a value an attacker could use — only the linked address, the scopes
 * Google actually granted, and what is missing.
 */
export async function connectionStatus(userId) {
  const row = await getConnection(userId);
  if (!row) {
    return {
      connected: false,
      email: '',
      scopes: [],
      granted: false,
      status: 'disconnected',
      needs_reauth: false,
      missing_scopes: GMAIL_SCOPES.slice(),
      last_error: '',
      connected_at: null,
      // Nothing is available until an account is connected, and saying so here
      // means every screen can disable an action instead of offering a button
      // that will fail.
      capabilities: { inbox: false, sent: false, send: false, modify: false, drafts: false },
    };
  }

  const scopes = String(row.scopes || '').split(/\s+/).filter(Boolean);
  const missing = GMAIL_SCOPES.filter((scope) => !scopes.includes(scope));
  const healthy = row.status === 'connected' && Boolean(row.token_ciphertext);

  return {
    connected: healthy,
    // The linked account address is not a secret; it is shown in Profile.
    email: String(row.gmail_email || ''),
    scopes,
    granted: scopes.length > 0,
    status: String(row.status || 'disconnected'),
    needs_reauth: Boolean(row.token_ciphertext) && !healthy,
    missing_scopes: missing,
    last_error: String(row.last_error || ''),
    connected_at: row.connected_at || null,
    // Which features are usable given what was actually granted, so the UI can
    // disable an action instead of offering a button that will fail.
    capabilities: {
      inbox: SCOPE_REQUIREMENTS.inbox.every((scope) => scopes.includes(scope)),
      sent: SCOPE_REQUIREMENTS.sent.every((scope) => scopes.includes(scope)),
      send: SCOPE_REQUIREMENTS.send.every((scope) => scopes.includes(scope)),
      modify: SCOPE_REQUIREMENTS.modify.every((scope) => scopes.includes(scope)),
      drafts: SCOPE_REQUIREMENTS.drafts.every((scope) => scopes.includes(scope)),
    },
  };
}

/** Store a freshly authorized connection (encrypting the refresh token first). */
export async function saveConnection({ userId, email, scopes, refreshToken, accessAlready }) {
  if (!refreshToken) {
    // Without a refresh token the connection works only until the access token
    // expires, then silently breaks. Refuse it and say why, rather than storing
    // something that will fail later.
    throw new HttpError(
      400,
      'Google did not return a refresh token, so the connection cannot be kept. Disconnect Seed Code Mail in your Google account permissions and connect again.',
      { code: 'no_refresh_token' },
    );
  }
  const row = {
    user_id: userId,
    gmail_email: String(email || '').slice(0, 254),
    scopes: (scopes || []).join(' ').slice(0, 2048),
    token_ciphertext: encryptSecret(refreshToken, encryptionKey()),
    key_version: 1,
    status: 'connected',
    last_error: '',
    connected_at: new Date().toISOString(),
    last_refreshed_at: accessAlready ? new Date().toISOString() : null,
  };
  return upsertConnection(row);
}

/**
 * Resolve a usable access token for a user.
 *
 * @throws HttpError 409 when nothing is connected (the UI offers "Connect"),
 *         HttpError 401 when Google revoked access (the UI offers "Reconnect").
 */
export async function requireAccessToken(userId) {
  const key = encryptionKey();
  const row = await getConnection(userId);
  if (!row || !row.token_ciphertext) {
    throw new HttpError(409, 'No Gmail account is connected yet. Connect one from Profile to use the mailbox.', {
      code: 'gmail_not_connected',
    });
  }
  if (row.status !== 'connected') {
    throw new HttpError(401, 'The Gmail connection needs to be authorized again.', {
      code: 'gmail_reauth_required',
    });
  }

  let refreshToken;
  try {
    refreshToken = decryptSecret(row.token_ciphertext, key);
  } catch (_) {
    // Wrong/rotated encryption key, or tampered ciphertext. Fail closed and
    // tell the user to reconnect; do not fall back to anything.
    await touchConnection(userId, {
      status: 'error',
      last_error: 'The stored Gmail credential could not be decrypted.',
    }).catch(() => {});
    throw new HttpError(401, 'The stored Gmail credential could not be read. Reconnect your Gmail account.', {
      code: 'gmail_reauth_required',
    });
  }

  try {
    const { accessToken } = await refreshAccessToken(refreshToken);
    // Non-fatal bookkeeping: a failed timestamp write must not fail the request.
    touchConnection(userId, { last_refreshed_at: new Date().toISOString() }).catch(() => {});
    return { accessToken, email: String(row.gmail_email || '') };
  } catch (error) {
    if (error instanceof HttpError && error.code === 'gmail_reauth_required') {
      await touchConnection(userId, {
        status: 'error',
        last_error: 'Gmail access was revoked or expired.',
      }).catch(() => {});
    }
    throw error;
  }
}
