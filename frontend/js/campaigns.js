// Seed Code Mail - campaigns page

import { api } from './api.js';
import {
  escapeHtml, icon, formatDate, refreshIcons, statusBadge,
  skeleton, emptyState, openModal, confirmDialog, toast, spinner,
} from './ui.js';
import { refreshTopbar } from './app.js';

let host = null;
let pollTimer = null;
let wizardState = null;

// `queued` belongs here: work handed to the remote send worker must be visible
// (and cancellable) while it waits, exactly like a run in progress.
const ACTIVE_STATUSES = ['queued', 'running', 'paused'];

function progressBar(counters) {
  const pct = counters?.progress ?? 0;
  return `<div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>`;
}

async function paintActive() {
  const box = host.querySelector('#active-campaign');
  try {
    const data = await api.campaigns();
    host.__campaigns = data.items;
    const active = data.items.find((c) => ACTIVE_STATUSES.includes(c.status));
    host.__active = active || null;

    if (!active) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';
    const c = active.counters || {};
    // A queued campaign has not been claimed by the worker yet, so it has no
    // "currently sending" recipient — saying otherwise would be a guess.
    const current = active.status === 'running' ? active.current_recipient : null;
    const queued = active.status === 'queued';
    box.innerHTML = `
      <div class="campaign-banner">
        <div class="meta" style="min-width:200px; flex:1;">
          <strong>${escapeHtml(active.name)} · ${statusBadge(active.status)}</strong>
          <small>${c.processed || 0} / ${c.total || 0} processed · ${c.sent || 0} submitted · ${c.failed || 0} failed · ${c.unknown || 0} unknown</small>
          <div style="margin-top:10px; max-width:420px;">${progressBar(c)}</div>
          ${queued ? `<small style="margin-top:6px;">Queued for the send worker — it will be delivered automatically. This page can be closed.</small>` : ''}
          ${current ? `<small style="margin-top:6px;">Sending to ${escapeHtml(current.company_name)} &lt;${escapeHtml(current.email)}&gt;</small>` : ''}
        </div>
        <div class="banner-actions">
          ${queued
            ? ''
            : (active.status === 'running'
              ? `<button class="btn btn-secondary btn-sm" data-pause>${icon('pause', 15)} Pause</button>`
              : `<button class="btn btn-secondary btn-sm" data-resume>${icon('play', 15)} Resume</button>`)}
          <button class="btn btn-secondary btn-sm" data-cancel>${icon('square', 15)} Cancel remaining</button>
        </div>
      </div>`;
    refreshIcons(box);

    box.querySelector('[data-pause]')?.addEventListener('click', () => act('pause', active.id));
    box.querySelector('[data-resume]')?.addEventListener('click', () => act('resume', active.id));
    box.querySelector('[data-cancel]')?.addEventListener('click', async () => {
      const ok = await confirmDialog('Cancel the remaining recipients? Already submitted emails are not affected.', { title: 'Cancel campaign', confirmLabel: 'Cancel remaining', danger: true });
      if (ok) act('cancel', active.id);
    });
  } catch (e) {
    box.style.display = 'none';
  }
}

async function act(action, id) {
  try {
    const fn = { pause: api.pauseCampaign, resume: api.resumeCampaign, cancel: api.cancelCampaign }[action];
    await fn(id);
    toast(`Campaign ${action}d.`, 'success');
    await paintActive();
    await paintList();
  } catch (e) { toast(e.message, 'error'); }
}

