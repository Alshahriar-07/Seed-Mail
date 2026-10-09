// Seed Code Mail — Supabase authentication
//
// Real Supabase Auth only: this module never stores or hashes passwords, never
// invents its own token scheme, and never puts tokens into URLs or logs.
//
// Flows covered: sign up (+ email confirmation), sign in, sign out, forgot
// password, password recovery, session restore after refresh, and expiry.
//
// Redirect URLs are derived from `window.location.origin`, so the same build
// works locally, on the beta domain and on production — provided each origin is
// listed in Supabase → Authentication → URL Configuration.

import { supabase, supabaseConfigured } from './lib/supabase.js';
import { escapeHtml, icon, refreshIcons, spinner, toast } from './ui.js';

const RECOVERY_FLAG = 'seedmail.pending-recovery';
const REDIRECT_PATH = '/';

export const AUTH_ROUTES = ['login', 'signup', 'forgot', 'update-password', 'verify'];

/**
 * How long session restoration may take before the UI gives up and offers a
 * retry. Supabase fetches are not bounded by default, so without this a stalled
 * request (slow network, paused project, blocked host) leaves the app on the
 * loading screen forever.
 */
export const AUTH_INIT_TIMEOUT_MS = 10000;
/** A stalled profile read must never delay the signed-in UI. */
const PROFILE_TIMEOUT_MS = 8000;

/**
 * Thrown when a session cannot be resolved *at all* (stalled or failed
 * request). This is deliberately distinct from "there is no session": a
 * network failure must never be presented as the user being signed out.
 */
export class AuthInitError extends Error {
  constructor(message, { reason = 'unavailable', cause = null } = {}) {
    super(message);
    this.name = 'AuthInitError';
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

const TIMED_OUT = Symbol('auth-timeout');
let currentSession = null;
let currentProfile = null;
let subscription = null;
let profileRequest = 0;
const listeners = new Set();

/**
 * Resolves with `promise` or, after `ms`, with `onTimeout()`. The original
 * promise is always observed, so a late rejection can never surface as an
 * unhandled promise rejection.
 */
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { resolve(onTimeout()); } catch (error) { reject(error); }
    }, ms);
    Promise.resolve(promise).then(
      (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); },
      (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); },
    );
  });
}

// --- helpers ---------------------------------------------------------------

function redirectTo() {
  return `${window.location.origin}${REDIRECT_PATH}`;
}

export function isRecoveryPending() {
  try {
    return sessionStorage.getItem(RECOVERY_FLAG) === '1';
  } catch (_) {
    return false;
  }
}

function setRecoveryPending(value) {
  try {
    if (value) sessionStorage.setItem(RECOVERY_FLAG, '1');
    else sessionStorage.removeItem(RECOVERY_FLAG);
  } catch (_) {
    /* ignore */
  }
}

export function isValidEmail(value) {
  const text = String(value ?? '').trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) && text.length <= 254;
}

/** Minimum viable password policy: Supabase enforces its own rules too. */
export function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < 8) return 'Use at least 8 characters.';
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return 'Include at least one letter and one number.';
  }
  return '';
}

function friendlyAuthError(error) {
  const message = String(error?.message || 'Authentication failed.');
  const code = String(error?.code || error?.status || '');
  if (/invalid login credentials/i.test(message)) return 'Incorrect email or password.';
  if (/email not confirmed/i.test(message)) return 'Confirm your email address before signing in.';
  if (/user already registered|already exists/i.test(message)) return 'An account with this email already exists.';
  if (/rate limit|too many/i.test(message)) return 'Too many attempts. Please wait a moment and try again.';
  if (/password should be at least/i.test(message)) return 'Your password is too weak. Use at least 8 characters.';
  if (/expired|invalid.*token|otp/i.test(message)) return 'That link has expired or is invalid. Request a new one.';
  if (/failed to fetch|network/i.test(message) || code === '0') {
    return 'Cannot reach Supabase. Check your connection and the VITE_SUPABASE_* configuration.';
  }
  return message;
}

/** Reads and clears `?error=...` that Supabase appends to an expired link. */
function consumeUrlError() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error_description') || params.get('error');
  if (!error) return '';
  params.delete('error');
  params.delete('error_code');
  params.delete('error_description');
  const query = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  return decodeURIComponent(String(error).replace(/\+/g, ' '));
}

async function loadProfile(userId) {
  if (!supabase || !userId) return null;
  const query = supabase
    .from('profiles')
    .select('id, display_name, created_at')
    .eq('id', userId)
    .maybeSingle();
  const result = await withTimeout(query, PROFILE_TIMEOUT_MS, () => null);
  if (!result || result.error) return null; // profile is optional metadata
  return result.data || null;
}

