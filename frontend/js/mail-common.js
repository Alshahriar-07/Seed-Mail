// Seed Code Mail — shared UI for the Gmail workspace (Inbox and Sent)
//
// Both mailboxes are the same problem: fetch one page from Gmail, show it, page
// through it, open a message safely. They share this module so the two pages
// cannot drift apart in behaviour or in how they report a problem.
//
// Every state is explicit and truthful:
//   * `setup`       — the server is missing Google/Supabase configuration
//   * `disconnected`— this user has not connected a Gmail account
//   * `reauth`      — the grant was revoked or expired
//   * `loading` / `empty` / `error` / `list`

import { gmail, GmailError, isNotConfigured } from './lib/gmail.js';
import { buildEmailDocument, emailPlainText, formatBytes } from './lib/email-html.js';
import {
  escapeHtml, icon, formatDate, refreshIcons, skeleton, emptyState, toast, openModal, confirmDialog,
} from './ui.js';
import { navigate } from './app.js';

const PAGE_SIZE = 25;

// --- compose handoff --------------------------------------------------------
// The reader's "Reply" and the Inbox's "Compose" both need to fill the Compose
// page. A tiny in-memory handoff is enough (the pages are in one SPA session)
// and it keeps recipient addresses out of the URL.

let composePrefill = null;

export function setComposePrefill(draft) {
  composePrefill = draft || null;
}

export function takeComposePrefill() {
  const draft = composePrefill;
  composePrefill = null;
  return draft;
}

// --- setup / connection cards ----------------------------------------------

/**
 * Renders the server-configuration card. This is the honest answer when the
 * backend has no Google client or encryption key: the feature genuinely cannot
 * work, so the page names what must be configured rather than offering a button
 * that would fail.
 */
export function serverSetupCard(configuration) {
  const problems = (configuration?.problems || []).map(
    (problem) => `<li>${escapeHtml(problem)}</li>`,
  ).join('');

  return `
    <div class="card setup-card">
      <div class="card-head"><h3>${icon('settings-2', 16)} Gmail is not configured on the server yet</h3></div>
      <p>Reading and sending mail uses Google's official Gmail API with OAuth 2.0. That
      requires credentials that only an operator can create — they cannot be generated
      by the application, and no placeholder is used in their place.</p>
      ${problems ? `<div class="notice notice-warning">${icon('triangle-alert', 16)}<span>
        Missing server configuration:<ul class="setup-list">${problems}</ul></span></div>` : ''}
      <div class="section-title">Environment variables to set in Vercel</div>
      <ul class="setup-list">
        <li><code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> — from a Google Cloud
            OAuth 2.0 <em>Web application</em> client.</li>
        <li><code>GOOGLE_OAUTH_REDIRECT_URI</code> — must exactly match an Authorised redirect URI
            on that client, e.g. <code>https://mrseedmail.vercel.app/api/gmail/callback</code>.</li>
        <li><code>GMAIL_TOKEN_ENCRYPTION_KEY</code> — a random 32-byte value used to encrypt stored
            refresh tokens (<code>openssl rand -base64 32</code>).</li>
        <li><code>SUPABASE_URL</code>, <code>SUPABASE_PUBLISHABLE_KEY</code>,
            <code>SUPABASE_SERVICE_ROLE_KEY</code> — the service-role key is server-only.</li>
      </ul>
      <div class="section-title">Then</div>
      <ol class="setup-list">
        <li>Enable the <strong>Gmail API</strong> in that Google Cloud project.</li>
        <li>Apply migration <code>supabase/migrations/0004_gmail.sql</code>.</li>
        <li>Redeploy — environment changes do not reach an existing deployment.</li>
      </ol>
      <p class="hint">See README → “Gmail account connection” for the full setup checklist.</p>
    </div>`;
}

/** The "connect your Gmail account" card, with a working button. */
export function connectCard({ title = 'Connect your Gmail account', message = '' } = {}) {
  return `
    <div class="card setup-card">
      <div class="card-head"><h3>${icon('mail-plus', 16)} ${escapeHtml(title)}</h3></div>
      <p>${escapeHtml(message || 'Seed Code Mail reads and sends mail through your own Gmail account using Google\'s official API. Your password is never shared, and Seed Code Mail never stores it.')}</p>
      <div class="notice">${icon('shield', 16)}<span>You will be sent to Google to approve access. Only these permissions are requested:
        read your mail, send mail, change read/unread state, and save drafts. Message contents are read on
        demand and are not copied into this application's database; the stored authorization is encrypted and
        cannot be read by the browser. Disconnecting removes it. See the
        <a href="#/privacy" data-legal="privacy">Privacy Policy</a> for exactly which Gmail data is accessed.</span></div>
      <button class="btn btn-primary" id="gmail-connect">${icon('link', 16)} Connect Gmail</button>
      <div id="gmail-connect-error" class="notice notice-error" hidden></div>
    </div>`;
}

