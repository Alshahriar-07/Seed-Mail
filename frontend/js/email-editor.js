// Seed Code Mail - email editor studio
//
// Everything here starts blank: no example HTML, no preloaded template.  The
// editor only ever shows what the user typed/imported, or a saved template the
// user explicitly opened.

import { api } from './api.js';
import { escapeHtml, icon, refreshIcons, debounce, toast, openModal, confirmDialog } from './ui.js';
import { setDirtyGuard } from './app.js';

const DESIGN_FIELDS = [
  { key: 'email_bg', label: 'Email background', type: 'color' },
  { key: 'container_bg', label: 'Container background', type: 'color' },
  { key: 'primary_text', label: 'Primary text color', type: 'color' },
  { key: 'secondary_text', label: 'Secondary text color', type: 'color' },
  { key: 'muted_text', label: 'Muted text color', type: 'color' },
  { key: 'accent', label: 'Accent color', type: 'color' },
  { key: 'font_family', label: 'Font family', type: 'text' },
  { key: 'font_size', label: 'Font size', type: 'text' },
  { key: 'container_width', label: 'Container width', type: 'text' },
  { key: 'border_radius', label: 'Border radius', type: 'text' },
  { key: 'logo_url', label: 'Logo URL', type: 'text', wide: true },
  { key: 'button_label', label: 'Button label', type: 'text' },
  { key: 'button_bg', label: 'Button color', type: 'color' },
  { key: 'footer_text', label: 'Footer text', type: 'textarea', wide: true },
];

// Preview viewports.  Widths are the real device widths; the frame is scaled
// for display only, the underlying HTML source is never rewritten.
const DEVICES = {
  desktop: { label: 'Desktop', width: 1024, height: 620, icon: 'monitor' },
  tablet: { label: 'Tablet', width: 768, height: 720, icon: 'tablet' },
  mobile: { label: 'Mobile', width: 390, height: 740, icon: 'smartphone' },
};

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const MAX_IMAGE_PROBES = 8;

const state = {
  templates: [],
  defaultDesign: {},
  id: null,
  name: '',
  html: '',
  design: {},
  savedHtml: '',
  savedDesign: {},
  savedName: '',
  mode: 'html',
  device: 'desktop',
  zoom: 1,
  fit: true,
  guide: [],
  preview: { company: '', senderName: '', senderEmail: '', subject: '', githubUrl: '' },
  previewDefaults: null,
  meta: { used: [], unknown: [], unresolved: [] },
  imageIssues: [],
  loading: false,
  error: '',
};

let host = null;
let renderToken = 0;
let probeToken = 0;
let lastPreviewKey = '';
let resizeObserver = null;

// --- dirty / validation helpers -------------------------------------------

function isDirty() {
  return state.html !== state.savedHtml
    || JSON.stringify(state.design) !== JSON.stringify(state.savedDesign)
    || state.name !== state.savedName;
}

function supportedNames() {
  return state.guide.map((v) => v.name);
}

function templateTokens() {
  return [...state.html.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]);
}

function validationWarnings() {
  const warnings = [];
  const html = state.html;
  if (!html.trim()) warnings.push('The HTML source is empty.');
  const supported = supportedNames();
  const tokens = [...new Set(templateTokens())];
  const unknown = tokens.filter((t) => !supported.includes(t) && !t.startsWith('D_'));
  if (unknown.length) warnings.push(`Unsupported variable(s): ${unknown.map((u) => '{{' + u + '}}').join(', ')}`);
  return warnings;
}

function designTokenPresence() {
  const present = new Set();
  DESIGN_FIELDS.forEach((f) => {
    if (state.html.includes('{{D_' + f.key.toUpperCase() + '}}')) present.add(f.key);
  });
  return present;
}

// --- status / warnings paint ----------------------------------------------

function paintStatus() {
  const badge = host.querySelector('#save-state');
  const dirty = isDirty();
  if (badge) {
    badge.className = dirty ? 'badge badge-pending' : 'badge badge-unknown';
    badge.innerHTML = `<span class="badge-dot"></span>${dirty ? 'Unsaved changes' : 'Saved'}`;
  }
  const saveBtn = host.querySelector('#btn-save');
  if (saveBtn) saveBtn.disabled = !dirty;
}

