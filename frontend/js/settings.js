// Seed Code Mail - settings page

import { api } from './api.js';
import { escapeHtml, icon, refreshIcons, toast, spinner, confirmDialog, openModal } from './ui.js';
import { refreshTopbar } from './app.js';
import { agentCardMarkup, bindAgentCard } from './agent-panel.js';

let host = null;
let snapshot = null;

const APP_PASSWORDS_URL = 'https://myaccount.google.com/apppasswords';

/**
 * The "How to create a Gmail App Password" help panel.
 *
 * It is written for someone who has never made one: the requirements, the exact
 * steps, the SMTP values Seed Code Mail uses, and what each authentication
 * failure means. Nothing here is credential-shaped, and the direct Google link
 * is the official settings page rather than a search result.
 */
function appPasswordHelpHtml() {
  return `
    <div class="help-panel">
      <p><strong>A Gmail App Password is a 16-character password Google generates for one specific app</strong>
      — here, Seed Code Mail. It is used when 2-Step Verification is on, and it lets the send worker sign in to
      Gmail's SMTP service without ever knowing your real Google password. You can revoke it at any time
      without changing your Google password.</p>

      <h4>Before you start</h4>
      <ul>
        <li>Be signed in to the Google Account you want to send from.</li>
        <li><strong>2-Step Verification must be turned on.</strong> Google only offers App Passwords on accounts
        that have it enabled — if the App Passwords page says the feature is unavailable, turn on 2-Step
        Verification first, then try again.</li>
        <li>Availability depends on the account and its security setup. Work, school and Advanced Protection
        accounts, and accounts managed by a security policy, often cannot create App Passwords at all. In that
        case use the Gmail API connection on the Profile page instead.</li>
      </ul>

      <h4>Create the App Password</h4>
      <ol>
        <li>Open <a href="${APP_PASSWORDS_URL}" target="_blank" rel="noopener noreferrer">${APP_PASSWORDS_URL.replace('https://', '')}</a>.</li>
        <li>Sign in to the Google Account you want to send from, if you are asked to.</li>
        <li>Enter an app name — for example <em>Seed Code Mail</em> — and choose <strong>Create</strong>.</li>
        <li>Google shows a 16-character password, usually as four groups of four (for example
        <code>abcd efgh ijkl mnop</code>). Copy it now: you cannot see it again.</li>
        <li>Come back here, paste it into <strong>Gmail App Password</strong>, and choose <strong>Save settings</strong>.</li>
      </ol>

      <h4>SMTP settings Seed Code Mail uses</h4>
      <ul>
        <li><strong>SMTP host:</strong> <code>smtp.gmail.com</code></li>
        <li><strong>Port:</strong> <code>465</code> for SSL (recommended) or <code>587</code> for STARTTLS</li>
        <li><strong>Username:</strong> your full Gmail address — the one in <strong>Sender Gmail address</strong></li>
        <li><strong>Password:</strong> the App Password you just created, never your normal Google password</li>
      </ul>

      <h4>Authentication failures and how to fix them</h4>
      <ul>
        <li><strong>535 5.7.8 Username and Password not accepted</strong> — the value is not a valid App Password,
        or it was revoked. Create a new one and save it again. Make sure it is the 16-character App Password,
        not your Google password.</li>
        <li><strong>534 5.7.9 Application-specific password required</strong> — 2-Step Verification is on but the
        normal password is being used. Create and use an App Password.</li>
        <li><strong>Wrong sender / invalid address</strong> — the username must be the exact Gmail address in
        <strong>Sender Gmail address</strong>. Gmail will not send from a different address over this connection.</li>
        <li><strong>Connection timed out</strong> — try port 465 (SSL). A network that blocks outbound SMTP blocks
        both ports.</li>
      </ul>

      <div class="notice">${icon('shield', 16)}<span>Keep your App Password secret. Never share it with another
      person, and never post it in a chat, a ticket or a screenshot. Store it only where it is needed — here it
      is written to your send worker only, never to your account database or the browser's storage. If it is ever
      exposed, delete it on the Google App Passwords page and create a new one.</span></div>
    </div>`;
}

function openAppPasswordHelp() {
  openModal({
    title: 'How to create a Gmail App Password',
    size: 'lg',
    body: appPasswordHelpHtml(),
    actions: [
      {
        label: 'Open Google App Passwords',
        variant: 'btn-secondary',
        closeOnClick: false,
        onClick: () => {
          window.open(APP_PASSWORDS_URL, '_blank', 'noopener,noreferrer');
          return false;
        },
      },
      { label: 'Close', variant: 'btn-primary' },
    ],
  });
}

/**
 * A one-line, accurate description of the send worker's state.
 *
 * It never tells an end user of a hosted deployment to run Python locally, and
 * it never claims the worker is online unless it has actually reported in.
 */
