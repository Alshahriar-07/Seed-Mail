// Seed Code Mail — Profile page
//
// Account details from Supabase Auth, the application profile row, the Gmail
// connection, and the account/security actions.
//
// Two things this page is careful about:
//   * no credential or token is ever rendered — not the Gmail refresh token, not
//     the (encrypted) payload, not an App Password, not a service-role key;
//   * disconnecting Gmail is presented as exactly what it is: it removes mailbox
//     access only, and leaves the account, campaigns, recipients and templates
//     untouched.

import { api } from './api.js';
import {
  currentUser, displayName, signOut, sendPasswordReset, updateDisplayName,
  requestEmailChange, accountCreatedAt,
} from './auth.js';
import { gmail, isNotConfigured } from './lib/gmail.js';
import {
  escapeHtml, icon, formatDate, refreshIcons, toast, spinner, confirmDialog,
} from './ui.js';
import { refreshTopbar } from './app.js';
import { bindConnect, connectCard, reauthCard, serverSetupCard } from './mail-common.js';

const SCOPE_LABELS = {
  'https://www.googleapis.com/auth/gmail.readonly': 'Read your mail (Inbox and Sent)',
  'https://www.googleapis.com/auth/gmail.send': 'Send email on your behalf',
  'https://www.googleapis.com/auth/gmail.modify': 'Change read/unread state',
  'https://www.googleapis.com/auth/gmail.compose': 'Create and send drafts',
};

/** Reads and clears the `?gmail=…` flag the OAuth callback redirects with. */
function consumeGmailFlag() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (_) {
    return null;
  }
  const ok = params.get('gmail');
  const error = params.get('gmail_error');
  if (!ok && !error) return null;

  params.delete('gmail');
  params.delete('gmail_error');
  const query = params.toString();
  window.history.replaceState(
    {},
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
  );
  return { ok, error };
}

const FLAG_MESSAGES = {
  denied: 'You cancelled the Google authorization, so no account was connected.',
  state: 'The authorization response did not match this browser session. Nothing was connected.',
  no_refresh_token: 'Google did not return a long-lived token, so the connection was not stored. Remove Seed Code Mail from your Google account permissions and try again.',
  failed: 'The Gmail connection could not be completed.',
};

function gmailConnectionCard(status) {
  const connection = status?.connection;

  if (!status?.configured && status?.configuration && !status.configuration.gmail_configured) {
    return serverSetupCard(status.configuration);
  }
  if (!connection?.connected) {
    return connection?.needs_reauth
      ? reauthCard(connection.last_error)
      : connectCard({ title: 'No Gmail account connected' });
  }

  const granted = (connection.scopes || []);
  return `
    <div class="card">
      <div class="card-head">
        <h3>${icon('mail-check', 16)} Gmail connection</h3>
        <span class="badge badge-sent"><span class="badge-dot"></span>Connected</span>
      </div>
      <div class="kv"><span>Connected address</span><span>${escapeHtml(connection.email || '—')}</span></div>
      <div class="kv"><span>Connected</span><span>${escapeHtml(formatDate(connection.connected_at))}</span></div>
      <div class="kv"><span>Mailbox storage</span><span>Gmail (messages are not copied here)</span></div>

      <div class="section-title">Granted permissions</div>
      <ul class="scope-list">
        ${granted.length
          ? granted.map((scope) => `<li>${icon('check', 14)} ${escapeHtml(SCOPE_LABELS[scope] || scope)}</li>`).join('')
          : '<li>Google did not report the granted permissions.</li>'}
      </ul>
      ${(connection.missing_scopes || []).length ? `
        <div class="notice notice-warning">${icon('triangle-warning', 16)}<span>
          Some optional permissions were not granted, so a few features are unavailable:
          <ul class="setup-list">${connection.missing_scopes.map((scope) => `<li>${escapeHtml(SCOPE_LABELS[scope] || scope)}</li>`).join('')}</ul>
          Reconnect to grant them.
        </span></div>` : ''}

      <div class="profile-actions">
        <button class="btn btn-secondary" id="gmail-reconnect">${icon('refresh-cw', 16)} Reconnect / grant more</button>
        <button class="btn btn-danger" id="gmail-disconnect">${icon('unlink', 16)} Disconnect Gmail</button>
      </div>
      <p class="hint">Disconnecting removes the stored authorization from Seed Code Mail and revokes it at
      Google. Your account, campaigns, recipients, templates and history are not affected.</p>
    </div>`;
}

