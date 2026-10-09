// Seed Code Mail — trusted backend configuration (Vercel serverless functions)
//
// These functions run on Vercel as short-lived request handlers. They are the
// only place that holds a server-side credential, and the only place that talks
// to Google on the user's behalf.
//
// Everything here comes from the process environment (Vercel → Project →
// Settings → Environment Variables). A local `.env` file is NOT automatically
// present on Vercel, and Vite's `VITE_`-prefixed values are inlined into the
// public browser bundle — so they are deliberately never read here.
//
// This module never returns a secret to a client. `describe()` produces a
// boolean/name-only report used by the status endpoint and the setup UI.

/**
 * Values that mean "not really configured".
 */
const PLACEHOLDERS = new Set([
  '', 'changeme', 'change-me', 'placeholder', 'example', 'your-key',
  'your-key-here', 'your-client-id', 'your-client-secret', 'todo', 'none', 'null',
]);

function clean(value) {
  let text = String(value ?? '').trim();
  if (text.length >= 2 && text[0] === text[text.length - 1] && (text[0] === '"' || text[0] === "'")) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** True when a value is present and is not an obvious placeholder. */
export function isReal(value) {
  const text = clean(value);
  if (!text) return false;
  const lowered = text.toLowerCase();
  if (PLACEHOLDERS.has(lowered)) return false;
  if (lowered.startsWith('<') && lowered.endsWith('>')) return false;
  return true;
}

/** First configured value among `names`, else ''. */
export function env(...names) {
  for (const name of names) {
    const value = clean(process.env[name]);
    if (isReal(value)) return value;
  }
  return '';
}

// --- Supabase ---------------------------------------------------------------

export const supabaseUrl = () => env('SUPABASE_URL').replace(/\/+$/, '');

/** Public publishable (anon) key — used only to verify a user's bearer token. */
export const supabasePublishableKey = () =>
  env('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_OR_ANON_KEY');

/** Secret key. Server-only; never exposed to a browser. */
export const supabaseServiceRoleKey = () =>
  env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY');

// --- Google OAuth 2.0 -------------------------------------------------------

export const googleClientId = () => env('GOOGLE_CLIENT_ID', 'GMAIL_CLIENT_ID');
export const googleClientSecret = () => env('GOOGLE_CLIENT_SECRET', 'GMAIL_CLIENT_SECRET');
export const tokenEncryptionKey = () => env('GMAIL_TOKEN_ENCRYPTION_KEY');

/**
 * The Gmail scopes this application actually implements, and nothing more.
 *
 * Every scope below is required by a feature that exists in the UI:
 *   * gmail.readonly  — list/read Inbox and Sent, read a message, download attachments
 *   * gmail.send      — send a message from Compose
 *   * gmail.modify    — change the UNREAD label (mark read / unread)
 *   * gmail.compose   — save a message as a Gmail draft
 *
 * Deliberately NOT requested: gmail.labels, gmail.settings.*, and the full
 * `https://mail.google.com/` scope.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
];

/** Scopes required for each feature, so the UI can name what is missing. */
export const SCOPE_REQUIREMENTS = {
  inbox: ['https://www.googleapis.com/auth/gmail.readonly'],
  sent: ['https://www.googleapis.com/auth/gmail.readonly'],
  send: ['https://www.googleapis.com/auth/gmail.send'],
  modify: ['https://www.googleapis.com/auth/gmail.modify'],
  drafts: ['https://www.googleapis.com/auth/gmail.compose'],
};

/** The OAuth redirect URI. Must exactly match the Google Cloud client config. */
export function redirectUri(origin) {
  const configured = env('GOOGLE_OAUTH_REDIRECT_URI', 'GOOGLE_REDIRECT_URI');
  if (configured) return configured;
  return origin ? `${origin}/api/gmail/callback` : '';
}

/** Where to send the browser back to after the OAuth dance. */
export function appUrl(origin) {
  return env('APP_URL', 'VITE_SITE_URL', 'SITE_URL') || origin || '';
}

// --- capability report ------------------------------------------------------

/**
 * What the server can and cannot do, with no value ever included — only
 * booleans, variable names and short actionable messages. The Inbox/Compose
 * setup card and the Profile page render this verbatim, so an operator knows
 * exactly which variable is missing instead of guessing.
 */
export function describe() {
  const problems = [];
  if (!supabaseUrl()) problems.push('SUPABASE_URL is not set on the server.');
  if (!supabasePublishableKey()) {
    problems.push('SUPABASE_PUBLISHABLE_KEY is not set, so user tokens cannot be verified.');
  }
  if (!supabaseServiceRoleKey()) {
    problems.push('SUPABASE_SERVICE_ROLE_KEY is not set, so Gmail connections cannot be stored.');
  }
  if (!googleClientId()) problems.push('GOOGLE_CLIENT_ID is not set (Google Cloud OAuth client).');
  if (!googleClientSecret()) problems.push('GOOGLE_CLIENT_SECRET is not set (Google Cloud OAuth client).');
  if (!tokenEncryptionKey()) {
    problems.push(
      'GMAIL_TOKEN_ENCRYPTION_KEY is not set, so Gmail refresh tokens cannot be encrypted at rest.',
    );
  }

  return {
    // "auth_configured" here means: the server can identify the caller.
    auth_configured: Boolean(supabaseUrl() && supabasePublishableKey()),
    storage_configured: Boolean(supabaseUrl() && supabaseServiceRoleKey()),
    google_oauth_configured: Boolean(googleClientId() && googleClientSecret()),
    token_encryption_configured: Boolean(tokenEncryptionKey()),
    // The whole Gmail feature is ready only when every part is present.
    gmail_configured: Boolean(
      supabaseUrl()
      && supabasePublishableKey()
      && supabaseServiceRoleKey()
      && googleClientId()
      && googleClientSecret()
      && tokenEncryptionKey(),
    ),
    scopes: GMAIL_SCOPES,
    problems,
  };
}
