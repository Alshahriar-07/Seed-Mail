// Tests for frontend/js/legal.js — the public Privacy Policy and Terms of Service
//
// These pin three things that are easy to break silently:
//
//   1. routing — /privacy, /terms and the `-policy`/`-of-service` spellings must
//      resolve from a real path AND from a hash, and a hash must always win so a
//      direct visit to /privacy cannot swallow later in-app navigation;
//   2. required content — the disclosures Google's OAuth review and a reader both
//      need must be present in the rendered document, not merely intended;
//   3. honesty — the documents must not claim verification, certification or
//      practices the code does not implement, and must not contain placeholders.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_NAME, PRODUCTION_URL, SUPPORT_EMAIL, OPERATOR,
  EFFECTIVE_DATE, LAST_UPDATED,
  LEGAL_META, LEGAL_SLUGS,
  legalFooter, legalHref, legalSlugFromLocation, legalUrl,
  privacyDocument, renderInApp, renderPublicPage, termsDocument,
} from '../../frontend/js/legal.js';

// --- routing ----------------------------------------------------------------

test('a real path resolves to its legal document', () => {
  assert.equal(legalSlugFromLocation({ pathname: '/privacy', hash: '' }), 'privacy');
  assert.equal(legalSlugFromLocation({ pathname: '/terms', hash: '' }), 'terms');
  assert.equal(legalSlugFromLocation({ pathname: '/privacy/', hash: '' }), 'privacy');
  assert.equal(legalSlugFromLocation({ pathname: '/privacy-policy', hash: '' }), 'privacy');
  assert.equal(legalSlugFromLocation({ pathname: '/terms-of-service', hash: '' }), 'terms');
});

test('a hash route resolves to its legal document', () => {
  assert.equal(legalSlugFromLocation({ pathname: '/', hash: '#/privacy' }), 'privacy');
  assert.equal(legalSlugFromLocation({ pathname: '/', hash: '#/terms' }), 'terms');
  assert.equal(legalSlugFromLocation({ pathname: '/', hash: '#/privacy-policy' }), 'privacy');
  assert.equal(legalSlugFromLocation({ pathname: '/', hash: '#/terms-of-service' }), 'terms');
});

test('the hash wins over a stale path so /privacy cannot shadow the app router', () => {
  // A direct visit to /privacy leaves that path in the address bar. Navigating to
  // #/inbox afterwards must render the app, not the policy again.
  assert.equal(legalSlugFromLocation({ pathname: '/privacy', hash: '#/inbox' }), '');
  assert.equal(legalSlugFromLocation({ pathname: '/privacy', hash: '#/compose' }), '');
  // And an ordinary application URL is never mistaken for a document.
  for (const hash of ['#/inbox', '#/dashboard', '#/settings', '#/about']) {
    assert.equal(legalSlugFromLocation({ pathname: '/', hash }), '', `${hash} is not a legal page`);
  }
  assert.equal(legalSlugFromLocation({ pathname: '/', hash: '' }), '');
  assert.equal(legalSlugFromLocation({ pathname: '/inbox', hash: '' }), '');
  assert.equal(legalSlugFromLocation({}), '');
});

test('legal URLs are the production https URLs and never a beta or preview host', () => {
  assert.equal(legalUrl('privacy'), 'https://mrseedmail.vercel.app/privacy');
  assert.equal(legalUrl('terms'), 'https://mrseedmail.vercel.app/terms');
  for (const slug of LEGAL_SLUGS) {
    const url = legalUrl(slug);
    assert.ok(url.startsWith('https://'), `${slug} must be an https URL`);
    assert.ok(!/beta|preview|localhost|127\.0\.0\.1/.test(url), `${slug} must not target a non-production host`);
  }
  assert.equal(PRODUCTION_URL, 'https://mrseedmail.vercel.app');
});

test('in-app links are hash routes and cover every declared slug', () => {
  for (const slug of LEGAL_SLUGS) {
    assert.equal(legalHref(slug), `#/${slug}`);
    assert.ok(LEGAL_META[slug], `${slug} needs metadata`);
    assert.ok(LEGAL_META[slug].title && LEGAL_META[slug].navLabel && LEGAL_META[slug].path);
  }
  assert.equal(legalHref('nonsense'), '#/privacy', 'an unknown slug must not produce a broken link');
});

