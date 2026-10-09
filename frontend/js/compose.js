// Seed Code Mail — Compose Email page
//
// Sends an ordinary message through the connected Gmail account with the Gmail
// API. There is no local mail server and no SMTP credential involved: the
// request goes to the trusted backend, which calls Gmail as the user.
//
// Deliberate behaviour:
//   * nothing is submitted until the user presses Send (or Save draft);
//   * the Send button is disabled for the whole in-flight request, so a
//     double-click cannot produce two emails;
//   * sending to more than one address asks for confirmation first;
//   * a success message says exactly what happened — Gmail accepted the message
//     — and never claims it reached the recipient's inbox.

import { gmail, isNotConfigured, isNotConnected, needsReauth } from './lib/gmail.js';
import { api } from './api.js';
import { buildEmailDocument } from './lib/email-html.js';
import {
  escapeHtml, icon, refreshIcons, toast, confirmDialog,
} from './ui.js';
import { navigate } from './app.js';
import { takeComposePrefill, bindConnect, reauthCard, serverSetupCard, connectCard } from './mail-common.js';
import { displayName } from './auth.js';

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

let state = {
  status: null,
  templateId: '',
  attachments: [],   // { filename, mimeType, data(base64), size }
  mode: 'html',      // 'html' | 'text'
  sending: false,
};

function addressCount(value) {
  return String(value || '')
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean).length;
}

function field(id, label, { type = 'text', value = '', placeholder = '', hint = '', autocomplete = '' } = {}) {
  return `<div class="field">
    <label for="${id}">${escapeHtml(label)}</label>
    <input class="input" id="${id}" type="${type}" value="${escapeHtml(value)}"
      placeholder="${escapeHtml(placeholder)}" ${autocomplete ? `autocomplete="${autocomplete}"` : ''}>
    ${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''}
  </div>`;
}

