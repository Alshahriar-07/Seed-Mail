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
 * Avatar markup.
 *
 * The initials are always rendered underneath the image, so the fallback needs no
 * JavaScript: if the picture never loads (or is removed by `refreshAvatars`), the
 * initials are already there. `refreshAvatars` only removes a picture that
 * actually failed, which is what turns a broken-image icon into a clean fallback.
 *
 * @param {{ name?: string, email?: string, src?: string }} person
 * @param {{ size?: number, kind?: 'account'|'sender', className?: string }} [options]
 */
export function avatarMarkup(person = {}, { size = 32, kind = 'sender', className = '' } = {}) {
  const name = String(person.name ?? '').trim();
  const email = String(person.email ?? '').trim();
  const initials = personInitials(name, email);
  const src = safeImageUrl(person.src);
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
