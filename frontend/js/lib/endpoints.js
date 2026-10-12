// Seed Code Mail — resolving the URLs of the app's two auxiliary services
//
// The application talks to two things besides Supabase:
//
//   * the **Gmail API backend** (`/api/gmail/…`), normally on this site's own
//     origin, served by the Vercel functions in `./api`;
//   * the **campaign send worker**, a separate long-running Python service.
//
// Both used to be able to "resolve" to `127.0.0.1` in a deployed build, because
// a hardcoded localhost default was applied unconditionally. On the production
// site that produced two misleading failures:
//
//     "The mail service is not deployed at this address."
//     'The send worker is not reachable. For local development, start it with
//      "python worker/main.py".'
//
// The second message is the real tell: a deployed site was telling its users to
// run a Python process on their own computer. This module makes that
// impossible:
//
//   * a URL from the environment is used as-is, EXCEPT that a loopback address
//     is rejected when the page itself is not being served from this machine —
//     a stale `http://127.0.0.1:…` copied into the Vercel environment must not
//     silently reach production code paths;
//   * the loopback default applies only during local development;
//   * when nothing usable is configured, the resolver returns an empty URL and a
//     short, actionable reason. Callers surface the reason; they never invent a
//     host and never pretend a service is reachable.
//
// It also answers a third question — "which origin is this application
// actually served from?" — because that decides whether an OAuth redirect can
// come back to it at all. See canonicalRedirectFor below.
//
// `hostname` is injectable so the rules can be unit-tested without a browser.

/** Loopback / "this machine" hostnames. */
const LOOPBACK_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLoopbackHostname(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // 127.0.0.0/8 is entirely loopback.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/** True when the page itself is being served from this machine. */
export function pageIsLocal(hostname = typeof location !== 'undefined' ? location.hostname : '') {
  return isLoopbackHostname(hostname);
}

// --- canonical origin -------------------------------------------------------

/**
 * The application's canonical production origin.
 *
 * A `Vercel` *deployment hostname* is not a safe place to complete a login. Every
 * `*.vercel.app` deployment — a preview URL, or the team-scoped project URL such
 * as `seedmail-<team>.vercel.app` — can sit behind Vercel Deployment Protection,
 * and an OAuth redirect that lands there is then answered by Vercel's own
 * authentication wall instead of this application. The authorisation `code` never
 * reaches the SPA, so the account is created in Supabase while no session is ever
 * established: the reported "Google says yes, the app says signed out" state,
 * with the browser left on a Vercel login page.
 *
 * `VITE_SITE_URL` overrides it (the value the README documents). The fallback is
 * the same production domain this project already hardcodes in its public files
 * (sitemap, robots.txt, canonical link, the desktop shell).
 */
export const DEFAULT_CANONICAL_ORIGIN = 'https://mrseedmail.vercel.app';

/** Parses an absolute https URL, or returns null when the value is unusable. */
function parseHttpsOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url : null;
  } catch (_) {
    return null;
  }
}

/**
 * Decide whether this page should move to the canonical origin before it does any
 * authentication, and where to.
 *
 * The rule is deliberately narrow, because a wrong redirect here is worse than
 * none:
 *
 *   * a **loopback / localhost** host is development — never canonicalised, so
 *     `npm run dev` keeps working;
 *   * a host that is **not** a `*.vercel.app` host is authoritative (a custom
 *     domain, an internal name, a `file://` page) — never canonicalised;
 *   * only a `*.vercel.app` host that differs from the canonical host is
 *     canonicalised, which is exactly the reported failure.
 *
 * The route is preserved (`pathname` + `hash`) and the query string is dropped: a
 * query on a wrong origin can only hold an OAuth `code`/`error` belonging to that
 * origin, which must not be replayed on the canonical one.
 *
 * @param {object} [input]
 * @param {string} [input.configured]    `VITE_SITE_URL`
 * @param {string} [input.hostname]      the host this page was served from
 * @param {string} [input.pathname]      the current path, preserved
 * @param {string} [input.hash]          the current hash route, preserved
 * @param {string} [input.defaultOrigin] the built-in production domain
 * @returns {string} an absolute URL to move to, or '' when no move is needed.
 */
export function canonicalRedirectFor({
  configured = '',
  hostname = '',
  pathname = '/',
  hash = '',
  defaultOrigin = DEFAULT_CANONICAL_ORIGIN,
} = {}) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host || isLoopbackHostname(host)) return '';
  if (!host.endsWith('.vercel.app')) return '';

  // A malformed or non-https `VITE_SITE_URL` must not silently disable the guard:
  // the built-in production domain is tried next, and only when neither is usable
  // is no redirect made at all.
  const canonical = parseHttpsOrigin(configured) || parseHttpsOrigin(defaultOrigin);
  if (!canonical) return '';
  if (canonical.hostname.toLowerCase() === host) return '';

  const path = String(pathname || '/') || '/';
  return `${canonical.origin}${path}${String(hash || '')}`;
}

/**
 * Resolve one service URL.
 *
 * @param {string} rawValue  the configured value (may be empty)
 * @param {object} [options]
 * @param {string} [options.localDefault]  URL to use in local development only
 * @param {string} [options.label]         human name used in the problem text
 * @param {string} [options.hostname]      override for tests
 * @returns {{url: string, source: 'configured'|'local-default'|'unset'|'invalid'|'stale-localhost'|'insecure', problem: string, staleLocalhost: boolean}}
 */
export function resolveServiceUrl(rawValue, { localDefault = '', label = 'service', hostname } = {}) {
  const raw = String(rawValue ?? '').trim();
  const locally = pageIsLocal(hostname);

  if (!raw) {
    if (locally && localDefault) {
      return { url: localDefault, source: 'local-default', problem: '', staleLocalhost: false };
    }
    return { url: '', source: 'unset', problem: '', staleLocalhost: false };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return {
      url: '',
      source: 'invalid',
      staleLocalhost: false,
      problem: `The configured ${label} URL is not a valid absolute http(s) URL. Correct it and redeploy.`,
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      url: '',
      source: 'invalid',
      staleLocalhost: false,
      problem: `The configured ${label} URL must use http or https.`,
    };
  }

  if (isLoopbackHostname(parsed.hostname) && !locally) {
    // The exact misconfiguration that told production users to start Python.
    return {
      url: '',
      source: 'stale-localhost',
      staleLocalhost: true,
      problem:
        `The configured ${label} URL (${raw}) points at this machine, which a deployed site cannot ` +
        'reach. Replace it with the deployed service URL and redeploy — a localhost value is only ' +
        'used by a locally served build.',
    };
  }

  // A remote page must not call an http:// service: the browser would block it
  // as mixed content, which looks like a network outage rather than a mistake.
  if (!locally && parsed.protocol === 'http:') {
    return {
      url: '',
      source: 'insecure',
      staleLocalhost: false,
      problem:
        `The configured ${label} URL uses http://, which a site served over https cannot call. ` +
        'Use the https:// URL of the service.',
    };
  }

  return { url: raw.replace(/\/+$/, ''), source: 'configured', problem: '', staleLocalhost: false };
}
