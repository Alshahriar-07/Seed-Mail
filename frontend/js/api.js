// Seed Code Mail — data layer
//
// The original app talked to a local FastAPI server. On Vercel there is no
// long-running Python process, so this module keeps the *same surface* the UI
// modules already use while sourcing data from:
//
//   * Supabase (Postgres + Auth)  → recipients, campaigns, job queue, history,
//                                   non-secret settings
//   * IndexedDB (this browser)    → email templates
//   * the local send worker       → Gmail SMTP delivery + the App Password
//
// Row Level Security is the access-control boundary: every query below returns
// only the signed-in user's rows, and `user_id` is never taken from the UI.

import { requireClient } from './lib/supabase.js';
import * as templates from './lib/templates-store.js';
import { DEFAULT_DESIGN, VARIABLE_GUIDE, previewTemplate as renderPreview, isValidEmail, isValidUrl, cleanDesign } from './lib/render.js';
import { worker, WorkerUnavailableError, workerConfigured, workerIsLocal, workerUnavailableHelp } from './lib/worker.js';
import { currentUser } from './auth.js';
import {
  download, recipientsCsv, recipientsJson, historyCsv, historyJson, templateFileName,
} from './lib/exports.js';

// Injected at build time from package.json (see vite.config.js). The guard keeps
// the module valid if it is ever loaded outside a Vite build.
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

const RECIPIENT_STATUSES = ['pending', 'sent', 'failed', 'unknown'];
const ACTIVE_STATUSES = ['queued', 'running', 'paused'];
const SORTABLE = ['company_name', 'email', 'status', 'created_at', 'updated_at'];

const DEFAULT_SETTINGS = {
  sender_email: '',
  sender_display_name: '',
  github_url: '',
  smtp_host: 'smtp.gmail.com',
  smtp_port: 465,
  send_delay_seconds: 5,
  smtp_timeout_seconds: 30,
  max_retries: 2,
  retry_delay_seconds: 10,
};

const PASSWORD_MASK = '********';

// --- error helpers ---------------------------------------------------------

function fail(error, fallback = 'The request failed.') {
  const message = String(error?.message || fallback);
  const code = String(error?.code || '');
  if (code === '23505' || /duplicate key/i.test(message)) {
    if (/recipients/i.test(message)) return new Error('A recipient with this email already exists.');
    return new Error('That record already exists.');
  }
  if (code === '42501' || /row-level security|permission denied/i.test(message)) {
    return new Error('You do not have access to that record.');
  }
  if (code === '23514' || /violates check constraint/i.test(message)) {
    return new Error('Some values were rejected as invalid. Check the form and try again.');
  }
  if (/failed to fetch|networkerror/i.test(message)) {
    return new Error('Network problem: could not reach Supabase. Your change was not saved.');
  }
  if (/jwt|not authenticated|invalid claim/i.test(message)) {
    return new Error('Your session has expired. Please sign in again.');
  }
  return new Error(message || fallback);
}

async function rows(promise, fallback) {
  const { data, error } = await promise;
  if (error) throw fail(error, fallback);
  return data ?? [];
}

async function one(promise, fallback, notFoundMessage) {
  const { data, error } = await promise;
  if (error) throw fail(error, fallback);
  if (data === null || data === undefined) throw new Error(notFoundMessage || 'Record not found.');
  return data;
}

function requireUser() {
  const user = currentUser();
  if (!user) throw new Error('Your session has expired. Please sign in again.');
  return user;
}

/**
 * PostgREST `or=` filters treat commas and parentheses as syntax, so strip them
 * from free-text search input instead of letting it break the query.
 */
function searchTerm(value) {
  return String(value ?? '').replace(/[,()%\\]/g, ' ').trim();
}

// --- mapping ---------------------------------------------------------------

function mapRecipient(row) {
  return {
    id: row.id,
    company_name: row.company_name,
    email: row.email,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_attempt_at: row.last_attempt_at,
  };
}

function countersFor(row, jobs = null) {
  if (jobs) {
    const counts = { pending: 0, sent: 0, failed: 0, unknown: 0, skipped: 0 };
    jobs.forEach((job) => { counts[job.status] = (counts[job.status] || 0) + 1; });
    const total = jobs.length;
    const processed = counts.sent + counts.failed + counts.unknown + counts.skipped;
    return {
      total,
      processed,
      sent: counts.sent,
      failed: counts.failed,
      unknown: counts.unknown,
      pending: counts.pending,
      progress: total ? Math.round((processed / total) * 1000) / 10 : 0,
    };
  }
  const total = row.total_recipients || 0;
  const processed = row.processed_count || 0;
  return {
    total,
    processed,
    sent: row.sent_count || 0,
    failed: row.failed_count || 0,
    unknown: row.unknown_count || 0,
    pending: Math.max(0, total - processed),
    progress: total ? Math.round((processed / total) * 1000) / 10 : 0,
  };
}

