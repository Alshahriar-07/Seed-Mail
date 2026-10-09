// Seed Code Mail — application shell, auth gate and router

import { api } from './api.js';
import { refreshIcons, escapeHtml, confirmDialog, toast } from './ui.js';
import { supabaseConfigured } from './lib/supabase.js';
import { requestPersistence } from './lib/templates-store.js';
import {
  bootstrapAuth, onAuthChange, renderAuth, normaliseAuthRoute,
  currentUser, displayName, signOut, isRecoveryPending,
} from './auth.js';
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

const PRIVATE_ROUTES = Object.keys(routes);

const authRoot = document.getElementById('auth-root');
const authPanel = document.getElementById('auth-panel');
const appShell = document.getElementById('app-shell');
const view = document.getElementById('view');
const titleEl = document.getElementById('section-title');
const shell = document.querySelector('.app-shell') || appShell;
const nav = document.getElementById('nav');
const robotsMeta = document.querySelector('meta[name="robots"]');
const skipLink = document.getElementById('skip-link');

let cleanup = null;
let signedIn = false;

// --- Unsaved-changes guard -------------------------------------------------
// Pages that hold unsaved state register a predicate. It is consulted before
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

// --- Views -----------------------------------------------------------------

/**
 * Private application views must never be indexed. The signed-out screen is the
 * crawlable public landing content, so it keeps `index, follow`.
 */
function setIndexable(indexable) {
  if (robotsMeta) robotsMeta.setAttribute('content', indexable ? 'index, follow' : 'noindex, nofollow');
}

function showAuthScreen() {
  signedIn = false;
  appShell.hidden = true;
  authRoot.hidden = false;
  if (skipLink) skipLink.hidden = true;
  setIndexable(true);
}

function showApplication() {
  signedIn = true;
  authRoot.hidden = true;
  appShell.hidden = false;
  // The skip link targets the app shell, so only reveal it when that exists.
  if (skipLink) skipLink.hidden = false;
  setIndexable(false);
}

async function renderAuthRoute() {
  showAuthScreen();
  const name = normaliseAuthRoute(location.hash);
  titleEl.textContent = 'Sign in';
  await renderAuth(authPanel, name || 'login');
  refreshIcons(document);
  if (authPanel) authPanel.focus({ preventScroll: true });
}

// --- Topbar ----------------------------------------------------------------

export async function refreshTopbar() {
  const user = currentUser();
  const name = displayName() || user?.email || 'Signed in';
  const email = user?.email || '';
  const nameEl = document.getElementById('profile-name');
  const emailEl = document.getElementById('profile-email');
  const avatar = document.getElementById('profile-avatar');
  if (nameEl) nameEl.textContent = name;
  if (emailEl) emailEl.textContent = email;
  if (avatar) avatar.textContent = (String(name).trim()[0] || '?').toUpperCase();

  const indicator = document.getElementById('smtp-indicator');
  const label = document.querySelector('.smtp-label');
  const led = document.getElementById('sidebar-led');
  const status = document.getElementById('sidebar-status');

  try {
    const worker = await api.workerStatus();
    const ready = Boolean(worker.available && worker.has_password);
    indicator?.classList.toggle('is-ok', ready);
    indicator?.classList.toggle('is-off', !ready);
    if (label) label.textContent = ready ? 'Send worker ready' : (worker.available ? 'App Password needed' : 'Worker offline');
    if (led) led.className = 'status-led ' + (ready ? 'is-ok' : 'is-off');
    if (status) {
      status.textContent = worker.available
        ? (ready ? 'Send worker ready' : 'Send worker: App Password missing')
        : 'Send worker not running';
    }
  } catch (_) {
    if (led) led.className = 'status-led is-off';
    if (status) status.textContent = 'Send worker not running';
  }
}

// --- Router ----------------------------------------------------------------

async function onHashChange() {
  if (!signedIn) {
    renderAuthRoute();
    return;
  }
  if (guardSuppressed) {
    guardSuppressed = false;
    lastHash = location.hash;
    renderAppRoute();
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
  renderAppRoute();
}

async function renderAppRoute() {
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, ...params] = hash.split('/');
  if (!PRIVATE_ROUTES.includes(name)) {
    guardSuppressed = true;
    location.hash = '#/dashboard';
    return;
  }
  const route = routes[name];

  nav.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.route === name);
  });
  titleEl.textContent = route.title;
  document.title = `${route.title} · Seed Code Mail`;

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
        <button class="btn btn-secondary" id="route-retry">Try again</button>
      </div>`;
    view.querySelector('#route-retry')?.addEventListener('click', () => renderAppRoute());
  }
  refreshIcons(document);
  view.focus({ preventScroll: true });
  closeSidebar();
}

// --- Mobile sidebar --------------------------------------------------------

function closeSidebar() { shell.classList.remove('sidebar-open'); }

document.getElementById('menu-toggle').addEventListener('click', () => {
  shell.classList.toggle('sidebar-open');
});
document.getElementById('sidebar-scrim').addEventListener('click', closeSidebar);
document.getElementById('settings-shortcut').addEventListener('click', () => navigate('settings'));
document.getElementById('smtp-indicator').addEventListener('click', () => navigate('settings'));
document.getElementById('profile-chip').addEventListener('click', () => navigate('settings'));

document.getElementById('signout').addEventListener('click', async () => {
  const ok = await confirmDialog('Sign out of Seed Code Mail?', { title: 'Sign out', confirmLabel: 'Sign out' });
  if (!ok) return;
  try {
    await signOut();
    toast('Signed out.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
});

// Route every nav click through navigate() so the unsaved-changes guard runs.
nav.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(item.dataset.route);
  });
});

window.addEventListener('hashchange', onHashChange);

// --- Auth state ------------------------------------------------------------

async function applyAuthState() {
  const user = currentUser();
  if (!user) {
    await renderAuthRoute();
    return;
  }
  if (isRecoveryPending()) {
    // A recovery link signed the user in: they must choose a new password
    // before using the app.
    await renderAuthRoute();
    return;
  }
  showApplication();
  await refreshTopbar();
  if (!location.hash || !PRIVATE_ROUTES.includes(location.hash.replace(/^#\/?/, '').split('/')[0])) {
    guardSuppressed = true;
    location.hash = '#/dashboard';
  }
  lastHash = location.hash;
  await renderAppRoute();
}

async function boot() {
  refreshIcons(document);

  if (!supabaseConfigured) {
    await renderAuthRoute();
    return;
  }

  await bootstrapAuth();

  onAuthChange(async (event) => {
    if (event === 'SIGNED_OUT') {
      if (typeof cleanup === 'function') { try { cleanup(); } catch (_) { /* ignore */ } cleanup = null; }
      view.innerHTML = '';
      await renderAuthRoute();
      return;
    }
    if (event === 'PASSWORD_RECOVERY') {
      await renderAuthRoute();
      return;
    }
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
      await applyAuthState();
    }
  });

  await applyAuthState();
  // Ask the browser to keep local templates even under storage pressure.
  requestPersistence();
  setInterval(() => { if (signedIn) refreshTopbar(); }, 60000);
}

window.addEventListener('DOMContentLoaded', boot);
