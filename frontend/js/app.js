// Seed Code Mail — application shell, auth gate and router

import { api } from './api.js';
import { refreshIcons, escapeHtml, confirmDialog, toast, icon } from './ui.js';
import { supabaseConfigured } from './lib/supabase.js';
import { requestPersistence } from './lib/templates-store.js';
import {
  bootstrapAuth, onAuthChange, renderAuth, normaliseAuthRoute,
  currentUser, displayName, signOut, isRecoveryPending, avatarUrl,
  renderAuthLoading, renderAuthInitFailure,
} from './auth.js';
import { avatarInner, refreshAvatars, safeImageUrl } from './lib/avatar.js';
import * as inbox from './inbox.js';
import * as compose from './compose.js';
import * as sent from './sent.js';
import * as dashboard from './dashboard.js';
import * as recipients from './recipients.js';
import * as campaigns from './campaigns.js';
import * as templates from './templates.js';
import * as editor from './email-editor.js';
import * as history from './history.js';
import * as profile from './profile.js';
import * as settings from './settings.js';
import * as about from './about.js';
import * as legal from './legal.js';

// The mailbox pages come first: reading and sending ordinary mail is the
// primary job now, and campaigns are the workspace's bulk tool.
const routes = {
  inbox: { title: 'Inbox', module: inbox },
  compose: { title: 'Compose Email', module: compose },
  sent: { title: 'Sent', module: sent },
  dashboard: { title: 'Dashboard', module: dashboard },
  recipients: { title: 'Recipients', module: recipients },
  campaigns: { title: 'Campaigns', module: campaigns },
  templates: { title: 'Email Templates', module: templates },
  editor: { title: 'Email Editor', module: editor },
  history: { title: 'Email History', module: history },
  profile: { title: 'Profile', module: profile },
  settings: { title: 'Settings', module: settings },
  about: { title: 'About', module: about },
};

// Where a signed-in user lands when no route is present in the URL.
const DEFAULT_ROUTE = 'inbox';

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
const legalRoot = document.getElementById('legal-root');
const legalTopbar = document.getElementById('legal-topbar');
const legalBody = document.getElementById('legal-body');
const legalFooterEl = document.getElementById('legal-footer');

let cleanup = null;
let signedIn = false;

// --- Authentication view state ---------------------------------------------
// The interface is always in exactly one of these states, so it can never be
// left on an indeterminate screen: `initializing` is bounded by a timeout and
// always ends in `authenticated`, `unauthenticated` or `error`.

export const AUTH_VIEW = {
  initializing: 'initializing',
  authenticated: 'authenticated',
  unauthenticated: 'unauthenticated',
  error: 'error',
  configuration: 'configuration',
};

let authView = AUTH_VIEW.initializing;
let restoreAttempt = 0;
let restoreInFlight = false;

/** Current authentication view state (exposed for diagnostics and tests). */
export function getAuthView() {
  return authView;
}

function setAuthView(next) {
  authView = next;
  document.body.dataset.authState = next;
}

// --- Unsaved-changes guard -------------------------------------------------
// Pages that hold unsaved state register a predicate. It is consulted before
// any navigation (nav links, programmatic navigation and browser back/forward)
// so a half-finished template can never be lost silently.

let dirtyGuard = null;
let guardSuppressed = false;
let lastHash = location.hash || '#/inbox';

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
  legalRoot.hidden = true;
  appShell.hidden = true;
  authRoot.hidden = false;
  if (skipLink) skipLink.hidden = true;
  setIndexable(true);
}

function showApplication() {
  signedIn = true;
  setAuthView(AUTH_VIEW.authenticated);
  // The signed-out panel is not part of the authenticated layout.
  authPanel.innerHTML = '';
  authRoot.hidden = true;
  legalRoot.hidden = true;
  appShell.hidden = false;
  // The skip link targets the app shell, so only reveal it when that exists.
  if (skipLink) skipLink.hidden = false;
  setIndexable(false);
}