function mapCampaign(row, jobs = null, currentRecipient = null) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    template_id: row.template_ref || '',
    status: row.status,
    counters: countersFor(row, jobs),
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    current_recipient: currentRecipient,
    results: jobs
      ? Object.fromEntries(jobs.map((job) => [job.recipient_id || job.id, {
          recipient_id: job.recipient_id,
          company_name: job.company_name,
          email: job.email,
          status: job.status,
          attempts: job.attempts,
          last_error_category: job.last_error_category,
          last_error: job.last_error,
          last_attempt_at: job.last_attempt_at,
        }]))
      : {},
  };
}

// --- recipients ------------------------------------------------------------

export async function listRecipients(params = {}) {
  const client = requireClient();
  const { search = '', status = '', sort = 'created_at', order = 'desc' } = params;

  let query = client.from('recipients').select('*', { count: 'exact' });
  if (status && RECIPIENT_STATUSES.includes(status)) query = query.eq('status', status);
  const term = searchTerm(search);
  if (term) query = query.or(`company_name.ilike.%${term}%,email.ilike.%${term}%`);
  const column = SORTABLE.includes(sort) ? sort : 'created_at';
  query = query.order(column, { ascending: order === 'asc' });

  const { data, error, count } = await query;
  if (error) throw fail(error, 'Could not load recipients.');
  const items = (data ?? []).map(mapRecipient);
  return { items, total: typeof count === 'number' ? count : items.length };
}

export async function addRecipient({ company_name, email }) {
  const client = requireClient();
  const company = String(company_name ?? '').trim().replace(/\s+/g, ' ');
  const address = String(email ?? '').trim();
  if (!company) throw new Error('Company name is required.');
  if (!isValidEmail(address)) throw new Error('A valid email address is required.');
  const inserted = await one(
    client.from('recipients').insert({ company_name: company, email: address }).select().single(),
    'Could not add the recipient.',
  );
  return mapRecipient(inserted);
}

export async function updateRecipient(id, fields) {
  const client = requireClient();
  const patch = {};
  if ('company_name' in fields) {
    const company = String(fields.company_name ?? '').trim().replace(/\s+/g, ' ');
    if (!company) throw new Error('Company name is required.');
    patch.company_name = company;
  }
  if ('email' in fields) {
    const address = String(fields.email ?? '').trim();
    if (!isValidEmail(address)) throw new Error('A valid email address is required.');
    patch.email = address;
  }
  const updated = await one(
    client.from('recipients').update(patch).eq('id', id).select().single(),
    'Could not update the recipient.',
    'Recipient not found.',
  );
  return mapRecipient(updated);
}

export async function deleteRecipient(id) {
  const client = requireClient();
  const data = await rows(client.from('recipients').delete().eq('id', id).select('id'), 'Could not delete the recipient.');
  if (!data.length) throw new Error('Recipient not found.');
  return null;
}

export async function deleteRecipients(ids) {
  if (!ids?.length) return { deleted: 0 };
  const client = requireClient();
  const data = await rows(client.from('recipients').delete().in('id', ids).select('id'), 'Could not delete the recipients.');
  return { deleted: data.length };
}

export async function resetRecipientStatus(ids) {
  if (!ids?.length) return { reset: 0 };
  const client = requireClient();
  const data = await rows(
    client.from('recipients')
      .update({ status: 'pending' })
      .in('id', ids)
      .in('status', ['failed', 'unknown'])
      .select('id'),
    'Could not reset the recipients.',
  );
  return { reset: data.length };
}

// --- recipient import ------------------------------------------------------

