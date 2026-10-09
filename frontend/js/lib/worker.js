// Seed Code Mail — interface to the send worker service
//
// Vercel cannot hold a long-running sequential SMTP campaign, and the Gmail App
// Password must never reach the browser bundle or Supabase. Sending therefore
// happens in a separate, continuously available worker service (`worker/`),
// deployed on a host that keeps a process alive and pointed at by
// `VITE_MAIL_WORKER_URL`. Nothing about it requires the end user to run Python:
// campaigns are queued in Supabase and the worker claims them from there.
//
// Trust model:
//   * every request carries the signed-in user's Supabase access token, which
//     the worker verifies against Supabase Auth before doing anything;
//   * no user id is ever taken from the request body;
//   * credentials (the Gmail App Password, the service-role key) live only in
//     the worker host's environment.
//
// The worker URL is public configuration; it is not a secret and contains no
// credentials.

import { currentAccessToken } from './supabase.js';

const DEFAULT_WORKER_URL = 'http://127.0.0.1:8765';
const TIMEOUT_MS = 10000;

/**
 * True when this build can reach a send worker at all.
 *
 * A deployed build (Vercel) is configured only through `VITE_MAIL_WORKER_URL`.
 * A build served from localhost is the development setup, where the worker runs
 * on this machine and the default URL already points at it — so it is treated as
 * configured rather than pretending no worker exists.
 */
export function workerConfigured() {
  if (import.meta.env.VITE_MAIL_WORKER_URL) return true;
  return servedLocally();
}

/** True when the page itself is being served from this machine. */
function servedLocally() {
  if (typeof location === 'undefined') return false;
  return ['', 'localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
}

/** True when the configured worker is on this machine (local development). */
export function workerIsLocal() {
  try {
    const host = new URL(workerBaseUrl()).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch (_) {
    return false;
  }
}

/**
 * A message that tells the operator what to do, without telling end users to
 * run a Python process that the production deployment does not need.
 */
export function workerUnavailableHelp() {
  if (!workerConfigured()) {
    return (
      'No send worker URL is configured for this deployment. Set VITE_MAIL_WORKER_URL ' +
      'to the worker service URL in the Vercel project settings and redeploy ' +
      '(local development: run "python worker/main.py").'
    );
  }
  if (workerIsLocal()) {
    return `Cannot reach the send worker at ${workerBaseUrl()}. For local development, start it with "python worker/main.py".`;
  }
  return (
    `The send worker service at ${workerBaseUrl()} did not respond. Queued campaigns stay ` +
    'queued and send once the worker is available again — no action is needed here.'
  );
}

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
      throw new WorkerUnavailableError(`The send worker did not respond in time. ${workerUnavailableHelp()}`);
    }
    throw new WorkerUnavailableError(workerUnavailableHelp());
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

  /**
   * Real queue availability: whether the durable consumer has reported in and
   * how much work is waiting. Never a fabricated "online" flag.
   */
  queueStatus: () => call('/api/worker/queue/status'),

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
