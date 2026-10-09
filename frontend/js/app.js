// Seed Code Mail — application shell, auth gate and router

import { api } from './api.js';
import { refreshIcons, escapeHtml, confirmDialog, toast, icon } from './ui.js';
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
const menuToggle = document.getElementById('menu-toggle');
const navClose = document.getElementById('nav-close');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarScrim = document.getElementById('sidebar-scrim');

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
  // Drop any private view (and its timers/listeners) before revealing the
  // authentication page: authentication is enforced here, not just by CSS.
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (_) { /* ignore */ }
    cleanup = null;
  }
  view.innerHTML = '';
  closeSidebar();
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

const AUTH_TITLES = {
  login: 'Sign in', signup: 'Create account', forgot: 'Reset password',
  'update-password': 'Choose a new password', verify: 'Confirm your email',
};

async function renderAuthRoute() {
  showAuthScreen();
  const name = normaliseAuthRoute(location.hash);
  const title = AUTH_TITLES[name] || 'Sign in';
  titleEl.textContent = title;
  document.title = `${title} · Seed Code Mail`;
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
    const isActive = item.dataset.route === name;
    item.classList.toggle('active', isActive);
    if (isActive) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
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

// --- Sidebar: mobile drawer ------------------------------------------------

const mobileQuery = window.matchMedia('(max-width: 900px)');

function drawerIsOpen() { return shell.classList.contains('sidebar-open'); }

function openSidebar() {
  if (!mobileQuery.matches) return;
  shell.classList.add('sidebar-open');
  if (menuToggle) {
    menuToggle.setAttribute('aria-expanded', 'true');
    menuToggle.setAttribute('aria-label', 'Close navigation');
  }
  // Move focus into the drawer so keyboard users are not left behind it.
  if (navClose) navClose.focus({ preventScroll: true });
}

function closeSidebar({ restoreFocus = false } = {}) {
  if (!drawerIsOpen()) return;
  shell.classList.remove('sidebar-open');
  if (menuToggle) {
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation');
  }
  if (restoreFocus) menuToggle?.focus({ preventScroll: true });
}

menuToggle?.addEventListener('click', () => {
  if (drawerIsOpen()) closeSidebar({ restoreFocus: true });
  else openSidebar();
});
navClose?.addEventListener('click', () => closeSidebar({ restoreFocus: true }));
sidebarScrim?.addEventListener('click', () => closeSidebar({ restoreFocus: true }));

// Escape always dismisses the drawer, from anywhere in the application.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drawerIsOpen()) closeSidebar({ restoreFocus: true });
});

// Leaving mobile widths closes the drawer so its backdrop cannot get stuck.
mobileQuery.addEventListener('change', (event) => { if (!event.matches) closeSidebar(); });

// --- Sidebar: desktop collapse / expand ------------------------------------

const SIDEBAR_PREF_KEY = 'seedmail.sidebar-collapsed';

function readSidebarPreference() {
  try {
    return localStorage.getItem(SIDEBAR_PREF_KEY) === '1';
  } catch (_) {
    // Storage can be unavailable (private mode, blocked cookies): fall back to
    // the expanded sidebar instead of failing to boot.
    return false;
  }
}

function saveSidebarPreference(collapsed) {
  try {
    localStorage.setItem(SIDEBAR_PREF_KEY, collapsed ? '1' : '0');
  } catch (_) { /* preference is a nicety, never a requirement */ }
}

/**
 * Applies the collapsed/expanded state to the shell and keeps the toggle's
 * label, icon and the icon-only navigation tooltips in sync.
 */
function applySidebarCollapsed(collapsed, { persist = true } = {}) {
  shell.classList.toggle('is-collapsed', collapsed);
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  if (sidebarToggle) {
    sidebarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    sidebarToggle.setAttribute('aria-label', label);
    sidebarToggle.title = label;
    sidebarToggle.innerHTML = icon(collapsed ? 'panel-left-open' : 'panel-left-close', 18);
    refreshIcons(sidebarToggle);
  }
  // Icon-only links need a descriptive tooltip; `title` plus the visually
  // hidden label (still read by screen readers) covers both audiences.
  nav.querySelectorAll('.nav-item').forEach((item) => {
    if (collapsed) item.title = item.querySelector('span')?.textContent?.trim() || '';
    else item.removeAttribute('title');
  });
  if (persist) saveSidebarPreference(collapsed);
}

sidebarToggle?.addEventListener('click', () => {
  applySidebarCollapsed(!shell.classList.contains('is-collapsed'));
});

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
  // Restore the saved sidebar preference before the shell is ever revealed.
  applySidebarCollapsed(readSidebarPreference(), { persist: false });
  closeSidebar();

  if (!supabaseConfigured) {
    await renderAuthRoute();
    return;
  }

  // `#auth-panel` still shows its "Checking your session…" placeholder here:
  // the application shell is only revealed once Supabase confirms a session,
  // so no dashboard content can flash before authentication is resolved.
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
