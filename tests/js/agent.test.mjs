// Tests for frontend/js/lib/agent.js
//
// The Local Agent is optional infrastructure that lives on the user's own
// machine, so its status has to be *reported* rather than assumed. These tests
// pin the contract:
//
//   * an agent that is not running is "not detected", never an error;
//   * "connected" requires an authenticated answer, not merely an open port;
//   * "email service not configured", "sending", "completed" and "failed" come
//     from what the agent actually reported;
//   * the URL resolution can point at loopback (that is the whole point) and
//     still refuses anything that is not a usable http(s) URL.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECENT_RUN_MS,
  describeAgent,
  localAgentUrl,
} from '../../frontend/js/lib/agent.js';

// --- URL resolution ---------------------------------------------------------

test('the local agent URL defaults to loopback on this machine', () => {
  assert.equal(localAgentUrl(''), 'http://127.0.0.1:8765');
  assert.equal(localAgentUrl(undefined), 'http://127.0.0.1:8765');
});

test('a configured agent URL is honoured, including a loopback one', () => {
  // Unlike a *deployed* worker URL, a loopback value is correct here: the agent
  // runs on the computer the browser is on.
  assert.equal(localAgentUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.equal(localAgentUrl('http://localhost:8765/'), 'http://localhost:8765');
});

test('an unusable agent URL falls back to the loopback default', () => {
  for (const value of ['not a url', 'ftp://127.0.0.1', 'javascript:alert(1)']) {
    assert.equal(localAgentUrl(value), 'http://127.0.0.1:8765', `${value} should fall back`);
  }
});

// --- the state machine ------------------------------------------------------

const HEALTH_READY = { ok: true, agent: true, smtp_configured: true, pairing_required: false };
const HEALTH_UNCONFIGURED = { ok: true, agent: true, smtp_configured: false, pairing_required: false };

test('no answer means the agent is not detected, and it is not an error', () => {
  const report = describeAgent({ reachable: false });
  assert.equal(report.state, 'unavailable');
  assert.equal(report.tone, 'off');
  assert.match(report.detail, /no local agent/i);
});

test('a reachable agent that cannot verify the account is merely "detected"', () => {
  const report = describeAgent({ reachable: true, health: HEALTH_READY, connected: false, error: 'Session expired.' });
  assert.equal(report.state, 'detected');
  assert.equal(report.detail, 'Session expired.');
});

test('a paired agent asks for the token before it is trusted', () => {
  const report = describeAgent({
    reachable: true,
    health: { ...HEALTH_READY, pairing_required: true },
    connected: false,
    hasPairingToken: false,
  });
  assert.equal(report.state, 'pairing');
  assert.equal(report.tone, 'warn');
});

test('a paired agent with a token proceeds to the normal states', () => {
  const report = describeAgent({
    reachable: true,
    health: { ...HEALTH_READY, pairing_required: true },
    connected: true,
    status: { has_password: true, sending: false },
    hasPairingToken: true,
  });
  assert.equal(report.state, 'connected');
});

test('a connected agent with no App Password reports the email service as unconfigured', () => {
  const report = describeAgent({
    reachable: true,
    health: HEALTH_UNCONFIGURED,
    connected: true,
    status: { has_password: false, sending: false },
  });
  assert.equal(report.state, 'not_configured');
  assert.match(report.detail, /App Password/i);
});

test('an actively sending agent reports sending, with the current recipient', () => {
  const report = describeAgent({
    reachable: true,
    health: HEALTH_READY,
    connected: true,
    status: { has_password: true, sending: true, current_recipient: { email: 'a@b.com' } },
  });
  assert.equal(report.state, 'sending');
  assert.equal(report.progress, 'sending');
  assert.match(report.detail, /a@b\.com/);
});

test('a run that finished recently reports completed', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const report = describeAgent({
    reachable: true,
    health: HEALTH_READY,
    connected: true,
    now,
    status: {
      has_password: true,
      sending: false,
      last_run: { ok: true, finished_at: new Date(now - 1000).toISOString(), counters: { failed: 0 } },
    },
  });
  assert.equal(report.state, 'completed');
  assert.equal(report.tone, 'ok');
});

test('a run that finished recently with failures reports failed', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const report = describeAgent({
    reachable: true,
    health: HEALTH_READY,
    connected: true,
    now,
    status: {
      has_password: true,
      sending: false,
      last_run: { ok: false, finished_at: new Date(now - 1000).toISOString(), counters: { failed: 3 } },
    },
  });
  assert.equal(report.state, 'failed');
  assert.match(report.detail, /3 failed/);
});

test('an old finished run does not masquerade as the current state', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const report = describeAgent({
    reachable: true,
    health: HEALTH_READY,
    connected: true,
    now,
    status: {
      has_password: true,
      sending: false,
      last_run: {
        ok: true,
        finished_at: new Date(now - RECENT_RUN_MS - 60_000).toISOString(),
        counters: { failed: 0 },
      },
    },
  });
  assert.equal(report.state, 'connected');
  assert.equal(report.progress, 'idle');
});

test('sending takes precedence over a recently finished run', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const report = describeAgent({
    reachable: true,
    health: HEALTH_READY,
    connected: true,
    now,
    status: {
      has_password: true,
      sending: true,
      last_run: { ok: true, finished_at: new Date(now - 1000).toISOString(), counters: {} },
    },
  });
  assert.equal(report.state, 'sending');
});
