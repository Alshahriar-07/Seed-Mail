// Seed Code Mail — Gmail backend client (browser side)
//
// The mailbox lives in Gmail and is reached through the trusted backend under
// `/api/gmail/…` (Vercel serverless functions). This module is the only thing
// that talks to it, so every call carries the signed-in user's Supabase access
// token and nothing else.
//
// What is deliberately absent from this file:
//   * no Google client id, no client secret, no refresh token, no access token;
//   * no client-side token exchange.
// The browser cannot hold a Gmail credential, so it never sees one — it asks the
// server to act on its behalf and gets back ordinary mailbox data.
//
// Deployments where the API is not on the same origin (for example a local Vite
// dev server pointed at the deployed functions) can set VITE_API_BASE_URL.

import { currentAccessToken } from './supabase.js';

const BASE = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const TIMEOUT_MS = 30000;

export class GmailError extends Error {
  constructor(message, { status = 0, code = '', configuration = null } = {}) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.code = code;
    // Present when the server answered "I am not configured": the UI renders the
    // exact variables that are missing instead of a generic failure.
    this.configuration = configuration;
  }
}

/** True when the account is not connected (as opposed to a real failure). */
export function isNotConnected(error) {
  return error instanceof GmailError && error.code === 'gmail_not_connected';
}

/** True when Google revoked/expired the grant and the user must reconnect. */
export function needsReauth(error) {
  return error instanceof GmailError && error.code === 'gmail_reauth_required';
}

/** True when the server itself lacks the Gmail configuration. */
export function isNotConfigured(error) {
  return error instanceof GmailError && (error.status === 503 || error.code === 'not_configured');
}

function endpoint(path, query) {
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  return `${BASE}/api/gmail${path}${search}`;
}

async function call(path, { method = 'GET', body, query, timeout = TIMEOUT_MS } = {}) {
  const token = await currentAccessToken();
  if (!token) throw new GmailError('You are not signed in.', { status: 401, code: 'unauthorized' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    response = await fetch(endpoint(path, query), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new GmailError('The mail service did not respond in time. Try again.', { code: 'timeout' });
    }
    throw new GmailError(
      'Could not reach the mail service for this deployment. The app\'s Gmail endpoints must be deployed alongside the site.',
      { code: 'backend_unavailable' },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    // A 404 here is almost always a routing/deployment problem rather than a
    // real answer, so it gets its own message.
    if (response.status === 404 && !payload?.error) {
      throw new GmailError('The mail service is not deployed at this address.', {
        status: 404,
        code: 'backend_unavailable',
      });
    }
    throw new GmailError(payload?.error || `The mail service returned ${response.status}.`, {
      status: response.status,
      code: payload?.code || '',
      configuration: payload?.details || null,
    });
  }

  return payload ?? {};
}

export const gmail = {
  /** Server configuration + this user's connection state. Never returns a token. */
  status: () => call('/status'),

  /** Returns the Google consent URL to navigate to. */
  connectUrl: async () => {
    const { url } = await call('/connect', { method: 'POST', body: {} });
    if (!url) throw new GmailError('The server did not return a Google authorization URL.', { code: 'no_url' });
    return url;
  },

  disconnect: () => call('/disconnect', { method: 'POST', body: {} }),

  inbox: ({ q = '', pageToken = '', max = 25 } = {}) =>
    call('/inbox', { query: { q, page_token: pageToken, max: String(max) } }),

  sent: ({ q = '', pageToken = '', max = 25 } = {}) =>
    call('/sent', { query: { q, page_token: pageToken, max: String(max) } }),

  message: (id) => call('/message', { query: { id } }),

  setRead: (id, read) => call('/modify', { method: 'POST', body: { id, read } }),

  send: (payload) => call('/send', { method: 'POST', body: payload }),

  /**
   * Fetches an attachment and returns a Blob URL the caller must revoke.
   * The download is authorized per request; there is no public attachment URL.
   */
  async downloadAttachment({ messageId, attachmentId, filename }) {
    const payload = await call('/attachment', {
      query: { message_id: messageId, attachment_id: attachmentId, filename },
    });
    const binary = atob(payload.data || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: 'application/octet-stream' });
  },
};