// --- Public legal documents -------------------------------------------------
// The Privacy Policy and Terms of Service are public: they must render for a
// signed-out visitor, for a signed-in user, for a crawler, and on a build whose
// Supabase configuration is missing. So they are checked before (and instead
// of) every authentication branch, and they never wait on a session check.

function showLegalPage(slug) {
  // Leaving the application shell is a real teardown: a private view's timers
  // and listeners must not keep running behind the document.
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (_) { /* ignore */ }
    cleanup = null;
  }
  view.innerHTML = '';
  closeSidebar();
  appShell.hidden = true;
  authRoot.hidden = true;
  legalRoot.hidden = false;
  if (skipLink) skipLink.hidden = true;

  const meta = legal.LEGAL_META[slug];
  document.title = `${meta.title} · Seed Code Mail`;
  // Legal documents are exactly the kind of public page search engines should
  // index, so this does NOT set the private noindex state.
  setIndexable(true);

  legal.renderPublicPage({
    slug,
    body: legalBody,
    topbar: legalTopbar,
    signedIn: Boolean(currentUser()),
    refreshIcons,
  });
  if (legalFooterEl) legalFooterEl.innerHTML = legal.legalFooter();
  refreshIcons(legalRoot);
  legalBody.focus({ preventScroll: true });
}

/**
 * Renders the requested legal document if the current URL asks for one.
 * Returns true when it handled the location, so every caller can simply return.
 */
function renderLegalIfRequested() {
  const slug = legal.legalSlugFromLocation();
  if (!slug) return false;
  showLegalPage(slug);
  return true;
}

const AUTH_TITLES = {
  login: 'Sign in', signup: 'Create account', forgot: 'Reset password',
  'update-password': 'Choose a new password', verify: 'Confirm your email',
};

async function renderAuthRoute() {
  if (renderLegalIfRequested()) return;
  showAuthScreen();
  setAuthView(AUTH_VIEW.unauthenticated);
  const name = normaliseAuthRoute(location.hash);
  const title = AUTH_TITLES[name] || 'Sign in';
  titleEl.textContent = title;
  document.title = `${title} · Seed Code Mail`;
  await renderAuth(authPanel, name || 'login');
  refreshIcons(document);
  if (authPanel) authPanel.focus({ preventScroll: true });
}

/** Loading state: shown only while the session check is actually running. */
function renderInitializing() {
  if (renderLegalIfRequested()) return;
  showAuthScreen();
  setAuthView(AUTH_VIEW.initializing);
  document.title = 'Seed Code Mail — Secure Email Campaign Management';
  renderAuthLoading(authPanel);
}

/**
 * A missing or invalid Supabase configuration is a definite, actionable state:
 * the card names the variables to set. It is not a session failure, so it is
 * not presented as a retryable error.
 */
async function renderConfiguration() {
  if (renderLegalIfRequested()) return;
  showAuthScreen();
  setAuthView(AUTH_VIEW.configuration);
  document.title = 'Configuration required · Seed Code Mail';
  await renderAuth(authPanel, 'login');
  refreshIcons(document);
}

/**
 * Recoverable failure: the session state could not be determined. This is
 * explicitly *not* the signed-out screen — the user is offered a retry, and a
 * manual route into the sign-in form if they want one.
 */