function paintWarnings() {
  const box = host.querySelector('#validation-box');
  if (!box) return;
  const warnings = [...validationWarnings()];

  if (state.meta.unknown?.length) {
    warnings.push(`Unknown variables left as-is: ${state.meta.unknown.map((v) => '{{' + v + '}}').join(', ')}`);
  }
  if (state.meta.unresolved?.length) {
    warnings.push(`Variables with no value: ${state.meta.unresolved.join(', ')} — set them in Settings or the preview values.`);
  }
  if (state.imageIssues.length) {
    warnings.push(...state.imageIssues);
  }

  if (!warnings.length) {
    box.innerHTML = state.html.trim()
      ? `<div class="notice notice-success">${icon('check-circle-2', 16)}<span>No variable problems detected.</span></div>`
      : '';
  } else {
    box.innerHTML = `<div class="notice notice-warning">${icon('triangle-alert', 16)}<span>${warnings.map(escapeHtml).join('<br>')}</span></div>`;
  }
  refreshIcons(box);
}

// --- preview ---------------------------------------------------------------

function previewKey() {
  return JSON.stringify({ html: state.html, design: state.design, preview: state.preview, device: null });
}

function showEmpty() {
  setLoading(false);
  host.querySelector('#preview-empty').hidden = false;
  host.querySelector('#preview-error').hidden = true;
  host.querySelector('#preview-canvas').hidden = true;
  state.meta = { used: [], unknown: [], unresolved: [] };
  state.imageIssues = [];
  paintWarnings();
  paintPreviewMeta();
}

function showError(message) {
  setLoading(false);
  state.error = message;
  host.querySelector('#preview-empty').hidden = true;
  host.querySelector('#preview-canvas').hidden = true;
  const box = host.querySelector('#preview-error');
  box.hidden = false;
  box.innerHTML = `<div class="empty-icon">${icon('triangle-alert', 26)}</div>
    <h3>Preview could not be rendered</h3>
    <p>${escapeHtml(message)}</p>
    <button class="btn btn-secondary btn-sm" id="preview-retry">${icon('refresh-cw', 14)} Try again</button>`;
  refreshIcons(box);
  box.querySelector('#preview-retry')?.addEventListener('click', () => renderPreview(true));
}

function showFrame() {
  host.querySelector('#preview-empty').hidden = true;
  host.querySelector('#preview-error').hidden = true;
  host.querySelector('#preview-canvas').hidden = false;
}

function setLoading(active) {
  state.loading = active;
  const node = host.querySelector('#preview-loading');
  if (node) node.hidden = !active;
}

const schedulePreview = debounce(() => renderPreview(false), 400);

async function renderPreview(force = false) {
  const key = previewKey();
  if (!force && key === lastPreviewKey) return;
  lastPreviewKey = key;

  const token = ++renderToken;
  const html = state.html;

  if (!html.trim()) {
    showEmpty();
    return;
  }

  setLoading(true);
  try {
    const result = await api.previewTemplate({
      html,
      design: state.design,
      company_name: state.preview.company,
      sender_name: state.preview.senderName,
      sender_email: state.preview.senderEmail,
      subject: state.preview.subject,
      github_url: state.preview.githubUrl,
    });
    if (token !== renderToken) return; // a newer render already started

    state.meta = {
      used: result.used_variables || [],
      unknown: result.unknown_variables || [],
      unresolved: result.unresolved_variables || [],
    };
    const frame = host.querySelector('#preview-frame');
    // The iframe is reused; only its srcdoc changes.
    frame.setAttribute('srcdoc', result.html);
    showFrame();
    paintWarnings();
    paintPreviewMeta();
    paintZoomLabel();
    probeImages(html, token);
  } catch (error) {
    if (token !== renderToken) return;
    showError(error.message || 'Unexpected error');
  } finally {
    if (token === renderToken) setLoading(false);
  }
}

function paintPreviewMeta() {
  const info = host.querySelector('#preview-info');
  if (!info) return;
  if (!state.html.trim()) {
    info.innerHTML = '';
    return;
  }
  if (state.meta.unresolved?.length) {
    info.innerHTML = `<span class="badge badge-pending"><span class="badge-dot"></span>${state.meta.unresolved.length} unresolved variable(s)</span>`;
  } else if (state.meta.unknown?.length) {
    info.innerHTML = `<span class="badge badge-failed"><span class="badge-dot"></span>${state.meta.unknown.length} unknown variable(s)</span>`;
  } else {
    info.innerHTML = `<span class="badge badge-sent"><span class="badge-dot"></span>Variables resolved</span>`;
  }
  refreshIcons(info);
}

// --- image handling --------------------------------------------------------

function extractImageSources(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('img')]
      .map((img) => (img.getAttribute('src') || '').trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function isRemote(src) {
  return /^https?:\/\//i.test(src) || /^data:image\//i.test(src);
}

function probeImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 6000);
    img.onload = () => { clearTimeout(timer); finish(true); };
    img.onerror = () => { clearTimeout(timer); finish(false); };
    img.src = src;
  });
}