/** Shows the reconnect banner (grant revoked or expired). */
export function reauthCard(lastError) {
  return `
    <div class="card setup-card">
      <div class="card-head"><h3>${icon('alert-circle', 16)} Gmail access needs to be authorized again</h3></div>
      <p>${escapeHtml(lastError || 'Google no longer accepts the stored authorization — it was revoked, or it expired.')}</p>
      <p class="hint">Your campaigns, recipients and templates are unaffected. Reconnecting only
      restores access to the mailbox.</p>
      <button class="btn btn-primary" id="gmail-connect">${icon('refresh-cw', 16)} Reconnect Gmail</button>
      <div id="gmail-connect-error" class="notice notice-error" hidden></div>
    </div>`;
}

/**
 * Asks the backend for a Google consent URL and navigates to it.
 * Shared by the workspace cards and the Profile page's "reconnect" action, so
 * there is exactly one implementation of starting the flow.
 */
export async function startConnect() {
  const url = await gmail.connectUrl();
  // A full navigation, not a fetch: Google must set its own cookies on its own
  // origin, and the consent screen is not embeddable.
  window.location.assign(url);
}

/** Wires the Connect button in either card, with an inline error slot. */
export function bindConnect(container, { onError } = {}) {
  const button = container.querySelector('#gmail-connect');
  if (!button) return;
  button.addEventListener('click', async () => {
    const box = container.querySelector('#gmail-connect-error');
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Opening Google';
    try {
      await startConnect();
    } catch (error) {
      button.disabled = false;
      button.innerHTML = original;
      refreshIcons(button);
      if (box) {
        box.hidden = false;
        box.innerHTML = `${icon('alert-circle', 16)}<span>${escapeHtml(error.message)}</span>`;
        refreshIcons(box);
      }
      if (onError) onError(error);
    }
  });
}

/** Renders the right card for a status payload. Returns true if it handled it. */
export function renderConnectionState(container, status) {
  if (!status?.configured && status?.configuration && !status.configuration.gmail_configured) {
    container.innerHTML = serverSetupCard(status.configuration);
    return 'setup';
  }
  const connection = status?.connection;
  if (!connection || !connection.connected) {
    if (connection?.needs_reauth) {
      container.innerHTML = reauthCard(connection.last_error);
      return 'reauth';
    }
    container.innerHTML = connectCard({});
    return 'disconnected';
  }
  return '';
}

/** A one-line mailbox status strip shown above a mailbox list. */
export function mailboxStatusStrip(connection) {
  if (!connection) return '';
  return `
    <div class="mailbox-strip">
      <span class="status-led ${connection.connected ? 'is-ok' : 'is-off'}"></span>
      <span>${escapeHtml(connection.email || 'Gmail account')}</span>
      <span class="cell-muted">·</span>
      <span class="cell-muted">mailbox in Gmail</span>
      <div class="grow"></div>
      <button class="btn btn-ghost btn-sm" id="mailbox-manage">${icon('user-cog', 15)} Manage connection</button>
    </div>`;
}

// --- mailbox list -----------------------------------------------------------

function addressLine(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map((entry) => entry.name ? `${entry.name} <${entry.email}>` : entry.email).join(', ');
}

function messageRow(message, { mailbox }) {
  const subject = message.subject || '(no subject)';
  const who = mailbox === 'sent'
    ? addressLine(message.to) || '(no recipient)'
    : (message.from?.name || message.from?.email || '(unknown sender)');
  const when = message.internal_date ? formatDate(message.internal_date) : (message.date || '');
  return `
    <li class="mail-row ${message.unread ? 'is-unread' : ''}" data-id="${escapeHtml(message.id)}">
      <button class="mail-open" data-open="${escapeHtml(message.id)}"
        aria-label="Open message: ${escapeHtml(subject)}">
        <span class="mail-who">${escapeHtml(who)}</span>
        <span class="mail-subject">${escapeHtml(subject)}</span>
        <span class="mail-snippet cell-muted">${escapeHtml(message.snippet || '')}</span>
        <span class="mail-date cell-muted">${escapeHtml(when)}</span>
        ${message.unread ? '<span class="mail-unread-dot" title="Unread"></span>' : ''}
      </button>
    </li>`;
}