function renderAuthFailure(error) {
  if (renderLegalIfRequested()) return;
  showAuthScreen();
  setAuthView(AUTH_VIEW.error);
  document.title = 'Session check failed · Seed Code Mail';
  renderAuthInitFailure(authPanel, {
    onRetry: () => { retrySessionRestore(); },
    onSignIn: () => { renderAuthRoute(); },
  });
  console.error('[Seed Code Mail] session restore failed:', error);
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
  if (avatar) {
    // The avatar is the *authenticated* user's: a real picture only when the
    // account actually has one (see auth.js → avatarUrl), and their initials
    // otherwise. It is re-rendered only when something changed, so the 60-second
    // topbar refresh does not reload the image every minute.
    const picture = safeImageUrl(avatarUrl());
    const signature = `${name}|${email}|${picture}`;
    if (avatar.dataset.signature !== signature) {
      avatar.dataset.signature = signature;
      avatar.className = `avatar avatar-account${picture ? ' has-image' : ''}`;
      avatar.dataset.avatar = '';
      avatar.innerHTML = avatarInner({ name, email }, { src: picture });
      refreshAvatars(avatar);
    }
  }

  const indicator = document.getElementById('smtp-indicator');
  const label = document.querySelector('.smtp-label');
  const led = document.getElementById('sidebar-led');
  const status = document.getElementById('sidebar-status');

  try {
    const worker = await api.workerStatus();
    // "Ready" means the API answered *and* the durable queue consumer has
    // reported in recently *and* an App Password exists. Any other combination
    // is reported honestly rather than as a generic failure.
    const consumer = worker.queue;
    const consumerOnline = consumer ? Boolean(consumer.consumer_online) : true;
    const ready = Boolean(worker.available && worker.has_password && consumerOnline);
    const starting = Boolean(worker.available && worker.has_password && consumer && consumer.configured && !consumerOnline);
    const state = !worker.available ? 'offline' : (ready ? 'ready' : (starting ? 'starting' : 'password'));
    const labelText = {
      ready: 'Send worker ready',
      starting: 'Send worker starting',
      password: 'App Password needed',
      offline: worker.configured === false ? 'Worker not configured' : 'Worker unreachable',
    }[state];

    indicator?.classList.toggle('is-ok', ready);
    indicator?.classList.toggle('is-off', state === 'offline' || state === 'password');
    if (label) label.textContent = labelText;
    if (led) led.className = 'status-led ' + (ready ? 'is-ok' : state === 'starting' ? '' : 'is-off');
    if (status) {
      status.textContent = {
        ready: 'Send worker ready',
        starting: 'Send worker starting — campaigns wait in the queue',
        password: 'Send worker: Gmail App Password missing',
        offline: state === 'offline' && worker.configured === false
          ? 'Send worker not configured for this deployment'
          : 'Send worker unreachable — queued campaigns will send when it returns',
      }[state];
    }
  } catch (_) {
    if (led) led.className = 'status-led is-off';
    if (status) status.textContent = 'Send worker status unavailable';
  }
}

// --- Router ----------------------------------------------------------------

