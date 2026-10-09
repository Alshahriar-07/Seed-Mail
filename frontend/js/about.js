// Seed Code Mail — About page
//
// Describes what the application actually does, and nothing it does not. The
// version comes from package.json at build time (see vite.config.js) rather than
// a hand-maintained constant, and the URLs are the real deployments.

import { api } from './api.js';
import { icon, escapeHtml, refreshIcons } from './ui.js';
import { supabaseConfigured } from './lib/supabase.js';
import { workerConfigured, workerIsLocal, workerBaseUrl } from './lib/worker.js';

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

const PRODUCTION_URL = 'https://mrseedmail.vercel.app/';
const BETA_URL = 'https://seedmail-beta.vercel.app/';

function capability({ iconName, title, body, state = '' }) {
  return `
    <li class="capability">
      <span class="capability-icon">${icon(iconName, 17)}</span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(body)}</p>
        ${state ? `<span class="capability-state">${escapeHtml(state)}</span>` : ''}
      </div>
    </li>`;
}

export async function render(container) {
  container.innerHTML = `
    <div class="page-head">
      <div>
        <h2>About Seed Code Mail</h2>
        <p>Version ${escapeHtml(String(APP_VERSION))} · a Gmail-connected email workspace and campaign manager.</p>
      </div>
    </div>

    <div class="grid grid-2" style="align-items:start;">
      <div class="card">
        <div class="card-head"><h3>${icon('mail', 16)} What it does</h3></div>
        <ul class="capability-list">
          ${capability({ iconName: 'inbox', title: 'Inbox', body: 'Reads your real Gmail inbox through the Gmail API, with search, paging, message content and attachment downloads. Nothing is copied into the application database.' })}
          ${capability({ iconName: 'pen-square', title: 'Compose Email', body: 'Writes and sends ordinary email from your connected Gmail account, with Cc/Bcc, HTML or plain text, template starting points, attachments, preview and multi-recipient confirmation.' })}
          ${capability({ iconName: 'send', title: 'Sent', body: 'Shows Gmail’s own Sent mailbox — the messages Gmail actually accepted — rather than treating a queued job as delivered.' })}
          ${capability({ iconName: 'layout-dashboard', title: 'Campaigns', body: 'Recipient lists, campaigns with a required per-campaign subject, real progress, pause/resume/cancel, bounded retries and a durable queue.' })}
          ${capability({ iconName: 'users', title: 'Recipients', body: 'Add, edit, import (CSV/JSON) and export recipients, with duplicate detection and per-recipient delivery status.' })}
          ${capability({ iconName: 'layout-template', title: 'Email Templates & Editor', body: 'Custom HTML templates with a variable guide, stored in this browser and snapshotted onto the campaign row when queued, so the worker can send with the page closed.' })}
          ${capability({ iconName: 'history', title: 'Email History', body: 'An append-only, per-recipient submission log kept separately from the Gmail mailbox. Deleting a history record never deletes a Gmail message.' })}
          ${capability({ iconName: 'user-round', title: 'Account', body: 'Supabase Auth sign-up, sign-in, email confirmation, password reset, display name, email change and Gmail connection management.' })}
        </ul>
      </div>

      <div>
        <div class="card">
          <div class="card-head"><h3>${icon('server', 16)} Runtime status</h3></div>
          <div id="about-runtime">${'<div class="loading-inline"><span class="spinner"></span><span>Checking</span></div>'}</div>
        </div>

        <div class="card" style="margin-top:20px;">
          <div class="card-head"><h3>${icon('git-branch', 16)} Deployments</h3></div>
          <div class="kv"><span>Production</span><span><a href="${PRODUCTION_URL}" rel="noreferrer noopener" target="_blank">mrseedmail.vercel.app</a></span></div>
          <div class="kv"><span>Beta</span><span><a href="${BETA_URL}" rel="noreferrer noopener" target="_blank">seedmail-beta.vercel.app</a></span></div>
          <div class="kv"><span>Version</span><span>${escapeHtml(String(APP_VERSION))}</span></div>
        </div>

        <div class="card" style="margin-top:20px;">
          <div class="card-head"><h3>${icon('shield', 16)} Security & privacy</h3></div>
          <ul class="setup-list">
            <li>Mailbox access uses Google OAuth 2.0 with the narrowest scopes the implemented features need.</li>
            <li>Gmail authorizations are encrypted server-side and are never readable by the browser.</li>
            <li>Password handling is entirely Supabase Auth — no password is stored by this application.</li>
            <li>Email HTML is rendered in a script-free, sandboxed frame with remote images blocked.</li>
            <li>Every user-owned table enforces row level security; ownership always comes from the verified session.</li>
          </ul>
        </div>

        <div class="card" style="margin-top:20px;">
          <div class="card-head"><h3>${icon('scale', 16)} Legal &amp; policies</h3></div>
          <ul class="setup-list">
            <li><a href="#/privacy" data-legal="privacy">Privacy Policy</a> — what is collected, which Gmail data is accessed, where it is stored and how to delete it.</li>
            <li><a href="#/terms" data-legal="terms">Terms of Service</a> — account responsibilities, acceptable sending practices and service limits.</li>
          </ul>
        </div>

        <div class="card" style="margin-top:20px;">
          <div class="card-head"><h3>${icon('info', 16)} Not claimed</h3></div>
          <ul class="setup-list">
            <li>Submitting a message is not proof of inbox delivery — only that the provider accepted it.</li>
            <li>Campaign delivery needs a running send worker; the browser cannot send bulk mail on its own.</li>
            <li>Gmail sending quotas are enforced by Google and can pause a large campaign.</li>
            <li>Email templates live in this browser only; they do not sync across devices.</li>
          </ul>
        </div>
      </div>
    </div>`;

  refreshIcons(container);

  const runtime = container.querySelector('#about-runtime');
  const rows = [];

  rows.push(['Supabase (auth & database)', supabaseConfigured ? 'Configured' : 'Not configured']);
  try {
    const health = await api.health();
    rows[0] = ['Supabase (auth & database)', `Reachable · app ${health.version}`];
  } catch (_) {
    rows[0] = ['Supabase (auth & database)', 'Unreachable'];
  }

  rows.push([
    'Gmail API backend',
    'Checking…',
  ]);
  try {
    const response = await fetch('/api/gmail/status', { headers: { Accept: 'application/json' } });
    if (response.status === 401) {
      rows[1][1] = 'Deployed (requires sign-in)';
    } else if (response.ok) {
      const payload = await response.json();
      rows[1][1] = payload?.configured ? 'Deployed and configured' : 'Deployed, server configuration incomplete';
    } else {
      rows[1][1] = `Deployed (HTTP ${response.status})`;
    }
  } catch (_) {
    rows[1][1] = 'Not reachable from this deployment';
  }

  rows.push([
    'Campaign send worker',
    workerConfigured()
      ? (workerIsLocal() ? 'Configured for this machine' : `Configured · ${workerBaseUrl()}`)
      : 'Not configured for this deployment',
  ]);

  runtime.innerHTML = rows.map(([label, value]) => `
    <div class="kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`).join('');
  refreshIcons(runtime);
}
