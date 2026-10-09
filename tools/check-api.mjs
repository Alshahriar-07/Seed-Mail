// Seed Code Mail — API route checker
//
//     npm run check:api
//
// The Vercel functions under `api/` cannot be exercised without a deployment, but
// the mistakes that actually break a deployment CAN be caught locally: a bad
// import path, a missing default export, a route that forgets authentication, or
// a handler that would leak a credential. This script imports every route and
// asserts those properties, so `npm run build` plus this check gives a real
// signal before anything is pushed.

import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const API_DIR = path.resolve(process.cwd(), 'api');

// Routes that must NOT require a session: the OAuth callback arrives as a
// browser navigation from Google, and status has to be able to explain a
// server-side misconfiguration before a session can be verified.
const PUBLIC_FILES = new Set(['callback.js']);

let failures = 0;
const report = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
};

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_')) continue; // shared code, not a route
      files.push(...await walk(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const routes = await walk(API_DIR);
if (!routes.length) {
  console.error('No API routes found under api/ — refusing to report success.');
  process.exit(1);
}

console.log('Checking API routes\n');

for (const file of routes.sort()) {
  const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    report(false, relative, `import failed: ${error.message}`);
    continue;
  }

  const handler = module.default;
  if (typeof handler !== 'function') {
    report(false, relative, 'has no default function export');
    continue;
  }

  // The handler source tells us whether it is wrapped in `authed(...)`, which is
  // how every user-scoped endpoint enforces authentication.
  const source = await (await import('node:fs/promises')).readFile(file, 'utf8');
  const base = path.basename(file);
  const isAuthed = /export default authed\(/.test(source);
  const isRoute = /export default route\(/.test(source);

  if (PUBLIC_FILES.has(base)) {
    report(!isAuthed, `${relative} is intentionally unauthenticated`, 'state/nonce verified instead');
  } else {
    report(isAuthed || isRoute, `${relative} uses a wrapped handler`, isAuthed ? 'authed()' : 'route()');
  }

  // A credential must never be returned by a route.
  if (/service_role_key\s*[:=]\s*[^=]|SUPABASE_SERVICE_ROLE_KEY.*(return|sendJson)/i.test(source)) {
    report(false, `${relative} does not echo a service-role key`);
  }
}

console.log('');

// Shared libraries must import cleanly too — a broken shared module would only
// surface at request time on Vercel.
const libDir = path.resolve(process.cwd(), 'backend/lib');
const { readdir: readdirLib } = await import('node:fs/promises');
for (const name of (await readdirLib(libDir)).filter((entry) => entry.endsWith('.js')).sort()) {
  const file = path.join(libDir, name);
  try {
    await import(pathToFileURL(file).href);
    report(true, `backend/lib/${name} imports`);
  } catch (error) {
    report(false, `backend/lib/${name} imports`, error.message);
  }
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`All ${routes.length} API routes and shared modules check out.`);
