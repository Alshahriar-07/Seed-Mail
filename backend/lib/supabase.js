// Seed Code Mail — Supabase access for the trusted backend
//
// Two deliberately different levels of access:
//
//   * `verifyUser()` uses the PUBLIC publishable key plus the caller's bearer
//     token to ask Supabase Auth "who is this?". It is the authentication
//     boundary for every Gmail endpoint: the user id comes from the verified
//     session, never from the request body or a query parameter.
//
//   * `admin*()` uses the SERVICE ROLE key, which only ever exists in the
//     server environment, to read/write the `gmail_connections` row. That table
//     has Row Level Security enabled and forced with no policy for
//     `authenticated`, so the browser cannot read it at all — which is why the
//     connection status has to be served by this backend.

import {
  supabasePublishableKey,
  supabaseServiceRoleKey,
  supabaseUrl,
} from './config.js';
import { HttpError, notConfigured, unauthorized } from './http.js';

const REQUEST_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, init = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new HttpError(504, 'The identity service did not respond in time.', { code: 'timeout' });
    }
    throw new HttpError(502, 'The identity service could not be reached.', { code: 'upstream_unreachable' });
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the bearer token from an Authorization header. */
export function bearerToken(req) {
  const header = String(req.headers?.authorization || '');
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

/**
 * Validate the caller's Supabase access token and return `{ id, email }`.
 *
 * The token is checked against Supabase Auth itself (`/auth/v1/user`) rather
 * than decoded locally, so an expired, forged or revoked session is rejected by
 * the authority that issued it. A missing/blank token, or a Supabase that is not
 * configured, are distinct failures so the UI can say which one happened.
 */
export async function verifyUser(req) {
  const url = supabaseUrl();
  const key = supabasePublishableKey();
  if (!url || !key) {
    throw notConfigured(
      'The server is not configured to verify signed-in users: SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set in the Vercel project environment.',
      { supabase_url_set: Boolean(url), supabase_publishable_key_set: Boolean(key) },
    );
  }

  const token = bearerToken(req);
  if (!token) throw unauthorized('Missing access token.');

  const response = await fetchWithTimeout(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  });

  if (response.status === 401 || response.status === 403) {
    throw unauthorized('Your session is invalid or has expired. Sign in again.', 'session_expired');
  }
  if (!response.ok) {
    throw new HttpError(502, 'The identity service rejected the request.', { code: 'auth_upstream_error' });
  }

  const payload = await response.json().catch(() => null);
  if (!payload?.id) throw unauthorized('The identity service returned no user for this token.');

  return {
    id: String(payload.id),
    email: typeof payload.email === 'string' ? payload.email : '',
  };
}

// --- service-role access ----------------------------------------------------

function adminConfig() {
  const url = supabaseUrl();
  const key = supabaseServiceRoleKey();
  if (!url || !key) {
    throw notConfigured(
      'The server cannot store Gmail connections: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the Vercel project environment.',
      { supabase_url_set: Boolean(url), supabase_service_role_key_set: Boolean(key) },
    );
  }
  return { url, key };
}

async function adminRequest(path, { method = 'GET', body, headers = {}, query } = {}) {
  const { url, key } = adminConfig();
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  const response = await fetchWithTimeout(`${url}/rest/v1/${path}${search}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    // Never echo the upstream body: it can contain request details, and the
    // service-role key is in the headers of the request that produced it.
    throw new HttpError(502, `Supabase rejected the request (${response.status}).`, {
      code: 'supabase_error',
    });
  }
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/** The stored Gmail connection for a user, or null. */
export async function getConnection(userId) {
  const rows = await adminRequest('gmail_connections', {
    query: { select: '*', user_id: `eq.${userId}`, limit: '1' },
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** Insert or replace the connection row (one row per user). */
export async function upsertConnection(row) {
  const rows = await adminRequest('gmail_connections', {
    method: 'POST',
    query: { on_conflict: 'user_id' },
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: row,
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function deleteConnection(userId) {
  await adminRequest('gmail_connections', {
    method: 'DELETE',
    query: { user_id: `eq.${userId}` },
    headers: { Prefer: 'return=minimal' },
  });
}

/** Record a token refresh without touching the rest of the row. */
export async function touchConnection(userId, patch) {
  await adminRequest('gmail_connections', {
    method: 'PATCH',
    query: { user_id: `eq.${userId}` },
    headers: { Prefer: 'return=minimal' },
    body: patch,
  });
}