async function paintList() {
  const list = host.querySelector('#campaign-list');
  const items = host.__campaigns || (await api.campaigns()).items;
  if (!items.length) {
    list.innerHTML = emptyState({
      title: 'No campaigns yet',
      message: 'Create a campaign to send your template to selected recipients.',
      actionLabel: 'New campaign',
      actionId: 'empty-campaign',
      iconName: 'send',
    });
    list.querySelector('#empty-campaign').addEventListener('click', openWizard);
    return;
  }

  list.innerHTML = `
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Campaign</th><th>Status</th><th>Progress</th><th>Submitted</th><th>Failed</th><th>Created</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${items.map((c) => {
        const cn = c.counters || {};
        return `<tr>
          <td class="cell-strong">${escapeHtml(c.name)}<div class="cell-muted" style="font-weight:400; font-size:12px;">${escapeHtml(c.subject || '')}</div></td>
          <td>${statusBadge(c.status)}</td>
          <td style="min-width:140px;">${progressBar(cn)}<span class="cell-muted" style="font-size:12px;">${cn.processed || 0}/${cn.total || 0}</span></td>
          <td>${cn.sent || 0}</td>
          <td>${cn.failed || 0}</td>
          <td class="cell-muted">${formatDate(c.created_at)}</td>
          <td><div class="row-actions">
            <button class="icon-btn" data-view="${escapeHtml(c.id)}" title="Details">${icon('eye', 15)}</button>
            <button class="icon-btn danger" data-del="${escapeHtml(c.id)}" title="Delete">${icon('trash-2', 15)}</button>
          </div></td>
        </tr>`; }).join('')}
      </tbody></table></div>`;
  refreshIcons(list);

  list.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewCampaign(b.dataset.view)));
  list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmDialog('Delete this campaign? History records are kept.', { title: 'Delete campaign', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try { await api.deleteCampaign(b.dataset.del); toast('Campaign deleted.', 'success'); refresh(); }
    catch (e) { toast(e.message, 'error'); }
  }));
}