/** Renders a page of messages into `listEl`, keeping existing rows for paging. */
function appendMessages(listEl, messages, { mailbox, append }) {
  if (!append) listEl.innerHTML = '';
  messages.forEach((message) => {
    listEl.insertAdjacentHTML('beforeend', messageRow(message, { mailbox }));
  });
}

/**
 * The full mailbox experience: status strip, search, list, paging, and the
 * reader. `load` is `gmail.inbox` or `gmail.sent`.
 */
export async function renderMailbox(container, {
  mailbox,
  load,
  emptyTitle,
  emptyMessage,
  iconName,
}) {
  container.innerHTML = `
    <div class="page-head">
      <div>
        <h2>${mailbox === 'sent' ? 'Sent' : 'Inbox'}</h2>
        <p>${mailbox === 'sent'
          ? 'Messages Gmail accepted for delivery from your connected account.'
          : 'Your real Gmail inbox, read through the Gmail API.'}</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-ghost" id="mail-refresh">${icon('refresh-cw', 16)} Refresh</button>
        <button class="btn btn-secondary" id="mail-compose">${icon('pen-square', 16)} Compose</button>
      </div>
    </div>
    <div id="mail-status"></div>
    <div id="mail-body">${skeleton(6)}</div>`;

  refreshIcons(container);

  const statusEl = container.querySelector('#mail-status');
  const bodyEl = container.querySelector('#mail-body');
  container.querySelector('#mail-compose').addEventListener('click', () => navigate('compose'));

  let status;
  try {
    status = await gmail.status();
  } catch (error) {
    bodyEl.innerHTML = `<div class="notice notice-error">${icon('alert-circle', 16)}<span>${escapeHtml(error.message)}</span></div>`;
    refreshIcons(bodyEl);
    return;
  }

  const state = renderConnectionState(bodyEl, status);
  if (state) {
    statusEl.innerHTML = '';
    if (state === 'setup' || state === 'disconnected' || state === 'reauth') {
      bindConnect(bodyEl);
    }
    refreshIcons(bodyEl);
    return;
  }

  const connection = status.connection;
  statusEl.innerHTML = mailboxStatusStrip(connection);
  refreshIcons(statusEl);
  statusEl.querySelector('#mailbox-manage')?.addEventListener('click', () => navigate('profile'));

  if (mailbox === 'sent' && connection.capabilities?.sent === false) {
    bodyEl.innerHTML = `<div class="notice notice-warning">${icon('triangle-alert', 16)}<span>The connected account did not grant read access to sent mail. Reconnect Gmail to enable this page.</span></div>`;
    refreshIcons(bodyEl);
    return;
  }

  // --- search + list --------------------------------------------------------

  bodyEl.innerHTML = `
    <div class="toolbar mail-toolbar">
      <div class="search-field">
        ${icon('search', 16)}
        <input class="input" id="mail-search" type="search" placeholder="${mailbox === 'sent' ? 'Search sent mail' : 'Search mail'}"
          aria-label="Search ${mailbox === 'sent' ? 'sent mail' : 'mail'}">
      </div>
      <button class="btn btn-secondary btn-sm" id="mail-search-go">Search</button>
      <button class="btn btn-ghost btn-sm" id="mail-search-clear">Clear</button>
    </div>
    <ul class="mail-list" id="mail-list" aria-live="polite"></ul>
    <div class="mail-more">
      <button class="btn btn-secondary" id="mail-more" hidden>${icon('chevron-down', 16)} Load more</button>
    </div>`;

  refreshIcons(bodyEl);

  const listEl = bodyEl.querySelector('#mail-list');
  const moreBtn = bodyEl.querySelector('#mail-more');
  let pageToken = '';
  let query = '';
  let loading = false;

  const showEmpty = () => {
    listEl.innerHTML = '';
    listEl.insertAdjacentHTML('beforeend', `<li class="mail-empty-slot">${emptyState({
      title: query ? 'No matching messages' : emptyTitle,
      message: query ? `Nothing in ${mailbox === 'sent' ? 'Sent' : 'the Inbox'} matches “${query}”.` : emptyMessage,
      iconName,
    })}</li>`);
    refreshIcons(listEl);
  };

  const fetchPage = async ({ append = false } = {}) => {
    if (loading) return;
    loading = true;
    moreBtn.disabled = true;
    moreBtn.innerHTML = '<span class="spinner"></span> Loading';
    try {
      const page = await load({ q: query, pageToken, max: PAGE_SIZE });
      pageToken = page.next_page_token || '';
      appendMessages(listEl, page.messages || [], { mailbox, append });
      if (!append && !(page.messages || []).length) showEmpty();
      moreBtn.hidden = !pageToken;
      refreshIcons(listEl);
    } catch (error) {
      moreBtn.hidden = true;
      const message = error instanceof GmailError ? error.message : String(error.message || error);
      if (isNotConfigured(error)) {
        bodyEl.innerHTML = serverSetupCard(error.configuration || status.configuration);
      } else if (error.code === 'gmail_reauth_required') {
        bodyEl.innerHTML = reauthCard(message);
        bindConnect(bodyEl);
      } else {
        if (!append) {
          listEl.innerHTML = '';
          listEl.insertAdjacentHTML('beforeend', `<li class="mail-empty-slot">
            <div class="notice notice-error">${icon('alert-circle', 16)}<span>${escapeHtml(message)}</span></div>
            <button class="btn btn-secondary" id="mail-retry">Try again</button></li>`);
          listEl.querySelector('#mail-retry')?.addEventListener('click', () => fetchPage({}));
        } else {
          toast(message, 'error');
        }
      }
      refreshIcons(bodyEl);
    } finally {
      loading = false;
      moreBtn.disabled = false;
      moreBtn.innerHTML = `${icon('chevron-down', 16)} Load more`;
      refreshIcons(moreBtn);
    }
  };

  bodyEl.querySelector('#mail-search-go').addEventListener('click', () => {
    query = bodyEl.querySelector('#mail-search').value.trim();
    pageToken = '';
    fetchPage({});
  });
  bodyEl.querySelector('#mail-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      query = event.target.value.trim();
      pageToken = '';
      fetchPage({});
    }
  });
  bodyEl.querySelector('#mail-search-clear').addEventListener('click', () => {
    bodyEl.querySelector('#mail-search').value = '';
    query = '';
    pageToken = '';
    fetchPage({});
  });
  moreBtn.addEventListener('click', () => fetchPage({ append: true }));
  container.querySelector('#mail-refresh').addEventListener('click', () => {
    pageToken = '';
    fetchPage({});
  });

  // Rows are rendered as buttons; one delegated listener keeps this cheap for
  // long lists and survives "load more".
  listEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open]');
    if (button) openReader(button.dataset.open, { mailbox, onChanged: () => fetchPage({}) });
  });

  await fetchPage({});
}

