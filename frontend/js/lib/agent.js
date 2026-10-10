// Seed Code Mail — the Windows Local Agent (browser side)
//
// The campaign sender can run on the user's own computer instead of a paid,
// always-on host. That process is the existing Python worker (`worker/main.py`,
// started by `start-agent.bat`); this module is how the *website* finds it.
//
// Three things shape the design:
//
//   1. **The agent is optional.** Inbox, Sent, Compose, recipients, templates
//      and history are all served by Supabase and the Gmail API and do not need
//      this at all. Detection never blocks a page and never throws.
//
//   2. **Only this machine can be probed.** The URL is loopback by default
//      (`http://127.0.0.1:8765`). Unlike `endpoints.js`, which refuses a
//      loopback address for a *deployed* service because a deployed site cannot
//      reach the user's computer, reaching the user's own computer is exactly
//      the point here — so the loopback default is used everywhere, and a
//      configured `VITE_LOCAL_AGENT_URL` may override it. Nothing is ever
//      guessed beyond that.
//
//   3. **Nothing is claimed.** "Connected" means the agent answered an
//      *authenticated* request as this signed-in user. "Sending" means the agent
//      said it is sending. A status is derived from those real answers only; a
//      failure to reach the agent is reported as "not detected", never as an
//      error the user must fix.
//
// The request/response rules are enforced by the agent itself (see
// `worker/security.py`): it checks the Origin and Host headers, answers Chrome's
// Private Network Access preflight, and — when the user has paired it —
// requires a pairing token on every endpoint except the public health probe.
// This module simply complies: it never sends a user id, and it never sends a
// credential other than the caller's own Supabase token.

const DEFAULT_AGENT_URL = 'http://127.0.0.1:8765';
const PROBE_TIMEOUT_MS = 4000;
const CALL_TIMEOUT_MS = 10000;
const PAIRING_STORAGE_KEY = 'seedmail.agent.token';

// How long a finished run is still worth reporting as the *current* state.
// After this the panel settles on "connected" and shows the outcome as history,
// so a campaign that finished yesterday is not presented as if it just ended.
export const RECENT_RUN_MS = 5 * 60 * 1000;

function env() {
  // `import.meta.env` exists in the Vite build and not under plain Node (the
  // unit tests import this module directly), hence the guard.
  return (typeof import.meta !== 'undefined' && import.meta.env) || {};
}

/**
 * The local agent's base URL.
 *
 * `VITE_LOCAL_AGENT_URL` overrides the default when set — useful for a
 * non-standard port. A loopback value is valid here on purpose (see the file
 * header); an unusable value falls back to the default rather than leaving the
 * panel unable to look for an agent at all.
 */
export function localAgentUrl(rawValue) {
  const raw = String(rawValue ?? env().VITE_LOCAL_AGENT_URL ?? '').trim();
  if (!raw) return DEFAULT_AGENT_URL;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return DEFAULT_AGENT_URL;
    return raw.replace(/\/+$/, '');
  } catch (_) {
    return DEFAULT_AGENT_URL;
  }
}

// --- pairing token ----------------------------------------------------------
//
// The token is optional and off by default. When the user has switched pairing
// on in the agent (`WORKER_AGENT_TOKEN`), they paste the value the agent printed
// here once. It is stored locally and sent as a header; it is never written to
// Supabase, never logged, and never rendered.