function parseRecords(text, format) {
  const source = String(text ?? '').replace(/^\ufeff/, '');
  const parsed = [];

  if (format === 'json') {
    let payload;
    try {
      payload = JSON.parse(source);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
    if (!Array.isArray(payload)) {
      payload = payload?.recipients || payload?.data;
    }
    if (!Array.isArray(payload)) throw new Error('JSON must be an array of recipient objects.');
    payload.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      parsed.push({
        company_name: String(item.company_name ?? item.company ?? '').trim(),
        email: String(item.email ?? item.address ?? '').trim(),
      });
    });
    return parsed;
  }

  if (format !== 'csv') throw new Error('Unsupported import format.');

  // Small, quote-aware CSV reader (handles quoted fields and embedded commas).
  const rowsCsv = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += char;
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      record.push(field); field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      record.push(field); field = '';
      if (record.some((cell) => cell.trim() !== '')) rowsCsv.push(record);
      record = [];
    } else field += char;
  }
  if (field !== '' || record.length) {
    record.push(field);
    if (record.some((cell) => cell.trim() !== '')) rowsCsv.push(record);
  }
  if (!rowsCsv.length) throw new Error('CSV file has no header row.');

  const header = rowsCsv[0].map((cell) => cell.trim().toLowerCase());
  const pick = (names) => names.map((n) => header.indexOf(n)).find((index) => index !== -1);
  const companyIndex = pick(['company_name', 'company', 'name', 'organization']);
  const emailIndex = pick(['email', 'email_address', 'address', 'mail']);
  if (emailIndex === undefined) throw new Error("CSV must contain an 'email' column.");

  rowsCsv.slice(1).forEach((cells) => {
    parsed.push({
      company_name: String(cells[companyIndex] ?? '').trim(),
      email: String(cells[emailIndex] ?? '').trim(),
    });
  });
  return parsed;
}

async function existingRecipientEmails() {
  const client = requireClient();
  const data = await rows(client.from('recipients').select('email'), 'Could not read the recipient list.');
  return new Set(data.map((row) => String(row.email).trim().toLowerCase()));
}

export async function previewImport(format, content) {
  const records = parseRecords(content, format);
  const existing = await existingRecipientEmails();
  const seen = new Set();
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  const rowsOut = records.map((row, index) => {
    const company = String(row.company_name ?? '').trim().replace(/\s+/g, ' ');
    const email = String(row.email ?? '').trim();
    const key = email.toLowerCase();
    const issues = [];

    if (!company) issues.push('Missing company name');
    if (!isValidEmail(email)) issues.push('Invalid email address');
    else if (existing.has(key)) issues.push('Duplicate of existing recipient');
    else if (seen.has(key)) issues.push('Duplicate within import file');

    if (key) seen.add(key);

    const valid = issues.length === 0;
    if (valid) validCount += 1;
    else if (issues.some((issue) => issue.includes('Duplicate'))) duplicateCount += 1;
    else invalidCount += 1;

    return { row: index + 1, company_name: company, email, valid, issues };
  });

  return { rows: rowsOut, total: rowsOut.length, valid_count: validCount, invalid_count: invalidCount, duplicate_count: duplicateCount };
}

export async function commitImport(rowsIn) {
  const client = requireClient();
  const existing = await existingRecipientEmails();
  const payload = [];
  let skipped = 0;

  (rowsIn || []).forEach((row) => {
    const company = String(row?.company_name ?? '').trim().replace(/\s+/g, ' ');
    const email = String(row?.email ?? '').trim();
    const key = email.toLowerCase();
    if (!company || !isValidEmail(email) || existing.has(key)) { skipped += 1; return; }
    existing.add(key);
    payload.push({ company_name: company, email });
  });

  if (!payload.length) return { added: 0, skipped };

  const { data, error } = await client.from('recipients').insert(payload).select('id');
  if (error) {
    // A concurrent insert may have taken an address: retry row by row so one
    // conflict cannot silently discard the whole import.
    let added = 0;
    for (const row of payload) {
      const single = await client.from('recipients').insert(row).select('id');
      if (single.error) skipped += 1; else added += 1;
    }
    return { added, skipped };
  }
  return { added: (data ?? []).length, skipped };
}

// --- recipient export ------------------------------------------------------

export async function exportRecipients(format = 'csv') {
  const { items } = await listRecipients({});
  if (format === 'json') download('recipients.json', recipientsJson(items), 'application/json');
  else download('recipients.csv', recipientsCsv(items), 'text/csv;charset=utf-8');
}

// --- templates (local to this browser) -------------------------------------

export async function listTemplates() {
  const items = await templates.listSummary();
  return { items, default_design: { ...DEFAULT_DESIGN } };
}

export async function templateVariables() {
  return { variables: VARIABLE_GUIDE.map((item) => ({ ...item })), preview_note: 'Preview may differ slightly across email clients.' };
}

export async function getTemplate(id) {
  const record = await templates.get(id);
  if (!record) throw new Error('Template not found.');
  return record;
}

export async function createTemplate({ name, html, description = '', design = null }) {
  return templates.create({ name, html, description, design });
}

export async function updateTemplate(id, fields) {
  return templates.update(id, fields);
}

export async function deleteTemplate(id) {
  return templates.remove(id);
}

export async function duplicateTemplate(id, name = '') {
  return templates.duplicate(id, name);
}

export async function setDefaultTemplate(id) {
  return templates.setDefault(id);
}

export async function importTemplate({ name, content, description = '' }) {
  return templates.create({ name, html: content, description, design: cleanDesign(null) });
}

