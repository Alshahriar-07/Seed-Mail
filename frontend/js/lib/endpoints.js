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