export async function render(container) {
  state = { status: null, templateId: '', attachments: [], mode: 'html', sending: false };

  container.innerHTML = `
    <div class="page-head">
      <div><h2>Compose Email</h2>
        <p>Send a normal email from your connected Gmail account.</p></div>
      <div class="page-actions">
        <button class="btn btn-ghost" id="compose-clear">${icon('eraser', 16)} Clear</button>
      </div>
    </div>
    <div id="compose-status"></div>
    <div id="compose-body"></div>`;

  refreshIcons(container);
  const statusEl = container.querySelector('#compose-status');
  const bodyEl = container.querySelector('#compose-body');

  try {
    state.status = await gmail.status();
  } catch (error) {
    bodyEl.innerHTML = `<div class="notice notice-error">${icon('alert-circle', 16)}<span>${escapeHtml(error.message)}</span></div>`;
    refreshIcons(bodyEl);
    return;
  }

  const configuration = state.status.configuration;
  const connection = state.status.connection;

  if (!state.status.configured && configuration && !configuration.gmail_configured) {
    bodyEl.innerHTML = serverSetupCard(configuration);
    refreshIcons(bodyEl);
    return;
  }
  if (!connection || !connection.connected) {
    bodyEl.innerHTML = connection?.needs_reauth ? reauthCard(connection.last_error) : connectCard({});
    bindConnect(bodyEl);
    refreshIcons(bodyEl);
    return;
  }
  if (connection.capabilities && connection.capabilities.send === false) {
    bodyEl.innerHTML = `<div class="notice notice-warning">${icon('triangle-alert', 16)}<span>
      The connected account did not grant permission to send mail. Reconnect Gmail and allow
      “Send email on your behalf” to use Compose.</span></div>`;
    refreshIcons(bodyEl);
    return;
  }

  statusEl.innerHTML = `
    <div class="mailbox-strip">
      <span class="status-led is-ok"></span>
      <span>Sending as <strong>${escapeHtml(connection.email)}</strong></span>
      <div class="grow"></div>
      <button class="btn btn-ghost btn-sm" id="compose-manage">${icon('user-cog', 15)} Manage connection</button>
    </div>`;
  refreshIcons(statusEl);
  statusEl.querySelector('#compose-manage').addEventListener('click', () => navigate('profile'));

  const prefill = takeComposePrefill() || {};

  bodyEl.innerHTML = `
    <div class="grid compose-grid">
      <div class="card compose-card">
        <div class="compose-recipients">
          ${field('c-to', 'To', { value: prefill.to || '', placeholder: 'name@example.com, second@example.com', autocomplete: 'off' })}
          <button class="btn btn-ghost btn-sm" id="toggle-ccbcc" aria-expanded="false">${icon('chevron-down', 15)} Cc / Bcc</button>
          <div id="ccbcc" hidden>
            ${field('c-cc', 'Cc', { placeholder: 'optional', autocomplete: 'off' })}
            ${field('c-bcc', 'Bcc', { placeholder: 'optional', autocomplete: 'off' })}
          </div>
        </div>
        ${field('c-subject', 'Subject', { value: prefill.subject || '' })}

        <div class="compose-toolbar">
          <div class="field inline-field">
            <label for="c-template">Start from a template</label>
            <select class="select" id="c-template"><option value="">No template (blank)</option></select>
          </div>
          <div class="segmented" role="group" aria-label="Body format">
            <button type="button" class="seg-btn is-active" data-mode="html">HTML</button>
            <button type="button" class="seg-btn" data-mode="text">Plain text</button>
          </div>
          <button class="btn btn-ghost btn-sm" id="compose-preview">${icon('eye', 15)} Preview</button>
        </div>

        <div class="field">
          <label for="c-body">Message</label>
          <textarea class="input textarea compose-body" id="c-body" rows="14"
            placeholder="Write your message…">${escapeHtml(prefill.text || '')}</textarea>
          <div class="hint" id="c-body-hint">HTML is sent as a multipart message with a plain-text alternative generated for you.</div>
        </div>

        <div class="field">
          <label for="c-files">Attachments</label>
          <input class="input" id="c-files" type="file" multiple>
          <div class="hint">Up to ${MAX_ATTACHMENTS} files, about 10 MB in total. Attachments are sent straight to Gmail and are not stored by Seed Code Mail.</div>
          <ul class="attachment-list" id="c-attachments"></ul>
        </div>

        <div class="compose-actions">
          <button class="btn btn-primary" id="compose-send">${icon('send', 16)} Send email</button>
          <button class="btn btn-secondary" id="compose-draft">${icon('file-pen', 16)} Save as Gmail draft</button>
          <span class="grow"></span>
          <span class="hint" id="compose-count"></span>
        </div>
        <div id="compose-result" aria-live="polite"></div>
      </div>

      <div class="card compose-side">
        <div class="card-head"><h3>${icon('shield', 16)} How this is sent</h3></div>
        <div class="kv"><span>From</span><span>${escapeHtml(connection.email)}</span></div>
        <div class="kv"><span>Channel</span><span>Gmail API (OAuth 2.0)</span></div>
        <p class="hint">Gmail accepts the message and puts it in your real Sent mailbox. A successful
        submit is not the same as confirmed inbox delivery, so Seed Code Mail does not claim that it
        is.</p>
        <div class="card-head" style="margin-top:16px;"><h3>${icon('info', 16)} Note</h3></div>
        <p class="hint">Personalisation variables such as <code>{{COMPANY_NAME}}</code> belong to
        campaigns. If a template contains them, replace the values here before sending.</p>
      </div>
    </div>`;

  refreshIcons(bodyEl);

  // --- templates ------------------------------------------------------------

  const templateSelect = bodyEl.querySelector('#c-template');
  try {
    const { items } = await api.templates();
    state.templates = items;
    templateSelect.innerHTML = '<option value="">No template (blank)</option>'
      + items.map((tpl) => `<option value="${escapeHtml(tpl.id)}">${escapeHtml(tpl.name)}${tpl.is_default ? ' (default)' : ''}</option>`).join('');
  } catch (_) {
    templateSelect.disabled = true;
    templateSelect.innerHTML = '<option value="">Templates unavailable</option>';
  }

  templateSelect.addEventListener('change', async () => {
    state.templateId = templateSelect.value;
    if (!state.templateId) return;
    try {
      const tpl = await api.template(state.templateId);
      const rendered = await api.previewTemplate({
        html: tpl.html || '',
        design: tpl.design,
        company_name: '',
        subject: bodyEl.querySelector('#c-subject').value,
      });
      bodyEl.querySelector('#c-body').value = rendered.html || tpl.html || '';
      const unresolved = rendered.unresolved_variables || [];
      const note = unresolved.length
        ? `Template loaded. These variables have no value in a normal email: ${unresolved.join(', ')}`
        : 'Template loaded.';
      toast(note, unresolved.length ? 'warning' : 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  // --- cc/bcc ---------------------------------------------------------------

  bodyEl.querySelector('#toggle-ccbcc').addEventListener('click', (event) => {
    const box = bodyEl.querySelector('#ccbcc');
    const open = box.hidden;
    box.hidden = !open;
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });

  // --- mode -----------------------------------------------------------------

  bodyEl.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.mode = button.dataset.mode;
      bodyEl.querySelectorAll('[data-mode]').forEach((other) => other.classList.toggle('is-active', other === button));
      bodyEl.querySelector('#c-body-hint').textContent = state.mode === 'html'
        ? 'HTML is sent as a multipart message with a plain-text alternative generated for you.'
        : 'Plain text is sent as-is, and Gmail will show it in a fixed-width font.';
    });
  });

  // --- live recipient count -------------------------------------------------

  const updateCount = () => {
    const total = addressCount(bodyEl.querySelector('#c-to').value)
      + addressCount(bodyEl.querySelector('#c-cc').value)
      + addressCount(bodyEl.querySelector('#c-bcc').value);
    bodyEl.querySelector('#compose-count').textContent = total
      ? `${total} recipient${total === 1 ? '' : 's'}`
      : 'No recipients yet';
  };
  ['#c-to', '#c-cc', '#c-bcc'].forEach((selector) => {
    bodyEl.querySelector(selector).addEventListener('input', updateCount);
  });
  updateCount();

  // --- attachments ----------------------------------------------------------

  const attachList = bodyEl.querySelector('#c-attachments');
  const paintAttachments = () => {
    attachList.innerHTML = state.attachments.length
      ? state.attachments.map((file, index) => `
        <li class="attachment readonly">
          ${icon('paperclip', 15)}
          <span class="attachment-name">${escapeHtml(file.filename)}</span>
          <span class="cell-muted">${escapeHtml(`${Math.round(file.size / 1024)} KB`)}</span>
          <button class="icon-btn danger" data-remove="${index}" aria-label="Remove attachment">${icon('x', 14)}</button>
        </li>`).join('')
      : '';
    refreshIcons(attachList);
    attachList.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        state.attachments.splice(Number(button.dataset.remove), 1);
        paintAttachments();
      });
    });
  };

  bodyEl.querySelector('#c-files').addEventListener('change', async (event) => {
    const files = [...event.target.files || []];
    event.target.value = '';
    for (const file of files) {
      if (state.attachments.length >= MAX_ATTACHMENTS) {
        toast(`Only ${MAX_ATTACHMENTS} attachments can be sent in one message.`, 'warning');
        break;
      }
      const size = state.attachments.reduce((total, item) => total + item.size, 0) + file.size;
      if (size > MAX_ATTACHMENT_BYTES) {
        toast('The attachments would be too large to send.', 'warning');
        break;
      }
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      state.attachments.push({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: btoa(binary),
        size: file.size,
      });
    }
    paintAttachments();
  });

  // --- preview --------------------------------------------------------------

  bodyEl.querySelector('#compose-preview').addEventListener('click', () => {
    const raw = bodyEl.querySelector('#c-body').value;
    // Remote images are blocked in the preview too: it shows what a recipient on
    // a privacy-conscious client sees, and `srcdoc` is assigned as a property so
    // the markup is never parsed as HTML by this page.
    const document_ = state.mode === 'html'
      ? buildEmailDocument({ html: raw, allowRemote: false })
      : buildEmailDocument({ text: raw, allowRemote: false });

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-xl" role="dialog" aria-modal="true" aria-label="Message preview">
        <div class="modal-header"><h3>Preview</h3>
          <button class="icon-btn" data-close aria-label="Close">${icon('x', 18)}</button></div>
        <div class="modal-body">
          <div class="notice">${icon('info', 16)}<span>Preview shown with remote images blocked, exactly
          as a recipient on a privacy-conscious client would see it.</span></div>
          <iframe class="reader-frame" sandbox="" referrerpolicy="no-referrer"
            title="Message preview" style="height:420px;"></iframe>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" data-close>Close</button></div>
      </div>`;
    overlay.querySelector('iframe').srcdoc = document_;
    document.body.appendChild(overlay);
    refreshIcons(overlay);
    const close = () => {
      overlay.classList.add('modal-closing');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    };
    overlay.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', close));
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
  });

  // --- actions --------------------------------------------------------------

  const setBusy = (busy) => {
    state.sending = busy;
    bodyEl.querySelector('#compose-send').disabled = busy;
    bodyEl.querySelector('#compose-draft').disabled = busy;
  };

  const collect = () => ({
    to: bodyEl.querySelector('#c-to').value,
    cc: bodyEl.querySelector('#c-cc').value,
    bcc: bodyEl.querySelector('#c-bcc').value,
    subject: bodyEl.querySelector('#c-subject').value.trim(),
    body: bodyEl.querySelector('#c-body').value,
    attachments: state.attachments.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })),
    from_name: displayName() || '',
  });

  const validate = (payload) => {
    const recipients = [payload.to, payload.cc, payload.bcc]
      .flatMap((value) => String(value || '').split(/[,;\n]/))
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!recipients.length) return 'Add at least one recipient.';
    const invalid = recipients.filter((address) => !/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(address.replace(/^<|>$/g, '')));
    if (invalid.length) return `These addresses are not valid: ${invalid.join(', ')}`;
    if (!payload.subject) return 'Add a subject before sending.';
    if (!payload.body.trim()) return 'Write a message before sending.';
    return '';
  };

  const run = async ({ draft }) => {
    if (state.sending) return; // duplicate-submission guard
    const payload = collect();
    const problem = validate(payload);
    if (problem) { toast(problem, 'warning'); return; }

    const recipientTotal = addressCount(payload.to) + addressCount(payload.cc) + addressCount(payload.bcc);
    if (!draft && recipientTotal > 1) {
      const ok = await confirmDialog(
        `Send this email to ${recipientTotal} recipients in a single message? Each of them will see the others' addresses unless you use Bcc.`,
        { title: 'Send to multiple recipients', confirmLabel: 'Send' },
      );
      if (!ok) return;
    }

    const resultBox = bodyEl.querySelector('#compose-result');
    setBusy(true);
    resultBox.innerHTML = `<div class="loading-inline"><span class="spinner"></span><span>${draft ? 'Saving draft' : 'Sending via Gmail'}…</span></div>`;
    try {
      const response = await gmail.send({
        ...payload,
        html: state.mode === 'html' ? payload.body : '',
        text: state.mode === 'text' ? payload.body : '',
        attachments: payload.attachments,
        draft: Boolean(draft),
      });

      if (response.saved_as_draft) {
        resultBox.innerHTML = `<div class="notice notice-success">${icon('check-circle-2', 16)}<span>
          Saved as a Gmail draft. Nothing was sent.</span></div>`;
        toast('Saved as a Gmail draft.', 'success');
      } else {
        resultBox.innerHTML = `<div class="notice notice-success">${icon('check-circle-2', 16)}<span>
          Gmail accepted the message (id <code>${escapeHtml(String(response.message_id || '').slice(0, 24))}</code>).
          ${escapeHtml(response.note || '')}</span>
          <button class="btn btn-ghost btn-sm" id="go-sent">View Sent</button></div>`;
        bodyEl.querySelector('#go-sent')?.addEventListener('click', () => navigate('sent'));
        toast('Message submitted to Gmail.', 'success');
      }
      state.attachments = [];
      paintAttachments();
      refreshIcons(resultBox);
    } catch (error) {
      if (isNotConnected(error)) {
        resultBox.innerHTML = connectCard({ title: 'Gmail is not connected' });
        bindConnect(resultBox);
      } else if (needsReauth(error)) {
        resultBox.innerHTML = reauthCard(error.message);
        bindConnect(resultBox);
      } else if (isNotConfigured(error)) {
        resultBox.innerHTML = serverSetupCard(error.configuration || state.status?.configuration);
      } else {
        resultBox.innerHTML = `<div class="notice notice-error">${icon('alert-circle', 16)}<span>${escapeHtml(error.message)}</span></div>`;
      }
      refreshIcons(resultBox);
    } finally {
      setBusy(false);
    }
  };

  bodyEl.querySelector('#compose-send').addEventListener('click', () => run({ draft: false }));
  bodyEl.querySelector('#compose-draft').addEventListener('click', () => run({ draft: true }));

  container.querySelector('#compose-clear').addEventListener('click', async () => {
    const ok = await confirmDialog('Clear the message you are writing?', { title: 'Clear message', confirmLabel: 'Clear', danger: true });
    if (!ok) return;
    ['#c-to', '#c-cc', '#c-bcc', '#c-subject', '#c-body'].forEach((selector) => {
      bodyEl.querySelector(selector).value = '';
    });
    state.attachments = [];
    state.templateId = '';
    templateSelect.value = '';
    paintAttachments();
    bodyEl.querySelector('#compose-result').innerHTML = '';
    updateCount();
  });

  // Reply handoff: keep the caret ready in the body.
  if (prefill.to || prefill.text) bodyEl.querySelector('#c-body').focus();
  else bodyEl.querySelector('#c-to').focus();
}
