'use strict';

// Seed Code Mail — desktop UI server.
//
// The desktop application serves the SAME built frontend that Vercel serves
// (`dist/`), from a loopback-only HTTP server. There are three reasons it is not
// loaded straight from disk with `file://`:
//
//   1. **A real origin.** `file://` gives the page an opaque origin, which
//      breaks Supabase's session storage and makes the bundled worker refuse the
//      page outright (its Origin allow-list exists precisely to stop arbitrary
//      local content driving it). `http://127.0.0.1:<port>` is a proper origin
//      the worker can allow by name.
//   2. **Cloud API on the same origin.** Requests to `/api/…` are proxied to the
//      deployed Vercel backend, so the frontend keeps calling `/api/gmail/…`
//      exactly as it does on the web and the browser never sees a cross-origin
//      call. No cloud secret is copied into the app: the Vercel functions own
//      the Google client secret and the refresh tokens.
//   3. **One code path.** The UI is byte-for-byte the web build, so the desktop
//      app cannot drift away from the deployed site.
//
// Security: it binds to 127.0.0.1 only, refuses path traversal, and only ever
// proxies to the configured deployed origin (never to an arbitrary host).

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// A permissive-but-not-dangerous policy for the application window. Scripts are
// same-origin only; the only external origins permitted are the web fonts the
// design uses and the Supabase/Gmail endpoints the app already talks to.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https:",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body === undefined || body === null) res.end();
  else res.end(body);
}

/** Proxies one request to the deployed backend, streaming both directions. */
function proxyTo(req, res, origin) {
  let target;
  try {
    target = new URL(req.url, origin);
  } catch (_) {
    return send(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Bad request path.' }));
  }
  if (target.origin !== origin) {
    return send(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Refused: proxy target outside the configured backend.' }));
  }

  // Forward the headers the backend actually uses; drop hop-by-hop and the
  // loopback Host so the request looks exactly like the browser's on Vercel.
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  headers.host = target.host;

  const transport = target.protocol === 'http:' ? http : https;
  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers,
    },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers };
      delete outHeaders['transfer-encoding'];
      delete outHeaders['content-encoding'];
      delete outHeaders.connection;
      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    send(
      res,
      502,
      { 'Content-Type': 'application/json' },
      JSON.stringify({
        error: 'The cloud backend could not be reached.',
        code: 'backend_unavailable',
        detail: String(error.message || error),
      }),
    );
  });

  req.pipe(upstream);
}

/** Serves one file from the build directory, with SPA fallback. */
function serveStatic(root, urlPath, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (_) {
    decoded = urlPath;
  }
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let filePath = path.join(root, safe);
  if (!filePath.startsWith(root)) {
    return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
  }

  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    stat = null;
  }
  // SPA fallback: a path with no extension is a client route, not a file.
  if (!stat || stat.isDirectory()) {
    if (path.extname(decoded) && stat) {
      return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    }
    filePath = path.join(root, 'index.html');
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      return send(res, 500, { 'Content-Type': 'text/plain' }, 'Application build not found.');
    }
  }

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Starts the loopback UI server.
 *
 * @returns {Promise<{server: import('node:http').Server, url: string}>}
 */
function startLocalServer({ port, root, proxyOrigin }) {
  const origin = new URL(proxyOrigin).origin;

  const server = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch (_) {
      pathname = '/';
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return proxyTo(req, res, origin);
    }
    return serveStatic(root, pathname, res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

module.exports = { startLocalServer, CSP };