// --- state / subscription --------------------------------------------------

export function currentUser() {
  return currentSession?.user || null;
}

function notify(event) {
  listeners.forEach((handler) => {
    try {
      const result = handler(event, currentSession);
      // Handlers may be async: their rejections must not become unhandled.
      if (result && typeof result.catch === 'function') {
        result.catch((error) => console.error('[Seed Code Mail] auth listener failed:', error));
      }
    } catch (error) {
      console.error('[Seed Code Mail] auth listener failed:', error);
    }
  });
}

export function onAuthChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/**
 * Loads the optional profile row *outside* the auth callback and without ever
 * being awaited by it: the callback must stay synchronous, and a slow profile
 * request must not hold up session resolution or the UI.
 */
function scheduleProfileLoad(userId) {
  const request = ++profileRequest;
  loadProfile(userId)
    .then((profile) => {
      if (request !== profileRequest) return; // a newer session superseded this
      currentProfile = profile;
      notify('profile', currentSession);
    })
    .catch(() => { /* profile is optional metadata */ });
}

/**
 * Subscribes exactly once to Supabase auth events.
 *
 * The callback is intentionally synchronous: awaiting Supabase calls inside an
 * `onAuthStateChange` handler can deadlock against the client's internal
 * initialization and refresh coordination.
 */
function ensureAuthListener() {
  if (subscription || !supabase) return;
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    currentSession = session || null;
    if (event === 'PASSWORD_RECOVERY') setRecoveryPending(true);
    if (event === 'SIGNED_OUT') {
      profileRequest += 1;
      currentProfile = null;
      setRecoveryPending(false);
    } else if (currentSession) {
      scheduleProfileLoad(currentSession.user.id);
    }
    notify(event, currentSession);
  });
  subscription = data?.subscription || null;
}

/** Removes the Supabase auth subscription (used when tearing the app down). */
export function disposeAuth() {
  if (subscription) {
    subscription.unsubscribe();
    subscription = null;
  }
}

export function isAuthListenerAttached() {
  return Boolean(subscription);
}

/**
 * Restores a persisted session (page refresh / new tab) and subscribes to
 * Supabase auth events. Returns the initial session, or null.
 *
 * Always settles: either with the restored session, or by throwing
 * AuthInitError when the session state cannot be determined in time. It never
 * waits on profile data, so a slow Supabase read cannot block the UI.
 */
export async function bootstrapAuth({ timeoutMs = AUTH_INIT_TIMEOUT_MS } = {}) {
  if (!supabaseConfigured || !supabase) {
    notify('unconfigured', null);
    return null;
  }

  // Subscribe first so no auth event can be missed while the initial session
  // is being read.
  ensureAuthListener();

  const result = await withTimeout(
    Promise.resolve().then(() => supabase.auth.getSession()),
    timeoutMs,
    () => TIMED_OUT,
  );

  if (result === TIMED_OUT) {
    throw new AuthInitError(
      'Timed out while checking your session.',
      { reason: 'timeout' },
    );
  }
  if (result?.error) {
    throw new AuthInitError(
      'The authentication service could not be reached.',
      { reason: 'unavailable', cause: result.error },
    );
  }

  currentSession = result?.data?.session || null;
  if (currentSession) scheduleProfileLoad(currentSession.user.id);
  else currentProfile = null;
  return currentSession;
}

// --- actions ---------------------------------------------------------------

export async function signIn(email, password) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new Error(friendlyAuthError(error));
  currentSession = data.session;
  currentProfile = await loadProfile(data.user.id);
  return data.session;
}

export async function signUp(email, password, displayName = '') {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      emailRedirectTo: redirectTo(),
      data: displayName ? { display_name: displayName.trim() } : undefined,
    },
  });
  if (error) throw new Error(friendlyAuthError(error));
  // When email confirmation is enabled Supabase returns no session here.
  return { needsConfirmation: !data.session, email: email.trim() };
}

export async function resendConfirmation(email) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: email.trim(),
    options: { emailRedirectTo: redirectTo() },
  });
  if (error) throw new Error(friendlyAuthError(error));
}

export async function sendPasswordReset(email) {
  if (!supabase) throw new Error('Supabase is not configured.');
  setRecoveryPending(true);
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirectTo() });
  if (error) {
    setRecoveryPending(false);
    throw new Error(friendlyAuthError(error));
  }
}

