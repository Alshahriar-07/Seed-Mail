// Generates desktop/generated/public-config.json from the frontend's public
// Supabase values.
//
// These are the SAME values Vite inlines into the web bundle: the project URL and
// the publishable (anon) key are public by design. Copying them here lets the
// desktop application pre-fill its setup form and start the worker with a working
// Supabase URL without asking the user for them.
//
// There is deliberately no service-role key here — a secret must never be
// compiled into the application or the installer. The user supplies it once, and
// it is stored encrypted on their machine.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');

function parseEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

const fileEnv = parseEnvFile(join(projectRoot, 'frontend', '.env'));
const supabaseUrl = (process.env.VITE_SUPABASE_URL || fileEnv.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const supabasePublishableKey = (process.env.VITE_SUPABASE_PUBLISHABLE_KEY || fileEnv.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();
const vercelOrigin = (process.env.SEEDMAIL_CLOUD_ORIGIN || 'https://mrseedmail.vercel.app').trim().replace(/\/+$/, '');

if (!supabaseUrl || !supabasePublishableKey) {
  console.warn(
    '[public-config] WARNING: VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY were not found ' +
      'in frontend/.env or the environment. The desktop setup form will start empty.',
  );
}

const outDir = join(here, '..', 'generated');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'public-config.json');
writeFileSync(
  outFile,
  JSON.stringify({ supabaseUrl, supabasePublishableKey, vercelOrigin }, null, 2) + '\n',
  'utf8',
);
console.log(`[public-config] wrote ${outFile} (supabase=${supabaseUrl || 'unset'}, origin=${vercelOrigin})`);