export function agentPairingToken() {
  try {
    return window.localStorage.getItem(PAIRING_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

export function setAgentPairingToken(value) {
  try {
    const text = String(value ?? '').trim();
    if (text) window.localStorage.setItem(PAIRING_STORAGE_KEY, text);
    else window.localStorage.removeItem(PAIRING_STORAGE_KEY);
  } catch (_) {
    // A browser with storage disabled simply runs unpaired.
  }
}

export function clearAgentPairingToken() {
  setAgentPairingToken('');
}

// --- the state machine ------------------------------------------------------
//
// A pure function of what was observed, so every state can be tested without a
// browser or a running agent.

/**
 * Turns observations into the single status the UI shows.
 *
 * @param {object} input
 * @param {boolean} input.reachable   the health probe answered
 * @param {object?} input.health      the parsed health payload (or null)
 * @param {boolean} input.connected   an authenticated status call succeeded
 * @param {object?} input.status      the parsed status payload (or null)
 * @param {string}  input.reason      why the probe failed, when it did
 * @param {string}  input.error       why the authenticated call failed, when it did
 * @param {boolean} input.hasPairingToken
 * @param {number}  input.now         epoch ms (injectable for tests)
 * @returns {{state: string, label: string, detail: string, tone: 'ok'|'warn'|'off', progress: 'idle'|'sending'|'completed'|'failed'}}
 */
export function describeAgent({
  reachable = false,
  health = null,
  connected = false,
  status = null,
  reason = '',
  error = '',
  hasPairingToken = false,
  now = Date.now(),
} = {}) {
  if (!reachable) {
    return {
      state: 'unavailable',
      label: 'No local agent detected',
      tone: 'off',
      progress: 'idle',
      detail: reason || 'No local agent is running on this computer.',
    };
  }

  if (health?.pairing_required && !hasPairingToken) {
    return {
      state: 'pairing',
      label: 'Agent detected — pairing required',
      tone: 'warn',
      progress: 'idle',
      detail: 'The agent is running and asks for a pairing token before it will accept requests from this site.',
    };
  }

  if (!connected) {
    return {
      state: 'detected',
      label: 'Agent detected',
      tone: 'warn',
      progress: 'idle',
      detail: error || 'The agent answered its health check, but this signed-in account could not be verified on it.',
    };
  }

  if (status?.sending) {
    return {
      state: 'sending',
      label: 'Sending in progress',
      tone: 'ok',
      progress: 'sending',
      detail: status?.current_recipient?.email
        ? `Currently sending to ${status.current_recipient.email}.`
        : 'The agent is running a campaign now.',
    };
  }

  const last = status?.last_run || null;
  const finishedAt = last?.finished_at ? Date.parse(last.finished_at) : NaN;
  const recent = Number.isFinite(finishedAt) && now - finishedAt <= RECENT_RUN_MS;
  if (last && recent) {
    if (last.ok) {
      return {
        state: 'completed',
        label: 'Sending completed',
        tone: 'ok',
        progress: 'completed',
        detail: 'The agent finished its most recent campaign and every recipient succeeded.',
      };
    }
    const failed = Number(last?.counters?.failed || 0);
    return {
      state: 'failed',
      label: 'Sending failed',
      tone: 'warn',
      progress: 'failed',
      detail: last?.error
        ? `The agent's most recent campaign did not complete: ${last.error}`
        : `The agent's most recent campaign ended with ${failed} failed recipient${failed === 1 ? '' : 's'}.`,
    };
  }

  const smtpConfigured = Boolean(health?.smtp_configured ?? status?.has_password);
  if (!smtpConfigured) {
    return {
      state: 'not_configured',
      label: 'Agent connected — email service not configured',
      tone: 'warn',
      progress: 'idle',
      detail: 'The agent is connected, but it has no Gmail App Password yet, so it cannot send. Add one below.',
    };
  }

  return {
    state: 'connected',
    label: 'Agent connected',
    tone: 'ok',
    progress: 'idle',
    detail: 'The agent is running on this computer and ready to send campaigns.',
  };
}

// --- talking to the agent ---------------------------------------------------

async function request(path, { method = 'GET', body, token = '', accessToken = '', timeout = CALL_TIMEOUT_MS } = {}) {
  const url = `${localAgentUrl()}${path}`;
  const headers = { Accept: 'application/json' };
  // Always sent: the agent ignores it unless pairing is switched on.
  const pairing = token || agentPairingToken();
  if (pairing) headers['X-Seedmail-Agent-Token'] = pairing;
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_) {
      payload = null;
    }
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' ? payload.detail || payload.error : payload;
      const failure = new Error(typeof detail === 'string' && detail ? detail : `The agent returned HTTP ${response.status}.`);
      failure.status = response.status;
      throw failure;
    }
    return payload ?? {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks for an agent without authentication.
 *
 * The health endpoint is the one route the agent answers before a user is
 * verified (and before pairing), which is exactly what makes "is an agent
 * running on this computer?" answerable at all.
 */
export async function probeAgent({ timeout = PROBE_TIMEOUT_MS } = {}) {
  try {
    const health = await request('/api/worker/health', { timeout });
    return { reachable: true, health };
  } catch (error) {
    return {
      reachable: false,
      health: null,
      reason:
        error?.status
          ? `A service is listening on ${localAgentUrl()} but it refused this request (HTTP ${error.status}).`
          : 'No local agent is running on this computer (or it did not answer in time).',
    };
  }
}

/**
 * A full, honest report of the agent's state for the signed-in user.
 *
 * Never throws: a missing agent is a normal, expected condition that the UI
 * renders as "not detected".
 *
 * The Supabase access token is passed in by the caller rather than fetched
 * here. That keeps this module free of the Supabase browser client, so it can
 * be unit-tested under plain Node — where `import.meta.env` does not exist —
 * without a dynamic import that the bundler has to work around.
 *
 * @param {{token?: string, now?: number}} [options]
 */
export async function agentReport({ token = '', now = Date.now() } = {}) {
  const probe = await probeAgent();
  if (!probe.reachable) {
    return {
      report: describeAgent({ reachable: false, reason: probe.reason, now }),
      probe,
      status: null,
    };
  }

  let status = null;
  let connected = false;
  let error = '';
  try {
    if (!token) {
      error = 'Sign in to let the agent verify this account.';
    } else {
      status = await request('/api/worker/status', { accessToken: token });
      connected = true;
    }
  } catch (failure) {
    error = failure?.message || 'The agent did not accept this account.';
  }

  return {
    report: describeAgent({
      reachable: true,
      health: probe.health,
      connected,
      status,
      error,
      hasPairingToken: Boolean(agentPairingToken()),
      now,
    }),
    probe,
    status,
  };
}

/** Saves non-secret SMTP settings (and optionally the App Password) on the agent. */
export async function saveAgentSettings(values, { token = '' } = {}) {
  if (!token) throw new Error('Sign in before configuring the local agent.');
  return request('/api/worker/settings', { method: 'PUT', body: values, accessToken: token });
}

/** Connects to SMTP and authenticates only — it never sends an email. */
export async function testAgentSmtp({ token = '' } = {}) {
  if (!token) throw new Error('Sign in before testing the local agent.');
  return request('/api/worker/test-smtp', { method: 'POST', body: {}, accessToken: token });
}