async function probeImages(html, token) {
  const myToken = ++probeToken;
  const sources = extractImageSources(html);
  if (!sources.length) {
    state.imageIssues = [];
    paintWarnings();
    return;
  }

  const localPaths = sources.filter((src) => !isRemote(src));
  const remote = sources.filter(isRemote).slice(0, MAX_IMAGE_PROBES);

  const broken = [];
  if (remote.length) {
    const results = await Promise.all(remote.map((src) => probeImage(src)));
    results.forEach((ok, index) => { if (!ok) broken.push(remote[index]); });
  }
  if (myToken !== probeToken || token !== renderToken) return; // outdated

  const issues = [];
  if (localPaths.length) {
    issues.push(
      `${localPaths.length} image(s) point at a local file path. Local files are never read — host the image and use an absolute URL.`,
    );
  }
  if (broken.length) {
    issues.push(`${broken.length} image(s) could not be loaded: ${broken.slice(0, 3).join(', ')}${broken.length > 3 ? '…' : ''}`);
  } else if (remote.length) {
    issues.push(`${remote.length} image(s) are loaded from external hosts; blocked or broken images may not display in the preview or some email clients.`);
  }
  state.imageIssues = issues;
  paintWarnings();
}

// --- sizing / zoom ---------------------------------------------------------

function activeDevice() {
  return DEVICES[state.device] || DEVICES.desktop;
}

function paintZoomLabel() {
  const label = host.querySelector('#preview-dimensions');
  if (!label) return;
  const device = activeDevice();
  const scale = currentScale();
  label.textContent = `${device.width} × ${device.height} px · ${Math.round(scale * 100)}%`;
  const zoomText = host.querySelector('#zoom-value');
  if (zoomText) zoomText.textContent = `${Math.round(scale * 100)}%`;
}

function currentScale() {
  const stage = host.querySelector('#preview-stage');
  const device = activeDevice();
  let scale = 1;
  if (state.fit && stage) {
    const available = Math.max(240, stage.clientWidth - 40);
    scale = Math.min(1, available / device.width);
  }
  return Math.max(0.05, scale * state.zoom);
}

function applySizing() {
  const stage = host.querySelector('#preview-stage');
  if (!stage) return;
  const device = activeDevice();
  const viewport = host.querySelector('#preview-viewport');
  const canvas = host.querySelector('#preview-canvas');
  const scale = currentScale();

  viewport.style.width = `${device.width}px`;
  viewport.style.height = `${device.height}px`;
  viewport.style.transform = `scale(${scale})`;
  canvas.style.width = `${Math.round(device.width * scale)}px`;
  canvas.style.height = `${Math.round(device.height * scale)}px`;
  paintZoomLabel();
}

// --- variables guide -------------------------------------------------------

async function loadGuide() {
  if (state.guide.length) return;
  try {
    const data = await api.templateVariables();
    state.guide = data.variables || [];
  } catch (_) {
    state.guide = [
      { name: 'COMPANY_NAME', summary: "The recipient company's name.", example: '<h2>Hello {{COMPANY_NAME}},</h2>', example_label: 'HTML greeting' },
      { name: 'SENDER_NAME', summary: "The configured sender's display name.", example: '{{SENDER_NAME}}', example_label: 'Signature' },
      { name: 'SENDER_EMAIL', summary: "The configured sender's email address.", example: '{{SENDER_EMAIL}}', example_label: 'Signature' },
      { name: 'SUBJECT', summary: 'The subject of the current campaign.', example: '<title>{{SUBJECT}}</title>', example_label: 'Document title' },
      { name: 'GITHUB_URL', summary: 'The GitHub URL configured in Settings, if set.', example: '<a href="{{GITHUB_URL}}">GitHub</a>', example_label: 'Link' },
    ];
  }
}

function paintGuide() {
  const list = host.querySelector('#variable-list');
  const body = host.querySelector('#variable-panel-body');
  if (!list) return;

  const panel = host.querySelector('#variable-panel');
  const collapsed = panel.dataset.collapsed === 'true';
  body.style.display = collapsed ? 'none' : '';
  host.querySelector('#variable-chevron').style.transform = collapsed ? 'rotate(-90deg)' : '';

  list.innerHTML = state.guide.map((v) => `
    <div class="variable-row" data-var="${escapeHtml(v.name)}">
      <div class="variable-main">
        <div class="variable-head">
          <code class="variable-token">{{${escapeHtml(v.name)}}}</code>
          <button class="icon-btn var-copy" data-copy-var="${escapeHtml(v.name)}" title="Copy {{${escapeHtml(v.name)}}}">${icon('copy', 14)}</button>
        </div>
        <p class="variable-desc">${escapeHtml(v.summary)}</p>
        <div class="variable-example"><span class="variable-example-label">${escapeHtml(v.example_label || 'Example')}</span><code>${escapeHtml(v.example)}</code>
          <button class="icon-btn var-copy" data-copy-example="${escapeHtml(v.example)}" title="Copy example">${icon('clipboard-copy', 14)}</button>
        </div>
      </div>
    </div>`).join('');

  refreshIcons(list);

  list.querySelectorAll('[data-copy-var]').forEach((btn) => btn.addEventListener('click', () => {
    copyText(`{{${btn.dataset.copyVar}}}`, 'Copied variable');
  }));
  list.querySelectorAll('[data-copy-example]').forEach((btn) => btn.addEventListener('click', () => {
    copyText(btn.dataset.copyExample, 'Copied example');
  }));
}

