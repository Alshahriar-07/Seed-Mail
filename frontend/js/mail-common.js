// Seed Code Mail — shared UI for the Gmail workspace (Inbox and Sent)
//
// Both mailboxes are the same problem: fetch one page from Gmail, show it, page
// through it, and read one message. They share this module so the two pages
// cannot drift apart in behaviour or in how they report a problem.
//
// There are two layouts over one container:
//
//   * the **list** (`renderMailbox`) — toolbar, rows, paging;
//   * the **reading view** (`renderReader`) — one message, occupying the main
//     content area the way Gmail and Outlook do. There is no email-reading modal:
//     a modal forced the message into a nested scroll box, wasted screen width,
//     and made the browser's Back button do nothing. The reader is now a real
//     route (`#/inbox/<message-id>`), so Back returns to the list and a message
//     is linkable and survives a refresh.
//
// Every state is explicit and truthful:
//   * `setup`        — the server is missing Google/Supabase configuration
//   * `disconnected` — this user has not connected a Gmail account
//   * `reauth`       — the grant was revoked or expired
//   * `loading` / `empty` / `error` / `list`

import { gmail, GmailError, isNotConfigured } from './lib/gmail.js';
import {
  buildEmailDocument, dataUrlFromBase64, emailPlainText, formatBytes,
  hasRemoteImages, normaliseContentId,
} from './lib/email-html.js';
import {
  escapeHtml, icon, formatDate, formatListDate, refreshIcons, skeleton, emptyState, toast,
  confirmDialog,
} from './ui.js';
import { avatarMarkup, refreshAvatars } from './lib/avatar.js';
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

// --- search memory ----------------------------------------------------------
// Reading a message is a separate route, so the list is rendered again when the
// user comes back. The search query is remembered per mailbox, otherwise opening
// one message would silently discard what the user had searched for — the
// opposite of "preserve the inbox search when returning from an opened message".

const lastQuery = { inbox: '', sent: '' };

// The message the user opened last, per mailbox.
//
// The reader is its own route, so no row can be "selected" while a message is on
// screen. What this does provide is the thing a user actually wants from a
// selected-row highlight: on returning to the list, the message they just read is
// marked, so they can see where they were without hunting for it.
const lastOpened = { inbox: '', sent: '' };

