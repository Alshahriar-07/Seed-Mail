// Seed Code Mail - settings page

import { api } from './api.js';
import { escapeHtml, icon, refreshIcons, toast, spinner, confirmDialog } from './ui.js';
import { refreshTopbar } from './app.js';

let host = null;
let snapshot = null;

function field(id, label, value, { type = 'text', hint = '', wide = false } = {}) {
  return `<div class="field" style="${wide ? 'grid-column:1 / -1;' : ''}">
    <label for="${id}">${escapeHtml(label)}</label>
    <input class="input" id="${id}" type="${type}" value="${escapeHtml(value)}">
    ${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''}
  </div>`;
}

function paint(data) {
  const v = data.values;
  host.querySelector('#settings-form').innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h3>${icon('user', 16)} Sender identity</h3></div>
        ${field('s-email', 'Sender Gmail address', data.email, { type: 'email', hint: 'The Gmail account that sends the emails (Email in .env).' })}
        ${field('s-name', 'Sender display name', v.SENDER_NAME)}
        ${field('s-github', 'GitHub URL (optional)', v.GITHUB_URL, { hint: 'Used by the {{GITHUB_URL}} template variable. Leave blank if unused.', wide: true })}
        ${field('s-pass', 'Gmail App Password', '', { type: 'password', hint: data.has_password ? 'A password is configured. Leave blank to keep it unchanged.' : 'No password configured yet. Paste your 16-character App Password (GAPP_PASS).', wide: true })}
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
      <div><h2>Settings</h2><p>Configure the sender identity and SMTP connection. Secrets are stored server-side only.</p>
        <p class="hint">The email subject is set per campaign, not here.</p></div>
      <div class="page-actions">
        <button class="btn btn-ghost" id="btn-defaults">${icon('rotate-ccw', 16)} Reset defaults</button>
        <button class="btn btn-secondary" id="btn-test">${icon('plug-zap', 16)} Test SMTP connection</button>
        <button class="btn btn-secondary" id="btn-cancel">Cancel changes</button>
        <button class="btn btn-primary" id="btn-save">${icon('save', 16)} Save settings</button>
      </div>
    </div>
    <div class="notice" style="margin-bottom:20px;">${icon('shield', 16)}
      <span>The App Password is never sent back to the browser. Exporting or viewing this page never exposes stored secrets.</span></div>
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
      toast('Settings saved to .env.', 'success');
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