export async function previewTemplate(data) {
  return renderPreview(data);
}

export async function exportAllTemplatesJson() {
  const text = await templates.exportAllJson();
  download('seed-code-mail-templates.json', text, 'application/json');
}

export async function importTemplatesJson(text) {
  return templates.importJsonText(text);
}

export async function exportTemplateHtml(id) {
  const record = await templates.get(id);
  if (!record) throw new Error('Template not found.');
  download(templateFileName(record.name), record.html || '', 'text/html;charset=utf-8');
}

// --- settings (non-secret in Supabase, App Password only in the worker) -----

function mapSettings(row) {
  return {
    values: {
      SENDER_NAME: row.sender_display_name || '',
      GITHUB_URL: row.github_url || '',
      SMTP_HOST: row.smtp_host || DEFAULT_SETTINGS.smtp_host,
      SMTP_PORT: String(row.smtp_port ?? DEFAULT_SETTINGS.smtp_port),
      SEND_DELAY_SECONDS: String(row.send_delay_seconds ?? DEFAULT_SETTINGS.send_delay_seconds),
      SMTP_TIMEOUT_SECONDS: String(row.smtp_timeout_seconds ?? DEFAULT_SETTINGS.smtp_timeout_seconds),
      MAX_RETRIES: String(row.max_retries ?? DEFAULT_SETTINGS.max_retries),
      RETRY_DELAY_SECONDS: String(row.retry_delay_seconds ?? DEFAULT_SETTINGS.retry_delay_seconds),
    },
    email: row.sender_email || '',
    sender_name: row.sender_display_name || '',
    has_password: false,
    password_mask: '',
    worker: { available: false, error: '' },
  };
}

async function loadSettingsRow() {
  const client = requireClient();
  const user = requireUser();
  const { data, error } = await client.from('user_settings').select('*').eq('user_id', user.id).maybeSingle();
  if (error) throw fail(error, 'Could not load settings.');
  if (data) return data;
  // The signup trigger normally creates this row; upsert covers pre-existing
  // accounts and keeps "avoid duplicate profiles/settings" true for them too.
  const { data: created, error: createError } = await client
    .from('user_settings')
    .upsert({ user_id: user.id, ...DEFAULT_SETTINGS })
    .select()
    .single();
  if (createError) throw fail(createError, 'Could not initialise settings.');
  return created;
}

export async function getSettings() {
  const row = await loadSettingsRow();
  const result = mapSettings(row);

  // has_password lives in the worker's own environment, never in Postgres.
  try {
    const status = await worker.status();
    result.has_password = Boolean(status?.has_password);
    result.password_mask = result.has_password ? PASSWORD_MASK : '';
    result.worker = { available: true, error: '', configured: workerConfigured(), local: workerIsLocal(), queue: status?.queue || null };
    if (status?.sender_email) result.email = status.sender_email;
    if (status?.sender_name) result.sender_name = status.sender_name;
  } catch (error) {
    result.worker = {
      available: false,
      error: error.message,
      configured: workerConfigured(),
      local: workerIsLocal(),
      queue: null,
    };
  }
  return result;
}

export async function saveSettings(data) {
  const client = requireClient();
  const user = requireUser();

  const senderEmail = String(data.Email ?? '').trim();
  if (senderEmail && !isValidEmail(senderEmail)) throw new Error('Sender email address is not valid.');
  const github = String(data.GITHUB_URL ?? '').trim();
  if (github && !isValidUrl(github)) throw new Error('GitHub URL must be a full http(s) address, or left blank.');
  const host = String(data.SMTP_HOST ?? '').trim();
  if (!host) throw new Error('SMTP host is required.');

  const asInt = (value, label, { min = 0, allowZero = true } = {}) => {
    const number = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(number)) throw new Error(`${label} must be a whole number.`);
    if (number < min || (!allowZero && number === 0)) throw new Error(`${label} must be a positive number.`);
    return number;
  };

  const patch = {
    user_id: user.id,
    sender_email: senderEmail,
    sender_display_name: String(data.SENDER_NAME ?? '').trim().slice(0, 120),
    github_url: github,
    smtp_host: host.slice(0, 255),
    smtp_port: asInt(data.SMTP_PORT, 'SMTP port', { min: 1 }),
    send_delay_seconds: asInt(data.SEND_DELAY_SECONDS, 'Sending delay'),
    smtp_timeout_seconds: asInt(data.SMTP_TIMEOUT_SECONDS, 'Connection timeout', { min: 1, allowZero: false }),
    max_retries: asInt(data.MAX_RETRIES, 'Maximum retries'),
    retry_delay_seconds: asInt(data.RETRY_DELAY_SECONDS, 'Retry delay'),
  };
  if (patch.smtp_port > 65535) throw new Error('SMTP port must be between 1 and 65535.');

  const { error } = await client.from('user_settings').upsert(patch);
  if (error) throw fail(error, 'Could not save settings.');

  // The App Password is deliberately NOT persisted here. If one was supplied it
  // goes straight to the local worker, which writes it into its own protected
  // environment on this machine.
  const submittedPassword = String(data.GAPP_PASS ?? '').trim();
  if (submittedPassword && submittedPassword !== PASSWORD_MASK) {
    if (submittedPassword.length < 8) throw new Error('That App Password looks too short — Gmail App Passwords are 16 characters.');
    try {
      await worker.saveSettings({ GAPP_PASS: submittedPassword });
    } catch (error) {
      if (error instanceof WorkerUnavailableError) {
        throw new Error(
          'Settings saved, but the Gmail App Password was NOT stored because the send worker ' +
          `service could not be reached. ${workerUnavailableHelp()}`,
        );
      }
      throw error;
    }
  }

  return getSettings();
}

