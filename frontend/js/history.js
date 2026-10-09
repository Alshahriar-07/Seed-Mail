// Seed Code Mail - email history page

import { api } from './api.js';
import {
  escapeHtml, icon, formatDate, refreshIcons, statusBadge,
  skeleton, emptyState, openModal, confirmDialog, toast,
} from './ui.js';

const state = { search: '', status: '', campaign_id: '', date_from: '', date_to: '', page: 1, page_size: 25 };
let host = null;
let campaigns = [];

async function load() {
  const body = host.querySelector('#history-body');
  body.innerHTML = skeleton(5);
  const params = { ...state };
  const data = await api.history(params);

  if (!data.items.length) {
    body.innerHTML = emptyState({
      title: 'No history found',
      message: 'No records match the current filters. Sending history appears here after campaigns run.',
      iconName: 'history',
    });
    host.querySelector('#pagination').innerHTML = '';
    return;
  }

  body.innerHTML = `
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Time</th><th>Company</th><th>Email</th><th>Status</th><th>Attempt</th><th>Error</th><th style="text-align:right;">Details</th></tr></thead>
      <tbody>${data.items.map((h) => `<tr>
        <td class="cell-muted">${formatDate(h.timestamp)}</td>
        <td class="cell-strong">${escapeHtml(h.company_name)}</td>
        <td class="cell-muted">${escapeHtml(h.email)}</td>
        <td>${statusBadge(h.status)}</td>
        <td>${h.attempt}</td>
        <td class="cell-muted" style="font-size:12px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(h.error_message || h.error_category || '—')}</td>
        <td><div class="row-actions"><button class="icon-btn" data-view="${escapeHtml(h.id)}">${icon('eye', 15)}</button></div></td>
      </tr>`).join('')}</tbody></table></div>`;
  refreshIcons(body);

  body.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    const record = data.items.find((h) => h.id === b.dataset.view);
    openModal({
      title: 'History detail',
      body: `
        <div class="kv"><span>Time</span><span>${formatDate(record.timestamp)}</span></div>
        <div class="kv"><span>Company</span><span>${escapeHtml(record.company_name)}</span></div>
        <div class="kv"><span>Email</span><span>${escapeHtml(record.email)}</span></div>
        <div class="kv"><span>Subject</span><span>${escapeHtml(record.subject)}</span></div>
        <div class="kv"><span>Campaign</span><span>${escapeHtml(record.campaign_name || record.campaign_id)}</span></div>
        <div class="kv"><span>Status</span><span>${escapeHtml(record.status)}</span></div>
        <div class="kv"><span>Attempt</span><span>${record.attempt}</span></div>
        <div class="kv"><span>Error category</span><span>${escapeHtml(record.error_category || '—')}</span></div>
        <div class="kv"><span>Error message</span><span>${escapeHtml(record.error_message || '—')}</span></div>`,
      actions: [{ label: 'Close' }],
    });
  }));

  const pag = host.querySelector('#pagination');
  pag.innerHTML = `
    <span>${data.total} record(s) · page ${data.page} of ${data.pages}</span>
    <span class="pages">
      <button class="btn btn-sm btn-secondary" id="pg-prev" ${data.page <= 1 ? 'disabled' : ''}>Prev</button>
      <button class="btn btn-sm btn-secondary" id="pg-next" ${data.page >= data.pages ? 'disabled' : ''}>Next</button>
    </span>`;
  pag.querySelector('#pg-prev')?.addEventListener('click', () => { state.page -= 1; load(); });
  pag.querySelector('#pg-next')?.addEventListener('click', () => { state.page += 1; load(); });
}

async function exportHistory(format) {
  // Exports are generated in the browser from the current filters.
  await api.exportHistory({
    format,
    search: state.search,
    status: state.status,
    campaign_id: state.campaign_id,
    date_from: state.date_from,
    date_to: state.date_to,
  });
}

export async function render(container) {
  host = container;
  Object.assign(state, { search: '', status: '', campaign_id: '', date_from: '', date_to: '', page: 1 });

  container.innerHTML = `
    <div class="page-head">
      <div><h2>Email History</h2><p>Every submission attempt, persisted across restarts.</p></div>
      <div class="page-actions">
        <button class="btn btn-secondary" id="btn-export-csv">${icon('download', 16)} Export CSV</button>
        <button class="btn btn-secondary" id="btn-export-json">${icon('download', 16)} Export JSON</button>
        <button class="btn btn-ghost" id="btn-clear">${icon('trash-2', 16)} Clear history</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="search-input">${icon('search', 16)}<input class="input" id="h-search" placeholder="Search company, email, subject"></div>
      <select class="select" id="h-status"><option value="">All statuses</option><option value="sent">Submitted</option><option value="failed">Failed</option><option value="unknown">Unknown</option></select>
      <select class="select" id="h-campaign"><option value="">All campaigns</option></select>
      <input class="input" type="date" id="h-from" title="From date">
      <input class="input" type="date" id="h-to" title="To date">
    </div>
    <div id="history-body"></div>
    <div class="pagination" id="pagination"></div>`;

  refreshIcons(container);

  try {
    const data = await api.campaigns();
    campaigns = data.items;
    const sel = container.querySelector('#h-campaign');
    sel.innerHTML = '<option value="">All campaigns</option>' + campaigns.map((c) =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  } catch (_) { /* ignore */ }

  let timer;
  container.querySelector('#h-search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.search = e.target.value; state.page = 1; load(); }, 300);
  });
  container.querySelector('#h-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });
  container.querySelector('#h-campaign').addEventListener('change', (e) => { state.campaign_id = e.target.value; state.page = 1; load(); });
  container.querySelector('#h-from').addEventListener('change', (e) => { state.date_from = e.target.value; state.page = 1; load(); });
  container.querySelector('#h-to').addEventListener('change', (e) => { state.date_to = e.target.value; state.page = 1; load(); });

  container.querySelector('#btn-export-csv').addEventListener('click', () => { exportHistory('csv').catch((e) => toast(e.message, 'error')); });
  container.querySelector('#btn-export-json').addEventListener('click', () => { exportHistory('json').catch((e) => toast(e.message, 'error')); });
  container.querySelector('#btn-clear').addEventListener('click', async () => {
    const ok = await confirmDialog('Delete all email history records? This cannot be undone.', { title: 'Clear history', confirmLabel: 'Clear all', danger: true });
    if (!ok) return;
    try { const res = await api.clearHistory(); toast(`${res.cleared} record(s) cleared.`, 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  });

  await load();
  return () => clearTimeout(timer);
}
