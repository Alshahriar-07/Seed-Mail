// Seed Code Mail — local email template store (IndexedDB)
//
// Templates belong to the user's browser profile, not to the cloud:
//   * a fresh installation starts with an EMPTY list — nothing is preloaded;
//   * templates survive a page refresh and are never uploaded to Supabase;
//   * they are NOT shared across devices or browsers, and clearing browser
//     storage deletes them — JSON export is the backup/migration path.
//
// The database is versioned (DB_VERSION). When the shape changes, bump the
// version and migrate inside `onupgradeneeded` — never drop the store, so no
// saved template is ever lost.

import { DEFAULT_DESIGN, cleanDesign } from './render.js';

const DB_NAME = 'seedcode-mail';
const DB_VERSION = 1;
const STORE = 'templates';
const MIGRATION_FLAG = 'seedmail.templates.migrated.v1';

// Legacy keys that a previous build might have written. If any are found they
// are imported once (and left in place, never deleted).
const LEGACY_KEYS = ['seedcode.templates', 'seedcode-mail.templates', 'templates'];

let dbPromise = null;

function hasIndexedDb() {
  return typeof indexedDB !== 'undefined';
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error('This browser has no IndexedDB, so templates cannot be stored locally.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB could not be opened.'));
  });
  return dbPromise;
}

