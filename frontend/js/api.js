// Seed Code Mail - API client
// All requests are same-origin; secrets never live in the browser.

async function request(path, { method = 'GET', body, raw = false } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch (networkError) {
    throw new Error('Cannot reach the local server. Is Seed Code Mail running?');
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) {
    let message = 'Request failed';
    if (payload && typeof payload === 'object' && payload.detail) {
      if (typeof payload.detail === 'string') {
        message = payload.detail;
      } else if (Array.isArray(payload.detail)) {
        message = payload.detail
          .map((item) => `${(item.loc || []).slice(1).join('.') || 'field'}: ${item.msg || 'invalid'}`)
          .join('; ');
      } else {
        message = JSON.stringify(payload.detail);
      }
    } else if (typeof payload === 'string' && payload) {
      message = payload;
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return raw ? { payload, response } : payload;
}

const get = (path) => request(path);
const post = (path, body) => request(path, { method: 'POST', body });
const put = (path, body) => request(path, { method: 'PUT', body });
const del = (path) => request(path, { method: 'DELETE' });

export const api = {
  get, post, put, del,

  health: () => get('/api/health'),
  dashboard: () => get('/api/dashboard'),

  recipients: (params = {}) => get('/api/recipients?' + new URLSearchParams(params)),
  addRecipient: (data) => post('/api/recipients', data),
  updateRecipient: (id, data) => put(`/api/recipients/${id}`, data),
  deleteRecipient: (id) => del(`/api/recipients/${id}`),
  deleteRecipients: (ids) => post('/api/recipients/delete-many', { ids }),
  resetRecipientStatus: (ids) => post('/api/recipients/reset-status', { ids }),
  previewImport: (format, content) => post('/api/recipients/import/preview', { format, content }),
  commitImport: (rows) => post('/api/recipients/import', { rows }),
  exportRecipientsUrl: (format) => `/api/recipients/export?format=${format}`,

  templates: () => get('/api/templates'),
  templateVariables: () => get('/api/templates/variables'),
  template: (id) => get(`/api/templates/${id}`),
  createTemplate: (data) => post('/api/templates', data),
  updateTemplate: (id, data) => put(`/api/templates/${id}`, data),
  deleteTemplate: (id) => del(`/api/templates/${id}`),
  duplicateTemplate: (id, name) => post(`/api/templates/${id}/duplicate`, { name }),
  setDefaultTemplate: (id) => post(`/api/templates/${id}/default`, {}),
  previewTemplate: (data) => post('/api/templates/preview', data),
  importTemplate: (data) => post('/api/templates/import', data),
  exportTemplateUrl: (id) => `/api/templates/${id}/export`,

  settings: () => get('/api/settings'),
  saveSettings: (data) => put('/api/settings', data),
  testSmtp: () => post('/api/settings/test-smtp', {}),
  resetSettings: () => post('/api/settings/reset', {}),

  campaigns: () => get('/api/campaigns'),
  campaign: (id) => get(`/api/campaigns/${id}`),
  createCampaign: (data) => post('/api/campaigns', data),
  startCampaign: (id) => post(`/api/campaigns/${id}/start`, {}),
  pauseCampaign: (id) => post(`/api/campaigns/${id}/pause`, {}),
  resumeCampaign: (id) => post(`/api/campaigns/${id}/resume`, {}),
  cancelCampaign: (id) => post(`/api/campaigns/${id}/cancel`, {}),
  deleteCampaign: (id) => del(`/api/campaigns/${id}`),

  history: (params = {}) => get('/api/history?' + new URLSearchParams(params)),
  exportHistoryUrl: (params = {}) => '/api/history/export?' + new URLSearchParams(params),
  clearHistory: () => del('/api/history'),
};