function paintPreviewValues() {
  const set = (id, value) => {
    const el = host.querySelector(id);
    if (el && document.activeElement !== el) el.value = value ?? '';
  };
  set('#pv-company', state.preview.company);
  set('#pv-sender-name', state.preview.senderName);
  set('#pv-sender-email', state.preview.senderEmail);
  set('#pv-subject', state.preview.subject);
  set('#pv-github', state.preview.githubUrl);
}

async function copyText(text, label = 'Copied') {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const node = document.createElement('textarea');
      node.value = text;
      node.setAttribute('readonly', '');
      node.style.position = 'fixed';
      node.style.opacity = '0';
      document.body.appendChild(node);
      node.select();
      document.execCommand('copy');
      node.remove();
    }
    toast(`${label}: ${text}`, 'success', 2600);
  } catch (_) {
    toast('Copy failed — select the text manually.', 'warning');
  }
}

function copyAllVariables() {
  const text = state.guide.map((v) => `{{${v.name}}} — ${v.summary}`).join('\n');
  copyText(text, 'Copied all variables');
}

// --- editor panes ----------------------------------------------------------

function paintHtmlEditor() {
  const source = host.querySelector('#html-source');
  if (source) source.value = state.html;
  updateCharCount();
  paintWarnings();
}

function updateCharCount() {
  const charCount = host.querySelector('#char-count');
  if (charCount) charCount.textContent = `${state.html.length.toLocaleString()} characters`;
}