// --- reader -----------------------------------------------------------------

/**
 * Opens one message in a modal.
 *
 * The body is shown in `iframe sandbox=""` with remote content blocked, so a
 * message can neither run script nor report that it was opened. "Show images"
 * is an explicit, per-message choice by the user.
 */
export async function openReader(id, { mailbox = 'inbox', onChanged } = {}) {
  const modal = openModal({
    title: 'Loading message…',
    size: 'xl',
    body: skeleton(5),
    actions: [{ label: 'Close', variant: 'btn-secondary' }],
  });

  let message;
  try {
    ({ message } = await gmail.message(id));
  } catch (error) {
    modal.body.innerHTML = `<div class="notice notice-error">${icon('alert-circle', 16)}<span>${escapeHtml(error.message)}</span></div>`;
    refreshIcons(modal.body);
    return;
  }

  const title = modal.overlay.querySelector('.modal-header h3');
  if (title) title.textContent = message.subject || '(no subject)';

  const attachments = (message.attachments || []);
  const attachmentsHtml = attachments.length ? `
    <div class="attachment-list">
      ${attachments.map((file) => `
        <button class="attachment" data-attachment="${escapeHtml(file.attachment_id)}"
          data-filename="${escapeHtml(file.filename)}">
          ${icon('paperclip', 15)}
          <span class="attachment-name">${escapeHtml(file.filename)}</span>
          <span class="cell-muted">${escapeHtml(formatBytes(file.size))}</span>
        </button>`).join('')}
    </div>` : '';

  modal.body.innerHTML = `
    <div class="reader-meta">
      <div class="reader-row">
        <span class="reader-label">From</span>
        <span>${escapeHtml(message.from?.name ? `${message.from.name} <${message.from.email}>` : (message.from?.email || '—'))}</span>
      </div>
      <div class="reader-row">
        <span class="reader-label">To</span>
        <span>${escapeHtml(addressLine(message.to) || '—')}</span>
      </div>
      ${message.cc?.length ? `<div class="reader-row"><span class="reader-label">Cc</span>
        <span>${escapeHtml(addressLine(message.cc))}</span></div>` : ''}
      <div class="reader-row">
        <span class="reader-label">Date</span>
        <span>${escapeHtml(message.internal_date ? formatDate(message.internal_date) : message.date || '—')}</span>
      </div>
      <div class="reader-actions">
        <button class="btn btn-ghost btn-sm" id="reader-read-toggle">
          ${icon(message.unread ? 'mail-open' : 'mail', 15)} ${message.unread ? 'Mark as read' : 'Mark as unread'}
        </button>
        <button class="btn btn-ghost btn-sm" id="reader-images">${icon('image', 15)} Show images</button>
        <button class="btn btn-secondary btn-sm" id="reader-reply">${icon('reply', 15)} Reply</button>
      </div>
      ${attachmentsHtml}
    </div>
    <div class="reader-body">
      <iframe class="reader-frame" id="reader-frame" sandbox="" referrerpolicy="no-referrer"
        title="Message content"></iframe>
      <details class="reader-plain">
        <summary>Plain text</summary>
        <pre>${escapeHtml(emailPlainText(message.body || {}))}</pre>
      </details>
    </div>`;

  refreshIcons(modal.body);

  const frame = modal.body.querySelector('#reader-frame');
  let allowRemote = false;
  const paintFrame = () => {
    frame.setAttribute('srcdoc', buildEmailDocument({
      html: message.body?.html || '',
      text: message.body?.text || '',
      allowRemote,
    }));
  };
  paintFrame();

  // Opening a message marks it read in Gmail — only when the account actually
  // granted the modify scope, and never for a message already read.
  if (message.unread && mailbox === 'inbox') {
    gmail.setRead(message.id, true).then(() => {
      message.unread = false;
      const toggle = modal.body.querySelector('#reader-read-toggle');
      if (toggle) toggle.innerHTML = `${icon('mail', 15)} Mark as unread`;
      refreshIcons(modal.body);
      if (onChanged) onChanged();
    }).catch(() => {
      // Not fatal: the message is shown either way. The toggle still works if
      // the permission allows it, and reports if it does not.
    });
  }

  modal.body.querySelector('#reader-read-toggle').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const nextRead = Boolean(message.unread);
      await gmail.setRead(message.id, nextRead);
      message.unread = !nextRead;
      button.innerHTML = `${icon(message.unread ? 'mail-open' : 'mail', 15)} ${message.unread ? 'Mark as read' : 'Mark as unread'}`;
      refreshIcons(button);
      toast(nextRead ? 'Marked as read in Gmail.' : 'Marked as unread in Gmail.', 'success');
      if (onChanged) onChanged();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  modal.body.querySelector('#reader-images').addEventListener('click', async (event) => {
    const ok = await confirmDialog(
      'Load remote images from this message? The sender will be able to see that you opened it, along with your IP address.',
      { title: 'Show remote images', confirmLabel: 'Show images' },
    );
    if (!ok) return;
    allowRemote = true;
    paintFrame();
    event.currentTarget.disabled = true;
    event.currentTarget.innerHTML = `${icon('image', 15)} Images shown`;
    refreshIcons(event.currentTarget);
  });

  modal.body.querySelector('#reader-reply').addEventListener('click', () => {
    const subject = message.subject || '';
    setComposePrefill({
      to: message.from?.email || '',
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      text: `\n\n--- ${message.from?.email || ''} wrote on ${message.internal_date ? formatDate(message.internal_date) : message.date || ''} ---\n${
        emailPlainText(message.body || {}).split('\n').map((line) => `> ${line}`).join('\n')
      }`,
    });
    modal.close();
    navigate('compose');
  });

  modal.body.querySelectorAll('[data-attachment]').forEach((button) => {
    button.addEventListener('click', async () => {
      const original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> Downloading';
      try {
        const blob = await gmail.downloadAttachment({
          messageId: message.id,
          attachmentId: button.dataset.attachment,
          filename: button.dataset.filename,
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = button.dataset.filename || 'attachment';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        button.disabled = false;
        button.innerHTML = original;
        refreshIcons(button);
      }
    });
  });

  return modal;
}
