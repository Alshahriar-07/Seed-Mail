// Seed Code Mail — public legal documents (Privacy Policy, Terms of Service)
//
// Why these exist as code rather than as static HTML files:
//   * a single-page app served by a rewrite rule (see vercel.json) has exactly
//     one HTML entry point, so /privacy and /terms are rendered by the same
//     router that renders everything else;
//   * it keeps the two documents in one place, next to the notes that say which
//     part of the system each statement describes.
//
// Accuracy rules this file follows:
//   * every statement about data is derived from the schema in
//     supabase/migrations/*.sql and from the backend in api/ and backend/ —
//     not from an aspiration;
//   * nothing is claimed that the code does not do: no "we never store
//     anything", no certification, no guarantee of inbox delivery;
//   * missing owner-supplied details (a postal address, a confirmed support
//     mailbox) are marked as owner actions instead of being invented.
//
// IMPORTANT — OWNER REVIEW BEFORE SUBMITTING FOR GOOGLE VERIFICATION
//   1. Confirm OWNER_ACTIONS is empty below, or act on each item.
//   2. Set SHOW_OWNER_ACTION_NOTICE = false once they are resolved so the
//      notice is no longer rendered.
//   3. Keep EFFECTIVE_DATE / LAST_UPDATED honest when the text changes.

export const APP_NAME = 'Seed Code Mail';

// Only the production URL appears in these documents. A legal page must not send
// a reviewer (or a user) to a beta or preview deployment, so no beta hostname is
// referenced here at all — the beta site is a build of this same codebase.
export const PRODUCTION_URL = 'https://mrseedmail.vercel.app';
export const REPOSITORY_URL = 'https://github.com/Alshahriar-07/Seed-Mail';

// The support mailbox. Provenance: the operator's own published contact address,
// which appears in this repository (data/templates.json) and in .env.example's
// SENDER_NAME entry. It is deliberately a single constant so it is trivial to
// change — and the owner must confirm it is still the address they monitor
// before submitting the app for Google's OAuth verification.
export const SUPPORT_EMAIL = 'alshahriarsowan425@gmail.com';

// The operator's own name, as published in this repository. No company, no
// registration number and no address is claimed, because none is verifiable
// here — that absence is listed in OWNER_ACTIONS below.
export const OPERATOR = 'Al Shahriar Sowan';

export const EFFECTIVE_DATE = 'October 9, 2026';
export const LAST_UPDATED = 'October 9, 2026';

// Rendered as a clearly marked operator notice on both documents while it is
// non-empty. Remove each item only by verifying it, not by deleting the line.
export const OWNER_ACTIONS = [
  'Confirm the support address above is one you actively monitor, or replace it.',
  'Decide whether to publish a registered legal entity name and postal address. None is claimed here, because none could be verified from this repository.',
  'Confirm the jurisdiction whose law should govern the Terms of Service; the current wording deliberately states that the operator chooses it rather than naming one.',
];

// Set to false once OWNER_ACTIONS is empty. Kept as a constant so the notice
// cannot be forgotten in one document but not the other.
export const SHOW_OWNER_ACTION_NOTICE = OWNER_ACTIONS.length > 0;

// --- routing ----------------------------------------------------------------

export const LEGAL_SLUGS = ['privacy', 'terms'];

/** Accepted spellings → canonical slug. `/privacy-policy` and `/terms-of-service`
 *  are supported because the request that produced these pages listed them as
 *  alternatives and both are common. */
const SLUG_ALIASES = {
  privacy: 'privacy',
  'privacy-policy': 'privacy',
  terms: 'terms',
  'terms-of-service': 'terms',
};

export const LEGAL_META = {
  privacy: {
    slug: 'privacy',
    title: 'Privacy Policy',
    navLabel: 'Privacy',
    path: '/privacy',
    description: `How ${APP_NAME} collects, uses, stores and deletes information, including the Gmail data it accesses through Google's API.`,
  },
  terms: {
    slug: 'terms',
    title: 'Terms of Service',
    navLabel: 'Terms',
    path: '/terms',
    description: `The terms on which ${APP_NAME} is provided, including account responsibilities, acceptable sending practices and service limitations.`,
  },
};

/**
 * Resolves the legal page requested by a URL, from either a real path
 * (`/privacy`, which Vercel rewrites to index.html) or a hash route
 * (`#/privacy`, which the in-app links use).
 *
 * Returns `''` when the current URL is not a legal page.
 *
 * @param {{pathname?: string, hash?: string}} [locationLike]
 */
