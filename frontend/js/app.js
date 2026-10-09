// Seed Code Mail - application shell and router

import { api } from './api.js';
import { refreshIcons, escapeHtml, confirmDialog } from './ui.js';
import * as dashboard from './dashboard.js';
import * as recipients from './recipients.js';
import * as campaigns from './campaigns.js';
import * as templates from './templates.js';
import * as editor from './email-editor.js';
import * as history from './history.js';
import * as settings from './settings.js';

const routes = {
  dashboard: { title: 'Dashboard', module: dashboard },
  recipients: { title: 'Recipients', module: recipients },
  campaigns: { title: 'Campaigns', module: campaigns },
  templates: { title: 'Email Templates', module: templates },
  editor: { title: 'Email Editor', module: editor },
  history: { title: 'Email History', module: history },
  settings: { title: 'Settings', module: settings },
};

const view = document.getElementById('view');
const titleEl = document.getElementById('section-title');
const shell = document.querySelector('.app-shell');
const nav = document.getElementById('nav');

let cleanup = null;

// --- Unsaved-changes guard -------------------------------------------------
// Pages that hold unsaved state register a predicate.  It is consulted before
// any navigation (nav links, programmatic navigation and browser back/forward)
// so a half-finished template can never be lost silently.

let dirtyGuard = null;
let guardSuppressed = false;
let lastHash = location.hash || '#/dashboard';

export function setDirtyGuard(predicate) {
  dirtyGuard = typeof predicate === 'function' ? predicate : null;
}

async function confirmLeave() {
  if (typeof dirtyGuard !== 'function' || !dirtyGuard()) return true;
  return confirmDialog(
    'You have unsaved changes. Leave this page and discard them?',
    { title: 'Unsaved changes', confirmLabel: 'Discard', danger: true },
  );
}

export async function navigate(route, params = []) {
  const suffix = params.length ? '/' + params.join('/') : '';
  const target = `#/${route}${suffix}`;
  if (location.hash === target) return;
  if (!(await confirmLeave())) return;
  guardSuppressed = true;
  location.hash = target;
}

async function onHashChange() {
  if (guardSuppressed) {
    guardSuppressed = false;
    lastHash = location.hash;
    renderRoute();
    return;
  }
  if (!(await confirmLeave())) {
    const revert = lastHash;
    if (revert === location.hash) {
      guardSuppressed = false;
      return;
    }
    guardSuppressed = true;
    location.hash = revert;
    return;
  }
  lastHash = location.hash;
  renderRoute();
}

export async function refreshTopbar() {
  try {
    const data = await api.settings();
    const values = data.values || {};
    const name = values.SENDER_NAME || 'Not configured';
    const email = data.email || 'Open Settings';
    document.getElementById('profile-name').textContent = name;
    document.getElementById('profile-email').textContent = email;
    const avatar = document.getElementById('profile-avatar');
    avatar.textContent = (name.trim()[0] || '?').toUpperCase();

    const indicator = document.getElementById('smtp-indicator');
    const configured = data.has_password && !!data.email;
    indicator.classList.toggle('is-ok', configured);
    indicator.classList.toggle('is-off', !configured);
    document.querySelector('.smtp-label').textContent = configured ? 'SMTP Ready' : 'SMTP Setup';

    const led = document.getElementById('sidebar-led');
    const status = document.getElementById('sidebar-status');
    led.className = 'status-led ' + (configured ? 'is-ok' : 'is-off');
    status.textContent = configured ? 'SMTP configured' : 'SMTP not configured';
  } catch (error) {
    const status = document.getElementById('sidebar-status');
    status.textContent = 'Server unreachable';
    document.getElementById('sidebar-led').className = 'status-led is-off';
  }
}

async function renderRoute() {
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, ...params] = hash.split('/');
  const route = routes[name] || routes.dashboard;

  nav.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.route === (routes[name] ? name : 'dashboard'));
  });
  titleEl.textContent = route.title;

  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (_) { /* ignore */ }
    cleanup = null;
  }

  view.innerHTML = '';
  view.classList.remove('view-enter');
  void view.offsetWidth;
  view.classList.add('view-enter');

  try {
    cleanup = await route.module.render(view, { params });
  } catch (error) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><i data-lucide="alert-triangle" data-size="28"></i></div>
        <h3>Something went wrong</h3>
        <p>${escapeHtml(error.message || 'Unexpected error')}</p>
      </div>`;
  }
  refreshIcons(document);
  view.focus({ preventScroll: true });
  closeSidebar();
}

// --- Mobile sidebar --------------------------------------------------------

function openSidebar() { shell.classList.add('sidebar-open'); }
function closeSidebar() { shell.classList.remove('sidebar-open'); }

document.getElementById('menu-toggle').addEventListener('click', () => {
  shell.classList.toggle('sidebar-open');
});
document.getElementById('sidebar-scrim').addEventListener('click', closeSidebar);
document.getElementById('settings-shortcut').addEventListener('click', () => navigate('settings'));
document.getElementById('smtp-indicator').addEventListener('click', () => navigate('settings'));
document.getElementById('profile-chip').addEventListener('click', () => navigate('settings'));

// Route every nav click through navigate() so the unsaved-changes guard runs.
nav.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(item.dataset.route);
  });
});

window.addEventListener('hashchange', onHashChange);
window.addEventListener('DOMContentLoaded', () => {
  if (!location.hash) location.hash = '#/dashboard';
  lastHash = location.hash;
  refreshIcons(document);
  refreshTopbar();
  renderRoute();
  setInterval(refreshTopbar, 60000);
});

// initial paint for icons already in the DOM
refreshIcons(document);
