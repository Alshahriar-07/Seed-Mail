// Seed Code Mail - shared UI helpers

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Icons are rendered by lucide, loaded as a UMD bundle in index.html.
//
// Two behaviours of lucide v1 that this code must not assume away:
//
//   1. `createIcons()` REPLACES the host element with an `<svg>`. It does not
//      nest the svg inside the `<i>`, so any selector written as `i > svg`, or
//      any CSS rule written as `.something i`, stops matching the moment the
//      library upgrades. It also COPIES the host's attributes onto the new svg
//      (including `class` and `data-size`), which is what makes a class-based
//      hook the durable way to style an icon.
//   2. `createIcons()` applies its own default size unless the element itself
//      carries width/height. Sizing therefore has to happen after the call, on
//      the resulting `<svg>`.
//
// `ui-icon` is that durable hook: it is on the `<i>` before replacement and on
// the `<svg>` afterwards, so one selector works in both states - including when
// the icon library fails to load at all and the empty `<i>` remains.

export function icon(name, size = 18) {
  return `<i class="ui-icon" data-lucide="${escapeHtml(name)}" data-size="${size}" aria-hidden="true"></i>`;
}

export function refreshIcons(root = document) {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons({ root, attrs: { 'stroke-width': 1.75 } });
  }
  // Runs whether or not lucide is available, so an unresolved `<i>` is never
  // stretched: the size is applied to whichever element carries the hook.
  root.querySelectorAll('svg.ui-icon, i.ui-icon, [data-lucide][data-size]').forEach((node) => {
    if (node.tagName && node.tagName.toLowerCase() !== 'svg') return;
    const size = node.dataset?.size || 18;
    node.setAttribute('width', size);
    node.setAttribute('height', size);
  });
}

// --- Dates -----------------------------------------------------------------

/**
 * Compact timestamp for dense lists (mailbox rows, campaign tables).
 *
 * `formatDate` prints a full date *and* time ("Oct 09, 2026, 02:14 PM"), which
 * is right for a message header but spends ~140px of a list row on information
 * that is usually redundant. Real mail clients show the time for today, the
 * day and month within the current year, and the date alone beyond it.
 *
 * @param {string} iso         ISO timestamp (Gmail's internalDate, normalized)
 * @param {Date}   [now]       injectable for tests
 */
export function formatListDate(iso, now = new Date()) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);

  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// --- Toasts ----------------------------------------------------------------

function toastHost() {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  return host;
}

export function toast(message, type = 'info', timeout = 4200) {
  const host = toastHost();
  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  const iconName = { success: 'check-circle-2', error: 'alert-circle', info: 'info', warning: 'triangle-alert' }[type] || 'info';
  node.innerHTML = `${icon(iconName, 18)}<span>${escapeHtml(message)}</span>`;
  host.appendChild(node);
  refreshIcons(node);

  const remove = () => {
    node.classList.add('toast-out');
    node.addEventListener('transitionend', () => node.remove(), { once: true });
  };
  const timer = setTimeout(remove, timeout);
  node.addEventListener('click', () => { clearTimeout(timer); remove(); });
  return node;
}

// --- Modals ----------------------------------------------------------------

export function openModal({ title, body, actions = [], size = 'md', onMount }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const actionHtml = actions.map((action, index) =>
    `<button class="btn ${action.variant || 'btn-secondary'}" data-action="${index}">${escapeHtml(action.label)}</button>`
  ).join('');

  overlay.innerHTML = `
    <div class="modal modal-${size}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-header">
        <h3>${escapeHtml(title)}</h3>
        <button class="icon-btn" data-close aria-label="Close">${icon('x', 18)}</button>
      </div>
      <div class="modal-body"></div>
      ${actionHtml ? `<div class="modal-footer">${actionHtml}</div>` : ''}
    </div>`;

  const bodyEl = overlay.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  function close() {
    overlay.classList.add('modal-closing');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    document.removeEventListener('keydown', onKey);
  }
  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  actions.forEach((action, index) => {
    overlay.querySelector(`[data-action="${index}"]`).addEventListener('click', async (event) => {
      if (action.onClick) {
        const result = await action.onClick({ close, event, overlay });
        if (result === false) return;
      }
      if (action.closeOnClick !== false) close();
    });
  });

  document.body.appendChild(overlay);
  refreshIcons(overlay);
  const focusTarget = overlay.querySelector('input, textarea, select, button:not([data-close])');
  if (focusTarget) setTimeout(() => focusTarget.focus(), 40);
  if (onMount) onMount({ overlay, close });
  return { overlay, close, body: bodyEl };
}

export function confirmDialog(message, { title = 'Please confirm', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      title,
      body: `<p class="modal-text">${escapeHtml(message)}</p>`,
      size: 'sm',
      actions: [
        { label: 'Cancel', variant: 'btn-secondary', onClick: () => { settled = true; resolve(false); } },
        {
          label: confirmLabel,
          variant: danger ? 'btn-danger' : 'btn-primary',
          onClick: () => { settled = true; resolve(true); },
        },
      ],
    });
    modal.overlay.addEventListener('transitionend', () => {
      if (!settled && !document.body.contains(modal.overlay)) { settled = true; resolve(false); }
    });
  });
}

// --- Small view helpers ----------------------------------------------------

export function skeleton(rows = 5) {
  return `<div class="skeleton-list">${Array.from({ length: rows })
    .map(() => '<div class="skeleton-row"><div class="skeleton sk-line"></div><div class="skeleton sk-line short"></div></div>')
    .join('')}</div>`;
}

export function emptyState({ title, message, actionLabel, actionId, iconName = 'inbox' }) {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon(iconName, 28)}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      ${actionLabel ? `<button class="btn btn-primary" id="${actionId}">${escapeHtml(actionLabel)}</button>` : ''}
    </div>`;
}

export function statusBadge(status, label) {
  const safe = String(status || '').toLowerCase();
  return `<span class="badge badge-${escapeHtml(safe)}"><span class="badge-dot"></span>${escapeHtml(label || status || 'unknown')}</span>`;
}

export function spinner(label = 'Loading') {
  return `<div class="loading-inline"><span class="spinner"></span><span>${escapeHtml(label)}…</span></div>`;
}
