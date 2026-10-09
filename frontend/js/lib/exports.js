// Seed Code Mail — client-side exports
//
// The old build streamed CSV/JSON from the Python server. On a static host
// there is no such endpoint, so exports are generated in the browser from the
// rows already loaded/downloaded from Supabase.

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach((row) => lines.push(row.map(csvCell).join(',')));
  return lines.join('\n') + '\n';
}

export function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const RECIPIENT_HEADERS = [
  'company_name', 'email', 'status', 'created_at', 'updated_at', 'last_attempt_at',
];

export function recipientsCsv(items) {
  return toCsv(
    ['id', ...RECIPIENT_HEADERS],
    items.map((r) => [r.id, r.company_name, r.email, r.status, r.created_at, r.updated_at, r.last_attempt_at || '']),
  );
}

export function recipientsJson(items) {
  return JSON.stringify({ recipients: items }, null, 2);
}

export const HISTORY_HEADERS = [
  'created_at', 'campaign_id', 'campaign_name', 'recipient_id', 'company_name',
  'email', 'subject', 'attempt', 'status', 'error_category', 'error_message',
];

export function historyCsv(items) {
  return toCsv(
    ['id', ...HISTORY_HEADERS],
    items.map((h) => [
      h.id, h.created_at, h.campaign_id || '', h.campaign_name || '', h.recipient_id || '',
      h.company_name, h.email, h.subject, h.attempt, h.status,
      h.error_category || '', h.error_message || '',
    ]),
  );
}

export function historyJson(items) {
  return JSON.stringify({ history: items }, null, 2);
}

/** Safe, human-readable file name for an HTML template export. */
export function templateFileName(name) {
  const cleaned = String(name || 'template').replace(/[^a-z0-9 \-_]/gi, '').trim();
  return `${cleaned || 'template'}.html`;
}