// --- document structure -----------------------------------------------------

const HTML_TAG = /<[^>]+>/g;
function text(html) {
  return String(html).replace(HTML_TAG, ' ');
}

test('every section is unique and the table of contents links to it', () => {
  for (const [slug, document] of [['privacy', privacyDocument()], ['terms', termsDocument()]]) {
    const ids = [...document.matchAll(/<h2 id="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(ids.length >= 12, `${slug} should have a full set of sections (found ${ids.length})`);
    assert.equal(new Set(ids).size, ids.length, `${slug} has a duplicate section id`);

    const toc = [...document.matchAll(/<a href="#([^"]+)">([^<]+)<\/a>/g)].map((match) => match[1]);
    for (const id of toc) {
      assert.ok(ids.includes(id), `${slug}: contents links to missing section #${id}`);
    }
    assert.equal(toc.length, ids.length, `${slug}: every section must appear in the contents`);
  }
});

test('both documents carry the app name, effective date and last-updated date', () => {
  for (const document of [privacyDocument(), termsDocument()]) {
    assert.ok(document.includes(APP_NAME));
    assert.ok(document.includes(`Effective ${EFFECTIVE_DATE}`), 'missing effective date');
    assert.ok(document.includes(`Last updated ${LAST_UPDATED}`), 'missing last-updated date');
  }
});

// --- required disclosures ---------------------------------------------------

test('the privacy policy names every Google scope and what each one is for', () => {
  const policy = privacyDocument();
  for (const scope of ['gmail.readonly', 'gmail.send', 'gmail.modify', 'gmail.compose']) {
    assert.ok(policy.includes(scope), `the policy must name the ${scope} scope`);
  }
  // Narrower-scope intent, stated where a reviewer looks for it.
  assert.match(policy, /deliberately not requested/);
  assert.match(policy, /Limited Use/);
});

test('the privacy policy states where Gmail data is processed and what is not done with it', () => {
  const policy = text(privacyDocument());
  assert.match(policy, /Gmail message contents are not copied into the application/i);
  assert.match(policy, /AES-256-GCM/);
  assert.match(policy, /row level security/i);
  assert.match(policy, /not.{0,20}sold/i, 'the policy must state that data is not sold');
  assert.match(policy, /not used for advertising, profiling or\s+creditworthiness/);
  assert.match(policy, /artificial-intelligence models/, 'the AI-training statement must be present');
  assert.match(policy, /no third-party advertising, analytics or\s+tracking scripts/);
  // The campaign path is different from the Compose path, and the policy must say so.
  assert.match(policy, /App Password held in the\n?\s*worker host's own environment/i);
});

test('the privacy policy explains revocation, retention and deletion', () => {
  const policy = privacyDocument();
  assert.match(policy, /myaccount\.google\.com\/permissions/, 'must link Google permission revocation');
  assert.match(policy, /How long data is kept/);
  assert.match(policy, /Deleting your data/);
  // No self-service deletion exists, and the policy must not imply that it does.
  assert.match(policy, /not currently implemented/);
});

test('the terms cover the required sections in plain language', () => {
  const terms = termsDocument();
  for (const heading of [
    'Acceptance',
    'What the service does',
    'Accounts and security',
    'Connecting an email account',
    'Your responsibility for the email you send',
    'Bulk email, spam and abuse',
    'Compliance and provider policies',
    'Rate limits, quotas and availability',
    'Third-party services',
    'Data and privacy',
    'Suspension and termination',
    'Disclaimers and limitation of liability',
    'Changes to the service and these terms',
    'Governing law',
    'Contact',
  ]) {
    assert.ok(terms.includes(heading), `the terms must include a "${heading}" section`);
  }
  assert.match(terms, /honoured promptly/);
  assert.match(terms, /not\s+a guarantee of inbox\s+delivery|not<\/strong> a guarantee of inbox/i);
});

test('contact details are present and use the production domain only', () => {
  for (const document of [privacyDocument(), termsDocument()]) {
    assert.ok(document.includes(OPERATOR));
    assert.ok(document.includes(SUPPORT_EMAIL), 'a working contact address must be published');
    assert.ok(document.includes('mrseedmail.vercel.app'));
    assert.ok(!document.includes('seedmail-beta'), 'no beta hostname in a legal document');
    assert.ok(!/localhost|127\.0\.0\.1/.test(document), 'no loopback address in a legal document');
  }
});

// --- honesty ----------------------------------------------------------------

test('no document claims Google verification, certification or impossibility', () => {
  const forbidden = [
    /google[- ]verified/i,
    /verified by google/i,
    /google has approved/i,
    /reviewed by google/i,
    /fully compliant/i,
    /guaranteed.*delivery/i,
    /we never store/i,
    /iso ?27001/i,
    /soc ?2/i,
    /hipaa/i,
    /\bGDPR compliant\b/i,
  ];
  for (const [name, document] of [['privacy', privacyDocument()], ['terms', termsDocument()]]) {
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(document), `${name} must not claim ${pattern}`);
    }
  }
});

test('no document contains a placeholder or TODO', () => {
  const placeholders = [/\bTODO\b/, /\bTBD\b/, /\bFIXME\b/, /lorem ipsum/i, /XXX/, /\[insert/i, /changeme/i];
  for (const [name, document] of [['privacy', privacyDocument()], ['terms', termsDocument()]]) {
    for (const pattern of placeholders) {
      assert.ok(!pattern.test(document), `${name} must not contain placeholder text (${pattern})`);
    }
  }
});

test('missing owner-supplied details are marked as such rather than invented', () => {
  // The notice is the mechanism that keeps the documents honest: if it is turned
  // off without resolving the items, this test documents that a decision was made.
  const policy = privacyDocument();
  const hasNotice = policy.includes('id="owner-actions"');
  const mentionsRegisteredEntity = /registered legal entity name and postal address/i.test(policy);
  assert.ok(hasNotice || !mentionsRegisteredEntity, 'the operator notice may only be removed once the items are resolved');
});

// --- rendering --------------------------------------------------------------

test('the public renderer writes the document, the top bar and an accurate title', () => {
  const body = { innerHTML: '' };
  const topbar = { innerHTML: '' };
  const title = renderPublicPage({ slug: 'privacy', body, topbar, signedIn: false });

  assert.equal(title, 'privacy');
  assert.ok(body.innerHTML.includes('<h1>Privacy Policy</h1>'));
  assert.ok(topbar.innerHTML.includes('#/terms'), 'the top bar must link to the other document');
  assert.ok(topbar.innerHTML.includes('Sign in'), 'a signed-out visitor is offered sign-in');
});

test('the public renderer offers a way back to the app when a session exists', () => {
  const body = { innerHTML: '' };
  const topbar = { innerHTML: '' };
  renderPublicPage({ slug: 'terms', body, topbar, signedIn: true });
  assert.ok(topbar.innerHTML.includes('#/inbox'), 'a signed-in reader must be able to return');
  assert.ok(topbar.innerHTML.includes('Open app'));
});

test('the in-app renderer returns no cleanup function and renders both documents', () => {
  const container = { innerHTML: '' };
  for (const slug of LEGAL_SLUGS) {
    const cleanup = renderInApp(container, slug, { refreshIcons: () => {} });
    assert.equal(cleanup, undefined, 'a static document needs no teardown');
    assert.ok(container.innerHTML.includes(LEGAL_META[slug].title));
    assert.ok(container.innerHTML.includes(`id="${slug === 'privacy' ? 'about' : 'acceptance'}"`));
  }
});

test('the footer links to both documents and to the source, never to a beta host', () => {
  const footer = legalFooter();
  assert.ok(footer.includes('href="#/privacy"'));
  assert.ok(footer.includes('href="#/terms"'));
  assert.ok(footer.includes('Privacy Policy') && footer.includes('Terms of Service'));
  assert.ok(footer.includes('https://github.com/Alshahriar-07/Seed-Mail'));
  assert.ok(!footer.includes('seedmail-beta'));
});
