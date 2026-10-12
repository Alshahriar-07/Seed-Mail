'use strict';

// Seed Code Mail — desktop credential store.
//
// What lives here
// ---------------
// The bundled worker needs two things it cannot discover on its own: the
// Supabase project URL and publishable key (public — the same values the web
// bundle ships, normally taken from `generated/public-config.json`), and — only
// where a deployment provides one — the Supabase **service-role key** the worker
// needs to claim queued campaigns.
//
// There is no setup form any more. The public values are compiled in at build
// time, and a privileged credential is never requested from the end user: it can
// only be provisioned out of band, by the organisation that owns the deployment,
// either as `SUPABASE_SERVICE_ROLE_KEY` in the process environment or as a record
// in this file written by an administrator.
//
// Why not embed the secret in the executable
// ------------------------------------------
// A service-role key is a server credential. Bundling it would publish it to
// everyone who downloads the installer, and would let any installed copy act
// with full database access. It is therefore NEVER compiled into the app, the
// installer, or the frontend bundle.
//
// An existing record written by the previous configuration screen is still read,
// so an installation that was already set up keeps working.
//
// How it is protected at rest
// ---------------------------
// Electron's `safeStorage` is used when the OS provides a backend (on Windows
// this is DPAPI, scoped to the signed-in user). The whole record is encrypted
// before it is written, so neither the service-role key nor the address of the
// project is left in a readable file. When no backend is available the record is
// written as plain JSON with a clear marker rather than silently pretending it
// was encrypted.

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

// `vercelOrigin` is the deployed backend the desktop app reuses for cloud
// operations (the Gmail API functions). It is deliberately a constant, not a
// secret, and not user-editable by accident.
const DEFAULT_VERCEL_ORIGIN = 'https://mrseedmail.vercel.app';

const EMPTY = {
  supabaseUrl: '',
  supabasePublishableKey: '',
  supabaseServiceRoleKey: '',
  vercelOrigin: DEFAULT_VERCEL_ORIGIN,
};

function configFilePath() {
  return path.join(app.getPath('userData'), 'desktop-config.json');
}

/**
 * The public Supabase values compiled in at build time (scripts/public-config.mjs).
 * They are public — the web bundle ships them — and pre-fill the setup form so
 * the user only has to paste the one secret. Reading them from a file keeps the
 * desktop app independent of `VITE_` variables, which do not exist here.
 */
function publicDefaults() {
  // `generated/` is copied into the packaged app (package.json → build.files), so
  // this one path is correct both in development (desktop/generated) and inside
  // the asar (app.asar/generated).
  const candidates = [
    path.join(__dirname, '..', 'generated', 'public-config.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return {
        supabaseUrl: String(parsed.supabaseUrl || ''),
        supabasePublishableKey: String(parsed.supabasePublishableKey || ''),
        vercelOrigin: String(parsed.vercelOrigin || DEFAULT_VERCEL_ORIGIN),
      };
    } catch (_) {
      // Missing/again unreadable: fall through to the next candidate.
    }
  }
  return { supabaseUrl: '', supabasePublishableKey: '', vercelOrigin: DEFAULT_VERCEL_ORIGIN };
}

function normalise(raw = {}) {
  const defaults = publicDefaults();
  return {
    supabaseUrl: String(raw.supabaseUrl || defaults.supabaseUrl || '').trim().replace(/\/+$/, ''),
    supabasePublishableKey: String(raw.supabasePublishableKey || defaults.supabasePublishableKey || '').trim(),
    supabaseServiceRoleKey: String(raw.supabaseServiceRoleKey || '').trim(),
    vercelOrigin: (String(raw.vercelOrigin || defaults.vercelOrigin || DEFAULT_VERCEL_ORIGIN).trim().replace(/\/+$/, '')) || DEFAULT_VERCEL_ORIGIN,
  };
}

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

/** True when the worker has everything it needs to verify users and consume the queue. */
function isConfigured(config) {
  return Boolean(
    config &&
      config.supabaseUrl &&
      config.supabasePublishableKey &&
      config.supabaseServiceRoleKey,
  );
}

function loadConfig() {
  const file = configFilePath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return normalise({});
  }

  let payload = parsed;
  if (parsed && parsed.encrypted === false && typeof parsed.data === 'string') {
    // A plaintext record written when no OS backend was available: the config is
    // carried as a JSON string in `data`.
    try {
      payload = JSON.parse(parsed.data);
    } catch (_) {
      return normalise({});
    }
  } else if (parsed && parsed.encrypted) {
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(String(parsed.data || ''), 'base64'));
      payload = JSON.parse(decrypted);
    } catch (_) {
      // The OS key changed (a different Windows user, a reinstalled profile):
      // the record cannot be read. Treat it as unconfigured so setup runs again
      // rather than starting a worker with no credentials.
      return normalise({});
    }
  }
  return normalise(payload);
}

function saveConfig(raw) {
  const config = normalise(raw);
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const json = JSON.stringify(config);
  let record;
  if (encryptionAvailable()) {
    record = { encrypted: true, backend: 'safeStorage', data: safeStorage.encryptString(json).toString('base64') };
  } else {
    record = { encrypted: false, backend: 'plaintext', data: json };
  }
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  return config;
}

module.exports = {
  DEFAULT_VERCEL_ORIGIN,
  EMPTY,
  configFilePath,
  encryptionAvailable,
  isConfigured,
  loadConfig,
  normalise,
  publicDefaults,
  saveConfig,
};
