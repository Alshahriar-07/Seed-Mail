// Seed Code Mail — interface to the local Gmail SMTP send worker
//
// Vercel serverless functions cannot hold a long-running sequential SMTP
// campaign, and the Gmail App Password must never reach the browser bundle or
// Supabase. Sending therefore happens in a small worker process that runs on a
// machine you control (worker/), started with `python worker/main.py`.
//
// Trust model:
//   * the worker listens on 127.0.0.1 only;
//   * every request carries the signed-in user's Supabase access token, which
//     the worker verifies before doing anything;
//   * campaign progress is written to Supabase by the worker under the user's
//     own RLS-scoped identity, so no service-role key is needed anywhere.
//
// The worker URL is public configuration (VITE_MAIL_WORKER_URL); it is not a
// secret and contains no credentials.

import { currentAccessToken } from './supabase.js';

const DEFAULT_WORKER_URL = 'http://127.0.0.1:8765';
const TIMEOUT_MS = 10000;

export class WorkerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkerUnavailableError';
    this.code = 'worker_unavailable';
  }
}

export function workerBaseUrl() {
  const configured = import.meta.env.VITE_MAIL_WORKER_URL || DEFAULT_WORKER_URL;
  return configured.replace(/\/+$/, '');
}

async function call(path, { method = 'GET', body, auth = true, timeout = TIMEOUT_MS } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (auth) {
    const token = await currentAccessToken();
    if (!token) throw new Error('You are not signed in.');
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    response = await fetch(workerBaseUrl() + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new WorkerUnavailableError('The send worker did not respond in time. Is it still running?');
    }
    throw new WorkerUnavailableError(
      `Cannot reach the send worker at ${workerBaseUrl()}. Start it with "python worker/main.py".`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {
    payload = text || null;
  }

  if (!response.ok) {
    const detail = payload && typeof payload === 'object' ? payload.detail || payload.error : payload;
    const message = typeof detail === 'string' && detail ? detail : `Worker request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload;
}

export const worker = {
  /** Unauthenticated liveness probe — safe to call before sign-in. */
  health: () => call('/api/worker/health', { auth: false, timeout: 4000 }),

  status: () => call('/api/worker/status'),

  /** Persists non-secret settings and (optionally) the App Password server-side. */
  saveSettings: (data) => call('/api/worker/settings', { method: 'PUT', body: data }),

  resetSettings: () => call('/api/worker/settings/reset', { method: 'POST', body: {} }),

  testSmtp: () => call('/api/worker/test-smtp', { method: 'POST', body: {} }),

  /**
   * Hands the worker everything it needs for one campaign run:
   * the campaign id, its subject, the LOCAL template HTML (never stored in
   * Postgres) and the recipient list.
   */
  startCampaign: (payload) => call('/api/worker/campaigns/start', { method: 'POST', body: payload }),

  pauseCampaign: (id) => call(`/api/worker/campaigns/${encodeURIComponent(id)}/pause`, { method: 'POST', body: {} }),
  resumeCampaign: (id) => call(`/api/worker/campaigns/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} }),
  cancelCampaign: (id) => call(`/api/worker/campaigns/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  campaignState: (id) => call(`/api/worker/campaigns/${encodeURIComponent(id)}`),
};
