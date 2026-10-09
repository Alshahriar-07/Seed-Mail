// Seed Code Mail - recipients page

import { api } from './api.js';
import {
  escapeHtml, icon, formatDate, refreshIcons, statusBadge,
  skeleton, emptyState, openModal, confirmDialog, toast, spinner,
} from './ui.js';

const state = {
  search: '',
  status: '',
  sort: 'created_at',
  order: 'desc',
  items: [],
  selected: new Set(),
};

let host = null;

async function load() {
  const tableHost = host.querySelector('#recipients-table');
  tableHost.innerHTML = skeleton(4);
  const params = { search: state.search, status: state.status, sort: state.sort, order: state.order };
  const data = await api.recipients(params);
  state.items = data.items;
  for (const id of [...state.selected]) {
    if (!state.items.some((r) => r.id === id)) state.selected.delete(id);
  }
  paintTable();
  paintBulkBar();
}

function paintTable() {
  const tableHost = host.querySelector('#recipients-table');
  if (!state.items.length) {
    const filtered = state.search || state.status;
    tableHost.innerHTML = emptyState({
      title: filtered ? 'No matching recipients' : 'No recipients yet',
      message: filtered
        ? 'Try adjusting your search or filters.'
        : 'Add a recipient manually or import a CSV / JSON file to get started.',
      actionLabel: filtered ? '' : 'Add recipient',
      actionId: 'empty-add',
      iconName: 'users',
    });
    host.querySelector('#empty-add')?.addEventListener('click', () => openRecipientModal());
    return;
  }

  const sortIcon = (key) => (state.sort === key ? (state.order === 'asc' ? 'chevron-up' : 'chevron-down') : '');

  tableHost.innerHTML = `
    <div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th style="width:36px;"><input type="checkbox" id="select-all" ${state.selected.size === state.items.length && state.items.length ? 'checked' : ''}></th>
          <th class="sortable" data-sort="company_name">Company ${icon(sortIcon('company_name'), 13)}</th>
          <th class="sortable" data-sort="email">Email ${icon(sortIcon('email'), 13)}</th>
          <th class="sortable" data-sort="status">Status ${icon(sortIcon('status'), 13)}</th>
          <th class="sortable" data-sort="updated_at">Last attempt ${icon(sortIcon('updated_at'), 13)}</th>
          <th style="text-align:right;">Actions</th>
        </tr></thead>
        <tbody>
          ${state.items.map((r) => `
            <tr data-id="${escapeHtml(r.id)}">
              <td><input type="checkbox" class="row-check" data-id="${escapeHtml(r.id)}" ${state.selected.has(r.id) ? 'checked' : ''}></td>
              <td class="cell-strong">${escapeHtml(r.company_name)}</td>
              <td class="cell-muted">${escapeHtml(r.email)}</td>
              <td>${statusBadge(r.status)}</td>
              <td class="cell-muted">${formatDate(r.last_attempt_at || r.updated_at)}</td>
              <td><div class="row-actions">
                <button class="icon-btn" data-edit="${escapeHtml(r.id)}" title="Edit">${icon('pencil', 15)}</button>
                <button class="icon-btn danger" data-delete="${escapeHtml(r.id)}" title="Delete">${icon('trash-2', 15)}</button>
              </div></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <span>${state.items.length} recipient${state.items.length === 1 ? '' : 's'}</span>
      <span class="cell-muted">Select rows and use the toolbar for bulk actions.</span>
    </div>`;

  refreshIcons(tableHost);

  tableHost.querySelector('#select-all')?.addEventListener('change', (e) => {
    if (e.target.checked) state.items.forEach((r) => state.selected.add(r.id));
    else state.selected.clear();
    paintTable();
    paintBulkBar();
  });
  tableHost.querySelectorAll('.row-check').forEach((cb) => cb.addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
    paintBulkBar();
  }));
  tableHost.querySelectorAll('[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sort === key) state.order = state.order === 'asc' ? 'desc' : 'asc';
    else { state.sort = key; state.order = 'asc'; }
    load();
  }));
  tableHost.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const record = state.items.find((r) => r.id === btn.dataset.edit);
    openRecipientModal(record);
  }));
  tableHost.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    const record = state.items.find((r) => r.id === btn.dataset.delete);
    const ok = await confirmDialog(`Delete ${record.company_name}? This cannot be undone.`, { title: 'Delete recipient', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deleteRecipient(record.id);
      state.selected.delete(record.id);
      toast('Recipient deleted.', 'success');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }));
}

function paintBulkBar() {
  const bar = host.querySelector('#bulk-bar');
  if (!state.selected.size) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `
    <span class="chip">${icon('check-square', 14)} ${state.selected.size} selected</span>
    <button class="btn btn-secondary btn-sm" id="bulk-retry">${icon('rotate-ccw', 15)} Reset for retry</button>
    <button class="btn btn-danger btn-sm" id="bulk-delete">${icon('trash-2', 15)} Delete selected</button>
    <button class="btn btn-ghost btn-sm" id="bulk-clear">Clear</button>`;
  refreshIcons(bar);

  bar.querySelector('#bulk-clear').addEventListener('click', () => { state.selected.clear(); paintTable(); paintBulkBar(); });
  bar.querySelector('#bulk-retry').addEventListener('click', async () => {
    try {
      const res = await api.resetRecipientStatus([...state.selected]);
      toast(`${res.reset} recipient(s) reset to pending.`, 'success');
      state.selected.clear();
      load();
    } catch (e) { toast(e.message, 'error'); }
  });
  bar.querySelector('#bulk-delete').addEventListener('click', async () => {
    const ok = await confirmDialog(`Delete ${state.selected.size} recipient(s)? This cannot be undone.`, { title: 'Delete recipients', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const res = await api.deleteRecipients([...state.selected]);
      toast(`${res.deleted} recipient(s) deleted.`, 'success');
      state.selected.clear();
      load();
    } catch (e) { toast(e.message, 'error'); }
  });
}

function openRecipientModal(record = null) {
  const isEdit = !!record;
  const body = `
    <form id="recipient-form">
      <div class="field">
        <label for="rc-company">Company name</label>
        <input class="input" id="rc-company" maxlength="200" placeholder="Example Company" value="${escapeHtml(record ? record.company_name : '')}">
        <div class="error-text" id="rc-company-error" style="display:none;"></div>
      </div>
      <div class="field">
        <label for="rc-email">Email address</label>
        <input class="input" id="rc-email" type="email" maxlength="254" placeholder="contact@example.com" value="${escapeHtml(record ? record.email : '')}">
        <div class="error-text" id="rc-email-error" style="display:none;"></div>
      </div>
      <div class="notice">${icon('info', 16)} Duplicate email addresses are rejected case-insensitively.</div>
    </form>`;

  openModal({
    title: isEdit ? 'Edit recipient' : 'Add recipient',
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: isEdit ? 'Save changes' : 'Add recipient',
        variant: 'btn-primary',
        onClick: async ({ close }) => {
          const company = document.getElementById('rc-company').value.trim();
          const email = document.getElementById('rc-email').value.trim();
          const companyErr = document.getElementById('rc-company-error');
          const emailErr = document.getElementById('rc-email-error');
          companyErr.style.display = emailErr.style.display = 'none';
          let bad = false;
          if (!company) { companyErr.textContent = 'Company name is required.'; companyErr.style.display = 'block'; bad = true; }
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { emailErr.textContent = 'Enter a valid email address.'; emailErr.style.display = 'block'; bad = true; }
          if (bad) return false;
          try {
            if (isEdit) await api.updateRecipient(record.id, { company_name: company, email });
            else await api.addRecipient({ company_name: company, email });
            toast(isEdit ? 'Recipient updated.' : 'Recipient added.', 'success');
            close();
            load();
          } catch (e) {
            toast(e.message, 'error');
            return false;
          }
        },
      },
    ],
  });
}

function openImportModal() {
  const body = `
    <div class="tabs" style="margin-bottom:16px;">
      <button class="tab active" data-tab="file">Upload file</button>
      <button class="tab" data-tab="paste">Paste text</button>
    </div>
    <div data-pane="file">
      <div class="field">
        <label for="imp-format">File type</label>
        <select class="select" id="imp-format"><option value="csv">CSV</option><option value="json">JSON</option></select>
      </div>
      <div class="field">
        <label for="imp-file">Choose a file</label>
        <input class="input" type="file" id="imp-file" accept=".csv,.json">
        <div class="hint">CSV needs an <code>email</code> column and a <code>company_name</code> column. JSON should be an array of {company_name, email}.</div>
      </div>
    </div>
    <div data-pane="paste" style="display:none;">
      <div class="field">
        <label for="imp-text">Paste CSV or JSON</label>
        <textarea class="textarea" id="imp-text" rows="8" placeholder="company_name,email&#10;Example Company,contact@example.com"></textarea>
      </div>
    </div>
    <div id="import-preview"></div>`;

  const modal = openModal({
    title: 'Import recipients',
    body,
    size: 'lg',
    actions: [
      { label: 'Cancel' },
      { label: 'Preview', variant: 'btn-secondary', closeOnClick: false, onClick: () => preview() },
      { label: 'Import valid rows', variant: 'btn-primary', closeOnClick: false, onClick: () => commit(modal) },
    ],
  });

  const overlay = modal.overlay;
  overlay.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    overlay.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    overlay.querySelectorAll('[data-pane]').forEach((p) => { p.style.display = p.dataset.pane === tab.dataset.tab ? '' : 'none'; });
  }));

  async function gather() {
    const format = document.getElementById('imp-format').value;
    const activeTab = overlay.querySelector('.tab.active').dataset.tab;
    if (activeTab === 'paste') return { format, content: document.getElementById('imp-text').value };
    const fileInput = document.getElementById('imp-file');
    if (!fileInput.files.length) throw new Error('Choose a file first.');
    const content = await fileInput.files[0].text();
    const name = fileInput.files[0].name.toLowerCase();
    return { format: name.endsWith('.json') ? 'json' : format, content };
  }

  async function preview() {
    const previewHost = document.getElementById('import-preview');
    previewHost.innerHTML = spinner('Validating');
    refreshIcons(previewHost);
    try {
      const { format, content } = await gather();
      const result = await api.previewImport(format, content);
      window.__scmImportRows = result.rows.filter((r) => r.valid);
      previewHost.innerHTML = `
        <div class="notice ${result.valid_count ? 'notice-success' : 'notice-warning'}" style="margin-bottom:12px;">
          ${icon(result.valid_count ? 'check-circle-2' : 'triangle-alert', 16)}
          <span>${result.valid_count} valid · ${result.invalid_count} invalid · ${result.duplicate_count} duplicate (of ${result.total})</span>
        </div>
        <div class="table-wrap" style="max-height:260px; overflow:auto;">
          <table class="data"><thead><tr><th>#</th><th>Company</th><th>Email</th><th>Status</th></tr></thead>
          <tbody>${result.rows.map((r) => `
            <tr><td>${r.row}</td><td>${escapeHtml(r.company_name || '—')}</td><td class="cell-muted">${escapeHtml(r.email || '—')}</td>
            <td>${r.valid ? '<span class="badge badge-sent">Ready</span>' : `<span class="badge badge-failed">${escapeHtml(r.issues.join(', '))}</span>`}</td></tr>`).join('')}
          </tbody></table>
        </div>`;
      refreshIcons(previewHost);
    } catch (e) {
      previewHost.innerHTML = `<div class="notice notice-error">${icon('alert-circle', 16)} <span>${escapeHtml(e.message)}</span></div>`;
      refreshIcons(previewHost);
    }
  }

  async function commit(modalRef) {
    const rows = window.__scmImportRows;
    if (!rows || !rows.length) { toast('Preview the import and fix issues first.', 'warning'); return false; }
    try {
      const res = await api.commitImport(rows);
      toast(`Imported ${res.added} recipient(s), skipped ${res.skipped}.`, 'success');
      modalRef.close();
      load();
    } catch (e) { toast(e.message, 'error'); return false; }
  }
}

export async function render(container, { params = [] } = {}) {
  host = container;
  state.selected.clear();

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Recipients</h2>
        <p>Manage companies and recipient addresses used by your campaigns.</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary" id="btn-import">${icon('upload', 16)} Import</button>
        <button class="btn btn-secondary" id="btn-export">${icon('download', 16)} Export</button>
        <button class="btn btn-primary" id="btn-add">${icon('user-plus', 16)} Add recipient</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="search-input">${icon('search', 16)}<input class="input" id="rc-search" placeholder="Search company or email" value="${escapeHtml(state.search)}"></div>
      <select class="select" id="rc-status">
        <option value="">All statuses</option>
        <option value="pending">Pending</option>
        <option value="sent">Submitted</option>
        <option value="failed">Failed</option>
        <option value="unknown">Unknown</option>
      </select>
    </div>
    <div class="toolbar" id="bulk-bar" style="display:none;"></div>
    <div id="recipients-table"></div>`;

  container.querySelector('#rc-status').value = state.status;
  refreshIcons(container);

  const search = container.querySelector('#rc-search');
  let timer;
  search.addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.search = e.target.value; load(); }, 300);
  });
  container.querySelector('#rc-status').addEventListener('change', (e) => { state.status = e.target.value; load(); });
  container.querySelector('#btn-add').addEventListener('click', () => openRecipientModal());
  container.querySelector('#btn-import').addEventListener('click', openImportModal);
  container.querySelector('#btn-export').addEventListener('click', () => {
    openModal({
      title: 'Export recipients',
      body: '<p class="modal-text">Choose a format. The file is generated in your browser from your own recipient records.</p>',
      actions: [
        { label: 'CSV', variant: 'btn-secondary', onClick: async () => { await api.exportRecipients('csv'); } },
        { label: 'JSON', variant: 'btn-primary', onClick: async () => { await api.exportRecipients('json'); } },
      ],
    });
  });

  await load();

  if (params[0] === 'new') openRecipientModal();
  if (params[0] === 'import') openImportModal();

  return () => { clearTimeout(timer); };
}