export async function resetSettings() {
  const client = requireClient();
  const user = requireUser();
  // Resets non-secret preferences only; the App Password lives in the worker.
  const { error } = await client.from('user_settings').upsert({ user_id: user.id, ...DEFAULT_SETTINGS });
  if (error) throw fail(error, 'Could not reset settings.');
  return getSettings();
}

export async function testSmtp() {
  try {
    return await worker.testSmtp();
  } catch (error) {
    if (error instanceof WorkerUnavailableError) {
      return {
        ok: false,
        category: 'worker',
        message: `SMTP cannot be tested because the send worker service is unavailable. ${workerUnavailableHelp()}`,
      };
    }
    return { ok: false, category: 'worker', message: error.message };
  }
}

export async function workerStatus() {
  try {
    const status = await worker.status();
    return { available: true, configured: workerConfigured(), local: workerIsLocal(), ...status };
  } catch (error) {
    return {
      available: false,
      // Distinguishes "this deployment has no worker configured" from "the
      // worker is configured but currently unreachable" — the UI says something
      // different (and useful) in each case.
      configured: workerConfigured(),
      local: workerIsLocal(),
      error: error.message,
      has_password: false,
      sending: false,
      queue: { configured: workerConfigured(), consumer_online: false, queued: 0, running: 0, last_seen_at: null },
    };
  }
}

// --- campaigns -------------------------------------------------------------

async function campaignJobs(campaignId) {
  const client = requireClient();
  return rows(
    client.from('campaign_recipients').select('*').eq('campaign_id', campaignId).order('created_at'),
    'Could not load the campaign queue.',
  );
}

export async function listCampaigns() {
  const client = requireClient();
  const data = await rows(
    client.from('campaigns').select('*').order('created_at', { ascending: false }),
    'Could not load campaigns.',
  );

  const active = data.find((row) => ACTIVE_STATUSES.includes(row.status));
  let currentRecipient = null;
  if (active) {
    const jobs = await rows(
      client.from('campaign_recipients')
        .select('recipient_id, company_name, email, status')
        .eq('campaign_id', active.id)
        .eq('status', 'pending')
        .order('created_at')
        .limit(1),
      '',
    );
    const first = jobs[0];
    if (first) currentRecipient = { id: first.recipient_id, company_name: first.company_name, email: first.email };
  }

  return {
    items: data.map((row) => mapCampaign(row, null, row.id === active?.id ? currentRecipient : null)),
  };
}

export async function getCampaign(id) {
  const client = requireClient();
  const campaign = await one(client.from('campaigns').select('*').eq('id', id).maybeSingle(), 'Could not load the campaign.', 'Campaign not found.');
  const jobs = await campaignJobs(id);
  const current = jobs.find((job) => job.status === 'pending');
  return mapCampaign(campaign, jobs, current ? { id: current.recipient_id, company_name: current.company_name, email: current.email } : null);
}

