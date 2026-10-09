// Seed Code Mail — HTTP helpers for the Vercel serverless handlers.
//
// The functions are same-origin (the SPA calls `/api/gmail/...`), so no CORS
// headers are needed and none are added: an endpoint that answers cross-origin
// by default is a larger attack surface than one that does not.

/** An error carrying the HTTP status the client should receive. */
export class HttpError extends Error {
  constructor(status, message, { code = '', details = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, code = 'bad_request') {
  return new HttpError(400, message, { code });
}

export function unauthorized(message = 'You are not signed in.', code = 'unauthorized') {
  return new HttpError(401, message, { code });
}

export function notConfigured(message, details = null) {
  return new HttpError(503, message, { code: 'not_configured', details });
}

export function methodNotAllowed(allowed) {
  return new HttpError(405, `Use ${allowed.join(' or ')} on this endpoint.`, { code: 'method_not_allowed' });
}

/** Write a JSON response. Never includes a stack trace. */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(payload);
}

export function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const body = {
    error: error instanceof HttpError ? error.message : 'The request could not be completed.',
    code: error instanceof HttpError ? error.code : 'internal_error',
  };
  if (error instanceof HttpError && error.details) body.details = error.details;
  if (status >= 500 && !(error instanceof HttpError)) {
    // Log server faults (without any credential) so they are visible in the
    // Vercel function logs; the client only ever sees a generic message.
    console.error('[seedmail] unhandled backend error:', error?.message || error);
  }
  sendJson(res, status, body);
}

/** Redirect the browser (used by the OAuth connect/callback endpoints). */
export function sendRedirect(res, location, status = 302) {
  res.statusCode = status;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end('');
}

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB, comfortably under every Vercel limit

/** Read and parse a JSON request body. */
export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw badRequest('The request body is too large.', 'body_too_large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('The request body must be a JSON object.', 'invalid_body');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badRequest('The request body is not valid JSON.', 'invalid_json');
  }
}

/** Query parameters as a plain object. */
export function queryOf(req) {
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

export function requireMethod(req, ...allowed) {
  if (!allowed.includes(req.method)) throw methodNotAllowed(allowed);
}

/** The absolute origin of this request (used to build redirect URIs). */
export function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return host ? `${proto}://${String(host).split(',')[0].trim()}` : '';
}

/**
 * Redirect back into the SPA with a short, non-secret status code.
 *
 * The flag goes in the QUERY STRING and the route in the fragment, so the SPA's
 * router (which reads `location.hash`) sees a clean route like `#/profile`
 * while the page can still read `?gmail=connected`. Putting the flag inside the
 * fragment would make the route name `profile?gmail=connected` and the router
 * would reject it.
 *
 * The value is a code the UI translates, so a raw Google error is never echoed
 * into a URL — and nothing sensitive can be placed there.
 */
export function appRedirect(res, base, hash, params = {}) {
  let url;
  try {
    url = new URL(String(base).replace(/\/+$/, '') + '/');
  } catch (_) {
    throw new HttpError(500, 'The application URL is not configured correctly.', { code: 'bad_app_url' });
  }
  const search = new URLSearchParams(params).toString();
  if (search) url.search = search;
  if (hash) url.hash = hash.startsWith('#') ? hash : `#${hash}`;
  sendRedirect(res, url.toString());
}