export function legalSlugFromLocation(locationLike = typeof location !== 'undefined' ? location : {}) {
  const hash = String(locationLike?.hash || '').replace(/^#\/?/, '');

  // The hash wins when there is one. It has to: a direct visit to `/privacy`
  // leaves that path in the address bar for the rest of the session, so if the
  // path were always consulted, every later hash navigation (`#/inbox`) would
  // still look like a request for the legal page.
  if (hash) {
    const firstFromHash = hash.split(/[/?#]/)[0].toLowerCase();
    return SLUG_ALIASES[firstFromHash] || '';
  }

  const segments = String(locationLike?.pathname || '').split('/').filter(Boolean);
  const lastFromPath = segments.length ? segments[segments.length - 1].toLowerCase() : '';
  return SLUG_ALIASES[lastFromPath] || '';
}

/** The canonical in-app link for a legal page (a hash route, so it works
 *  without a server round trip and survives the SPA rewrite). */
export function legalHref(slug) {
  return `#/${LEGAL_META[slug] ? slug : 'privacy'}`;
}

/** Canonical, absolute, https URL for a legal page — the form to give Google. */
export function legalUrl(slug) {
  return `${PRODUCTION_URL}${LEGAL_META[slug] ? LEGAL_META[slug].path : '/privacy'}`;
}

// --- shared fragments -------------------------------------------------------

function contactBlock() {
  return `
    <h2 id="contact">Contact</h2>
    <div class="legal-contact">
      <dl>
        <dt>Operator</dt><dd>${OPERATOR}</dd>
        <dt>Project</dt><dd>${APP_NAME} — <a href="${PRODUCTION_URL}/">${PRODUCTION_URL.replace('https://', '')}</a></dd>
        <dt>Support &amp; privacy requests</dt>
        <dd><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></dd>
        <dt>Source code</dt>
        <dd><a href="${REPOSITORY_URL}" rel="noreferrer noopener" target="_blank">${REPOSITORY_URL.replace('https://', '')}</a></dd>
      </dl>
    </div>`;
}

function ownerActionNotice() {
  if (!SHOW_OWNER_ACTION_NOTICE) return '';
  return `
    <div class="legal-owner-note" id="owner-actions">
      <strong>Operator review required before this document is relied on.</strong>
      This text was written from the application's actual behaviour, but the
      following details can only be supplied by the operator. They are listed
      here rather than filled in with invented values. Remove this notice by
      setting <code>SHOW_OWNER_ACTION_NOTICE</code> to <code>false</code> in
      <code>frontend/js/legal.js</code> once every item is resolved.
      <ul>${OWNER_ACTIONS.map((item) => `<li>${item}</li>`).join('')}</ul>
    </div>`;
}

function tableOfContents(sections) {
  return `
    <nav class="legal-toc" aria-label="Contents">
      <div class="legal-toc-title">Contents</div>
      <ol>
        ${sections.map((section) => `<li><a href="#${section.id}">${section.heading}</a></li>`).join('')}
      </ol>
    </nav>`;
}

// --- Privacy Policy ---------------------------------------------------------

const PRIVACY_SECTIONS = [
  {
    id: 'about',
    heading: '1. What Seed Code Mail is',
    html: `
      <p>${APP_NAME} is a self-hostable web application for working with one Gmail
      account and for sending personalised email campaigns. It is an independent
      project operated by ${OPERATOR}, and it is offered free of charge.</p>
      <p>Two different systems send mail, and this policy distinguishes them because
      they use different data:</p>
      <ul>
        <li><strong>Reading and sending ordinary email</strong> (Inbox, message
        reader, Compose, Sent) is done through Google's official Gmail API, using
        an authorization <em>you</em> grant to <em>your own</em> Google account.</li>
        <li><strong>Campaign sending</strong> (Recipients, Campaigns, Email
        History) is performed by a separate background send worker process, which
        delivers through Gmail's SMTP service using a Gmail credential that the
        operator of the deployment configures on the worker host. That credential
        is not yours and is not created by your Google authorization — see
        section 6.</li>
      </ul>`,
  },
  {
    id: 'your-data',
    heading: '2. Information you give us',
    html: `
      <p>When you create an account and use the application, the following is stored
      in the application's Supabase database:</p>
      <ul>
        <li><strong>Account</strong>: your email address, and a password. The
        password is handled entirely by Supabase Auth (the application never
        receives or stores it — it is hashed by the authentication service).</li>
        <li><strong>Profile</strong>: a display name, if you provide one.</li>
        <li><strong>Sending preferences</strong>: sender email address and display
        name, an optional GitHub URL, the SMTP host and port, send delay, timeout
        and retry settings.</li>
        <li><strong>Recipients</strong>: the company names and email addresses you
        add, import or edit, together with each recipient's last known delivery
        status.</li>
        <li><strong>Campaigns</strong>: campaign name, the subject line you write,
        a reference to the template you chose, the campaign's run configuration,
        progress counters, a copy of the template content captured when the
        campaign is queued (so the worker can send with your browser closed), and
        the queue/lease bookkeeping the worker needs.</li>
        <li><strong>Delivery records</strong>: one row per campaign recipient
        attempt — the address, company name, attempt count, outcome
        (<code>sent</code>, <code>failed</code> or <code>unknown</code>), a short
        error category and message, which channel was used, and any message
        identifier the channel returned. These append-only records are what the
        Email History page shows.</li>
      </ul>
      <p><strong>Templates are not stored on the server.</strong> Email templates
      you build are saved in your own browser (IndexedDB). The server only receives
      a template reference, plus the snapshot described above at the moment you
      queue a campaign.</p>
      <p>The application does not ask for, and does not store, your Gmail password.
      It never asks for an App Password in the browser: an App Password belongs to
      the send worker's own server-side environment.</p>`,
  },
  {
    id: 'google-account',
    heading: '3. Google account access (OAuth)',
    html: `
      <p>Connecting a Gmail account is a separate, explicit action you take from the
      Profile page or the Inbox. It sends you to Google's own consent screen, where
      you approve specific permissions. The application requests only these four
      scopes, each of which backs a feature that exists in the app:</p>
      <ul>
        <li><code>gmail.readonly</code> — list and read Inbox and Sent, open a
        message, download an attachment.</li>
        <li><code>gmail.send</code> — send a message you wrote in Compose from your
        account.</li>
        <li><code>gmail.modify</code> — mark a message read or unread.</li>
        <li><code>gmail.compose</code> — save a message as a Gmail draft.</li>
      </ul>
      <p>Broader Gmail scopes — <code>gmail.labels</code>,
      <code>gmail.settings.*</code>, and the full <code>https://mail.google.com/</code>
      scope — are deliberately not requested. The application cannot read your
      Google password, and it cannot access any Google service other than Gmail
      through this authorization.</p>
      <p>Google sends back an <strong>access token</strong> (short-lived) and a
      <strong>refresh token</strong> (long-lived). See section 7 for how those are
      stored.</p>`,
  },
  {
    id: 'gmail-data',
    heading: '4. Which Gmail data is accessed, and why',
    html: `
      <p>Gmail data is read through the Gmail API when — and only when — a page or
      action needs it:</p>
      <ul>
        <li><strong>Inbox / Sent lists</strong>: message identifiers and pages of
        message metadata (subject, sender and recipient names and addresses,
        internal date, snippet, unread state) for the page you requested.</li>
        <li><strong>Message reader</strong>: the message's headers and its text and
        HTML bodies, plus the list of its attachments (filename, size, inline
        image identifiers) and, if you click one, the attachment's bytes.</li>
        <li><strong>Search</strong>: the query you type is sent to Gmail as a search
        term.</li>
        <li><strong>Sending</strong>: the recipients, subject, body and attachments
        of a message you compose.</li>
        <li><strong>Read state</strong>: opening an unread message marks it read;
        the reader's toggle can mark a message read or unread.</li>
      </ul>
      <p><strong>Gmail message contents are not copied into the application's
      database.</strong> Gmail remains the store of record; the application reads
      what it needs to display one page or one message, in memory, per request.
      There is no background mailbox import, no full-mailbox index, and no copy of
      your mail kept on the server after the request completes. The one piece of
      mailbox-derived state that persists is the account address and the granted
      scope list in the connection record described in section 7, and it exists so
      the interface can tell you truthfully what is connected.</p>
      <p>Attachment files are streamed to your browser when you ask to download
      one. They are not written to any application storage.</p>`,
  },
  {
    id: 'connecting',
    heading: '5. How a Gmail connection is established and protected',
    html: `
      <p>Starting a connection creates a short-lived, random <code>state</code>
      value. It is signed and echoed back to the browser in an
      <code>HttpOnly</code>, <code>SameSite=Lax</code> cookie with a lifetime of a
      few minutes. Google returns that value on the redirect, and the callback
      endpoint only accepts it if it matches the signed value and the cookie — so a
      callback cannot be replayed for a different browser session, and the
      authorization code cannot be swapped for someone else's account.</p>
      <p>The redirect URI is fixed on the server
      (<code>/api/gmail/callback</code>) and must match the value registered on the
      Google Cloud OAuth client; arbitrary redirect targets are not accepted.</p>`,
  },
  {
    id: 'campaign-data',
    heading: '6. Campaign sending and the send worker',
    html: `
      <p>Campaigns are a bulk tool and behave differently from Compose. When you
      queue a campaign, the following leaves your browser and is stored in your own
      account rows in Supabase: the campaign subject, the recipient addresses and
      company names, a snapshot of the template content and design, your sending
      preferences, and the campaign's run configuration.</p>
      <p>A separate background worker process then claims one campaign at a time,
      using an atomic claim that guarantees two workers cannot send the same
      campaign simultaneously, and delivers one message per recipient with a
      configurable delay and bounded retries. It writes each attempt's outcome
      back. A message that was accepted is never re-sent; an attempt whose outcome
      could not be determined is recorded as
      <code>unknown</code> and is deliberately not retried automatically, because
      retrying could duplicate a message.</p>
      <p><strong>The credential used to deliver campaigns.</strong> The worker
      authenticates to Gmail's SMTP service with a Gmail App Password held in the
      worker host's own environment variables. It is never sent to the browser,
      never written to Supabase, and it is not overridable by any request. It
      belongs to the Gmail account the operator configured for that deployment.
      Consequently a campaign's "From" address must be that account (or an address
      Gmail permits it to send as); the sender email address stored in your
      settings is used as the From header but does not change which account
      authenticates. Compose is unaffected by this: messages you send from Compose
      go through <em>your</em> Gmail authorization.</p>
      <p>Neither path claims inbox delivery. A record of <code>sent</code> means the
      provider accepted the message, nothing more.</p>`,
  },
  {
    id: 'tokens',
    heading: '7. How OAuth tokens are stored',
    html: `
      <p>The connection record — your connected Gmail address, the scopes Google
      granted, the token, and connection status — lives in a
      <code>gmail_connections</code> table that the browser is not permitted to
      read at all. Row level security is enabled <em>and forced</em> on that table,
      with no policy granting access to the anonymous or authenticated roles, and
      those roles have had all privileges revoked. Only the server-side code paths
      that hold the service-role credential can read it.</p>
      <p>The refresh token is never stored in plain text. It is encrypted with
      <strong>AES-256-GCM</strong> before it is written, using a key held only in
      the deployment's server-side environment variables
      (<code>GMAIL_TOKEN_ENCRYPTION_KEY</code>). If that key is absent the
      application refuses to store a connection rather than storing one it cannot
      protect. If the stored value cannot be decrypted — for example after a key
      rotation — the connection is marked as needing re-authorization and fails
      closed.</p>
      <p>Access tokens are short-lived and are obtained on demand from the refresh
      token; they are not persisted by the application. No token, encrypted or
      otherwise, is ever returned to the browser, written into a URL, placed in a
      log line, or embedded in a rendered message.</p>
      <p>The service-role key, the Google client secret and the encryption key
      exist only as server-side environment variables. They are never prefixed with
      <code>VITE_</code> (which is how a build client expose a value to the browser)
      and never appear in the built front-end bundle.</p>`,
  },
  {
    id: 'not-collected',
    heading: '8. What is not done with your data',
    html: `
      <p>Stated plainly, because vague wording helps nobody:</p>
      <ul>
        <li>Google user data accessed through the Gmail API is used <strong>only</strong>
        to provide the features you turn on: showing your mail, sending what you
        write, and marking a message read or unread. It is not transferred or sold
        to third parties, and it is not used for advertising, profiling or
        creditworthiness.</li>
        <li>Google user data is <strong>not</strong> used to train or improve
        machine-learning or artificial-intelligence models, and no part of this
        application sends your mail to a model provider. This application contains
        no AI features at all.</li>
        <li>Your mail is <strong>not</strong> sold, rented, or shared with data
        brokers.</li>
        <li>No human at this project reads your email. There is no moderation or
        review queue that inspects message content. Error records contain a short
        technical category and message, not mail content.</li>
        <li>The application contains no third-party advertising, analytics or
        tracking scripts.</li>
      </ul>
      <p>These uses are limited to what is necessary to provide the features you
      request, consistent with the Google API Services User Data Policy and its
      Limited Use requirements.</p>`,
  },
  {
    id: 'cookies',
    heading: '9. Cookies and local browser storage',
    html: `
      <ul>
        <li><strong>Session</strong>: Supabase Auth keeps your sign-in session in
        the browser's own storage so you stay signed in between page loads. Signing
        out clears it.</li>
        <li><strong>OAuth state cookie</strong>: the <code>HttpOnly</code>,
        <code>SameSite=Lax</code> cookie described in section 5, which exists only
        during a Gmail connection attempt and is deleted immediately afterwards.</li>
        <li><strong>Local preferences</strong>: whether the sidebar is collapsed.</li>
        <li><strong>Email templates</strong>: your templates are kept in your
        browser's IndexedDB on this device and are not uploaded.</li>
      </ul>
      <p>No cookie or storage entry is used for advertising or cross-site
      tracking. Clearing your browser's site data removes the local items; it does
      not delete your account data, which is managed as described in sections 12
      and 13.</p>`,
  },
  {
    id: 'processors',
    heading: '10. Service providers that process data',
    html: `
      <p>${APP_NAME} is not run on hardware belonging to the operator. The following
      providers process data on the operator's behalf, each only for the purpose
      listed:</p>
      <ul>
        <li><strong>Supabase</strong> — authentication, the Postgres database
        (including row level security), and storage of the data listed in section 2.
        Supabase is the data processor for account, recipient, campaign and
        connection data.</li>
        <li><strong>Vercel</strong> — serves the web application and runs the
        server-side functions that talk to Google. Requests to
        <code>/api/gmail/*</code> pass through Vercel's platform, and Vercel retains
        standard platform request logs for a limited period.</li>
        <li><strong>Google</strong> — Gmail API and OAuth 2.0. Google processes your
        mail under your own Google account and Google's own terms and privacy
        policy; your authorization is a grant to this application, not a
        replacement for your relationship with Google.</li>
        <li><strong>Google Fonts</strong> and <strong>unpkg</strong> (a CDN) — the
        page loads its web font and its icon library from these hosts. Those
        requests are made by your browser directly and reveal your IP address and
        user agent to them, as any CDN request does.</li>
        <li><strong>A send worker host</strong>, if campaigns are enabled for the
        deployment, running the process described in section 6. It holds no
        database credential beyond the service-role key it needs to claim work and
        write results.</li>
      </ul>
      <p>No other third party receives your data. There are no data-sharing
      agreements to disclose because there is no sale or sharing of personal data
      for value.</p>`,
  },
  {
    id: 'security',
    heading: '11. Security, and its limits',
    html: `
      <p>Measures that are actually in place:</p>
      <ul>
        <li>Every user-owned table has row level security enabled, and ownership is
        taken from the verified session rather than from anything the browser
        supplies. One account cannot read or change another account's rows.</li>
        <li>The Gmail connection table is unreadable by browser roles and holds only
        an AES-256-GCM ciphertext of the refresh token.</li>
        <li>Untrusted email HTML is rendered in a script-free sandboxed frame with a
        restrictive content security policy; remote images are blocked until you
        explicitly load them for a specific message, so a tracking pixel cannot
        report that you opened it.</li>
        <li>Privileged keys exist only in server-side environments. The public
        front-end bundle carries no secret.</li>
      </ul>
      <p>Limits you should know about:</p>
      <ul>
        <li>No system is perfectly secure. This one is maintained by an individual,
        not by a security team, and it has not been independently audited or
        penetration-tested.</li>
        <li>Anyone with access to your signed-in browser profile can use your
        session. Sign out on shared devices.</li>
        <li>The operator of a self-hosted deployment controls that deployment's
        server, its database credentials and its send worker. If you are using an
        instance you do not operate, that operator can technically access stored
        data. Only connect an account to an instance you trust.</li>
      </ul>`,
  },
  {
    id: 'retention',
    heading: '12. How long data is kept',
    html: `
      <ul>
        <li>Account, profile, settings, recipients, campaigns and delivery history
        are kept until you delete them or the account is deleted. Nothing here
        expires on a timer.</li>
        <li>The Gmail connection record is kept until you disconnect the account,
        after which the stored token is deleted.</li>
        <li>Gmail message content is not retained by the application at all (section
        4).</li>
        <li>Platform-level request logs held by the hosting providers expire under
        those providers' own retention schedules.</li>
        <li>If the deployment is backed up, backups may contain deleted rows until
        the backup itself ages out.</li>
      </ul>`,
  },
  {
    id: 'disconnect',
    heading: '13. Disconnecting Gmail and revoking access',
    html: `
      <p>You are in control of the authorization, and there are two independent ways
      to end it:</p>
      <ol>
        <li><strong>In this application</strong> — the Profile page's disconnect
        action removes the stored connection, including the encrypted refresh token.
        Your account, recipients, campaigns and templates are untouched; only
        mailbox access ends.</li>
        <li><strong>In your Google account</strong> — at
        <a href="https://myaccount.google.com/permissions" rel="noreferrer noopener" target="_blank">myaccount.google.com/permissions</a>,
        remove ${APP_NAME} from the list of apps with access. This is the
        authoritative revocation: once it is done, the refresh token the application
        holds stops working.</li>
      </ol>
      <p>Either action stops all reading, sending and read-state changes through your
      Gmail account. If this application later holds a token Google has already
      rejected, the connection is shown as needing re-authorization rather than
      failing silently.</p>`,
  },
  {
    id: 'deletion',
    heading: '14. Deleting your data',
    html: `
      <p>Individual records — recipients, campaigns, history entries — can be
      deleted in the application. Deleting a history record never deletes a Gmail
      message; Gmail is separate and unchanged.</p>
      <p>To have your account and its stored data deleted, ask using the contact
      details below. The request is actioned by deleting your authentication user,
      which cascades to the profile, settings, recipients, campaigns, campaign
      recipients, delivery history and the Gmail connection record. Mail in your
      Gmail mailbox is not affected and cannot be deleted by this application.</p>
      <p>Because deletion is a manual request rather than a self-service button,
      include the email address of the account so it can be identified. An
      automated self-service deletion flow is not currently implemented.</p>`,
  },
  {
    id: 'rights',
    heading: '15. Your rights',
    html: `
      <p>Depending on where you live, you may have rights to access, correct,
      export, restrict or delete your personal data, and to object to certain
      processing. The application supports much of this directly: recipients,
      campaigns and history can be viewed, exported and deleted from the interface,
      and the Gmail authorization can be revoked at any time.</p>
      <p>For anything you cannot do in the interface, use the contact details below.
      Requests are answered by the operator. Note honestly that this is an
      individual-run free service without a formal compliance department, so no
      fixed statutory response time is promised — but a request will not be
      ignored, and there is no charge for making one.</p>`,
  },
  {
    id: 'children',
    heading: '16. Children',
    html: `
      <p>The service is intended for people who are old enough to hold their own
      Gmail account and enter into these terms. It is not directed to children, and
      personal information from children is not knowingly collected. If you believe
      a child has created an account, contact the address below and it will be
      removed.</p>`,
  },
  {
    id: 'changes',
    heading: '17. Changes to this policy',
    html: `
      <p>When the application's data handling changes, this document is updated and
      the "last updated" date above changes with it. The document describes the
      application as it exists in the source repository; the effective and
      last-updated dates are not decorative.</p>`,
  },
];

// --- Terms of Service -------------------------------------------------------

const TERMS_SECTIONS = [
  {
    id: 'acceptance',
    heading: '1. Acceptance',
    html: `
      <p>These terms govern your use of ${APP_NAME} (the "service"). By creating an
      account, signing in, or otherwise using the service, you agree to them. If you
      do not agree, do not use the service.</p>
      <p>The service is operated by ${OPERATOR} (the "operator"). It is a free
      service; no payment is required, and no paid tier is offered by the code in
      this repository.</p>`,
  },
  {
    id: 'description',
    heading: '2. What the service does',
    html: `
      <p>The service provides:</p>
      <ul>
        <li>reading, searching and paging through the Inbox and Sent mailboxes of a
        Gmail account you connect, and opening individual messages;</li>
        <li>composing and sending email from that connected Gmail account;</li>
        <li>marking messages read or unread;</li>
        <li>managing recipients, email templates and campaigns, and having campaigns
        delivered by a background worker.</li>
      </ul>
      <p>Functionality depends on third-party services, on configuration performed
      by the operator of the deployment you are using, and — for campaigns — on a
      send worker actually running. Sections 8 and 9 describe those dependencies
      and their limits.</p>`,
  },
  {
    id: 'accounts',
    heading: '3. Accounts and security',
    html: `
      <ul>
        <li>You must provide an email address you control and keep your password
        confidential. Passwords are handled by Supabase Auth; the operator cannot
        retrieve yours.</li>
        <li>You are responsible for activity under your account. If you believe your
        account has been compromised, change your password and sign out of other
        sessions.</li>
        <li>Do not share your account, or use the service on behalf of someone else
        without their permission.</li>
        <li>Do not attempt to access other users' data, probe or bypass the
        application's access controls, or interfere with the service's operation,
        including its database or its send worker.</li>
        <li>The service is offered free of charge and without a support-level
        agreement. Availability is described in section 8.</li>
      </ul>`,
  },
  {
    id: 'authorization',
    heading: '4. Connecting an email account',
    html: `
      <p>To use the mailbox features you authorize this application to access your
      Gmail account through Google OAuth 2.0. By doing so you confirm that:</p>
      <ul>
        <li>the account is yours, or you are authorized to grant access to it;</li>
        <li>you understand that the application will read messages, send messages as
        you instruct, and change read/unread state, within the permissions you
        approve;</li>
        <li>you can revoke that access at any time, either from the Profile page or
        from your Google account permissions.</li>
      </ul>
      <p>Your use of Gmail through the service remains subject to Google's own terms
      and policies in addition to these terms.</p>`,
  },
  {
    id: 'responsibility',
    heading: '5. Your responsibility for the email you send',
    html: `
      <ul>
        <li>You alone choose the recipients, the content and the timing of the email
        you send, including every campaign.</li>
        <li>You are responsible for having a lawful basis to contact each recipient,
        and for complying with the anti-spam, consent, disclosure and unsubscribe
        requirements that apply to you and to your recipients' jurisdictions.</li>
        <li>You must not use the service to send unsolicited bulk email, deceptive or
        spoofed messages, phishing, malware, harassment, or anything unlawful.</li>
        <li>You must not use the service in a way that would breach your email
        provider's policies or cause the operator's sending account, domain or
        host to be blocked or blacklisted.</li>
      </ul>`,
  },
  {
    id: 'bulk',
    heading: '6. Bulk email, spam and abuse',
    html: `
      <p>The campaign features exist for genuinely intended, permission-based
      communication. Abusing them puts the whole deployment at risk, so:</p>
      <ul>
        <li>recipients must be people you have a real, defensible reason to contact;</li>
        <li>messages must identify you honestly and must not disguise their origin;</li>
        <li>any unsubscribe or opt-out request you receive must be honoured promptly,
        and the recipient removed from your lists;</li>
        <li>importing purchased, scraped or rented address lists is prohibited;</li>
        <li>attempting to evade Gmail's sending limits, retry behaviour or
        deliverability controls is prohibited.</li>
      </ul>
      <p>Accounts used for spam or abuse may be suspended or terminated under
      section 11, without notice where the risk requires it.</p>`,
  },
  {
    id: 'compliance',
    heading: '7. Compliance and provider policies',
    html: `
      <p>You are responsible for complying with the laws that apply to you
      (including marketing, privacy and data-protection law) and with the terms and
      policies of Google, Gmail, Supabase and Vercel, in each case as they apply to
      your use of the service. Nothing in the service is legal advice, and no
      configuration in it makes your sending lawful by itself.</p>`,
  },
  {
    id: 'limits',
    heading: '8. Rate limits, quotas and availability',
    html: `
      <ul>
        <li>Gmail enforces its own sending limits on every account, including
        per-day message and recipient caps. A large campaign can therefore be
        paused, slowed or rejected by Gmail regardless of this application's
        behaviour. Daily limits are set by Google, not by the operator.</li>
        <li>Campaign delivery requires a send worker process to be running for the
        deployment you use. If it is not running or is unreachable, campaigns stay
        queued and nothing is sent. The interface reports this state rather than
        pretending a message was delivered.</li>
        <li>The service depends on free tiers of third-party infrastructure. Those
        limits — database size and compute, function invocations and bandwidth —
        can pause or interrupt the service, and there is no uptime guarantee or
        service-level commitment.</li>
        <li>A submission recorded as <code>sent</code> means the email provider
        accepted the message. It is <strong>not</strong> a guarantee of inbox
        delivery, a guarantee that the recipient read it, or proof that it was not
        filtered as spam.</li>
      </ul>`,
  },
  {
    id: 'third-parties',
    heading: '9. Third-party services',
    html: `
      <p>The service is built on Supabase (authentication and database), Vercel
      (hosting and server-side functions), Google (Gmail API and OAuth) and — where
      enabled — a send worker host. Your use of those components is also subject to
      their terms. The operator does not control them and is not responsible for
      their outages, policy changes, pricing changes or account actions, including
      the suspension of an account that breaks their rules.</p>`,
  },
  {
    id: 'data',
    heading: '10. Data and privacy',
    html: `
      <p>How personal data, Gmail data and credentials are handled is set out in the
      <a href="${legalHref('privacy')}" data-legal="privacy">Privacy Policy</a>,
      which forms part of these terms. In summary: Gmail message contents are read
      on demand and are not copied into the application database; the OAuth refresh
      token is stored encrypted and is unreadable by the browser; campaign
      recipients, subjects and a template snapshot are stored so the worker can
      deliver them; and data is kept until you delete it or request deletion.</p>`,
  },
  {
    id: 'termination',
    heading: '11. Suspension and termination',
    html: `
      <p>The operator may suspend or terminate access if these terms are breached —
      in particular for spam, abuse, unlawful use, or any activity that threatens
      the service or the operator's sending reputation. You may stop using the
      service at any time and may request deletion of your data as described in the
      Privacy Policy. On termination, sections covering responsibility, disclaimers
      and liability survive.</p>`,
  },
  {
    id: 'disclaimers',
    heading: '12. Disclaimers and limitation of liability',
    html: `
      <p>The service is provided "as is" and "as available", without warranties of
      any kind, express or implied, including fitness for a particular purpose,
      merchantability, accuracy, or uninterrupted or error-free operation. No
      warranty is given that email will be delivered, that it will not be filtered,
      or that data will never be lost.</p>
      <p>To the fullest extent permitted by law, the operator is not liable for
      indirect, incidental, special, consequential or punitive damages, nor for lost
      profits, lost business, lost data, or damage to reputation arising from your
      use of the service — including messages that were not delivered, messages
      delivered late, or an account suspended by a third-party provider. Where
      liability cannot be excluded, it is limited to the amount you paid for the
      service, which is nothing.</p>
      <p>Nothing in these terms excludes liability that the law does not allow to be
      excluded.</p>`,
  },
  {
    id: 'changes',
    heading: '13. Changes to the service and these terms',
    html: `
      <p>Features may be added, changed or removed. These terms may be updated; the
      "last updated" date above changes when they are, and continued use after a
      change means you accept the updated terms. Material changes should be
      reflected in this document rather than in an announcement elsewhere.</p>`,
  },
  {
    id: 'law',
    heading: '14. Governing law',
    html: `
      <p>These terms are governed by the laws applicable at the operator's place of
      business. The operator is an individual and this document does not name a
      jurisdiction, a company registration or a postal address, because none has
      been supplied; section 15 explains how to ask for those details to be
      clarified. Nothing here deprives you of mandatory consumer protections
      available where you live.</p>`,
  },
];

// --- rendering --------------------------------------------------------------

const DOCUMENTS = {
  privacy: {
    sections: PRIVACY_SECTIONS,
    lede:
      `This policy explains what information ${APP_NAME} collects, what Google
       account data it accesses and why, where that data is stored, how long it is
       kept, and how to remove it. It describes the application as it actually
       behaves; where something is not implemented, it says so.`,
  },
  terms: {
    sections: TERMS_SECTIONS,
    lede:
      `These terms set out the agreement between you and the operator of
       ${APP_NAME}, including what the service does, what you are responsible for
       when you send email, and the limits of the service.`,
  },
};

function documentHtml(slug) {
  const meta = LEGAL_META[slug];
  const doc = DOCUMENTS[slug];
  return `
    <article class="legal-doc" id="legal-doc">
      <h1>${meta.title}</h1>
      <div class="legal-meta">
        <span>${APP_NAME}</span>
        <span class="footer-sep">·</span>
        <span>Effective ${EFFECTIVE_DATE}</span>
        <span class="footer-sep">·</span>
        <span>Last updated ${LAST_UPDATED}</span>
      </div>
      <p class="legal-lede">${doc.lede}</p>
      ${ownerActionNotice()}
      ${tableOfContents([...doc.sections, { id: 'contact', heading: 'Contact' }])}
      ${doc.sections.map((section) => `<h2 id="${section.id}">${section.heading}</h2>${section.html}`).join('\n')}
      ${contactBlock()}
    </article>`;
}

function topbarHtml(slug, { signedIn }) {
  const link = (target) => `
    <a href="${legalHref(target)}" data-legal="${target}"
      ${target === slug ? 'aria-current="page"' : ''}>${LEGAL_META[target].navLabel}</a>`;
  return `
    <div class="legal-topbar">
      <a class="brand" href="${signedIn ? '#/inbox' : '#/login'}">
        <span class="brand-mark brand-mark-sm"><img src="/icon-192.png" alt="" width="32" height="32" decoding="async"></span>
        <span class="brand-text">
          <span class="brand-name">${APP_NAME}</span>
          <span class="brand-sub"> · ${signedIn ? 'Back to the app' : 'Gmail-connected email workspace'}</span>
        </span>
      </a>
      <nav class="legal-topbar-nav" aria-label="Legal and account">
        ${link('privacy')}
        ${link('terms')}
        <a href="${signedIn ? '#/inbox' : '#/login'}">${signedIn ? 'Open app' : 'Sign in'}</a>
      </nav>
    </div>`;
}

/**
 * Footer used on the public landing page and under the legal pages. Links are
 * relative hash routes so they resolve on every domain the app is served from
 * (production, beta, a preview deployment or a self-hosted copy) instead of
 * hardcoding one deployment's hostname into another's pages.
 */
export function legalFooter() {
  return `
    <span class="footer-brand">${APP_NAME}</span>
    <span class="footer-sep">·</span>
    <a href="${legalHref('privacy')}" data-legal="privacy">Privacy Policy</a>
    <span class="footer-sep">·</span>
    <a href="${legalHref('terms')}" data-legal="terms">Terms of Service</a>
    <span class="grow"></span>
    <a href="${REPOSITORY_URL}" rel="noreferrer noopener" target="_blank">Source</a>
    <span class="footer-sep">·</span>
    <span>© ${new Date().getFullYear()} ${OPERATOR}</span>`;
}

/**
 * Renders a legal document into the standalone public layout.
 *
 * Used when the page is opened directly (`/privacy`, `/#/privacy`) or reached
 * from a link while signed out — and also while signed in, because a legal
 * document should be readable without a session and should look the same to a
 * reviewer as it does to a user.
 *
 * @returns {string} the slug that was rendered.
 */
export function renderPublicPage({ slug, body, topbar, signedIn = false, refreshIcons }) {
  body.innerHTML = documentHtml(slug);
  if (topbar) topbar.innerHTML = topbarHtml(slug, { signedIn });
  if (typeof refreshIcons === 'function') {
    refreshIcons(topbar || document);
    refreshIcons(body);
  }
  return slug;
}

/**
 * Renders a legal document inside the signed-in application shell (the view
 * container), so the sidebar and topbar stay available.
 */
export function renderInApp(container, slug, { refreshIcons } = {}) {
  container.innerHTML = `
    <div class="page-head">
      <div>
        <h2>${LEGAL_META[slug].title}</h2>
        <p>${LEGAL_META[slug].description}</p>
      </div>
    </div>
    <div class="legal-shell legal-shell-embedded">${documentHtml(slug)}</div>`;
  if (typeof refreshIcons === 'function') refreshIcons(container);
  return undefined; // no cleanup required
}

export function privacyDocument() {
  return documentHtml('privacy');
}

export function termsDocument() {
  return documentHtml('terms');
}