async function viewCampaign(id) {
  const c = await api.campaign(id);
  const rows = Object.values(c.results || {});
  openModal({
    title: `Campaign · ${c.name}`,
    size: 'xl',
    body: `
      <div class="grid grid-2" style="margin-bottom:16px;">
        <div><div class="kv"><span>Subject</span><span>${escapeHtml(c.subject || '—')}</span></div>
          <div class="kv"><span>Status</span><span>${escapeHtml(c.status)}</span></div>
          <div class="kv"><span>Started</span><span>${formatDate(c.started_at)}</span></div>
          <div class="kv"><span>Finished</span><span>${formatDate(c.finished_at)}</span></div></div>
        <div><div class="kv"><span>Processed</span><span>${c.counters.processed}/${c.counters.total}</span></div>
          <div class="kv"><span>Submitted</span><span>${c.counters.sent}</span></div>
          <div class="kv"><span>Failed</span><span>${c.counters.failed}</span></div>
          <div class="kv"><span>Unknown</span><span>${c.counters.unknown}</span></div></div>
      </div>
      <div class="table-wrap" style="max-height:380px; overflow:auto;">
        <table class="data"><thead><tr><th>Company</th><th>Email</th><th>Status</th><th>Attempts</th><th>Last error</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="cell-strong">${escapeHtml(r.company_name)}</td>
          <td class="cell-muted">${escapeHtml(r.email)}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${r.attempts || 0}</td>
          <td class="cell-muted" style="font-size:12px;">${escapeHtml(r.last_error || '—')}</td>
        </tr>`).join('')}</tbody></table>
      </div>`,
    actions: [{ label: 'Close' }],
  });
}

// --- Wizard ----------------------------------------------------------------

function openWizard() {
  wizardState = {
    step: 0,
    name: '', subject: '', template_id: '',
    recipients: [], selected: new Set(),
    onlyPending: true,
    settings: null,
  };
  const modal = openModal({
    title: 'New campaign',
    size: 'xl',
    body: '<div id="wizard-body"></div>',
    actions: [
      { label: 'Cancel', variant: 'btn-ghost', closeOnClick: true },
      { label: 'Back', variant: 'btn-secondary', closeOnClick: false, onClick: () => { wizardState.step = Math.max(0, wizardState.step - 1); paintWizard(); } },
      { label: 'Next', variant: 'btn-primary', id: 'wizard-next', closeOnClick: false, onClick: () => onNext(modal) },
    ],
  });
  modal.overlay.querySelector('.modal-footer').firstElementChild.textContent = 'Cancel';
  wizardState.modal = modal;
  initWizard();
}

async function initWizard() {
  try {
    const [settings, templates, recipients] = await Promise.all([api.settings(), api.templates(), api.recipients({})]);
    wizardState.settings = settings;
    wizardState.templates = templates.items;
    wizardState.recipients = recipients.items;
    wizardState.template_id = (templates.items.find((t) => t.is_default) || templates.items[0] || {}).id || '';
    // The subject is per campaign: there is no stored default to fall back to.
    wizardState.subject = '';
    paintWizard();
  } catch (e) { toast(e.message, 'error'); }
}

function paintWizard() {
  const body = document.getElementById('wizard-body');
  if (!body) return;
  const step = wizardState.step;
  const steps = ['Details', 'Recipients', 'Preview', 'Confirm'];

  const stepper = `<div class="steps">${steps.map((label, i) =>
    `<div class="step ${i === step ? 'active' : (i < step ? 'done' : '')}"><span class="step-num">${i + 1}</span>${label}</div>`).join('')}</div>`;

  let content = '';
  if (step === 0) {
    content = `
      <div class="field"><label for="wz-name">Campaign name</label><input class="input" id="wz-name" value="${escapeHtml(wizardState.name)}" placeholder="Q4 outreach"></div>
      <div class="field"><label for="wz-subject">Email subject <span class="req">required</span></label><input class="input" id="wz-subject" value="${escapeHtml(wizardState.subject)}" placeholder="e.g. A quick proposal for {{COMPANY_NAME}}"></div>
      <div class="hint" style="margin:-8px 0 14px;">This subject is stored with the campaign and preserved in history. Use <code>{{SUBJECT}}</code> in your template to render it inside the email body.</div>
      <div class="field"><label for="wz-template">Template</label>
        <select class="select" id="wz-template">${wizardState.templates.map((t) =>
          `<option value="${escapeHtml(t.id)}" ${t.id === wizardState.template_id ? 'selected' : ''}>${escapeHtml(t.name)}${t.is_default ? ' (default)' : ''}</option>`).join('')}</select></div>`;
  } else if (step === 1) {
    const list = wizardState.recipients.filter((r) => !wizardState.onlyPending || r.status === 'pending');
    content = `
      <div class="toolbar">
        <label class="checkbox"><input type="checkbox" id="wz-pending" ${wizardState.onlyPending ? 'checked' : ''}> Only pending</label>
        <button class="btn btn-sm btn-secondary" id="wz-all">Select all</button>
        <button class="btn btn-sm btn-ghost" id="wz-none">Clear</button>
        <span class="chip">${icon('check-square', 14)} ${wizardState.selected.size} selected</span>
      </div>
      ${list.length ? `<div class="list-select">${list.map((r) => `
        <div class="row">
          <input type="checkbox" data-recipient="${escapeHtml(r.id)}" ${wizardState.selected.has(r.id) ? 'checked' : ''}>
          <div class="grow"><strong>${escapeHtml(r.company_name)}</strong><span>${escapeHtml(r.email)}</span></div>
          ${statusBadge(r.status)}
        </div>`).join('')}</div>`
        : `<div class="empty-state"><h3>No eligible recipients</h3><p>Adjust the filter or add recipients first.</p></div>`}`;
  } else if (step === 2) {
    content = `
      <div class="grid grid-2" style="align-items:start;">
        <div>
          <div class="section-title">Review</div>
          <div class="kv"><span>Campaign</span><span>${escapeHtml(wizardState.name || '—')}</span></div>
          <div class="kv"><span>Subject</span><span>${escapeHtml(wizardState.subject || '—')}</span></div>
          <div class="kv"><span>Sender</span><span>${escapeHtml(wizardState.settings?.sender_name || '—')}</span></div>
          <div class="kv"><span>From</span><span>${escapeHtml(wizardState.settings?.email || '—')}</span></div>
          <div class="kv"><span>Recipients</span><span>${wizardState.selected.size}</span></div>
          <div id="wz-warnings" style="margin-top:12px;"></div>
        </div>
        <div>
          <div class="section-title">Preview (first recipient)</div>
          <iframe class="preview-frame" id="wz-preview" sandbox="" style="height:400px;" title="Campaign preview"></iframe>
        </div>
      </div>`;
  } else {
    content = `
      <div class="notice notice-warning" style="margin-bottom:16px;">${icon('triangle-alert', 16)}
        <span>Sending starts immediately and uses real SMTP delivery. Emails are sent sequentially with a delay, and each recipient receives a separate message.</span></div>
      <div class="kv"><span>Recipients</span><span>${wizardState.selected.size}</span></div>
      <div class="kv"><span>Template</span><span>${escapeHtml(wizardState.templates.find((t) => t.id === wizardState.template_id)?.name || '—')}</span></div>
      <div class="kv"><span>Subject</span><span>${escapeHtml(wizardState.subject)}</span></div>
      <div class="notice" style="margin-top:16px;">${icon('shield', 16)} <span>Successfully submitted recipients are never resent automatically.</span></div>`;
  }

  body.innerHTML = stepper + content;

  // bind step-specific controls
  if (step === 0) {
    body.querySelector('#wz-name').addEventListener('input', (e) => { wizardState.name = e.target.value; });
    body.querySelector('#wz-subject').addEventListener('input', (e) => { wizardState.subject = e.target.value; });
    body.querySelector('#wz-template').addEventListener('change', (e) => { wizardState.template_id = e.target.value; });
  } else if (step === 1) {
    body.querySelector('#wz-pending').addEventListener('change', (e) => { wizardState.onlyPending = e.target.checked; paintWizard(); });
    body.querySelector('#wz-all').addEventListener('click', () => {
      wizardState.recipients.filter((r) => !wizardState.onlyPending || r.status === 'pending').forEach((r) => wizardState.selected.add(r.id));
      paintWizard();
    });
    body.querySelector('#wz-none').addEventListener('click', () => { wizardState.selected.clear(); paintWizard(); });
    body.querySelectorAll('[data-recipient]').forEach((cb) => cb.addEventListener('change', (e) => {
      if (e.target.checked) wizardState.selected.add(e.target.dataset.recipient); else wizardState.selected.delete(e.target.dataset.recipient);
      paintWizard();
    }));
  } else if (step === 2) {
    paintWizardPreview();
  }

  const nextBtn = wizardState.modal.overlay.querySelector('[data-action="2"]');
  if (nextBtn) nextBtn.textContent = step === 3 ? 'Create & start sending' : 'Next';
  refreshIcons(body);
}

async function paintWizardPreview() {
  const warningsBox = document.getElementById('wz-warnings');
  const frame = document.getElementById('wz-preview');
  if (!warningsBox || !frame) return;
  warningsBox.innerHTML = spinner('Rendering preview');
  refreshIcons(warningsBox);

  const selected = wizardState.recipients.filter((r) => wizardState.selected.has(r.id));
  const sample = selected[0];
  try {
    const tpl = await api.template(wizardState.template_id);
    const result = await api.previewTemplate({
      html: tpl.html,
      design: tpl.design,
      company_name: sample ? sample.company_name : 'Example Company',
      subject: wizardState.subject,
    });
    frame.setAttribute('srcdoc', result.html);

    const emails = new Set();
    const duplicates = selected.filter((r) => {
      const key = r.email.toLowerCase();
      if (emails.has(key)) return true;
      emails.add(key);
      return false;
    });
    const msgs = [];
    if (!wizardState.subject.trim()) msgs.push('This campaign has no subject.');
    if (!(tpl.html || '').trim()) msgs.push('The selected template is empty.');
    const unresolved = (result.unresolved_variables || []);
    if (unresolved.length) msgs.push(`Variables with no value: ${unresolved.join(', ')}`);
    const unknown = (result.unknown_variables || []);
    if (unknown.length) msgs.push(`Unsupported variables: ${unknown.map((v) => '{{' + v + '}}').join(', ')}`);
    if (duplicates.length) msgs.push(`${duplicates.length} duplicate email address(es) in selection`);
    const incomplete = selected.filter((r) => !String(r.company_name || '').trim() || !String(r.email || '').trim());
    if (incomplete.length) msgs.push(`${incomplete.length} recipient(s) are missing a company name or email address`);
    if (!wizardState.settings?.has_password) msgs.push('SMTP App Password is not configured — sending will fail.');
    warningsBox.innerHTML = msgs.length
      ? `<div class="notice notice-warning">${icon('triangle-alert', 16)}<span>${msgs.map(escapeHtml).join('<br>')}</span></div>`
      : `<div class="notice notice-success">${icon('check-circle-2', 16)}<span>No issues detected.</span></div>`;
  } catch (e) {
    warningsBox.innerHTML = `<div class="notice notice-error">${escapeHtml(e.message)}</div>`;
  }
  refreshIcons(warningsBox);
}

async function onNext(modal) {
  const step = wizardState.step;
  if (step === 0) {
    if (!wizardState.name.trim()) { toast('Enter a campaign name.', 'warning'); return false; }
    if (!wizardState.subject.trim()) { toast('Enter an email subject for this campaign.', 'warning'); return false; }
    if (!wizardState.template_id) { toast('Select a template.', 'warning'); return false; }
    wizardState.step = 1; paintWizard(); return false;
  }
  if (step === 1) {
    if (!wizardState.selected.size) { toast('Select at least one recipient.', 'warning'); return false; }
    wizardState.step = 2; paintWizard(); return false;
  }
  if (step === 2) { wizardState.step = 3; paintWizard(); return false; }
  // final: create + start
  try {
    const campaign = await api.createCampaign({
      name: wizardState.name,
      subject: wizardState.subject,
      template_id: wizardState.template_id,
      recipient_ids: [...wizardState.selected],
    });
    modal.close();
    try {
      await api.startCampaign(campaign.id);
      // Queueing never depends on a local process. Report the worker's *real*
      // state so nobody is told a campaign is sending when the queue consumer
      // is offline or this deployment has no worker configured at all.
      const worker = await api.workerStatus().catch(() => null);
      if (worker && worker.configured === false) {
        toast('Campaign queued, but no send worker is configured for this deployment, so it will not send yet.', 'warning');
      } else if (worker && worker.queue && !worker.queue.consumer_online) {
        toast('Campaign queued — it sends as soon as the send worker is available.', 'warning');
      } else {
        toast('Campaign queued — the send worker is online and will deliver it.', 'success');
      }
    } catch (e) {
      toast(`Campaign created but not started: ${e.message}`, 'warning');
    }
    refresh();
  } catch (e) { toast(e.message, 'error'); return false; }
}

function refresh() {
  paintActive();
  paintList();
  refreshTopbar();
}

export async function render(container, { params = [] } = {}) {
  host = container;
  container.innerHTML = `
    <div class="page-head">
      <div><h2>Campaigns</h2><p>Send templates to selected recipients with live progress and full control.</p></div>
      <div class="page-actions"><button class="btn btn-primary" id="btn-new-campaign">${icon('plus', 16)} New campaign</button></div>
    </div>
    <div id="active-campaign" style="display:none;"></div>
    <div id="campaign-list"></div>`;

  refreshIcons(container);
  container.querySelector('#btn-new-campaign').addEventListener('click', openWizard);

  host.querySelector('#campaign-list').innerHTML = skeleton(3);
  await paintActive();
  await paintList();

  pollTimer = setInterval(() => {
    if (host.__active) { paintActive(); paintList(); }
  }, 2500);

  if (params[0] === 'new') openWizard();

  return () => { clearInterval(pollTimer); pollTimer = null; };
}
