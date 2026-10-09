// Seed Code Mail — Gmail backend client (browser side)
//
// The mailbox lives in Gmail and is reached through the trusted backend under
// `/api/gmail/…` (the Vercel functions in `./api`), which is normally the SAME
// origin as this page. This module is the only thing that talks to it, so every
// call carries the signed-in user's Supabase access token and nothing else.
//
// What is deliberately absent from this file:
//   * no Google client id, no client secret, no refresh token, no access token;
//   * no client-side token exchange;
//   * no assumed or invented backend host.
// The browser cannot hold a Gmail credential, so it never sees one — it asks the
// server to act on its behalf and gets back ordinary mailbox data.
//
// Deployment reality this module is explicit about: deploying the static site
// does not by itself deploy the Python campaign worker, and it only serves
// `/api/gmail` if the functions in `./api` are part of the same Vercel project.
// When that is not the case the error says so precisely, because the difference
// between "the functions are missing from this deployment" and "Gmail is
// unreachable" is exactly what an operator needs to know.

import { currentAccessToken } from './supabase.js';
import { resolveServiceUrl } from './endpoints.js';

const TIMEOUT_MS = 30000;

export class GmailError extends Error {
  constructor(message, { status = 0, code = '', configuration = null, hint = '' } = {}) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.code = code;
    // Present when the server answered "I am not configured": the UI renders the
    // exact variables that are missing instead of a generic failure.
    this.configuration = configuration;
    // Optional second line with the next concrete action.
    this.hint = hint;
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

/** True when this deployment does not serve the mail API at all. */
export function isBackendMissing(error) {
  return error instanceof GmailError && (
    error.code === 'backend_unavailable' || error.code === 'backend_misconfigured'
  );
}

/**
 * The resolved API base for this call.
 *
 * Empty string means "this origin", which is the correct production value: the
 * functions ship with the site. `VITE_API_BASE_URL` exists only for the unusual
 * case of hosting them elsewhere, and a loopback value is refused for a deployed
 * page (see lib/endpoints.js) rather than attempted and reported as an outage.
 */
function apiBase() {
  return resolveServiceUrl(import.meta.env.VITE_API_BASE_URL, {
    label: 'Gmail API base (VITE_API_BASE_URL)',
  });
}

function endpoint(base, path, query) {
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  return `${base}/api/gmail${path}${search}`;
}

async function call(path, { method = 'GET', body, query, timeout = TIMEOUT_MS } = {}) {
  const resolved = apiBase();
  if (resolved.problem) {
    throw new GmailError(resolved.problem, { code: 'backend_misconfigured' });
  }

  const token = await currentAccessToken();
  if (!token) throw new GmailError('You are not signed in.', { status: 401, code: 'unauthorized' });

  const url = endpoint(resolved.url, path, query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    response = await fetch(url, {
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
      `Could not reach the mail service at ${new URL(url, location.origin).pathname}.`,
      {
        code: 'backend_unavailable',
        hint: 'If the site was just deployed, confirm the functions in the api/ directory were included in the Vercel build (see the README, "Deployment").',
      },
    );
  } finally {
    clearTimeout(timer);
  }

  const contentType = String(response.headers.get('content-type') || '');
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    // The single most useful diagnostic for this application: the request came
    // back as HTML, which means the SPA rewrite answered it because no API
    // function matched the path. That is a deployment problem, not a Gmail one.
    if (contentType.includes('text/html')) {
      throw new GmailError(
        `The mail API is not being served on this deployment: ${url} returned the web page instead of an API response.`,
        {
          status: response.status,
          code: 'backend_unavailable',
          hint: 'The Vercel project must deploy the functions in the api/ directory (the SPA rewrite excludes /api/, so a page response means those functions are absent from this deployment).',
        },
      );
    }

    if (response.status === 404 && !payload?.error) {
      throw new GmailError(
        `The mail API endpoint ${url} does not exist on this deployment.`,
        {
          status: 404,
          code: 'backend_unavailable',
          hint: 'Deploying the static site does not deploy the mail functions: they must be part of the same Vercel project as the api/ directory.',
        },
      );
    }

    throw new GmailError(payload?.error || `The mail service returned ${response.status}.`, {
      status: response.status,
      code: payload?.code || '',
      configuration: payload?.details || null,
    });
  }

  if (contentType.includes('text/html')) {
    // A 200 that is a web page cannot be trusted as mailbox data.
    throw new GmailError(
      `The mail API returned an unexpected web page instead of data for ${url}.`,
      { code: 'backend_unavailable' },
    );
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
   * Fetches an attachment and returns a Blob the caller turns into a download.
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