export async function createCampaign({ name, subject, template_id, recipient_ids }) {
  const client = requireClient();
  const user = requireUser();
  const cleanName = String(name ?? '').trim().slice(0, 120);
  // The subject is required per campaign; there is no global default.
  const cleanSubject = String(subject ?? '').trim().slice(0, 200);
  if (!cleanName) throw new Error('Campaign name is required.');
  if (!cleanSubject) throw new Error('Campaign subject is required.');

  const localTemplate = await templates.get(template_id);
  if (!localTemplate) throw new Error('Selected template was not found in this browser.');

  const uniqueIds = [...new Set((recipient_ids || []).filter(Boolean))];
  if (!uniqueIds.length) throw new Error('Select at least one recipient.');

  const selected = await rows(
    client.from('recipients').select('id, company_name, email').in('id', uniqueIds),
    'Could not load the selected recipients.',
  );
  if (!selected.length) throw new Error('None of the selected recipients still exist.');
  const incomplete = selected.filter((r) => !String(r.company_name || '').trim() || !String(r.email || '').trim());
  if (incomplete.length) {
    throw new Error(`${incomplete.length} selected recipient(s) are missing a company name or email address.`);
  }

  const campaign = await one(
    client.from('campaigns').insert({
      user_id: user.id,
      name: cleanName,
      subject: cleanSubject,
      template_ref: template_id,   // local reference only — never the HTML
      status: 'draft',
      total_recipients: selected.length,
    }).select().single(),
    'Could not create the campaign.',
  );

  const jobRows = selected.map((recipient) => ({
    user_id: user.id,
    campaign_id: campaign.id,
    recipient_id: recipient.id,
    company_name: recipient.company_name,
    email: recipient.email,
    status: 'pending',
  }));

  const { error: jobError } = await client.from('campaign_recipients').insert(jobRows);
  if (jobError) {
    // No multi-statement transaction available over PostgREST: roll the parent
    // back so a failed queue insert cannot leave a half-built campaign.
    await client.from('campaigns').delete().eq('id', campaign.id);
    throw fail(jobError, 'Could not build the campaign queue.');
  }

  return getCampaign(campaign.id);
}

async function setCampaignStatus(id, status, extra = {}) {
  const client = requireClient();
  const { error } = await client.from('campaigns').update({ status, ...extra }).eq('id', id);
  if (error) throw fail(error, 'Could not update the campaign.');
}

async function pendingJobPayload(campaign) {
  const client = requireClient();
  const jobs = await rows(
    client.from('campaign_recipients')
      .select('id, recipient_id, company_name, email, status')
      .eq('campaign_id', campaign.id)
      .in('status', ['pending', 'failed', 'unknown'])
      .order('created_at'),
    'Could not read the campaign queue.',
  );
  const queue = jobs.filter((job) => job.status !== 'sent');
  return queue.map((job) => ({
    job_id: job.id,
    recipient_id: job.recipient_id,
    company_name: job.company_name,
    email: job.email,
  }));
}

/**
 * The run snapshot the send worker needs, taken from the campaign's own
 * (browser-local) template plus the account's sending preferences.
 *
 * It is written to the owner's `campaigns` row, which is protected by RLS, so
 * the worker can send the campaign even when this browser is closed. Nothing
 * secret is included: the Gmail App Password never leaves the worker host.
 */
async function runSnapshot(campaign) {
  const template = await templates.get(campaign.template_id);
  if (!template) throw new Error('The template for this campaign was not found in this browser.');
  const settings = await loadSettingsRow();
  return {
    template_html: template.html || '',
    template_design: template.design || {},
    run_config: {
      sender_name: settings.sender_display_name || '',
      sender_email: settings.sender_email || '',
      github_url: settings.github_url || '',
      smtp_host: settings.smtp_host || '',
      smtp_port: settings.smtp_port ?? null,
      smtp_timeout_seconds: settings.smtp_timeout_seconds ?? null,
      send_delay_seconds: settings.send_delay_seconds ?? null,
      max_retries: settings.max_retries ?? null,
      retry_delay_seconds: settings.retry_delay_seconds ?? null,
    },
  };
}

/**
 * Queues a campaign for the send worker.
 *
 * This no longer requires a local Python process: the campaign (with its run
 * snapshot) is stored in Supabase, a continuously available worker claims it and
 * reports progress back into the same tables the UI already reads. If the worker
 * is down the campaign simply waits in `queued` — the browser can be closed.
 */
export async function startCampaign(id) {
  const client = requireClient();
  const campaign = await getCampaign(id);
  if (!ACTIVE_STATUSES.includes(campaign.status) && campaign.counters.pending === 0 && campaign.counters.processed > 0) {
    throw new Error('This campaign has already completed.');
  }

  const queue = await pendingJobPayload(campaign);
  if (!queue.length) throw new Error('There is nothing left to send in this campaign.');
  const snapshot = await runSnapshot(campaign);

  const { error } = await client.from('campaigns').update({
    status: 'queued',
    queued_at: new Date().toISOString(),
    finished_at: null,
    // Fresh queue entry: clear the previous run's cooperative flags/errors.
    pause_requested: false,
    cancel_requested: false,
    last_error: '',
    ...snapshot,
  }).eq('id', id);
  if (error) throw fail(error, 'Could not queue the campaign.');

  return getCampaign(id);
}