export async function render(container) {
  const user = currentUser();
  const flag = consumeGmailFlag();

  container.innerHTML = `
    <div class="page-head">
      <div><h2>Profile</h2><p>Your account, connected mailbox and security settings.</p></div>
    </div>
    <div id="profile-flag"></div>
    <div class="grid grid-2" style="align-items:start;">
      <div>
        <div class="card">
          <div class="card-head"><h3>${icon('user-round', 16)} Account</h3></div>
          <div class="kv"><span>Email address</span><span>${escapeHtml(user?.email || '—')}</span></div>
          <div class="kv"><span>Account created</span><span>${escapeHtml(accountCreatedAt() ? formatDate(accountCreatedAt()) : 'Not reported')}</span></div>
          <div class="kv"><span>User id</span><span class="mono cell-muted">${escapeHtml(user?.id || '—')}</span></div>
          <div class="field" style="margin-top:14px;">
            <label for="p-name">Display name</label>
            <input class="input" id="p-name" value="${escapeHtml(displayName())}" maxlength="120">
            <div class="hint">Shown in the topbar and used as {{SENDER_NAME}} when you have not set one in Settings.</div>
          </div>
          <div class="profile-actions">
            <button class="btn btn-primary" id="p-save-name">${icon('save', 16)} Save display name</button>
            <button class="btn btn-ghost" id="p-signout">${icon('log-out', 16)} Sign out</button>
          </div>
        </div>

        <div class="card" style="margin-top:20px;">
          <div class="card-head"><h3>${icon('shield', 16)} Security</h3></div>
          <div class="field">
            <label for="p-new-email">Change email address</label>
            <input class="input" id="p-new-email" type="email" placeholder="new-address@example.com" autocomplete="email">
            <div class="hint">Supabase emails a confirmation link to the new address; the change applies
            only after it is confirmed.</div>
          </div>
          <div class="profile-actions">
            <button class="btn btn-secondary" id="p-change-email">${icon('mail', 16)} Request email change</button>
            <button class="btn btn-ghost" id="p-reset">${icon('key-round', 16)} Send password reset link</button>
          </div>
        </div>
      </div>

      <div>
        <div id="gmail-card">${spinner('Checking Gmail connection')}</div>

        <div class="card" style="margin-top:20px;">
          <div class="card-head"><h3>${icon('database', 16)} What is stored where</h3></div>
          <div class="kv"><span>Mailbox messages</span><span>Gmail only</span></div>
          <div class="kv"><span>Recipients, campaigns, history, settings</span><span>Your Supabase account (RLS)</span></div>
          <div class="kv"><span>Email templates</span><span>This browser (IndexedDB)</span></div>
          <div class="kv"><span>Gmail authorization</span><span>Encrypted, server-side only</span></div>
          <p class="hint">Seed Code Mail never asks for your Gmail password, and never receives one. The
          authorization you grant at Google can be revoked here or from your Google account at any time.</p>
        </div>
      </div>
    </div>`;

  refreshIcons(container);

  // --- Gmail flag from the OAuth callback -----------------------------------

  const flagBox = container.querySelector('#profile-flag');
  if (flag?.ok === 'connected') {
    flagBox.innerHTML = `<div class="notice notice-success">${icon('check-circle-2', 16)}<span>Gmail connected. The Inbox, Compose and Sent pages are ready.</span></div>`;
  } else if (flag?.error) {
    flagBox.innerHTML = `<div class="notice notice-error">${icon('alert-circle', 16)}<span>${escapeHtml(FLAG_MESSAGES[flag.error] || FLAG_MESSAGES.failed)}</span></div>`;
  }
  refreshIcons(flagBox);

  // --- account actions ------------------------------------------------------

  const setBusy = (selector, busy, label) => {
    const button = container.querySelector(selector);
    if (!button) return;
    if (busy) {
      button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = spinner(label);
      refreshIcons(button);
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
  };

  container.querySelector('#p-save-name').addEventListener('click', async () => {
    const name = container.querySelector('#p-name').value;
    setBusy('#p-save-name', true, 'Saving');
    try {
      await api.saveProfile({ display_name: name });
      await updateDisplayName(name);
      await refreshTopbar();
      toast('Display name updated.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy('#p-save-name', false);
    }
  });

  container.querySelector('#p-change-email').addEventListener('click', async () => {
    const next = container.querySelector('#p-new-email').value.trim();
    if (!next) { toast('Enter the new email address first.', 'warning'); return; }
    const ok = await confirmDialog(
      `Request a change of your sign-in email to ${next}? Supabase will email a confirmation link.`,
      { title: 'Change email address', confirmLabel: 'Send confirmation' },
    );
    if (!ok) return;
    setBusy('#p-change-email', true, 'Requesting');
    try {
      await requestEmailChange(next);
      toast('Confirmation link sent. Your email changes once it is confirmed.', 'success');
      container.querySelector('#p-new-email').value = '';
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy('#p-change-email', false);
    }
  });

  container.querySelector('#p-reset').addEventListener('click', async () => {
    if (!user?.email) { toast('No email address is available for this session.', 'warning'); return; }
    setBusy('#p-reset', true, 'Sending');
    try {
      await sendPasswordReset(user.email);
      toast('Password reset link sent to your email.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy('#p-reset', false);
    }
  });

  container.querySelector('#p-signout').addEventListener('click', async () => {
    const ok = await confirmDialog('Sign out of Seed Code Mail?', { title: 'Sign out', confirmLabel: 'Sign out' });
    if (!ok) return;
    try {
      await signOut();
      toast('Signed out.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  // --- Gmail connection -----------------------------------------------------

  const gmailCard = container.querySelector('#gmail-card');
  let status = null;
  try {
    status = await gmail.status();
  } catch (error) {
    gmailCard.innerHTML = `<div class="notice notice-error">${icon('alert-circle', 16)}<span>${escapeHtml(error.message)}</span></div>`;
    refreshIcons(gmailCard);
    return;
  }

  const paint = () => {
    gmailCard.innerHTML = gmailConnectionCard(status);
    refreshIcons(gmailCard);
    bindConnect(gmailCard);
    const disconnect = gmailCard.querySelector('#gmail-disconnect');
    if (disconnect) disconnect.addEventListener('click', onDisconnect);
    const reconnect = gmailCard.querySelector('#gmail-reconnect');
    if (reconnect) reconnect.addEventListener('click', () => gmailCard.querySelector('#gmail-connect')?.click());
  };

  async function onDisconnect() {
    const ok = await confirmDialog(
      'Disconnect Gmail? Mailbox access is removed and the authorization is revoked at Google. Your account, campaigns, recipients and history are kept.',
      { title: 'Disconnect Gmail', confirmLabel: 'Disconnect', danger: true },
    );
    if (!ok) return;
    const button = gmailCard.querySelector('#gmail-disconnect');
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = spinner('Disconnecting');
    try {
      await gmail.disconnect();
      status = await gmail.status();
      paint();
      toast('Gmail disconnected.', 'success');
    } catch (error) {
      button.disabled = false;
      button.innerHTML = original;
      refreshIcons(button);
      if (isNotConfigured(error)) {
        gmailCard.innerHTML = serverSetupCard(error.configuration || status?.configuration);
        refreshIcons(gmailCard);
      } else {
        toast(error.message, 'error');
      }
    }
  }

  paint();
}