function paintDesign() {
  const present = designTokenPresence();
  const grid = host.querySelector('#design-grid');
  if (!grid) return;
  grid.innerHTML = DESIGN_FIELDS.map((field) => {
    const value = state.design[field.key] ?? '';
    const available = present.has(field.key);
    const control = field.type === 'color'
      ? `<div class="color-field"><input type="color" data-design="${field.key}" value="${escapeHtml(value.startsWith('#') ? value : '#111111')}"><input class="input" data-design-text="${field.key}" value="${escapeHtml(value)}"></div>`
      : field.type === 'textarea'
        ? `<textarea class="textarea" data-design="${field.key}" rows="2">${escapeHtml(value)}</textarea>`
        : `<input class="input" data-design="${field.key}" value="${escapeHtml(value)}">`;
    return `<div class="field" style="${field.wide ? 'grid-column:1 / -1;' : ''}">
      <label>${escapeHtml(field.label)} ${available ? '' : '<span class="cell-muted" style="font-weight:400;">(token not in HTML)</span>'}</label>
      ${control}
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-design]').forEach((input) => input.addEventListener('input', () => {
    state.design[input.dataset.design] = input.value;
    const twin = grid.querySelector(`[data-design-text="${input.dataset.design}"]`);
    if (twin) twin.value = input.value;
    paintStatus();
    schedulePreview();
  }));
  grid.querySelectorAll('[data-design-text]').forEach((input) => input.addEventListener('input', () => {
    state.design[input.dataset.designText] = input.value;
    const twin = grid.querySelector(`[data-design="${input.dataset.designText}"]`);
    if (twin && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.value)) twin.value = input.value;
    paintStatus();
    schedulePreview();
  }));
}

function switchMode(mode) {
  state.mode = mode;
  host.querySelectorAll('.tab[data-mode]').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  host.querySelector('#pane-html').style.display = mode === 'html' ? '' : 'none';
  host.querySelector('#pane-design').style.display = mode === 'design' ? '' : 'none';
}

function formatHtml(source) {
  // Lightweight pretty-printer: re-indent block-level lines without touching text.
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const tokens = source.replace(/>\s+</g, '><').split(/(?=<)/g);
  let depth = 0;
  const lines = [];
  tokens.forEach((raw) => {
    const token = raw.trim();
    if (!token) return;
    const closing = /^<\//.test(token);
    const selfClosing = /\/>$/.test(token) || voidTags.has((token.match(/^<([a-zA-Z0-9]+)/) || [])[1]?.toLowerCase());
    const opening = /^<[a-zA-Z]/.test(token) && !closing && !selfClosing && !token.startsWith('<!');
    if (closing) depth = Math.max(0, depth - 1);
    lines.push('  '.repeat(depth) + token);
    if (opening) depth += 1;
  });
  return lines.join('\n');
}

// --- persistence -----------------------------------------------------------

async function refreshTemplateList() {
  const data = await api.templates();
  state.templates = data.items;
  state.defaultDesign = data.default_design || state.defaultDesign;
  const select = host.querySelector('#template-select');
  select.innerHTML = `<option value="">— New template —</option>` + state.templates.map((t) =>
    `<option value="${escapeHtml(t.id)}" ${t.id === state.id ? 'selected' : ''}>${escapeHtml(t.name)}${t.is_default ? ' (default)' : ''}</option>`
  ).join('');
  if (!state.id) select.value = '';
}

function applyLoaded(template) {
  state.id = template.id;
  state.name = template.name || '';
  state.html = template.html || '';
  state.design = { ...(template.design || {}) };
  state.savedHtml = state.html;
  state.savedDesign = { ...state.design };
  state.savedName = state.name;
  const nameInput = host.querySelector('#template-name');
  if (nameInput) nameInput.value = state.name;
  paintHtmlEditor();
  paintDesign();
  paintStatus();
  renderPreview(true);
}

function newTemplate() {
  state.id = null;
  state.name = '';
  state.html = '';
  state.design = { ...state.defaultDesign };
  state.savedHtml = '';
  state.savedDesign = { ...state.design };
  state.savedName = '';
  const nameInput = host.querySelector('#template-name');
  if (nameInput) nameInput.value = '';
  const select = host.querySelector('#template-select');
  if (select) select.value = '';
  paintHtmlEditor();
  paintDesign();
  paintStatus();
  lastPreviewKey = '';
  showEmpty();
}

async function loadTemplate(id) {
  const template = await api.template(id);
  applyLoaded(template);
  const select = host.querySelector('#template-select');
  if (select) select.value = id;
}

async function save(saveAsNew = false) {
  if (!state.html.trim()) {
    toast('An empty template cannot be saved. Write or import HTML first.', 'warning');
    return;
  }
  const name = (state.name || '').trim();
  if (!name) {
    toast('Enter a template name before saving.', 'warning');
    host.querySelector('#template-name')?.focus();
    return;
  }
  const btn = host.querySelector(saveAsNew ? '#btn-save-new' : '#btn-save');
  const original = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Saving`; }
  try {
    if (saveAsNew || !state.id) {
      const created = await api.createTemplate({ name, html: state.html, design: state.design, description: '' });
      state.id = created.id;
      state.savedName = created.name;
      toast('Saved as a new template.', 'success');
    } else {
      const updated = await api.updateTemplate(state.id, { name, html: state.html, design: state.design });
      state.savedName = updated.name;
      toast('Template saved.', 'success');
    }
    state.savedHtml = state.html;
    state.savedDesign = { ...state.design };
    paintStatus();
    await refreshTemplateList();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = original; refreshIcons(btn); }
  }
}

function restoreSaved() {
  if (!isDirty()) { toast('No changes to restore.', 'info'); return; }
  state.html = state.savedHtml;
  state.design = { ...state.savedDesign };
  state.name = state.savedName;
  const nameInput = host.querySelector('#template-name');
  if (nameInput) nameInput.value = state.name;
  paintHtmlEditor();
  paintDesign();
  paintStatus();
  renderPreview(true);
  toast('Reverted to the last saved version.', 'info');
}

function renameTemplate() {
  openModal({
    title: 'Rename template',
    body: `<div class="field"><label for="rn-name">Template name</label><input class="input" id="rn-name" value="${escapeHtml(state.name)}"></div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Rename', variant: 'btn-primary', onClick: () => {
        const value = document.getElementById('rn-name').value.trim();
        if (!value) { toast('Name is required.', 'warning'); return false; }
        state.name = value;
        host.querySelector('#template-name').value = value;
        paintStatus();
      } },
    ],
  });
}

function importHtml() {
  openModal({
    title: 'Import HTML into editor',
    body: `<div class="field"><label for="ed-file">HTML file</label><input class="input" type="file" id="ed-file" accept=".html,.htm,text/html"></div>
      <div class="notice">${icon('info', 16)} Importing replaces the current editor contents (not saved until you press Save).</div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Load into editor', variant: 'btn-primary', onClick: async () => {
        const input = document.getElementById('ed-file');
        if (!input.files.length) { toast('Choose a file.', 'warning'); return false; }
        state.html = await input.files[0].text();
        paintHtmlEditor();
        paintStatus();
        renderPreview(true);
        toast('HTML loaded into editor.', 'success');
      } },
    ],
  });
}

