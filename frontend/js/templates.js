// Seed Code Mail - templates page
//
// The list is driven entirely by what the user saved.  A fresh installation
// shows an empty state with explicit "Create Template" / "Import HTML"
// actions; nothing is preloaded or auto-imported.

import { api } from './api.js';
import { escapeHtml, icon, formatDate, refreshIcons, skeleton, emptyState, openModal, confirmDialog, toast } from './ui.js';
import { navigate } from './app.js';

let host = null;

function startBlankTemplate() {
  navigate('editor', ['new']);
}

async function load() {
  const list = host.querySelector('#template-list');
  list.innerHTML = skeleton(3);
  const data = await api.templates();

  if (!data.items.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${icon('layout-template', 28)}</div>
        <h3>No email templates yet</h3>
        <p>Create your first email template by writing HTML or importing an HTML file.</p>
        <div class="empty-actions">
          <button class="btn btn-primary" id="empty-tpl-create">${icon('plus', 16)} Create Template</button>
          <button class="btn btn-secondary" id="empty-tpl-import">${icon('upload', 16)} Import HTML</button>
        </div>
      </div>`;
    refreshIcons(list);
    list.querySelector('#empty-tpl-create').addEventListener('click', startBlankTemplate);
    list.querySelector('#empty-tpl-import').addEventListener('click', importTemplateModal);
    return;
  }

  list.innerHTML = `<div class="grid grid-3 card-list">
    ${data.items.map((t) => `
      <div class="card hoverable" data-id="${escapeHtml(t.id)}">
        <div class="card-head">
          <h3 style="font-size:14px;">${escapeHtml(t.name)}</h3>
          ${t.is_default ? '<span class="badge badge-sent"><span class="badge-dot"></span>Default</span>' : ''}
        </div>
        <p class="cell-muted" style="font-size:12.5px; min-height:34px;">${escapeHtml(t.description || 'No description')}</p>
        <div class="kv"><span>Size</span><span>${(t.size / 1024).toFixed(1)} KB</span></div>
        <div class="kv"><span>Updated</span><span>${formatDate(t.updated_at)}</span></div>
        <div class="row-actions" style="justify-content:flex-start; gap:6px; margin-top:14px; flex-wrap:wrap;">
          <button class="btn btn-sm btn-primary" data-open="${escapeHtml(t.id)}">${icon('pencil', 14)} Edit</button>
          <button class="btn btn-sm btn-secondary" data-duplicate="${escapeHtml(t.id)}">${icon('copy', 14)} Duplicate</button>
          <button class="icon-btn" data-default="${escapeHtml(t.id)}" title="Set as default">${icon('star', 15)}</button>
          <button class="icon-btn" data-export="${escapeHtml(t.id)}" title="Export HTML">${icon('download', 15)}</button>
          <button class="icon-btn danger" data-del="${escapeHtml(t.id)}" title="Delete">${icon('trash-2', 15)}</button>
        </div>
      </div>`).join('')}
  </div>`;

  refreshIcons(list);

  list.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => navigate('editor', [b.dataset.open])));
  list.querySelectorAll('[data-duplicate]').forEach((b) => b.addEventListener('click', async () => {
    try { const clone = await api.duplicateTemplate(b.dataset.duplicate, ''); toast('Template duplicated.', 'success'); navigate('editor', [clone.id]); }
    catch (e) { toast(e.message, 'error'); }
  }));
  list.querySelectorAll('[data-default]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.setDefaultTemplate(b.dataset.default); toast('Default template updated.', 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }));
  list.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.exportTemplateHtml(b.dataset.export); }
    catch (e) { toast(e.message, 'error'); }
  }));
  list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const card = b.closest('.card');
    const name = card.querySelector('h3').textContent;
    const ok = await confirmDialog(`Delete "${name}"? This cannot be undone.`, { title: 'Delete template', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try { await api.deleteTemplate(b.dataset.del); toast('Template deleted.', 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }));
}

function importTemplateModal() {
  const body = `
    <div class="field"><label for="imp-file">HTML file</label><input class="input" type="file" id="imp-file" accept=".html,.htm,text/html"></div>
    <div class="field"><label for="imp-name">Template name</label><input class="input" id="imp-name" placeholder="Imported template"></div>
    <div class="notice">${icon('info', 16)} <span>The file is loaded into a new template. Nothing is sent and the editor stays in control until you save.</span></div>`;

  openModal({
    title: 'Import HTML template',
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Import', variant: 'btn-primary',
        onClick: async ({ close }) => {
          const name = document.getElementById('imp-name').value.trim();
          const fileInput = document.getElementById('imp-file');
          if (!fileInput.files.length) { toast('Choose an HTML file.', 'warning'); return false; }
          if (!name) { toast('Template name is required.', 'warning'); return false; }
          try {
            const content = await fileInput.files[0].text();
            const created = await api.importTemplate({ name, content });
            toast('Template imported.', 'success');
            close();
            navigate('editor', [created.id]);
          } catch (e) { toast(e.message, 'error'); return false; }
        },
      },
    ],
  });
}

export async function render(container) {
  host = container;
  container.innerHTML = `
    <div class="page-head">
      <div><h2>Email Templates</h2><p>Saved HTML email designs you can reuse across campaigns.</p>
        <p class="hint">Templates are stored in this browser only — they do not sync to other devices. Export JSON regularly to back them up.</p></div>
      <div class="page-actions">
        <button class="btn btn-ghost" id="btn-export-all">${icon('download', 16)} Export all (JSON)</button>
        <button class="btn btn-ghost" id="btn-import-json">${icon('upload', 16)} Import JSON</button>
        <button class="btn btn-secondary" id="btn-import-tpl">${icon('upload', 16)} Import HTML</button>
        <button class="btn btn-primary" id="btn-new-tpl">${icon('plus', 16)} Create Template</button>
      </div>
    </div>
    <input type="file" id="tpl-json-input" accept=".json,application/json" hidden>
    <div id="template-list"></div>`;

  refreshIcons(container);
  container.querySelector('#btn-new-tpl').addEventListener('click', startBlankTemplate);
  container.querySelector('#btn-import-tpl').addEventListener('click', importTemplateModal);
  container.querySelector('#btn-export-all').addEventListener('click', async () => {
    try { await api.exportAllTemplatesJson(); toast('Templates exported as JSON.', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  });
  const jsonInput = container.querySelector('#tpl-json-input');
  container.querySelector('#btn-import-json').addEventListener('click', () => jsonInput.click());
  jsonInput.addEventListener('change', async () => {
    if (!jsonInput.files.length) return;
    try {
      const result = await api.importTemplatesJson(await jsonInput.files[0].text());
      toast(`Imported ${result.imported} template(s), skipped ${result.skipped}.`, result.imported ? 'success' : 'warning');
      await load();
    } catch (e) { toast(e.message, 'error'); }
    jsonInput.value = '';
  });
  await load();
}