function workerStatusLine(worker) {
  const configured = worker.configured !== false;
  const available = Boolean(worker.available);
  const queue = worker.queue || null;
  const queueOnline = queue ? Boolean(queue.consumer_online) : available;
  const waiting = Number(queue?.queued || 0);

  // A URL this build cannot use is a configuration error (for example a
  // localhost value left in the deployed environment), so it is reported as
  // such rather than as an unreachable service.
  if (worker.config_problem) {
    return worker.config_problem;
  }
  if (!configured) {
    return 'No send worker is configured for this deployment, so campaigns stay queued in your account. Set VITE_MAIL_WORKER_URL to the deployed worker service URL and redeploy.';
  }
  if (!available) {
    return worker.local
      ? 'Cannot reach the send worker. For local development, start it with "python worker/main.py".'
      : 'The send worker service is not reachable right now. Campaigns stay queued and are delivered automatically when it returns.';
  }
  if (!queueOnline) {
    return `The send worker is starting up.${waiting ? ` ${waiting} campaign(s) are waiting in the queue.` : ''}`;
  }
  return `Send worker online — campaigns are queued here and delivered by the worker service.${waiting ? ` ${waiting} waiting in the queue.` : ''}`;
}

function field(id, label, value, { type = 'text', hint = '', wide = false } = {}) {
  return `<div class="field" style="${wide ? 'grid-column:1 / -1;' : ''}">
    <label for="${id}">${escapeHtml(label)}</label>
    <input class="input" id="${id}" type="${type}" value="${escapeHtml(value)}">
    ${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''}
  </div>`;
}

function workerStateLabel(worker) {
  if (worker?.config_problem || worker?.configured === false) return 'Not configured';
  if (!worker?.available) return 'Not reachable';
  const queue = worker?.queue;
  if (queue && queue.configured === false) return 'Configured (no queue consumer)';
  return queue?.consumer_online ? 'Online' : 'Starting';
}