export async function updatePassword(newPassword) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(friendlyAuthError(error));
  setRecoveryPending(false);
}

export async function signOut() {
  if (!supabase) return;
  setRecoveryPending(false);
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(friendlyAuthError(error));
  currentSession = null;
  currentProfile = null;
}

export function displayName() {
  return (
    currentProfile?.display_name
    || currentSession?.user?.user_metadata?.display_name
    || currentSession?.user?.email?.split('@')[0]
    || ''
  );
}

/** When the account was created, if the session exposes it. */
export function accountCreatedAt() {
  return currentSession?.user?.created_at || currentProfile?.created_at || '';
}

/**
 * Updates the display name in the user's auth metadata.
 *
 * The `profiles` row is the application's copy (written by the caller through
 * RLS); this is the auth-side copy, so the name is already present on a fresh
 * device before the profile row has loaded. It is not a credential and is not
 * used for authorization anywhere.
 */
export async function updateDisplayName(name) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const { error } = await supabase.auth.updateUser({ data: { display_name: clean } });
  if (error) throw new Error(friendlyAuthError(error));
  if (currentProfile) currentProfile.display_name = clean;
  else currentProfile = { id: currentSession?.user?.id || '', display_name: clean, created_at: null };
  notify('profile', currentSession);
  return clean;
}

/**
 * Requests an email-address change.
 *
 * Supabase owns the confirmation flow: it emails the new address (and, by
 * project configuration, notifies the old one) and only applies the change once
 * the link is followed. No part of that is reimplemented here.
 */
export async function requestEmailChange(email) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const next = String(email ?? '').trim();
  if (!isValidEmail(next)) throw new Error('Enter a valid email address.');
  const { error } = await supabase.auth.updateUser({ email: next });
  if (error) throw new Error(friendlyAuthError(error));
  return next;
}

// --- signed-out screens ----------------------------------------------------

const ROUTE_COPY = {
  login: { title: 'Sign in', subtitle: 'Welcome back. Sign in to manage your campaigns.' },
  signup: { title: 'Create your account', subtitle: 'Set up an account to start sending personalised campaigns.' },
  forgot: { title: 'Reset your password', subtitle: 'We will email you a secure link to choose a new password.' },
  'update-password': { title: 'Choose a new password', subtitle: 'Enter a new password for your account.' },
  verify: { title: 'Confirm your email', subtitle: 'Check your inbox to finish creating your account.' },
};

function fieldHtml({ id, label, type = 'text', autocomplete, hint = '', value = '' }) {
  return `<div class="field">
    <label for="${id}">${escapeHtml(label)}</label>
    <input class="input" id="${id}" name="${id}" type="${type}" value="${escapeHtml(value)}"
      ${autocomplete ? `autocomplete="${autocomplete}"` : ''} ${type === 'password' ? 'minlength="8"' : ''}
      ${type === 'email' ? 'required inputmode="email"' : ''}>
    ${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''}
  </div>`;
}

function shell(route, bodyHtml, { footer = '' } = {}) {
  const copy = ROUTE_COPY[route] || ROUTE_COPY.login;
  return `
    <div class="auth-card">
      <div class="auth-card-head">
        <h2>${escapeHtml(copy.title)}</h2>
        <p>${escapeHtml(copy.subtitle)}</p>
      </div>
      <div id="auth-error" class="notice notice-error" hidden></div>
      ${bodyHtml}
      ${footer}
    </div>`;
}

/**
 * Sign In / Create Account / Forgot Password links, always present on the
 * authentication screens so every flow is reachable by mouse and keyboard.
 * The current screen is marked with `aria-current`.
 */