function mailboxLabel(mailbox) {
  return mailbox === 'sent' ? 'Sent' : 'Inbox';
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

/** Renders the right card for a status payload. Returns the state it handled. */
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

function errorNotice(message, { retryId = '' } = {}) {
  return `
    <div class="notice notice-error">${icon('alert-circle', 16)}<span>${escapeHtml(message)}</span></div>
    ${retryId ? `<div class="reader-error-actions"><button class="btn btn-secondary" id="${retryId}">Try again</button></div>` : ''}`;
}

// --- mailbox list -----------------------------------------------------------

function addressLine(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map((entry) => entry.name ? `${entry.name} <${entry.email}>` : entry.email).join(', ');
}

function first(list) {
  return Array.isArray(list) && list.length ? list[0] : { name: '', email: '' };
}

/**
 * One row of a mailbox list.
 *
 * Layout rules, and why they are enforced here rather than in CSS alone:
 *
 *   * the **subject** is the primary content of the row, so it owns a grid track
 *     of its own and never truncates to make room for the preview;
 *   * the **snippet** is secondary and yields to the subject;
 *   * Inbox shows the **sender**, Sent shows the **recipient** — never each
 *     other — with the address as secondary detail when a display name exists,
 *     and as the primary value when it does not;
 *   * the avatar is initials, not a picture: Gmail's API does not expose a
 *     sender's profile photo (see frontend/js/lib/avatar.js);
 *   * the date is short (`formatListDate`: time today, "Oct 9" this year) and
 *     keeps the full timestamp in its `title`.
 */
function messageRow(message, { mailbox }) {
  const subject = message.subject || '(no subject)';
  const snippet = String(message.snippet || '').replace(/\s+/g, ' ').trim();

  const person = mailbox === 'sent' ? first(message.to) : (message.from || { name: '', email: '' });
  const fallback = mailbox === 'sent' ? '(no recipient)' : '(unknown sender)';
  const name = person.name || person.email || fallback;
  // Secondary line: the address, but only when a display name already fills the
  // primary slot (otherwise the address *is* the primary value, shown once).
  const secondary = person.name ? String(person.email || '') : '';
  const more = mailbox === 'sent' && Array.isArray(message.to) && message.to.length > 1
    ? `+${message.to.length - 1}` : '';

  const when = message.internal_date ? formatListDate(message.internal_date) : (message.date || '');
  const fullWhen = message.internal_date ? formatDate(message.internal_date) : (message.date || '');
  const unread = Boolean(message.unread);
  const current = lastOpened[mailbox] === message.id;

  return `
    <li class="mail-row ${unread ? 'is-unread' : ''} ${current ? 'is-current' : ''}" data-id="${escapeHtml(message.id)}"${current ? ' aria-current="true"' : ''}>
      <button class="mail-open" data-open="${escapeHtml(message.id)}"
        aria-label="${escapeHtml(`${unread ? 'Unread. ' : ''}${mailbox === 'sent' ? 'To' : 'From'} ${name}. ${subject}. ${fullWhen}`)}">
        ${avatarMarkup({ name: person.name, email: person.email }, { size: 34, kind: 'sender', className: 'mail-avatar' })}
        <span class="mail-identity">
          <span class="mail-who" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          ${more ? `<span class="mail-more-count">${escapeHtml(more)}</span>` : ''}
          ${secondary ? `<span class="mail-addr" title="${escapeHtml(secondary)}">${escapeHtml(secondary)}</span>` : ''}
        </span>
        <span class="mail-preview">
          <span class="mail-subject ${message.subject ? '' : 'is-empty'}" title="${escapeHtml(subject)}">${escapeHtml(subject)}</span>
          ${snippet ? `<span class="mail-snippet" title="${escapeHtml(snippet)}">${escapeHtml(snippet)}</span>` : ''}
        </span>
        <span class="mail-date" title="${escapeHtml(fullWhen)}">${escapeHtml(when)}</span>
        <span class="mail-unread-dot"${unread ? '' : ' hidden'} aria-hidden="true"></span>
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
 * The mailbox experience: status strip, search, list and paging.
 *
 * Opening a message is a *navigation* (`#/<mailbox>/<id>`), not an overlay. The
 * router re-renders this function on the way back, and `lastQuery` restores the
 * search that was in effect.
 */
export async function renderMailbox(container, {
  mailbox,
  load,
  emptyTitle,
  emptyMessage,
  iconName,
}) {
  container.classList.remove('view-reader');
  const label = mailboxLabel(mailbox);

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h2>${label}</h2>
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
    bodyEl.innerHTML = errorNotice(error.message);
    refreshIcons(bodyEl);
    return;
  }

  const state = renderConnectionState(bodyEl, status);
  if (state) {
    statusEl.innerHTML = '';
    bindConnect(bodyEl);
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

  let query = lastQuery[mailbox] || '';

  bodyEl.innerHTML = `
    <div class="toolbar mail-toolbar">
      <div class="search-field">
        ${icon('search', 16)}
        <input class="input" id="mail-search" type="search" value="${escapeHtml(query)}"
          placeholder="${mailbox === 'sent' ? 'Search sent mail' : 'Search mail'}"
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
  let loading = false;

  const showEmpty = () => {
    listEl.innerHTML = '';
    listEl.insertAdjacentHTML('beforeend', `<li class="mail-empty-slot">${emptyState({
      title: query ? 'No matching messages' : emptyTitle,
      message: query ? `Nothing in ${label} matches “${query}”.` : emptyMessage,
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
      refreshAvatars(listEl);
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

  const applyQuery = (next) => {
    query = String(next || '').trim();
    lastQuery[mailbox] = query;
    pageToken = '';
    fetchPage({});
  };

  bodyEl.querySelector('#mail-search-go').addEventListener('click', () => {
    applyQuery(bodyEl.querySelector('#mail-search').value);
  });
  bodyEl.querySelector('#mail-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyQuery(event.target.value);
  });
  bodyEl.querySelector('#mail-search-clear').addEventListener('click', () => {
    bodyEl.querySelector('#mail-search').value = '';
    applyQuery('');
  });
  moreBtn.addEventListener('click', () => fetchPage({ append: true }));
  container.querySelector('#mail-refresh').addEventListener('click', () => {
    pageToken = '';
    fetchPage({});
  });

  // Rows are rendered as buttons; one delegated listener keeps this cheap for
  // long lists and survives "load more".
  //
  // The click *navigates* rather than opening an overlay: the route change is what
  // makes the browser's Back button return to this exact list, with the search
  // still applied.
  listEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open]');
    if (!button) return;
    // Remembered so the row is marked when the user comes back to this list.
    lastOpened[mailbox] = button.dataset.open;
    navigate(mailbox, [button.dataset.open]);
  });

  await fetchPage({});
}

// --- reading view -----------------------------------------------------------

const INLINE_IMAGE_LIMIT = 8;
const INLINE_IMAGE_MAX_BYTES = 2_000_000;

function blobToDataUrl(blob, mimeType) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      // `FileReader` reports the Blob's own type (`application/octet-stream` for
      // the download endpoint), and a `data:application/octet-stream` URL is not
      // rendered as an image. Re-label it with the MIME type the message part
      // actually declared.
      const corrected = mimeType && /^data:[^;]*;/.test(result)
        ? result.replace(/^data:[^;]*;/, `data:${mimeType};`)
        : result;
      resolve(corrected);
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Resolves the message's embedded images to renderable `data:` URLs.
 *
 * Each entry is keyed by both its `Content-ID` and its attachment id, so an HTML
 * part that refers to `cid:` by either form resolves. A part that already came
 * with its bytes is used directly; the rest are fetched through the authorized
 * attachment endpoint. A failure is skipped rather than thrown: a message must
 * still open without its images, and the reader marks the image it could not load.
 */
async function loadInlineImages(message) {
  const inline = Array.isArray(message?.inline_images) ? message.inline_images : [];
  const usable = inline
    .filter((part) => part && (part.attachment_id || part.data))
    .slice(0, INLINE_IMAGE_LIMIT);
  if (!usable.length) return {};

  const entries = await Promise.all(usable.map(async (part) => {
    if (part.data) {
      const direct = dataUrlFromBase64(part.mime_type, part.data);
      return direct ? [part, direct] : null;
    }
    if (Number(part.size || 0) > INLINE_IMAGE_MAX_BYTES) return null;
    try {
      const blob = await gmail.downloadAttachment({
        messageId: message.id,
        attachmentId: part.attachment_id,
        filename: part.filename || 'inline-image',
      });
      const dataUrl = await blobToDataUrl(blob, part.mime_type);
      return [part, dataUrl];
    } catch (_) {
      return null; // an unresolvable part leaves its placeholder, not a failure
    }
  }));

  const map = {};
  for (const entry of entries) {
    if (!entry) continue;
    const [part, dataUrl] = entry;
    if (!dataUrl) continue;
    if (part.content_id) map[normaliseContentId(part.content_id)] = dataUrl;
    if (part.attachment_id) map[normaliseContentId(part.attachment_id)] = dataUrl;
  }
  return map;
}

/**
 * Opens one message. Kept as a small function (rather than the reader itself) so
 * every caller goes through the same route.
 */
export function openReader(id, { mailbox = 'inbox' } = {}) {
  return navigate(mailbox, [id]);
}

function recipientBlock(message, { mailbox }) {
  const rows = [];
  if (mailbox === 'sent') {
    if (message.from?.email || message.from?.name) {
      rows.push(`<div class="reader-row"><span class="reader-label">From</span>
        <span>${escapeHtml(message.from?.name ? `${message.from.name} <${message.from.email}>` : message.from.email)}</span></div>`);
    }
  }
  rows.push(`<div class="reader-row"><span class="reader-label">To</span>
    <span>${escapeHtml(addressLine(message.to) || '—')}</span></div>`);
  if (message.cc?.length) {
    rows.push(`<div class="reader-row"><span class="reader-label">Cc</span>
      <span>${escapeHtml(addressLine(message.cc))}</span></div>`);
  }
  return rows.join('');
}

function attachmentsBlock(attachments) {
  if (!attachments.length) return '';
  return `
    <div class="reader-attachments">
      <div class="reader-attachments-title">${icon('paperclip', 15)} ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}</div>
      <div class="attachment-list">
        ${attachments.map((file) => `
          <button class="attachment" data-attachment="${escapeHtml(file.attachment_id)}"
            data-filename="${escapeHtml(file.filename)}">
            ${icon('paperclip', 15)}
            <span class="attachment-name">${escapeHtml(file.filename)}</span>
            <span class="cell-muted">${escapeHtml(formatBytes(file.size))}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

/**
 * The full-page reading view for one message.
 *
 * Rendered into the main content area — the sidebar, header and navigation stay
 * exactly where they are. The message body is shown in an `iframe sandbox=""`
 * with remote content blocked, so a message can neither run script nor report
 * that it was opened; "Show images" is an explicit, per-message choice.
 *
 * Returns a cleanup function the router calls when leaving the route.
 */
export async function renderReader(container, { mailbox = 'inbox', messageId } = {}) {
  const label = mailboxLabel(mailbox);
  container.classList.add('view-reader');

  container.innerHTML = `
    <div class="reader-view" id="reader-view">
      <div class="reader-toolbar">
        <button class="btn btn-ghost btn-sm reader-back" id="reader-back">
          ${icon('arrow-left', 16)} Back to ${label}
        </button>
        <div class="grow"></div>
        <span class="reader-status cell-muted" id="reader-status" aria-live="polite"></span>
      </div>
      <div id="reader-shell">${skeleton(5)}</div>
    </div>`;

  refreshIcons(container);
  container.querySelector('#reader-back').addEventListener('click', () => navigate(mailbox));

  const shell = container.querySelector('#reader-shell');
  const statusEl = container.querySelector('#reader-status');
  const cleanup = () => container.classList.remove('view-reader');

  let status;
  try {
    status = await gmail.status();
  } catch (error) {
    shell.innerHTML = errorNotice(error.message);
    refreshIcons(shell);
    return cleanup;
  }

  const state = renderConnectionState(shell, status);
  if (state) {
    bindConnect(shell);
    refreshIcons(shell);
    return cleanup;
  }

  const connection = status.connection;
  const canModify = connection.capabilities?.modify === true;
  const canSend = connection.capabilities?.send !== false;

  let message;
  try {
    ({ message } = await gmail.message(messageId));
  } catch (error) {
    shell.innerHTML = errorNotice(error.message, { retryId: 'reader-retry' });
    shell.querySelector('#reader-retry')?.addEventListener('click', () => renderReader(container, { mailbox, messageId }));
    refreshIcons(shell);
    return cleanup;
  }

  const isSent = mailbox === 'sent';
  const person = isSent ? first(message.to) : (message.from || { name: '', email: '' });
  const subject = message.subject || '(no subject)';
  const remoteImages = hasRemoteImages(message.body?.html || '');
  const inlineImages = await loadInlineImages(message);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  const dateIso = message.internal_date || message.date || '';
  const dateLabel = message.internal_date ? formatDate(message.internal_date) : (message.date || '—');

  shell.innerHTML = `
    <article class="card reader-card">
      <header class="reader-head">
        ${avatarMarkup({ name: person.name, email: person.email }, { size: 46, kind: 'sender' })}
        <div class="reader-head-main">
          <h1 class="reader-subject" id="reader-subject">${escapeHtml(subject)}</h1>
          <div class="reader-head-line">
            <span class="reader-from">${escapeHtml(person.name || person.email || '(unknown sender)')}</span>
            ${person.name && person.email ? `<span class="reader-from-addr">&lt;${escapeHtml(person.email)}&gt;</span>` : ''}
          </div>
          <div class="reader-recipients" id="reader-recipients"></div>
        </div>
        <time class="reader-date" datetime="${escapeHtml(dateIso)}" title="${escapeHtml(dateLabel)}">${escapeHtml(formatListDate(dateIso) || dateLabel)}</time>
      </header>

      <div class="reader-actions">
        ${canSend ? `<button class="btn btn-secondary btn-sm" id="reader-reply">${icon('reply', 15)} Reply</button>
        <button class="btn btn-ghost btn-sm" id="reader-forward">${icon('forward', 15)} Forward</button>` : ''}
        ${remoteImages ? `<button class="btn btn-ghost btn-sm" id="reader-images">${icon('image', 15)} Show images</button>` : ''}
        ${canModify ? `<button class="btn btn-ghost btn-sm" id="reader-read-toggle">
          ${icon(message.unread ? 'mail-open' : 'mail', 15)} ${message.unread ? 'Mark as read' : 'Mark as unread'}
        </button>
        <button class="btn btn-ghost btn-sm" id="reader-archive">${icon('archive', 15)} Archive</button>
        <button class="btn btn-ghost btn-sm danger" id="reader-delete">${icon('trash-2', 15)} Delete</button>` : ''}
      </div>

      <div id="reader-banner"></div>

      <div class="reader-body">
        <!-- The sandbox token list omits allow-scripts, allow-forms,
             allow-same-origin and allow-top-navigation, so the message stays
             inert and cannot reach this application or its session.
             allow-popups (and allow-popups-to-escape-sandbox) is deliberate: it
             lets a link the user clicks open in a new tab - which is what makes a
             confirmation link usable - while the message still cannot run script,
             submit a form, or navigate this application away from itself. -->
        <iframe class="reader-frame" id="reader-frame"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerpolicy="no-referrer" title="Message content"></iframe>
      </div>

      <details class="reader-plain">
        <summary>Plain text</summary>
        <pre>${escapeHtml(emailPlainText(message.body || {}))}</pre>
      </details>

      ${attachmentsBlock(attachments)}
    </article>`;

  shell.querySelector('#reader-recipients').innerHTML = recipientBlock(message, { mailbox });
  refreshIcons(shell);
  refreshAvatars(shell);

  // --- body ------------------------------------------------------------------

  const frame = shell.querySelector('#reader-frame');
  const banner = shell.querySelector('#reader-banner');
  let allowRemote = false;

  const paintFrame = () => {
    frame.setAttribute('srcdoc', buildEmailDocument({
      html: message.body?.html || '',
      text: message.body?.text || '',
      allowRemote,
      inlineImages,
    }));
  };

  const paintBanner = () => {
    if (!remoteImages || allowRemote) {
      banner.innerHTML = '';
      return;
    }
    banner.innerHTML = `
      <div class="notice reader-image-notice">${icon('shield', 16)}<span>
        Images in this message are stored on the sender's server, so they stay blocked until you
        choose <strong>Show images</strong> — loading one would tell the sender that you opened the
        message, and from where.</span></div>`;
    refreshIcons(banner);
  };

  paintFrame();
  paintBanner();

  // Opening a message marks it read in Gmail — only when the account granted the
  // modify scope, and never for a message that is already read.
  if (message.unread && !isSent && canModify) {
    gmail.setRead(message.id, true).then(() => {
      message.unread = false;
      const toggle = shell.querySelector('#reader-read-toggle');
      if (toggle) {
        toggle.innerHTML = `${icon('mail', 15)} Mark as unread`;
        refreshIcons(toggle);
      }
    }).catch(() => {
      // Not fatal: the message is shown either way, and the toggle still works if
      // the permission allows it and reports it if not.
    });
  }

  const setBusy = (selector, busy, label_) => {
    const button = shell.querySelector(selector);
    if (!button) return null;
    if (busy) {
      button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span> ${escapeHtml(label_)}`;
      refreshIcons(button);
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
    return button;
  };

  shell.querySelector('#reader-read-toggle')?.addEventListener('click', async () => {
    const nextRead = Boolean(message.unread);
    const button = setBusy('#reader-read-toggle', true, nextRead ? 'Marking' : 'Updating');
    try {
      await gmail.setRead(message.id, nextRead);
      message.unread = !nextRead;
      delete button.dataset.label;
      button.innerHTML = `${icon(message.unread ? 'mail-open' : 'mail', 15)} ${message.unread ? 'Mark as read' : 'Mark as unread'}`;
      refreshIcons(button);
      toast(nextRead ? 'Marked as read in Gmail.' : 'Marked as unread in Gmail.', 'success');
    } catch (error) {
      setBusy('#reader-read-toggle', false);
      toast(error.message, 'error');
    }
  });

  shell.querySelector('#reader-archive')?.addEventListener('click', async () => {
    setBusy('#reader-archive', true, 'Archiving');
    try {
      await gmail.archive(message.id);
      toast('Archived. The message left the Inbox and stays in All Mail.', 'success');
      // Navigating back re-reads the list from Gmail, so the row is gone.
      navigate(mailbox);
    } catch (error) {
      setBusy('#reader-archive', false);
      toast(error.message, 'error');
    }
  });

  shell.querySelector('#reader-delete')?.addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Move this message to the Trash? Gmail keeps it for 30 days, so this is recoverable.',
      { title: 'Delete message', confirmLabel: 'Move to Trash', danger: true },
    );
    if (!ok) return;
    setBusy('#reader-delete', true, 'Deleting');
    try {
      await gmail.trash(message.id);
      toast('Moved to Trash in Gmail.', 'success');
      navigate(mailbox);
    } catch (error) {
      setBusy('#reader-delete', false);
      toast(error.message, 'error');
    }
  });

  shell.querySelector('#reader-images')?.addEventListener('click', async (event) => {
    const ok = await confirmDialog(
      'Load remote images from this message? The sender will be able to see that you opened it, along with your IP address.',
      { title: 'Show remote images', confirmLabel: 'Show images' },
    );
    if (!ok) return;
    allowRemote = true;
    paintFrame();
    paintBanner();
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = `${icon('image', 15)} Images shown`;
    refreshIcons(button);
    statusEl.textContent = 'Remote images loaded for this message.';
  });

  shell.querySelector('#reader-reply')?.addEventListener('click', () => {
    setComposePrefill({
      to: message.from?.email || '',
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      text: `\n\n--- ${message.from?.email || ''} wrote on ${message.internal_date ? formatDate(message.internal_date) : message.date || ''} ---\n${
        emailPlainText(message.body || {}).split('\n').map((line) => `> ${line}`).join('\n')
      }`,
    });
    navigate('compose');
  });

  shell.querySelector('#reader-forward')?.addEventListener('click', () => {
    setComposePrefill({
      to: '',
      subject: /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`,
      text: `\n\n---------- Forwarded message ----------\nFrom: ${person.name ? `${person.name} <${person.email}>` : person.email || ''}\nDate: ${dateLabel}\nSubject: ${subject}\n\n${
        emailPlainText(message.body || {})
      }`,
    });
    navigate('compose');
  });

  shell.querySelectorAll('[data-attachment]').forEach((button) => {
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

  return cleanup;
}
