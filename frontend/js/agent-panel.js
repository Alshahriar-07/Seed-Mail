// Seed Code Mail — the Local Agent panel
//
// The card that answers "is the email-sending agent running on this computer?".
// It is used by Settings (full size) and the Dashboard (compact), so the status
// wording cannot drift between the two.
//
// What it deliberately does NOT do:
//
//   * it never downloads or executes anything. A website cannot start a local
//     process, and claiming otherwise would be a lie. The instructions tell the
//     user to start the agent themselves; the button only *looks* for it.
//   * it never reports a state the agent did not report. Every label comes from
//     `describeAgent()` (lib/agent.js), which is a pure function of the agent's
//     real answers — see tests/js/agent.test.mjs.
//   * it never blocks the page. If there is no agent, that is a normal state.

import {
  agentPairingToken, clearAgentPairingToken, describeAgent, probeAgent, agentReport,
  saveAgentSettings, setAgentPairingToken, testAgentSmtp, localAgentUrl,
} from './lib/agent.js';
import { escapeHtml, icon, refreshIcons, toast } from './ui.js';
import { currentAccessToken } from './lib/supabase.js';

const REPO_URL = 'https://github.com/Alshahriar-07/Seed-Mail';

const TONE_CLASS = {
  ok: 'badge-sent',
  warn: 'badge-failed',
  off: 'badge-queued',
};

/** Which features need the agent, so the user knows what they are turning on. */
const CAPABILITIES = [
  ['Read the inbox, Sent, and open messages', 'Cloud', 'Uses the Gmail API through the deployed backend.'],
  ['Compose and send ordinary email', 'Cloud', 'Sent by Gmail as your connected account.'],
  ['Recipients, templates, campaigns, history', 'Cloud', 'Stored in your Supabase account.'],
  ['Send a campaign to your recipient list', 'Local Agent', 'Gmail SMTP with an App Password, from this computer.'],
  ['App Password and SMTP settings', 'Local Agent', 'Written only to the agent on this machine, never to Supabase.'],
];

function capabilityRows() {
  return CAPABILITIES.map(([feature, needs, detail]) => `
    <tr>
      <td>${escapeHtml(feature)}</td>
      <td><span class="badge ${needs === 'Local Agent' ? 'badge-running' : 'badge-sent'}">${escapeHtml(needs)}</span></td>
      <td class="cell-muted">${escapeHtml(detail)}</td>
    </tr>`).join('');
}

function instructionsMarkup() {
  return `
    <div class="notice">${icon('info', 16)}<span>
      A website cannot install or start a program on your computer, and this one will not try.
      The steps below are yours to perform; the button only checks whether the agent is already running.
    </span></div>
    <ol class="setup-list">
      <li><a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">Open the project repository</a>
          and download it (Code → Download ZIP), or use a release build if one is provided.</li>
      <li>Install <strong>Python 3.12</strong> from python.org and tick “Add python.exe to PATH”.</li>
      <li>Double-click <code>start-agent.bat</code> in the project folder. A console window opens and stays open
          while the agent runs. Leave it running; close the window to stop the agent.</li>
      <li>Come back here and choose <strong>Check for local agent</strong>. Then add your Gmail App Password below.</li>
    </ol>
    <div class="notice">${icon('shield', 16)}<span>
      The agent listens only on <code>${escapeHtml(localAgentUrl())}</code> — this computer. It refuses requests from
      any other website origin, refuses a request that arrives under a different hostname, and (optionally) can
      require a pairing token that only you have. It is not an open relay: it sends only campaigns you queued while
      signed in.
    </span></div>`;
}