function authNav(active) {
  const links = [
    { route: 'login', label: 'Sign in' },
    { route: 'signup', label: 'Create account' },
    { route: 'forgot', label: 'Forgot password' },
  ];
  return `<nav class="auth-nav" aria-label="Authentication">${links
    .map(({ route, label }) =>
      `<a href="#/${route}" data-auth-link="${route}"${route === active ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`)
    .join('')}</nav>`;
}

function unconfiguredCard() {
  return `
    <div class="auth-card">
      <div class="auth-card-head">
        <h2>Configuration required</h2>
        <p>Supabase is not configured for this deployment.</p>
      </div>
      <div class="notice notice-error">${icon('alert-circle', 16)}
        <span>Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>
        in <code>frontend/.env</code> (or in the Vercel project settings), then redeploy.</span></div>
    </div>`;
}

/** Loading card shown while the session is being restored (bounded). */
export function authLoadingCard() {
  return `
    <div class="auth-card">
      <div class="loading-inline"><span class="spinner"></span><span>Checking your session…</span></div>
    </div>`;
}

/** Renders the loading state. Used when a retry restarts the session check. */
export function renderAuthLoading(container) {
  container.innerHTML = authLoadingCard();
  refreshIcons(container);
}

/**
 * Renders the recoverable session-restore failure.
 *
 * A failed session check is not the same as "signed out", so it never silently
 * presents the login form as if it were authoritative: it explains that the
 * session is unknown, offers a retry, and lets the user continue to sign in.
 * No error internals are shown, and no credential is ever rendered.
 */
export function renderAuthInitFailure(container, { onRetry, onSignIn } = {}) {
  container.innerHTML = `
    <div class="auth-card">
      <div class="auth-card-head">
        <h2>Could not check your session</h2>
        <p>Seed Code Mail could not reach the authentication service to confirm
        your session. Nothing was changed.</p>
      </div>
      <div class="notice notice-warning">${icon('wifi-off', 16)}
        <span>Check your connection, then try again.</span></div>
      <button class="btn btn-primary btn-block" type="button" id="auth-retry">${icon('refresh-cw', 16)} Try again</button>
      <div class="auth-links"><span><a href="#/login" id="auth-fallback">Continue to sign in</a></span></div>
    </div>`;
  refreshIcons(container);

  const retry = container.querySelector('#auth-retry');
  retry.addEventListener('click', () => onRetry?.());
  container.querySelector('#auth-fallback').addEventListener('click', (event) => {
    event.preventDefault();
    onSignIn?.();
  });
  retry.focus({ preventScroll: true });
}

function showError(container, message) {
  const box = container.querySelector('#auth-error');
  if (!box) return;
  box.hidden = !message;
  box.innerHTML = message ? `${icon('alert-circle', 16)}<span>${escapeHtml(message)}</span>` : '';
  refreshIcons(box);
}

function setBusy(button, busy, label) {
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
}

export function normaliseAuthRoute(hash) {
  const name = String(hash || '').replace(/^#\/?/, '').split('/')[0];
  return AUTH_ROUTES.includes(name) ? name : '';
}

/** Renders the signed-out screen for a route into `container`. */
export async function renderAuth(container, route = 'login') {
  if (!supabaseConfigured) {
    container.innerHTML = unconfiguredCard();
    refreshIcons(container);
    return;
  }

  // A recovery link establishes a session; show the new-password form.
  if (isRecoveryPending() && currentSession) route = 'update-password';

  const urlError = consumeUrlError();

  if (route === 'signup') return renderSignup(container, urlError);
  if (route === 'forgot') return renderForgot(container, urlError);
  if (route === 'update-password') return renderUpdatePassword(container, urlError);
  if (route === 'verify') return renderVerify(container, urlError);
  return renderLogin(container, urlError);
}

function renderLogin(container, urlError) {
  container.innerHTML = shell(
    'login',
    `<form id="auth-form" novalidate>
      ${fieldHtml({ id: 'email', label: 'Email address', type: 'email', autocomplete: 'email' })}
      ${fieldHtml({ id: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' })}
      <button class="btn btn-primary btn-block" type="submit" id="auth-submit">${icon('log-in', 16)} Sign in</button>
    </form>`,
    { footer: authNav('login') },
  );
  refreshIcons(container);
  if (urlError) showError(container, urlError);

  const form = container.querySelector('#auth-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = container.querySelector('#auth-submit');
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!isValidEmail(email)) return showError(container, 'Enter a valid email address.');
    if (!password) return showError(container, 'Enter your password.');
    showError(container, '');
    setBusy(button, true, 'Signing in');
    try {
      await signIn(email, password);
      // The shell re-renders on the auth state change.
    } catch (error) {
      showError(container, error.message);
      setBusy(button, false);
    }
  });
}