export async function pauseCampaign(id) {
  const client = requireClient();
  // Flag in the database: every worker and every tab sees the same truth, and
  // the run stops between delivery attempts.
  const { error } = await client.from('campaigns')
    .update({ pause_requested: true, status: 'paused' })
    .eq('id', id);
  if (error) throw fail(error, 'Could not pause the campaign.');
  return getCampaign(id);
}

export async function resumeCampaign(id) {
  const client = requireClient();
  const campaign = await getCampaign(id);
  const queue = await pendingJobPayload(campaign);
  if (!queue.length) throw new Error('There is nothing left to send in this campaign.');
  // The snapshot is refreshed here too, so a campaign queued before a template
  // change (or before this version) still has a sendable template.
  const snapshot = await runSnapshot(campaign);
  const { error } = await client.from('campaigns').update({
    status: 'queued',
    queued_at: new Date().toISOString(),
    pause_requested: false,
    cancel_requested: false,
    ...snapshot,
  }).eq('id', id);
  if (error) throw fail(error, 'Could not resume the campaign.');
  return getCampaign(id);
}

export async function cancelCampaign(id) {
  const client = requireClient();
  const { error } = await client.from('campaigns')
    .update({
      cancel_requested: true,
      pause_requested: false,
      status: 'cancelled',
      finished_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw fail(error, 'Could not cancel the campaign.');
  return getCampaign(id);
}

export async function deleteCampaign(id) {
  const client = requireClient();
  const campaign = await getCampaign(id);
  if (['queued', 'running'].includes(campaign.status)) {
    throw new Error('Pause or cancel the campaign before deleting it.');
  }
  const { error } = await client.from('campaigns').delete().eq('id', id);
  if (error) throw fail(error, 'Could not delete the campaign.');
  return null;
}

// --- history ---------------------------------------------------------------

export async function listHistory(params = {}) {
  const client = requireClient();
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const pageSize = Math.min(Math.max(1, Number.parseInt(params.page_size, 10) || 25), 200);
  const from = (page - 1) * pageSize;

  let query = client.from('email_history').select('*', { count: 'exact' });
  if (params.status) query = query.eq('status', params.status);
  if (params.campaign_id) query = query.eq('campaign_id', params.campaign_id);
  if (params.date_from) query = query.gte('created_at', `${params.date_from}T00:00:00.000Z`);
  if (params.date_to) query = query.lte('created_at', `${params.date_to}T23:59:59.999Z`);
  const term = searchTerm(params.search);
  if (term) query = query.or(`company_name.ilike.%${term}%,email.ilike.%${term}%,subject.ilike.%${term}%`);
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw fail(error, 'Could not load email history.');

  const campaignNames = new Map(
    (await rows(client.from('campaigns').select('id, name'), '')).map((row) => [row.id, row.name]),
  );
  const items = (data ?? []).map((row) => ({
    id: row.id,
    timestamp: row.created_at,       // `timestamp` kept for UI compatibility
    created_at: row.created_at,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_id ? campaignNames.get(row.campaign_id) || '' : '',
    recipient_id: row.recipient_id,
    company_name: row.company_name,
    email: row.email,
    subject: row.subject,
    attempt: row.attempt,
    status: row.status,
    error_category: row.error_category,
    error_message: row.error_message,
  }));

  const total = typeof count === 'number' ? count : items.length;
  return { items, total, page, page_size: pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function exportHistory(params = {}) {
  const format = params.format === 'json' ? 'json' : 'csv';
  const data = await listHistory({ ...params, page: 1, page_size: 200 });
  if (format === 'json') download('email_history.json', historyJson(data.items), 'application/json');
  else download('email_history.csv', historyCsv(data.items), 'text/csv;charset=utf-8');
}

export async function clearHistory() {
  const client = requireClient();
  const data = await rows(client.from('email_history').delete().not('id', 'is', null).select('id'), 'Could not clear history.');
  return { cleared: data.length };
}

// --- dashboard -------------------------------------------------------------

async function countRows(build) {
  const { count, error } = await build();
  if (error) throw fail(error, 'Could not load the dashboard.');
  return count || 0;
}

export async function getDashboard() {
  const client = requireClient();
  const statusCount = (status) =>
    countRows(() => client.from('recipients').select('*', { count: 'exact', head: true }).eq('status', status));

  const [total, pending, sent, failed, unknown, campaigns, recent, settings] = await Promise.all([
    countRows(() => client.from('recipients').select('*', { count: 'exact', head: true })),
    statusCount('pending'),
    statusCount('sent'),
    statusCount('failed'),
    statusCount('unknown'),
    listCampaigns(),
    listHistory({ page: 1, page_size: 8 }),
    getSettings(),
  ]);

  const active = campaigns.items.find((campaign) => ACTIVE_STATUSES.includes(campaign.status)) || null;
  const workerAvailable = Boolean(settings.worker?.available);

  return {
    recipients: { total, pending, sent, failed, unknown },
    campaigns: {
      total: campaigns.items.length,
      active: active?.id || null,
      active_name: active?.name || null,
      active_counters: active?.counters || null,
    },
    smtp: {
      // "Configured" means the worker can actually authenticate — not merely
      // that some fields are filled in.
      configured: Boolean(workerAvailable && settings.has_password && settings.email),
      has_password: Boolean(settings.has_password),
      sender_email: settings.email || '',
      sender_name: settings.sender_name || '',
      host: settings.values.SMTP_HOST || '',
      port: Number(settings.values.SMTP_PORT) || 0,
      worker_available: workerAvailable,
      worker_error: settings.worker?.error || '',
      // Real queue availability, so the dashboard can explain *why* sending is
      // waiting instead of showing a generic failure.
      worker_configured: settings.worker?.configured !== false,
      worker_queue_configured: Boolean(settings.worker?.queue?.configured ?? settings.worker?.configured),
      worker_queue_online: Boolean(settings.worker?.queue?.consumer_online),
      worker_queue_depth: Number(settings.worker?.queue?.queued || 0),
      worker_note: describeWorkerState(settings.worker),
    },
    recent_activity: recent.items,
  };
}

/**
 * Plain-language worker state for the dashboard notice. It never claims emails
 * can be sent right now unless the worker really is available and ready.
 */
function describeWorkerState(worker) {
  const configured = worker?.configured !== false;
  const available = Boolean(worker?.available);
  const queueOnline = Boolean(worker?.queue?.consumer_online);
  const waiting = Number(worker?.queue?.queued || 0);
  const queuedNote = waiting ? ` ${waiting} campaign(s) are waiting in the queue.` : '';

  if (!configured) {
    return 'Campaigns stay queued because no send worker is configured for this deployment.';
  }
  if (!available) {
    if (worker?.local) {
      return 'The send worker is not reachable. For local development, start it with "python worker/main.py".';
    }
    return `The send worker service is not reachable right now.${queuedNote || ' Queued campaigns are delivered automatically when it returns.'}`;
  }
  if (!queueOnline) {
    return `The send worker is starting up.${queuedNote}`;
  }
  if (!worker?.has_password) {
    return 'Add your Gmail App Password in Settings so the worker can send campaigns.';
  }
  return '';
}

export async function health() {
  const client = requireClient();
  const { error } = await client.from('profiles').select('id', { count: 'exact', head: true });
  if (error) throw fail(error, 'Supabase is unreachable.');
  return { status: 'ok', app: 'Seed Code Mail', version: APP_VERSION };
}

// --- profile ---------------------------------------------------------------

/**
 * The signed-in user's application profile row.
 *
 * Only non-secret, user-owned metadata lives here (a display name and its
 * timestamps). Credentials — including any Gmail authorization — are never part
 * of this record and are never readable through the public API key.
 */
export async function getProfile() {
  const client = requireClient();
  const user = requireUser();
  const { data, error } = await client
    .from('profiles')
    .select('id, display_name, created_at, updated_at')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw fail(error, 'Could not load your profile.');
  return data || { id: user.id, display_name: '', created_at: null, updated_at: null };
}

/** Saves the display name on the `profiles` row (RLS restricts it to its owner). */
export async function saveProfile({ display_name }) {
  const client = requireClient();
  const user = requireUser();
  const name = String(display_name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const { data, error } = await client
    .from('profiles')
    .upsert({ id: user.id, display_name: name })
    .select('id, display_name, created_at, updated_at')
    .single();
  if (error) throw fail(error, 'Could not update your profile.');
  return data;
}

// --- compatibility surface used by the UI modules --------------------------

export const api = {
  health,
  dashboard: getDashboard,

  profile: getProfile,
  saveProfile,

  recipients: listRecipients,
  addRecipient,
  updateRecipient,
  deleteRecipient,
  deleteRecipients,
  resetRecipientStatus,
  previewImport,
  commitImport,
  exportRecipients,

  templates: listTemplates,
  templateVariables,
  template: getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  duplicateTemplate,
  setDefaultTemplate,
  previewTemplate,
  importTemplate,
  exportTemplateHtml,
  exportAllTemplatesJson,
  importTemplatesJson,

  settings: getSettings,
  saveSettings,
  testSmtp,
  resetSettings,
  workerStatus,

  campaigns: listCampaigns,
  campaign: getCampaign,
  createCampaign,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  deleteCampaign,

  history: listHistory,
  exportHistory,
  clearHistory,
};