/** The card shell. Kept as a string so Settings and Dashboard embed the same thing. */
export function agentCardMarkup({ compact = false } = {}) {
  return `
    <div class="card agent-card" id="agent-card">
      <div class="card-head">
        <h3>${icon('monitor-down', 16)} Local Agent</h3>
        <span class="badge" id="agent-badge"><span class="badge-dot"></span> Checking…</span>
      </div>
      <p class="hint">The agent is the small program on this computer that sends campaigns over Gmail SMTP.
      Everything else in Seed Code Mail works without it.</p>
      <div class="kv"><span>Status</span><span id="agent-label">Checking…</span></div>
      <div class="hint" id="agent-detail"></div>
      <div class="page-actions" style="margin-top:14px;">
        <button class="btn btn-secondary" id="agent-check">${icon('refresh-cw', 16)} Check for local agent</button>
        <button class="btn btn-ghost" id="agent-instructions-toggle" aria-expanded="false">Setup instructions</button>
      </div>
      <div id="agent-pairing" hidden>
        <div class="field" style="margin-top:12px;">
          <label for="agent-token">Pairing token</label>
          <input class="input" id="agent-token" type="password" placeholder="Paste the token shown by the agent">
          <div class="hint">The agent printed this when you started it with pairing enabled. It is stored in this
          browser only, never in Supabase.</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary btn-sm" id="agent-save-token">Save token</button>
          <button class="btn btn-ghost btn-sm" id="agent-clear-token">Forget token</button>
        </div>
      </div>
      <div id="agent-instructions" hidden>${instructionsMarkup()}</div>
      ${compact ? '' : `
      <div class="card-head" style="margin-top:18px;"><h3>${icon('list-checks', 16)} What needs the agent</h3></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Feature</th><th>Provided by</th><th>Notes</th></tr></thead>
          <tbody>${capabilityRows()}</tbody>
        </table>
      </div>`}
    </div>`;
}

/** A one-line status for the dashboard, derived from the same report. */
export function agentStatusLine(report) {
  return `${report.label} — ${report.detail}`;
}

function paint(root, report) {
  const badge = root.querySelector('#agent-badge');
  const label = root.querySelector('#agent-label');
  const detail = root.querySelector('#agent-detail');
  const pairing = root.querySelector('#agent-pairing');

  if (badge) {
    badge.className = `badge ${TONE_CLASS[report.tone] || ''}`;
    badge.innerHTML = `<span class="badge-dot"></span> ${escapeHtml(report.label)}`;
  }
  if (label) label.textContent = report.label;
  if (detail) detail.textContent = report.detail;
  if (pairing) {
    pairing.hidden = report.state !== 'pairing';
    const input = root.querySelector('#agent-token');
    if (input && !input.value) input.value = agentPairingToken();
  }
  refreshIcons(root);
}

/** Runs a check and paints the result. Never throws. */
export async function refreshAgentCard(root) {
  const check = root.querySelector('#agent-check');
  const original = check ? check.innerHTML : '';
  if (check) {
    check.disabled = true;
    check.innerHTML = '<span class="spinner"></span> Checking';
    refreshIcons(check);
  }
  try {
    const token = await currentAccessToken();
    const { report } = await agentReport({ token });
    paint(root, report);
    return report;
  } catch (error) {
    // agentReport is already total; this is belt-and-braces so a surprise can
    // never leave the card stuck on "Checking…".
    paint(root, describeAgent({ reachable: false, reason: error?.message || '' }));
    return null;
  } finally {
    if (check) {
      check.disabled = false;
      check.innerHTML = original;
      refreshIcons(check);
    }
  }
}

/**
 * Wires the card's buttons and performs the first check.
 *
 * @param {HTMLElement} root  an element containing `agentCardMarkup()`
 * @param {{ onChange?: Function }} [options]
 */
export function bindAgentCard(root, { onChange } = {}) {
  const rerender = () => refreshAgentCard(root).then((report) => onChange?.(report)).catch(() => {});

  root.querySelector('#agent-check')?.addEventListener('click', rerender);

  root.querySelector('#agent-instructions-toggle')?.addEventListener('click', (event) => {
    const box = root.querySelector('#agent-instructions');
    if (!box) return;
    const open = box.hidden;
    box.hidden = !open;
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });

  root.querySelector('#agent-save-token')?.addEventListener('click', async () => {
    const value = root.querySelector('#agent-token')?.value || '';
    setAgentPairingToken(value);
    toast(value ? 'Pairing token saved in this browser.' : 'Pairing token cleared.', 'success');
    await rerender();
  });

  root.querySelector('#agent-clear-token')?.addEventListener('click', async () => {
    clearAgentPairingToken();
    const input = root.querySelector('#agent-token');
    if (input) input.value = '';
    toast('Pairing token forgotten.', 'info');
    await rerender();
  });

  return rerender();
}

/**
 * Saves the App Password to the agent (not to Supabase) and tests the SMTP
 * connection. Used by Settings, where the fields live.
 */
export async function configureAgent({ email, password }) {
  const values = {};
  if (email) values.Email = email;
  if (password) values.GAPP_PASS = password;
  if (!Object.keys(values).length) return null;
  const token = await currentAccessToken();
  return saveAgentSettings(values, { token });
}

export { probeAgent, testAgentSmtp };