function paint(data) {
  const v = data.values;

  const notice = host.querySelector('#worker-notice');
  if (notice) {
    const worker = data.worker || {};
    const online = Boolean(worker.available) && Boolean(worker.queue?.consumer_online);
    const unavailable = workerStatusLine(worker);
    notice.innerHTML = `<div class="notice ${online ? 'notice-success' : 'notice-warning'}">
      ${icon(online ? 'check-circle-2' : 'alert-circle', 16)}
      <span>${escapeHtml(unavailable)}</span></div>`;
  }

  host.querySelector('#settings-form').innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h3>${icon('user', 16)} Sender identity</h3></div>
        ${field('s-email', 'Sender Gmail address', data.email, { type: 'email', hint: 'The Gmail account that sends the emails (Email in .env).' })}
        ${field('s-name', 'Sender display name', v.SENDER_NAME)}
        ${field('s-github', 'GitHub URL (optional)', v.GITHUB_URL, { hint: 'Used by the {{GITHUB_URL}} template variable. Leave blank if unused.', wide: true })}
        ${field('s-pass', 'Gmail App Password', '', { type: 'password', hint: data.has_password ? 'An App Password is configured on the send worker. Leave blank to keep it unchanged.' : 'No password configured yet. Paste your 16-character Gmail App Password — it is sent only to the worker service, never stored in the browser or the database.', wide: true })}
        <div class="field" style="grid-column:1 / -1; margin-top:-4px;">
          <button class="btn btn-ghost btn-sm" type="button" id="btn-app-password-help">${icon('circle-help', 15)} How to create a Gmail App Password</button>
        </div>
        <div class="kv"><span>Send worker</span><span>${escapeHtml(workerStateLabel(data.worker))}</span></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>${icon('server', 16)} SMTP & sending</h3></div>
        <div class="grid grid-2">
          ${field('s-host', 'SMTP host', v.SMTP_HOST)}
          ${field('s-port', 'SMTP port', v.SMTP_PORT, { hint: '465 = SSL, 587 = STARTTLS' })}
        </div>
        <div class="grid grid-2">
          ${field('s-delay', 'Sending delay (seconds)', v.SEND_DELAY_SECONDS)}
          ${field('s-timeout', 'Connection timeout (seconds)', v.SMTP_TIMEOUT_SECONDS)}
        </div>
        <div class="grid grid-2">
          ${field('s-retries', 'Max retries', v.MAX_RETRIES, { hint: 'Applies to definite transient failures only.' })}
          ${field('s-retry-delay', 'Retry delay (seconds)', v.RETRY_DELAY_SECONDS)}
        </div>
      </div>
    </div>`;
  refreshIcons(host);

  // Bound on every paint, because the form is re-rendered after a save.
  host.querySelector('#btn-app-password-help')?.addEventListener('click', (event) => {
    event.preventDefault();
    openAppPasswordHelp();
  });
}

function collect() {
  return {
    Email: document.getElementById('s-email').value.trim(),
    SENDER_NAME: document.getElementById('s-name').value.trim(),
    GITHUB_URL: document.getElementById('s-github').value.trim(),
    SMTP_HOST: document.getElementById('s-host').value.trim(),
    SMTP_PORT: Number(document.getElementById('s-port').value) || 0,
    SEND_DELAY_SECONDS: Number(document.getElementById('s-delay').value) || 0,
    SMTP_TIMEOUT_SECONDS: Number(document.getElementById('s-timeout').value) || 0,
    MAX_RETRIES: Number(document.getElementById('s-retries').value) || 0,
    RETRY_DELAY_SECONDS: Number(document.getElementById('s-retry-delay').value) || 0,
    GAPP_PASS: document.getElementById('s-pass').value,
  };
}

async function load() {
  const data = await api.settings();
  snapshot = data;
  paint(data);
}

export async function render(container) {
  host = container;

  container.innerHTML = `
    <div class="page-head">
      <div><h2>Settings</h2><p>Configure the sender identity and SMTP connection.</p>
        <p class="hint">Non-secret preferences are stored in your account (Supabase). The Gmail App Password is only ever written to the send worker on your own machine — never to Supabase or the browser.</p>
        <p class="hint">The email subject is set per campaign, not here.</p></div>
      <div class="page-actions">
        <button class="btn btn-ghost" id="btn-defaults">${icon('rotate-ccw', 16)} Reset defaults</button>
        <button class="btn btn-secondary" id="btn-test">${icon('plug-zap', 16)} Test SMTP connection</button>
        <button class="btn btn-secondary" id="btn-cancel">Cancel changes</button>
        <button class="btn btn-primary" id="btn-save">${icon('save', 16)} Save settings</button>
      </div>
    </div>
    <div class="notice" style="margin-bottom:20px;">${icon('info', 16)}
      <span>This page configures <strong>campaign delivery</strong>, which uses Gmail SMTP with an App Password.
      Reading your Inbox and sending ordinary email works differently — it uses Google's Gmail API with OAuth 2.0,
      and is set up on the <a href="#/profile">Profile</a> page. A Gmail App Password does not grant Gmail API access.</span></div>
    <div class="notice" style="margin-bottom:20px;">${icon('shield', 16)}
      <span>The App Password is never sent back to the browser, never stored in Supabase, and never saved in localStorage or IndexedDB. It is written to the send worker's own environment on your machine.</span></div>
    <div id="worker-notice" style="margin-bottom:20px;"></div>
    <div id="local-agent" style="margin-bottom:20px;"></div>
    <div id="settings-form"></div>
    <div id="smtp-result" style="margin-top:20px;"></div>

    <div class="card" style="margin-top:20px;">
      <div class="card-head"><h3>${icon('scale', 16)} Legal &amp; data handling</h3></div>
      <p>The Privacy Policy describes every category of data this application stores, which Gmail
      data it accesses and for what purpose, how the stored OAuth credential is protected, and how to
      delete your data or revoke access. The Terms of Service cover account responsibilities,
      acceptable sending practices and the limits of the service.</p>
      <div class="page-actions">
        <a class="btn btn-secondary" href="#/privacy" data-legal="privacy">${icon('shield', 16)} Privacy Policy</a>
        <a class="btn btn-ghost" href="#/terms" data-legal="terms">${icon('file-text', 16)} Terms of Service</a>
      </div>
    </div>`;

  refreshIcons(container);
  const body = container.querySelector('#settings-form');
  body.innerHTML = spinner('Loading settings');
  refreshIcons(body);

  // The Local Agent card is independent of the settings row: it reports whether
  // a sender is running on this computer, which is a different question from
  // what the stored preferences are.
  const agentHost = container.querySelector('#local-agent');
  agentHost.innerHTML = agentCardMarkup();
  refreshIcons(agentHost);
  bindAgentCard(agentHost);

  await load();

  container.querySelector('#btn-save').addEventListener('click', async () => {
    const btn = container.querySelector('#btn-save');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = spinner('Saving');
    try {
      await api.saveSettings(collect());
      toast('Settings saved.', 'success');
      await load();
      await refreshTopbar();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
      refreshIcons(btn);
    }
  });

  container.querySelector('#btn-cancel').addEventListener('click', () => {
    paint(snapshot);
    toast('Changes discarded.', 'info');
  });

  container.querySelector('#btn-test').addEventListener('click', async () => {
    const result = container.querySelector('#smtp-result');
    result.innerHTML = spinner('Testing SMTP connection');
    refreshIcons(result);
    try {
      const res = await api.testSmtp();
      const cls = res.ok ? 'notice-success' : 'notice-error';
      const iconName = res.ok ? 'check-circle-2' : 'alert-circle';
      result.innerHTML = `<div class="notice ${cls}">${icon(iconName, 16)}<span>${escapeHtml(res.message)}${res.category && res.category !== 'ok' ? ` (${escapeHtml(res.category)})` : ''}</span></div>`;
      await refreshTopbar();
    } catch (e) {
      result.innerHTML = `<div class="notice notice-error">${icon('alert-circle', 16)}<span>${escapeHtml(e.message)}</span></div>`;
    }
    refreshIcons(result);
  });

  container.querySelector('#btn-defaults').addEventListener('click', async () => {
    const ok = await confirmDialog('Reset all non-secret settings to their defaults? Your App Password is kept.', { title: 'Reset defaults', confirmLabel: 'Reset', danger: true });
    if (!ok) return;
    try { await api.resetSettings(); toast('Non-secret settings reset.', 'success'); await load(); await refreshTopbar(); }
    catch (e) { toast(e.message, 'error'); }
  });
}
