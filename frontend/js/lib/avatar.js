// Seed Code Mail — avatars
//
// One implementation for every avatar in the application, so the account chip,
// the inbox rows and the message header cannot drift apart.
//
// What this module will and will not do:
//
//   * It renders a **real image only from a URL it was actually given**. For the
//     signed-in account that URL comes from the user's own Supabase auth
//     metadata (`avatar_url` / `picture`), which is populated when the account
//     signed in through a provider that supplies one. Nothing is constructed,
//     guessed, hashed into a third-party avatar service, or scraped.
//   * Gmail's API does not expose a sender's profile photo: it has no endpoint
//     for it, and `messages.get` returns headers — a name and an address — and
//     nothing else. So a sender avatar is **initials**, not a picture. Fabricating
//     an image URL for a sender would either leak the address to a third party or
//     simply fail, and neither is acceptable.
//   * An image that fails to load degrades to the same initials, so a broken
//     avatar is never an empty circle or a broken-image icon.

import { escapeHtml } from '../ui.js';

/**
 * One or two letters standing in for a person.
 *
 * A display name usually has the answer ("Nadia Okonkwo" → "NO"). An address does
 * not — "ada@example.com" must read "A", not "AE" from the local part split on
 * the `@` — so the local part's first letter is used when there is no name.
 */
export function personInitials(name, email) {
  const label = String(name ?? '').trim();
  if (label) {
    const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return words[0].slice(0, 2).toUpperCase();
  }
  const address = String(email ?? '').trim();
  const local = address.split('@')[0] || address;
  const cleaned = local.replace(/[^\p{L}\p{N}]+/gu, '');
  return (cleaned[0] || '?').toUpperCase();
}

/**
 * Only an `https:` URL, a `data:image/…` URL or a same-origin relative path is
 * ever placed in an `src`. This is what keeps a malicious or accidental
 * `javascript:` value from an auth-metadata field out of the DOM.
 */
export function safeImageUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^data:image\//i.test(text)) return text;
  if (/^https:\/\//i.test(text)) return text;
  if (/^\/[^/]/.test(text)) return text;
  return '';
}

/**
 * The picture to show for a person, without ever inventing one.
 *
 * A message header or list row can only legitimately show a *picture* when the
 * person is the signed-in account holder: that is the one address whose photo the
 * application genuinely has (from the account's own auth metadata). Any other
 * address — an Inbox sender, a campaign recipient — has no trustworthy photo
 * source, because Gmail's API exposes a name and an address and nothing else, so
 * it keeps its initials. This is the rule that prevents one account's picture
 * from being shown next to another account's message.
 *
 * The comparison is on the whole, lower-cased address and never on a partial
 * match, and the URL is accepted only when it passes `safeImageUrl`.
 *
 * @param {{ name?: string, email?: string, src?: string }} person
 * @param {{ accountEmail?: string, accountSrc?: string }} [account]
 */
export function avatarSource(person = {}, { accountEmail = '', accountSrc = '' } = {}) {
  const own = String(accountEmail || '').trim().toLowerCase();
  const email = String(person?.email || '').trim().toLowerCase();
  if (own && email && own === email) {
    return safeImageUrl(accountSrc) || safeImageUrl(person?.src);
  }
  return safeImageUrl(person?.src);
}

/**
 * Avatar markup.
 *
 * The initials are always rendered underneath the image, so the fallback needs no
 * JavaScript: if the picture never loads (or is removed by `refreshAvatars`), the
 * initials are already there. `refreshAvatars` only removes a picture that
 * actually failed, which is what turns a broken-image icon into a clean fallback.
 *
 * @param {{ name?: string, email?: string, src?: string }} person
 * @param {{ size?: number, kind?: 'account'|'sender', className?: string, src?: string }} [options]
 *   `src` on the options object overrides the person's own `src`, so a caller can
 *   resolve the picture through `avatarSource` without rebuilding the object.
 */
export function avatarMarkup(person = {}, { size = 32, kind = 'sender', className = '', src: optionSrc = '' } = {}) {
  const name = String(person.name ?? '').trim();
  const email = String(person.email ?? '').trim();
  const initials = personInitials(name, email);
  const src = safeImageUrl(optionSrc) || safeImageUrl(person.src);
  const label = name || email;
  const accessible = label ? ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"` : '';

  return `<span class="avatar avatar-${kind}${src ? ' has-image' : ''}${className ? ` ${className}` : ''}"`
    + ` data-avatar style="--avatar-size:${Number(size) || 32}px"${accessible}>`
    + (src
      ? `<img class="avatar-image" src="${escapeHtml(src)}" alt="" data-avatar-image loading="lazy" referrerpolicy="no-referrer">`
      : '')
    + `<span class="avatar-initials" aria-hidden="true">${escapeHtml(initials)}</span>`
    + '</span>';
}

/** The inner content of an avatar host, for the topbar element that already exists. */
export function avatarInner(person = {}, { src = '' } = {}) {
  const value = safeImageUrl(src);
  return (value
    ? `<img class="avatar-image" src="${escapeHtml(value)}" alt="" data-avatar-image loading="lazy" referrerpolicy="no-referrer">`
    : '') + `<span class="avatar-initials" aria-hidden="true">${escapeHtml(personInitials(person.name, person.email))}</span>`;
}

/**
 * Attaches the load-failure handler to every avatar image under `root`, once.
 *
 * Called wherever `refreshIcons` is called, because the two problems are the
 * same shape: markup is produced as a string, then the runtime hooks are attached
 * to the resulting nodes.
 */
export function refreshAvatars(root = document) {
  root.querySelectorAll('[data-avatar-image]').forEach((image) => {
    if (image.dataset.avatarWired === '1') return;
    image.dataset.avatarWired = '1';
    const host = image.closest('[data-avatar]');
    image.addEventListener('error', () => {
      host?.classList.add('is-broken');
      host?.classList.remove('has-image');
      image.remove();
    });
    // An error that fired before this handler was attached (a cached 404) never
    // fires again, so it is checked once here too.
    if (image.complete && image.naturalWidth === 0) {
      host?.classList.add('is-broken');
      host?.classList.remove('has-image');
      image.remove();
    }
  });
}
