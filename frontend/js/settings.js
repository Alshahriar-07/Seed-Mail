// Seed Code Mail - settings page

import { api } from './api.js';
import { escapeHtml, icon, refreshIcons, toast, spinner, confirmDialog } from './ui.js';
import { refreshTopbar } from './app.js';

let host = null;
let snapshot = null;

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
    <div id="settings-form"></div>
    <div id="smtp-result" style="margin-top:20px;"></div>`;

  refreshIcons(container);
  const body = container.querySelector('#settings-form');
  body.innerHTML = spinner('Loading settings');
  refreshIcons(body);

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