async function onHashChange() {
  if (renderLegalIfRequested()) return;
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
  if (renderLegalIfRequested()) return;

  // Rendering a private route must also restore the private shell, because the
  // router is reachable from a public legal document while a session exists
  // (Settings → Privacy Policy → "Open app", or the browser's Back button).
  // showLegalPage() hides the app shell; without this the route would render
  // into a hidden container and the document would appear frozen.
  if (!currentUser()) {
    await renderAuthRoute();
    return;
  }
  showApplication();

  const hash = location.hash.replace(/^#\/?/, '') || DEFAULT_ROUTE;
  const [name, ...params] = hash.split('/');
  if (!PRIVATE_ROUTES.includes(name)) {
    guardSuppressed = true;
    location.hash = `#/${DEFAULT_ROUTE}`;
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
  // Dismiss the mobile drawer as soon as the navigation is committed. Waiting
  // for the view to finish rendering would leave it open on a slow request
  // (Supabase data calls retry with backoff before they fail).
  closeSidebar();

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
  // Move focus into the drawer so keyboard users are not left behind it. The
  // focus must wait a frame: the drawer's `visibility` only becomes `visible`
  // once the transition starts, and focus() is ignored in a hidden subtree.
  if (navClose) {
    requestAnimationFrame(() => {
      if (drawerIsOpen()) navClose.focus({ preventScroll: true });
    });
  }
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
// The account chip opens the Profile page, which is where the account and the
// Gmail connection are managed; Settings remains for sending preferences.
document.getElementById('profile-chip').addEventListener('click', () => navigate('profile'));

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
  // A legal document is not gated on the session: restore may finish long after
  // the document has been read, and it must not replace what is on screen.
  if (renderLegalIfRequested()) return;
  const user = currentUser();
  if (!user) {
    setAuthView(AUTH_VIEW.unauthenticated);
    await renderAuthRoute();
    return;
  }
  if (isRecoveryPending()) {
    // A recovery link signed the user in: they must choose a new password
    // before using the app.
    setAuthView(AUTH_VIEW.unauthenticated);
    await renderAuthRoute();
    return;
  }
  showApplication();
  await refreshTopbar();
  if (!location.hash || !PRIVATE_ROUTES.includes(location.hash.replace(/^#\/?/, '').split('/')[0])) {
    guardSuppressed = true;
    location.hash = `#/${DEFAULT_ROUTE}`;
  }
  lastHash = location.hash;
  await renderAppRoute();
}

async function handleAuthEvent(event) {
  // The profile row arrives asynchronously and only affects the topbar.
  if (event === 'profile') {
    if (authView === AUTH_VIEW.authenticated) await refreshTopbar();
    return;
  }
  if (event === 'unconfigured') return;
  if (event === 'SIGNED_OUT') {
    if (typeof cleanup === 'function') { try { cleanup(); } catch (_) { /* ignore */ } cleanup = null; }
    view.innerHTML = '';
    authPanel.innerHTML = '';
    setAuthView(AUTH_VIEW.unauthenticated);
    await renderAuthRoute();
    return;
  }
  if (event === 'PASSWORD_RECOVERY') {
    setAuthView(AUTH_VIEW.unauthenticated);
    await renderAuthRoute();
    return;
  }
  if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
    // The initial event can arrive while the explicit restore attempt is still
    // running; that attempt owns the outcome, so a stale session cannot
    // overwrite a newer state.
    if (event === 'INITIAL_SESSION' && restoreInFlight) return;
    await applyAuthState();
  }
}

/**
 * Bounded session restoration. `bootstrapAuth()` always settles (it times out
 * rather than waiting on Supabase forever), and every outcome maps to exactly
 * one view state — the loading screen can never be permanent.
 */
async function startSessionRestore() {
  const attempt = ++restoreAttempt;
  restoreInFlight = true;
  try {
    await bootstrapAuth();
  } catch (error) {
    if (attempt !== restoreAttempt) return; // a newer attempt supersedes this
    renderAuthFailure(error);
    return;
  } finally {
    if (attempt === restoreAttempt) restoreInFlight = false;
  }
  if (attempt !== restoreAttempt) return;
  await applyAuthState();
}

/** Retry offered by the failure screen. */
async function retrySessionRestore() {
  renderInitializing();
  await startSessionRestore();
}

async function boot() {
  refreshIcons(document);
  // Restore the saved sidebar preference before the shell is ever revealed.
  applySidebarCollapsed(readSidebarPreference(), { persist: false });
  closeSidebar();

  // Subscribe before restoring, so no auth event can be lost.
  onAuthChange(handleAuthEvent);

  if (!supabaseConfigured) {
    await renderConfiguration();
    return;
  }

  // A legal document is public and does not depend on Supabase being
  // configured, so a direct visit renders it immediately rather than showing a
  // session spinner first. The session restore below still runs, and
  // applyAuthState() leaves the document in place when it settles.
  const legalSlug = legal.legalSlugFromLocation();
  if (legalSlug) showLegalPage(legalSlug);

  // Session restoration is explicitly bounded: the shell is only revealed once
  // Supabase confirms a session, and a stalled request ends in the recoverable
  // error state instead of an endless loading screen.
  if (!legalSlug) renderInitializing();
  await startSessionRestore();

  // Ask the browser to keep local templates even under storage pressure.
  requestPersistence();
  setInterval(() => { if (signedIn) refreshTopbar(); }, 60000);
}

window.addEventListener('DOMContentLoaded', () => {
  boot().catch((error) => {
    // Last-resort guard: a boot failure must surface, never hang silently.
    console.error('[Seed Code Mail] startup failed:', error);
    renderAuthFailure(error);
  });
});