function run(mode, work) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try {
          result = work(store);
        } catch (error) {
          reject(error);
          return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('Local template store failed.'));
        tx.onabort = () => reject(tx.error || new Error('Local template store aborted.'));
      }),
  );
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function newId() {
  const raw = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `tpl_${raw.slice(0, 16)}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeName(name) {
  return String(name ?? '').trim().slice(0, 120);
}

// --- one-time migration from legacy localStorage ---------------------------

function readLegacyTemplates() {
  try {
    for (const key of LEGACY_KEYS) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : parsed?.templates;
      if (Array.isArray(items) && items.length) return items;
    }
  } catch (_) {
    /* ignore malformed legacy data */
  }
  return [];
}

function toRecord(source, { isDefault = false } = {}) {
  return {
    id: typeof source.id === 'string' && source.id ? source.id : newId(),
    name: normalizeName(source.name) || 'Recovered template',
    description: String(source.description ?? '').slice(0, 300),
    html: String(source.html ?? ''),
    design: cleanDesign(source.design),
    is_default: Boolean(isDefault),
    created_at: source.created_at || now(),
    updated_at: now(),
  };
}

async function migrateLegacyOnce() {
  let alreadyDone = true;
  try {
    alreadyDone = localStorage.getItem(MIGRATION_FLAG) === '1';
  } catch (_) {
    alreadyDone = true; // storage unavailable: nothing to migrate
  }
  if (alreadyDone) return 0;

  const legacy = readLegacyTemplates();
  let imported = 0;
  if (legacy.length) {
    const existing = await listAll();
    const existingIds = new Set(existing.map((t) => t.id));
    const records = legacy
      .map((item, index) => toRecord(item, { isDefault: index === 0 && existing.length === 0 }))
      .filter((record) => record.html.trim() && !existingIds.has(record.id));
    if (records.length) {
      await run('readwrite', (store) => {
        records.forEach((record) => store.put(record));
        return records.length;
      });
      imported = records.length;
    }
  }
  try {
    localStorage.setItem(MIGRATION_FLAG, '1');
  } catch (_) {
    /* ignore */
  }
  return imported;
}

let readyPromise = null;

/** Ensures the store exists and the legacy migration ran exactly once. */
export function ensureReady() {
  if (!readyPromise) {
    readyPromise = openDatabase()
      .then(() => migrateLegacyOnce())
      .catch((error) => {
        readyPromise = null;
        throw error;
      });
  }
  return readyPromise;
}

/** Ask the browser to keep this data even under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch (_) {
    /* ignore */
  }
  return false;
}

// --- reads -----------------------------------------------------------------

export async function listAll() {
  await ensureReady();
  const items = await run('readonly', (store) => requestResult(store.getAll()));
  return (items || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function listSummary() {
  const items = await listAll();
  return items.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description || '',
    is_default: Boolean(template.is_default),
    design: template.design || { ...DEFAULT_DESIGN },
    size: String(template.html || '').length,
    created_at: template.created_at,
    updated_at: template.updated_at,
  }));
}

export async function get(id) {
  await ensureReady();
  const record = await run('readonly', (store) => requestResult(store.get(id)));
  return record || null;
}

// --- writes ----------------------------------------------------------------

export async function create({ name, html, description = '', design = null } = {}) {
  const cleanName = normalizeName(name);
  if (!cleanName) throw new Error('Template name is required.');
  if (!String(html ?? '').trim()) {
    // An empty document is never stored, so it can never silently replace a
    // saved template.
    throw new Error('Template HTML cannot be empty.');
  }
  await ensureReady();
  const items = await listAll();
  const record = {
    id: newId(),
    name: cleanName,
    description: String(description ?? '').slice(0, 300),
    html: String(html),
    design: cleanDesign(design),
    is_default: !items.some((t) => t.is_default),
    created_at: now(),
    updated_at: now(),
  };
  await run('readwrite', (store) => store.put(record));
  return record;
}

export async function update(id, fields = {}) {
  await ensureReady();
  const current = await get(id);
  if (!current) throw new Error('Template not found.');

  const next = { ...current };
  if ('name' in fields && normalizeName(fields.name)) next.name = normalizeName(fields.name);
  if ('description' in fields) next.description = String(fields.description ?? '').slice(0, 300);
  if ('html' in fields) {
    const incoming = String(fields.html ?? '');
    if (!incoming.trim()) {
      // Never let an empty editor silently wipe a saved template.
      throw new Error('Refusing to overwrite a saved template with empty HTML.');
    }
    next.html = incoming;
  }
  if ('design' in fields) next.design = cleanDesign(fields.design);
  next.updated_at = now();

  await run('readwrite', (store) => store.put(next));
  return next;
}

export async function duplicate(id, name = '') {
  await ensureReady();
  const source = await get(id);
  if (!source) throw new Error('Template not found.');
  const clone = {
    ...source,
    id: newId(),
    name: normalizeName(name) || `${source.name} (copy)`.slice(0, 120),
    is_default: false,
    created_at: now(),
    updated_at: now(),
  };
  await run('readwrite', (store) => store.put(clone));
  return clone;
}

export async function setDefault(id) {
  await ensureReady();
  const items = await listAll();
  if (!items.some((t) => t.id === id)) throw new Error('Template not found.');
  await run('readwrite', (store) => {
    items.forEach((template) => {
      const isDefault = template.id === id;
      if (template.is_default !== isDefault) {
        template.is_default = isDefault;
        template.updated_at = now();
        store.put(template);
      }
    });
    return true;
  });
  return get(id);
}

export async function remove(id) {
  await ensureReady();
  const target = await get(id);
  if (!target) throw new Error('Template not found.');
  await run('readwrite', (store) => store.delete(id));
  if (target.is_default) {
    const remaining = await listAll();
    if (remaining.length) await setDefault(remaining[0].id);
  }
}

// --- import / export -------------------------------------------------------

export function exportJsonText(items) {
  return JSON.stringify(
    {
      app: 'Seed Code Mail',
      schema: DB_VERSION,
      exported_at: now(),
      // Note for the reader (and for a future importer): these templates are
      // local to one browser profile.
      templates: items.map(({ id, name, description, html, design, is_default, created_at, updated_at }) => ({
        id, name, description, html, design, is_default, created_at, updated_at,
      })),
    },
    null,
    2,
  );
}

export async function importJsonText(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
  const items = Array.isArray(payload) ? payload : payload?.templates;
  if (!Array.isArray(items)) {
    throw new Error('JSON must be an array of templates or an object with a "templates" array.');
  }
  await ensureReady();
  const existing = await listAll();
  const existingIds = new Set(existing.map((t) => t.id));
  const seenNames = new Set(existing.map((t) => t.name.toLowerCase()));

  const records = [];
  let skipped = 0;
  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') { skipped += 1; return; }
    const record = toRecord(item, { isDefault: index === 0 && existing.length === 0 && records.length === 0 });
    if (!record.html.trim() || existingIds.has(record.id)) { skipped += 1; return; }
    // Keep names unique so the list stays readable.
    let name = record.name;
    let suffix = 2;
    while (seenNames.has(name.toLowerCase())) {
      name = `${record.name} (${suffix})`.slice(0, 120);
      suffix += 1;
    }
    record.name = name;
    seenNames.add(name.toLowerCase());
    existingIds.add(record.id);
    records.push(record);
  });

  if (records.length) {
    await run('readwrite', (store) => {
      records.forEach((record) => store.put(record));
      return records.length;
    });
  }
  return { imported: records.length, skipped };
}

export async function exportAllJson() {
  return exportJsonText(await listAll());
}