function exportTemplate() {
  if (!state.id) { toast('Save the template before exporting.', 'warning'); return; }
  window.open(api.exportTemplateUrl(state.id), '_blank');
}

async function deleteTemplate() {
  if (!state.id) { toast('This template has not been saved yet.', 'info'); return; }
  const ok = await confirmDialog(`Delete "${state.name}"? This cannot be undone.`, { title: 'Delete template', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api.deleteTemplate(state.id);
    toast('Template deleted.', 'success');
    const data = await api.templates();
    state.templates = data.items;
    if (data.items.length) await loadTemplate(data.items[0].id);
    else newTemplate();
    await refreshTemplateList();
  } catch (error) { toast(error.message, 'error'); }
}

// --- render ----------------------------------------------------------------

export async function render(container, { params = [] } = {}) {
  host = container;

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Email Editor</h2>
        <p>Write complete HTML, personalise it with variables, and preview it per recipient.</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary" id="btn-new-blank">${icon('file-plus', 16)} New blank</button>
        <button class="btn btn-secondary" id="btn-restore">${icon('undo-2', 16)} Restore</button>
        <button class="btn btn-secondary" id="btn-save-new">${icon('save-all', 16)} Save as new</button>
        <button class="btn btn-primary" id="btn-save" disabled>${icon('save', 16)} Save Template</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="toolbar" style="margin:0;">
        <select class="select" id="template-select" style="min-width:220px;"></select>
        <input class="input" id="template-name" style="flex:1; min-width:200px;" placeholder="Template name">
        <span id="save-state" class="badge badge-unknown"><span class="badge-dot"></span>Saved</span>
        <button class="icon-btn" id="btn-rename" title="Rename">${icon('pencil', 15)}</button>
        <button class="icon-btn" id="btn-import-html" title="Import HTML file">${icon('upload', 15)}</button>
        <button class="icon-btn" id="btn-export" title="Export HTML">${icon('download', 15)}</button>
        <button class="icon-btn danger" id="btn-delete" title="Delete template">${icon('trash-2', 15)}</button>
      </div>
    </div>

    <section class="variable-panel" id="variable-panel" data-collapsed="false">
      <button class="variable-panel-head" id="variable-panel-toggle" aria-expanded="true">
        <span class="variable-panel-title">${icon('braces', 16)} Template Variables</span>
        <span class="variable-panel-sub">Insert these anywhere in your HTML to personalise each email</span>
        <span class="variable-chevron" id="variable-chevron">${icon('chevron-down', 16)}</span>
      </button>
      <div class="variable-panel-body" id="variable-panel-body">
        <p class="variable-intro">
          Variables are placeholders that are automatically replaced with the appropriate value when a campaign
          generates an email for each recipient. The saved template itself is never modified — a fresh document is
          produced for every recipient, so one company's information can never appear in another's email.
        </p>
        <div class="variable-actions">
          <button class="btn btn-sm btn-secondary" id="btn-copy-all">${icon('clipboard-copy', 14)} Copy All</button>
          <span class="hint">Values are HTML-escaped for their context; URLs are validated before being placed in a link.</span>
        </div>
        <div class="variable-list" id="variable-list"></div>

        <div class="preview-values">
          <div class="section-title">Preview Variables</div>
          <p class="hint">These values are used for the preview only. They are never saved as recipients and never become a default subject.</p>
          <div class="design-grid">
            <div class="field"><label for="pv-company">Test company name</label><input class="input" id="pv-company" placeholder="Example Company"></div>
            <div class="field"><label for="pv-subject">Preview subject</label><input class="input" id="pv-subject" placeholder="Temporary preview subject"></div>
            <div class="field"><label for="pv-sender-name">Sender name</label><input class="input" id="pv-sender-name"></div>
            <div class="field"><label for="pv-sender-email">Sender email</label><input class="input" id="pv-sender-email"></div>
            <div class="field" style="grid-column:1 / -1;"><label for="pv-github">GitHub URL</label><input class="input" id="pv-github" placeholder="https://github.com/you"></div>
          </div>
        </div>
      </div>
    </section>

    <div class="editor-grid">
      <div>
        <div class="tabs" style="margin-bottom:14px;">
          <button class="tab active" data-mode="html">HTML Source</button>
          <button class="tab" data-mode="design">Visual Customization</button>
        </div>

        <div id="pane-html">
          <textarea class="code-editor" id="html-source" spellcheck="false" placeholder="Paste or write your email HTML here..."></textarea>
          <div class="toolbar" style="margin-top:12px;">
            <button class="btn btn-secondary btn-sm" id="btn-format">${icon('align-left', 14)} Format HTML</button>
            <span class="cell-muted" style="font-size:12px;" id="char-count"></span>
          </div>
          <div id="validation-box" style="margin-top:12px;"></div>
        </div>

        <div id="pane-design" style="display:none;">
          <div class="notice" style="margin-bottom:14px;">${icon('info', 16)} <span>These controls update token-mapped properties only. Anything else stays editable in HTML Source.</span></div>
          <div class="design-grid" id="design-grid"></div>
        </div>
      </div>

      <div>
        <div class="preview-frame-wrap">
          <div class="preview-frame-bar">
            <div class="device-toggle">
              ${Object.entries(DEVICES).map(([key, device]) => `
                <button class="btn btn-sm ${key === 'desktop' ? 'btn-secondary' : 'btn-ghost'}" data-device="${key}">${icon(device.icon, 14)} ${device.label}</button>`).join('')}
            </div>
            <div class="preview-tools">
              <button class="btn btn-sm btn-secondary" id="btn-fit">Fit width</button>
              <button class="btn btn-sm btn-ghost" id="btn-actual">Actual size</button>
              <button class="icon-btn" id="zoom-out" title="Zoom out">${icon('zoom-out', 15)}</button>
              <span class="zoom-value" id="zoom-value">100%</span>
              <button class="icon-btn" id="zoom-in" title="Zoom in">${icon('zoom-in', 15)}</button>
              <button class="icon-btn" id="refresh-preview" title="Refresh preview">${icon('refresh-cw', 15)}</button>
            </div>
          </div>

          <div class="preview-stage" id="preview-stage">
            <div class="preview-canvas" id="preview-canvas" hidden>
              <div class="preview-viewport" id="preview-viewport">
                <iframe class="preview-frame" id="preview-frame" sandbox="" title="Email preview"></iframe>
              </div>
            </div>

            <div class="preview-empty" id="preview-empty">
              <div class="empty-icon">${icon('mail-open', 28)}</div>
              <h3>Your email preview will appear here.</h3>
              <p>Write HTML, import a file, or open a saved template to get started.</p>
            </div>

            <div class="preview-error" id="preview-error" hidden></div>

            <div class="preview-loading" id="preview-loading" hidden>
              <span class="spinner"></span><span>Rendering preview…</span>
            </div>
          </div>

          <div class="preview-frame-bar preview-frame-foot">
            <span class="cell-muted" style="font-size:12px;">Isolated sandbox · scripts disabled</span>
            <span class="cell-muted" style="font-size:12px;" id="preview-dimensions"></span>
            <span id="preview-info"></span>
          </div>
          <div class="preview-note">Preview may differ slightly across email clients.</div>
        </div>
      </div>
    </div>`;

  refreshIcons(container);

  // --- guide ---
  await loadGuide();
  paintGuide();

  container.querySelector('#variable-panel-toggle').addEventListener('click', () => {
    const panel = container.querySelector('#variable-panel');
    const collapsed = panel.dataset.collapsed === 'true';
    panel.dataset.collapsed = collapsed ? 'false' : 'true';
    container.querySelector('#variable-panel-toggle').setAttribute('aria-expanded', String(collapsed));
    paintGuide();
  });
  container.querySelector('#btn-copy-all').addEventListener('click', copyAllVariables);

  // --- preview values ---
  const previewBindings = [
    ['#pv-company', 'company'],
    ['#pv-sender-name', 'senderName'],
    ['#pv-sender-email', 'senderEmail'],
    ['#pv-subject', 'subject'],
    ['#pv-github', 'githubUrl'],
  ];
  previewBindings.forEach(([selector, key]) => {
    const input = container.querySelector(selector);
    input.addEventListener('input', debounce(() => {
      state.preview[key] = input.value;
      renderPreview(false);
    }, 400));
  });

  // --- editor controls ---
  container.querySelectorAll('.tab[data-mode]').forEach((tab) => tab.addEventListener('click', () => switchMode(tab.dataset.mode)));

  const source = container.querySelector('#html-source');
  source.addEventListener('input', () => {
    state.html = source.value;
    updateCharCount();
    paintStatus();
    paintWarnings();
    schedulePreview();
  });

  container.querySelector('#btn-format').addEventListener('click', () => {
    try {
      state.html = formatHtml(state.html);
      paintHtmlEditor();
      paintStatus();
      schedulePreview();
      toast('HTML formatted.', 'success');
    } catch (error) { toast('Could not format HTML: ' + error.message, 'warning'); }
  });

  container.querySelector('#btn-new-blank').addEventListener('click', async () => {
    if (isDirty()) {
      const ok = await confirmDialog('Discard unsaved changes and start a new template?', { title: 'Unsaved changes', confirmLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    newTemplate();
    toast('Blank editor ready. Write or import HTML, then save.', 'info');
  });

  container.querySelector('#btn-save').addEventListener('click', () => save(false));
  container.querySelector('#btn-save-new').addEventListener('click', () => save(true));
  container.querySelector('#btn-restore').addEventListener('click', restoreSaved);
  container.querySelector('#btn-rename').addEventListener('click', renameTemplate);
  container.querySelector('#btn-import-html').addEventListener('click', importHtml);
  container.querySelector('#btn-export').addEventListener('click', exportTemplate);
  container.querySelector('#btn-delete').addEventListener('click', deleteTemplate);

  container.querySelector('#template-select').addEventListener('change', async (event) => {
    if (isDirty()) {
      const proceed = await confirmDialog('You have unsaved changes. Discard them and switch templates?', { title: 'Unsaved changes', confirmLabel: 'Discard', danger: true });
      if (!proceed) { event.target.value = state.id || ''; return; }
    }
    if (!event.target.value) { newTemplate(); return; }
    try {
      await loadTemplate(event.target.value);
    } catch (error) { toast(error.message, 'error'); }
  });

  container.querySelector('#template-name').addEventListener('input', (event) => { state.name = event.target.value; paintStatus(); });

  // --- preview controls ---
  container.querySelectorAll('[data-device]').forEach((btn) => btn.addEventListener('click', () => {
    state.device = btn.dataset.device;
    container.querySelectorAll('[data-device]').forEach((b) => {
      b.classList.toggle('btn-secondary', b.dataset.device === state.device);
      b.classList.toggle('btn-ghost', b.dataset.device !== state.device);
    });
    applySizing();
  }));

  container.querySelector('#btn-fit').addEventListener('click', () => {
    state.fit = true;
    state.zoom = 1;
    container.querySelector('#btn-fit').classList.add('btn-secondary');
    container.querySelector('#btn-fit').classList.remove('btn-ghost');
    container.querySelector('#btn-actual').classList.remove('btn-secondary');
    container.querySelector('#btn-actual').classList.add('btn-ghost');
    applySizing();
  });
  container.querySelector('#btn-actual').addEventListener('click', () => {
    state.fit = false;
    state.zoom = 1;
    container.querySelector('#btn-actual').classList.add('btn-secondary');
    container.querySelector('#btn-actual').classList.remove('btn-ghost');
    container.querySelector('#btn-fit').classList.remove('btn-secondary');
    container.querySelector('#btn-fit').classList.add('btn-ghost');
    applySizing();
  });
  container.querySelector('#zoom-in').addEventListener('click', () => {
    state.zoom = Math.min(ZOOM_MAX, +(state.zoom + ZOOM_STEP).toFixed(2));
    applySizing();
  });
  container.querySelector('#zoom-out').addEventListener('click', () => {
    state.zoom = Math.max(ZOOM_MIN, +(state.zoom - ZOOM_STEP).toFixed(2));
    applySizing();
  });
  container.querySelector('#refresh-preview').addEventListener('click', () => renderPreview(true));

  // --- sizing ---
  const stage = container.querySelector('#preview-stage');
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => applySizing());
    resizeObserver.observe(stage);
  } else {
    window.addEventListener('resize', applySizing);
  }
  applySizing();

  // --- initial state ---
  const data = await api.templates();
  state.templates = data.items;
  state.defaultDesign = data.default_design || {};
  const settings = await api.settings().catch(() => null);
  if (settings) {
    const values = settings.values || {};
    state.preview = {
      company: '',
      senderName: values.SENDER_NAME || '',
      senderEmail: settings.email || '',
      subject: '',
      githubUrl: values.GITHUB_URL || '',
    };
  }
  paintPreviewValues();
  await refreshTemplateList();

  const requested = params[0];
  if (requested && requested !== 'new' && data.items.some((t) => t.id === requested)) {
    await loadTemplate(requested);
  } else {
    newTemplate();
    lastPreviewKey = '';
  }

  setDirtyGuard(isDirty);
  window.addEventListener('beforeunload', onBeforeUnload);

  return () => {
    setDirtyGuard(null);
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    else window.removeEventListener('resize', applySizing);
    renderToken += 1;
    probeToken += 1;
  };
}

function onBeforeUnload(event) {
  if (isDirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
}
