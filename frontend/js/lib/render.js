// Seed Code Mail — template rendering (pure, no DOM)
//
// This is a faithful port of the original Python `services/template_service.py`
// rendering rules, moved to the browser because email templates are now stored
// locally in the user's browser (IndexedDB) instead of on a server.
//
// Guarantees preserved from the original implementation:
//   * Only the documented variables are substituted; anything else is left
//     untouched so it stays visible and is reported as "unknown".
//   * Injected values are HTML-escaped for their context. Inside a tag
//     attribute, quotes are escaped too; a URL is only placed in an attribute
//     after passing validation.
//   * A fresh string is produced on every call — a saved template is never
//     mutated, so one recipient's data can never leak into another's message.

export const DESIGN_TOKENS = {
  email_bg: '{{D_EMAIL_BG}}',
  container_bg: '{{D_CONTAINER_BG}}',
  primary_text: '{{D_PRIMARY_TEXT}}',
  secondary_text: '{{D_SECONDARY_TEXT}}',
  muted_text: '{{D_MUTED_TEXT}}',
  accent: '{{D_ACCENT}}',
  font_family: '{{D_FONT_FAMILY}}',
  font_size: '{{D_FONT_SIZE}}',
  container_width: '{{D_CONTAINER_WIDTH}}',
  border_radius: '{{D_BORDER_RADIUS}}',
  logo_url: '{{D_LOGO_URL}}',
  button_label: '{{D_BUTTON_LABEL}}',
  button_bg: '{{D_BUTTON_BG}}',
  footer_text: '{{D_FOOTER_TEXT}}',
};

export const DEFAULT_DESIGN = {
  email_bg: '#F7F7F7',
  container_bg: '#FFFFFF',
  primary_text: '#111111',
  secondary_text: '#444444',
  muted_text: '#737373',
  accent: '#111111',
  font_family: "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  font_size: '16px',
  container_width: '600px',
  border_radius: '12px',
  logo_url: '',
  button_label: 'Learn more',
  button_bg: '#111111',
  footer_text: '',
};

// Single source of truth for the variable guide and for substitution, so an
// undocumented variable is never silently supported.
export const VARIABLE_GUIDE = [
  {
    name: 'COMPANY_NAME',
    group: 'Recipient',
    summary: "The recipient company's name.",
    example: '<h2>Hello {{COMPANY_NAME}},</h2>',
    example_label: 'HTML greeting',
  },
  {
    name: 'SENDER_NAME',
    group: 'Sender',
    summary: "The configured sender's display name.",
    example: '<p>Best regards,<br>{{SENDER_NAME}}</p>',
    example_label: 'Signature name',
  },
  {
    name: 'SENDER_EMAIL',
    group: 'Sender',
    summary: "The configured sender's email address.",
    example: '<a href="mailto:{{SENDER_EMAIL}}">{{SENDER_EMAIL}}</a>',
    example_label: 'Signature email',
  },
  {
    name: 'SUBJECT',
    group: 'Campaign',
    summary: 'The subject of the current campaign.',
    example: '<title>{{SUBJECT}}</title>',
    example_label: 'Document title',
  },
  {
    name: 'GITHUB_URL',
    group: 'Sender',
    summary: 'The GitHub profile or project URL configured in Settings (if set).',
    example: '<a href="{{GITHUB_URL}}">GitHub</a>',
    example_label: 'Link button',
  },
];

export const PERSONALIZATION_VARS = VARIABLE_GUIDE.map((item) => item.name);

// Variables that must resolve to a safe absolute URL inside a tag attribute.
export const URL_VARIABLES = new Set(['GITHUB_URL']);

