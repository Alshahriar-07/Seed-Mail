// Seed Code Mail - dashboard page

import { api } from './api.js';
import { escapeHtml, icon, formatDate, refreshIcons, statusBadge, skeleton, emptyState } from './ui.js';
import { navigate } from './app.js';

function statCard({ label, value, iconName }) {
  return `
    <div class="card stat-card hoverable">
      <div class="stat-top"><span class="stat-label">${escapeHtml(label)}</span>
        <span class="stat-icon">${icon(iconName, 17)}</span></div>
      <div class="stat-value">${escapeHtml(String(value))}</div>
    </div>`;
}

export async function render(container) {
  container.innerHTML = skeleton(4);
  const data = await api.dashboard();
  const r = data.recipients;
  const smtp = data.smtp;

  const activeBanner = data.campaigns.active ? `
    <div class="campaign-banner">
      <div class="meta">
        <strong>${escapeHtml(data.campaigns.active_name || 'Active campaign')}</strong>
        <small>${data.campaigns.active_counters ? data.campaigns.active_counters.processed : 0} of ${data.campaigns.active_counters ? data.campaigns.active_counters.total : 0} processed · ${data.campaigns.active_counters ? data.campaigns.active_counters.progress : 0}%</small>
      </div>
      <div class="banner-actions">
        <button class="btn btn-secondary btn-sm" data-goto-campaign>${icon('activity', 15)} View campaign</button>
      </div>
    </div>` : '';

  const activity = data.recent_activity.length ? `
    <div class="activity-list">
      ${data.recent_activity.map((item) => `
        <div class="activity-item">
          <div class="grow">
            <strong>${escapeHtml(item.company_name || item.email)}</strong>
            <span>${escapeHtml(item.email)} · ${formatDate(item.timestamp)}</span>
          </div>
          ${statusBadge(item.status)}
        </div>`).join('')}
    </div>` : emptyState({ title: 'No activity yet', message: 'Sending history will appear here once you run a campaign.', iconName: 'activity' });

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Overview</h2>
        <p>Live status of your recipients, campaigns and SMTP connection.</p>
      </div>
    </div>

    ${activeBanner}

    <div class="grid grid-4 card-list" style="margin-bottom:20px;">
      ${statCard({ label: 'Total recipients', value: r.total, iconName: 'users' })}
      ${statCard({ label: 'Pending', value: r.pending, iconName: 'clock' })}
      ${statCard({ label: 'Submitted', value: r.sent, iconName: 'check-circle-2' })}
      ${statCard({ label: 'Failed attempts', value: r.failed, iconName: 'alert-circle' })}
    </div>

    <div class="grid grid-2" style="align-items:start;">
      <div class="card">
        <div class="card-head"><h3>Quick actions</h3></div>
        <div class="quick-actions">
          <button class="quick-action" data-q="new-campaign"><span class="stat-icon">${icon('send', 17)}</span> New Campaign</button>
          <button class="quick-action" data-q="add-recipient"><span class="stat-icon">${icon('user-plus', 17)}</span> Add Recipient</button>
          <button class="quick-action" data-q="import"><span class="stat-icon">${icon('upload', 17)}</span> Import Recipients</button>
          <button class="quick-action" data-q="editor"><span class="stat-icon">${icon('code', 17)}</span> Edit Email Template</button>
          <button class="quick-action" data-q="settings"><span class="stat-icon">${icon('settings', 17)}</span> Manage Settings</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>SMTP connection</h3>${smtp.configured ? '<span class="badge badge-sent"><span class="badge-dot"></span>Ready</span>' : '<span class="badge badge-failed"><span class="badge-dot"></span>Setup needed</span>'}</div>
        <div class="kv"><span>Sender</span><span>${escapeHtml(smtp.sender_name || '—')}</span></div>
        <div class="kv"><span>Email</span><span>${escapeHtml(smtp.sender_email || '—')}</span></div>
        <div class="kv"><span>Host</span><span>${escapeHtml(smtp.host || '—')}</span></div>
        <div class="kv"><span>Port</span><span>${escapeHtml(String(smtp.port || '—'))}</span></div>
        <div class="kv"><span>Send worker</span><span>${smtp.worker_available ? 'Running' : 'Not running'}</span></div>
        <div class="kv"><span>App Password</span><span>${smtp.has_password ? 'Configured (worker)' : 'Not set'}</span></div>
        ${smtp.worker_available ? '' : `<div class="notice notice-warning" style="margin-top:12px;">${icon('triangle-alert', 16)}
          <span>Emails are sent by the local worker. Start it with <code>python worker/main.py</code> to send campaigns.</span></div>`}
        <div style="margin-top:14px;"><button class="btn btn-secondary btn-block" data-goto-settings>${icon('settings-2', 15)} Open Settings</button></div>
      </div>
    </div>

    <div class="card" style="margin-top:20px;">
      <div class="card-head"><h3>Recent sending activity</h3>
        <button class="btn btn-ghost btn-sm" data-goto-history>View all</button></div>
      ${activity}
    </div>
  `;

  refreshIcons(container);

  container.querySelector('[data-goto-settings]')?.addEventListener('click', () => navigate('settings'));
  container.querySelector('[data-goto-history]')?.addEventListener('click', () => navigate('history'));
  container.querySelector('[data-goto-campaign]')?.addEventListener('click', () => navigate('campaigns'));
  container.querySelector('[data-q="new-campaign"]').addEventListener('click', () => navigate('campaigns', ['new']));
  container.querySelector('[data-q="add-recipient"]').addEventListener('click', () => navigate('recipients', ['new']));
  container.querySelector('[data-q="import"]').addEventListener('click', () => navigate('recipients', ['import']));
  container.querySelector('[data-q="editor"]').addEventListener('click', () => navigate('editor'));
  container.querySelector('[data-q="settings"]').addEventListener('click', () => navigate('settings'));
}