function renderSignup(container, urlError) {
  container.innerHTML = shell(
    'signup',
    `<form id="auth-form" novalidate>
      ${fieldHtml({ id: 'name', label: 'Display name (optional)', autocomplete: 'name' })}
      ${fieldHtml({ id: 'email', label: 'Email address', type: 'email', autocomplete: 'email' })}
      ${fieldHtml({
        id: 'password', label: 'Password', type: 'password', autocomplete: 'new-password',
        hint: 'At least 8 characters, with a letter and a number.',
      })}
      <button class="btn btn-primary btn-block" type="submit" id="auth-submit">${icon('user-plus', 16)} Create account</button>
    </form>`,
    { footer: authNav('signup') },
  );
  refreshIcons(container);
  if (urlError) showError(container, urlError);

  const form = container.querySelector('#auth-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = container.querySelector('#auth-submit');
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!isValidEmail(email)) return showError(container, 'Enter a valid email address.');
    const problem = passwordProblem(password);
    if (problem) return showError(container, problem);
    showError(container, '');
    setBusy(button, true, 'Creating account');
    try {
      const { needsConfirmation } = await signUp(email, password, form.name.value);
      if (needsConfirmation) {
        sessionStorage.setItem('seedmail.pending-verification', email);
        location.hash = '#/verify';
      } else {
        toast('Account created.', 'success');
      }
    } catch (error) {
      showError(container, error.message);
      setBusy(button, false);
    }
  });
}

function renderVerify(container, urlError) {
  let email = '';
  try { email = sessionStorage.getItem('seedmail.pending-verification') || ''; } catch (_) { /* ignore */ }
  container.innerHTML = shell(
    'verify',
    `<div class="notice">${icon('mail-check', 16)}
      <span>${email ? `We sent a confirmation link to <strong>${escapeHtml(email)}</strong>.` : 'We sent a confirmation link to your email address.'}
      Open it to activate your account, then sign in.</span></div>
      <button class="btn btn-secondary btn-block" id="auth-resend">${icon('refresh-cw', 16)} Resend confirmation email</button>`,
    {
      footer: `<div class="auth-links"><span><a href="#/login" data-auth-link="login">Back to sign in</a></span></div>`,
    },
  );
  refreshIcons(container);
  if (urlError) showError(container, urlError);

  container.querySelector('#auth-resend').addEventListener('click', async (event) => {
    if (!email) return showError(container, 'Enter your email on the sign-in page and try again.');
    setBusy(event.currentTarget, true, 'Sending');
    try {
      await resendConfirmation(email);
      toast('Confirmation email sent.', 'success');
    } catch (error) {
      showError(container, error.message);
    } finally {
      setBusy(event.currentTarget, false);
    }
  });
}

function renderForgot(container, urlError) {
  container.innerHTML = shell(
    'forgot',
    `<form id="auth-form" novalidate>
      ${fieldHtml({ id: 'email', label: 'Email address', type: 'email', autocomplete: 'email' })}
      <button class="btn btn-primary btn-block" type="submit" id="auth-submit">${icon('send', 16)} Email reset link</button>
    </form>`,
    { footer: authNav('forgot') },
  );
  refreshIcons(container);
  if (urlError) showError(container, urlError);

  const form = container.querySelector('#auth-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = container.querySelector('#auth-submit');
    const email = form.email.value.trim();
    if (!isValidEmail(email)) return showError(container, 'Enter a valid email address.');
    showError(container, '');
    setBusy(button, true, 'Sending');
    try {
      await sendPasswordReset(email);
      container.querySelector('.auth-card').innerHTML = `
        <div class="auth-card-head">
          <h2>Check your email</h2>
          <p>If an account exists for <strong>${escapeHtml(email)}</strong>, a reset link is on its way.
          The link expires after a short time.</p>
        </div>
        <div class="auth-links"><span><a href="#/login" data-auth-link="login">Back to sign in</a></span></div>`;
      refreshIcons(container);
    } catch (error) {
      showError(container, error.message);
      setBusy(button, false);
    }
  });
}

function renderUpdatePassword(container, urlError) {
  container.innerHTML = shell(
    'update-password',
    `<form id="auth-form" novalidate>
      ${fieldHtml({
        id: 'password', label: 'New password', type: 'password', autocomplete: 'new-password',
        hint: 'At least 8 characters, with a letter and a number.',
      })}
      ${fieldHtml({ id: 'confirm', label: 'Confirm new password', type: 'password', autocomplete: 'new-password' })}
      <button class="btn btn-primary btn-block" type="submit" id="auth-submit">${icon('key-round', 16)} Update password</button>
    </form>`,
  );
  refreshIcons(container);
  if (urlError) showError(container, urlError);

  const form = container.querySelector('#auth-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = container.querySelector('#auth-submit');
    const password = form.password.value;
    const problem = passwordProblem(password);
    if (problem) return showError(container, problem);
    if (password !== form.confirm.value) return showError(container, 'The two passwords do not match.');
    showError(container, '');
    setBusy(button, true, 'Updating');
    try {
      await updatePassword(password);
      toast('Password updated. You are signed in.', 'success');
      location.hash = '#/dashboard';
    } catch (error) {
      showError(container, error.message);
      setBusy(button, false);
    }
  });
}