const VARIABLE_PATTERN = '\\{\\{\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\}\\}';
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SIZE_RE = /^\d{1,4}(px|pt|em|rem|%)$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_RE = /^https?:\/\/[^\s"'<>]+$/i;

const COLOR_KEYS = new Set([
  'email_bg', 'container_bg', 'primary_text', 'secondary_text',
  'muted_text', 'accent', 'button_bg',
]);
const SIZE_KEYS = new Set(['font_size', 'container_width', 'border_radius']);

export function isValidEmail(value) {
  const text = String(value ?? '').trim();
  return Boolean(text) && text.length <= 254 && EMAIL_RE.test(text);
}

export function isValidUrl(value) {
  const text = String(value ?? '').trim();
  return Boolean(text) && text.length <= 2048 && URL_RE.test(text);
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * True when `index` in `source` sits inside an HTML tag attribute.
 * Uses only raw text, so malformed markup degrades to "text context".
 */
function attributeContext(source, index) {
  const tagStart = source.lastIndexOf('<', index - 1);
  if (tagStart === -1) return false;
  const tagEnd = source.lastIndexOf('>', index - 1);
  if (tagEnd > tagStart) return false; // between tags -> content
  const fragment = source.slice(tagStart, index);
  if (!/^<[a-zA-Z!/]/.test(fragment)) return false;
  const doubleQuotes = (fragment.match(/"/g) || []).length;
  const singleQuotes = (fragment.match(/'/g) || []).length;
  return doubleQuotes % 2 === 1 || singleQuotes % 2 === 1;
}

export function variableTokens(html) {
  return [...String(html ?? '').matchAll(new RegExp(VARIABLE_PATTERN, 'g'))].map((m) => m[1]);
}

/** Normalize/validate a design object, mirroring the original Python rules. */
export function cleanDesign(design) {
  const cleaned = { ...DEFAULT_DESIGN };
  if (!design || typeof design !== 'object') return cleaned;
  for (const [key, value] of Object.entries(design)) {
    if (!(key in DESIGN_TOKENS)) continue;
    const text = String(value ?? '').trim();
    if (COLOR_KEYS.has(key)) {
      if (COLOR_RE.test(text)) cleaned[key] = text;
    } else if (SIZE_KEYS.has(key)) {
      if (SIZE_RE.test(text)) cleaned[key] = text;
    } else if (key === 'logo_url') {
      if (!text || /^(https?:\/\/|data:image\/)/.test(text)) cleaned[key] = text;
    } else {
      cleaned[key] = text.slice(0, 400);
    }
  }
  return cleaned;
}

/** Replace {{D_*}} design tokens. Values are author-controlled, not recipient data. */
export function applyDesign(html, design) {
  const merged = { ...DEFAULT_DESIGN };
  if (design && typeof design === 'object') {
    for (const [key, value] of Object.entries(design)) {
      if (key in DESIGN_TOKENS && value !== null && value !== undefined && value !== '') {
        merged[key] = String(value);
      }
    }
  }
  let result = String(html ?? '');
  for (const [key, token] of Object.entries(DESIGN_TOKENS)) {
    result = result.split(token).join(merged[key] ?? '');
  }
  return result;
}

/** Substitute supported variables, escaping according to the HTML context. */
export function substituteVariables(html, values) {
  const source = String(html ?? '');
  const regex = new RegExp(VARIABLE_PATTERN, 'g');
  const out = [];
  let position = 0;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const name = match[1];
    out.push(source.slice(position, match.index));

    if (!(name in values)) {
      out.push(match[0]); // unknown token: keep as-is
      position = match.index + match[0].length;
      continue;
    }

    const raw = values[name] ?? '';
    if (attributeContext(source, match.index)) {
      if (URL_VARIABLES.has(name)) {
        out.push(isValidUrl(raw) ? escapeAttr(raw) : '');
      } else {
        out.push(escapeAttr(raw));
      }
    } else {
      out.push(escapeText(raw));
    }
    position = match.index + match[0].length;
  }

  out.push(source.slice(position));
  return out.join('');
}

export function usedVariables(html) {
  return [...new Set(variableTokens(html))].sort();
}

/** Supported variables the template does not use at all. */
export function missingVariables(html) {
  const used = new Set(variableTokens(html));
  return PERSONALIZATION_VARS.filter((name) => !used.has(name));
}

/** Tokens that look like variables but are not supported. */
export function unknownVariables(html) {
  return [...new Set(variableTokens(html))]
    .filter((token) => !PERSONALIZATION_VARS.includes(token) && !token.startsWith('D_'))
    .sort();
}

/** Supported variables used in the template whose value is empty. */
export function unresolvedVariables(html, values) {
  const used = new Set(variableTokens(html));
  return PERSONALIZATION_VARS
    .filter((name) => used.has(name) && !String(values?.[name] ?? '').trim())
    .sort();
}

export function buildPersonalizedHtml(templateHtml, design, {
  companyName = '', senderName = '', senderEmail = '', subject = '', githubUrl = '',
} = {}) {
  const rendered = applyDesign(templateHtml, design);
  const values = {
    COMPANY_NAME: companyName || '',
    SENDER_NAME: senderName || '',
    // Only a syntactically valid address is used; otherwise the token resolves
    // to an empty string instead of leaking a half-configured value.
    SENDER_EMAIL: isValidEmail(senderEmail) ? senderEmail : '',
    SUBJECT: subject || '',
    GITHUB_URL: isValidUrl(githubUrl) ? githubUrl : '',
  };
  return substituteVariables(rendered, values);
}

/**
 * Preview payload builder — returns the same shape the old server endpoint did,
 * so the editor and campaign wizard did not need rewriting.
 */
export function previewTemplate({
  html = '', design = null, company_name = '', sender_name = '',
  sender_email = '', subject = '', github_url = '',
} = {}) {
  const company = company_name || 'Example Company';
  const rendered = buildPersonalizedHtml(html, design, {
    companyName: company,
    senderName: sender_name,
    senderEmail: sender_email,
    subject,
    githubUrl: github_url,
  });
  const values = {
    COMPANY_NAME: company,
    SENDER_NAME: sender_name,
    SENDER_EMAIL: sender_email,
    SUBJECT: subject,
    GITHUB_URL: github_url,
  };
  return {
    html: rendered,
    used_variables: usedVariables(html),
    missing_variables: missingVariables(html),
    unknown_variables: unknownVariables(html),
    unresolved_variables: unresolvedVariables(html, values),
    empty: !String(html ?? '').trim(),
  };
}
