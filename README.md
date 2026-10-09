# Seed Code Mail

A Gmail-connected email workspace and personalised campaign manager: read your
real Gmail Inbox, compose and send ordinary email from your own account, manage
recipients, templates and campaigns with real progress, and keep a complete
submission history.

Production: <https://mrseedmail.vercel.app/> · Beta: <https://seedmail-beta.vercel.app/>

---

## 1. Architecture

Four cooperating surfaces. Understanding the split explains almost every
configuration question in this document.

```
┌───────────────────────────┐
│  Vite frontend (./frontend)│   static site on Vercel
│  • Supabase Auth           │
│  • recipients, campaigns   │
│  • templates (IndexedDB)   │
│  • Inbox / Compose / Sent  │
└─────────┬─────────┬───────┘
          │         │
          │         │  /api/gmail/*  (same origin, HTTPS)
          │         ▼
          │   ┌───────────────────────────────┐
          │   │ Vercel functions (./api)       │
          │   │ • Google OAuth 2.0             │
          │   │ • Gmail API read/send          │
          │   │ • encrypts refresh tokens      │
          │   └───────┬───────────────┬───────┘
          │           │               │
          ▼           ▼               ▼
   ┌────────────┐ ┌──────────┐ ┌─────────────┐
   │ Supabase    │ │ Gmail    │ │ campaign    │
   │ Auth +      │ │ (the     │ │ send worker │
   │ Postgres    │ │ mailbox) │ │ (SMTP)      │
   └────────────┘ └──────────┘ └─────────────┘
```

| Concern | Where it lives | Notes |
| --- | --- | --- |
| **Mailbox messages** | **Gmail** | The Inbox, Sent label, message bodies and attachments. Never copied into Postgres. |
| Reading / sending ordinary mail | **Vercel functions** (`api/gmail/`) | Gmail API with OAuth 2.0. One bounded request each; no long-running process, no local Python. |
| Gmail authorization | **Supabase Postgres**, encrypted | `gmail_connections`, readable only by the server (`service_role`). See §8. |
| Sign up / sign in / sessions | Supabase Auth | PKCE, session restored on refresh. |
| Recipients, campaigns, queue, history, settings | Supabase Postgres | Row Level Security per user. |
| Email templates | **Your browser** (IndexedDB) | Never uploaded; snapshotted onto the campaign row when queued. |
| **Campaign delivery** | **Python send worker** | A long, sequential, stateful SMTP job. Runs on a host that keeps a process alive. See §10. |

Two deliberate separations:

* **Ordinary mail never depends on the worker.** Inbox, Compose and Sent use
  the Gmail API directly, so they work even when the campaign worker is
  offline or not deployed at all.
* **The worker never touches the Gmail API.** Campaign delivery uses SMTP with
  an App Password; the Gmail authorization used by the mailbox features is
  separate, is stored encrypted, and is never given to the worker.

The original local-only FastAPI application (`app.py` + `services/`) is retained:
it still holds shared business logic, is the source of the SMTP engine the worker
reuses, and can serve a built copy of the site on `127.0.0.1` for offline use.

---

## 2. Local development

Requirements: **Node.js 20+**, **Python 3.12+**, and (for campaign sending) a
Gmail account with 2-Step Verification and an App Password.

```bash
# 1. Frontend
npm install
cp frontend/.env.example frontend/.env      # paste your Supabase publishable key

# 2. Worker / backend
python -m pip install -r requirements.txt
cp .env.example .env                        # fill in SUPABASE_* and the Gmail values

# 3a. Develop the UI (http://127.0.0.1:5173)
npm run dev

# 3b. In a second terminal: the campaign send worker (http://127.0.0.1:8765)
python worker/main.py
```

On Windows, `start.bat` checks Python and dependencies, builds the site, starts
the worker in its own window, serves the build on <http://127.0.0.1:8000> and
opens the browser.

**The Gmail mailbox features need the Vercel functions.** `vite dev` serves the
SPA only, so `/api/gmail/*` is absent locally. To exercise the real backend while
developing:

```bash
# point the dev server at a deployed origin that has the functions
VITE_API_PROXY_TARGET=https://mrseedmail.vercel.app npm run dev
```

Without that, the pages say the mail service is not reachable — they do not
simulate a mailbox.

### Build & test

```bash
npm run build            # production bundle -> ./dist (what Vercel serves)
npm test                 # node tests: renderer, MIME, crypto, email HTML, API routes
npm run check:api        # imports every api/ route and asserts its auth wiring
python -m pytest tests -q   # worker + backend tests
npm run test:rls         # cross-user isolation against a real Supabase project (§7)
```

No test sends email and no test opens a network socket: SMTP, Supabase and
Google are all mocked.

---

## 3. Environment variables

On Vercel, nothing is read from a `.env` file — both the frontend build and the
`api/gmail/*` functions take configuration only from the project's environment
variables. Set the values below in each platform's own environment configuration.

The one exception is the campaign worker: it reads its own `.env` when that file
exists (the local-development source, and the file the Settings page writes) and
otherwise the process environment, so a container platform works with no file at
all. The precedence is spelled out in §3.3.

### 3.1 Vercel — frontend build (public)

| Variable | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://jptukeybgvuehdzghxfj.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | your Supabase **publishable (anon)** key |
| `VITE_SITE_URL` | `https://mrseedmail.vercel.app` |
| `VITE_MAIL_WORKER_URL` | the **deployed** campaign worker service URL, e.g. `https://seedmail-worker.onrender.com` (§10). Leave it **blank** for local development to use `http://127.0.0.1:8765`. |
| `VITE_API_BASE_URL` | *optional.* Only for a build whose `/api/gmail` lives somewhere other than this site. Leave unset in production. |

Everything `VITE_`-prefixed is inlined into the public JavaScript bundle. Never
put a Supabase secret/service-role key, a Google client secret, or a Gmail App
Password behind a `VITE_` name.

> **Never set a `localhost` / `127.0.0.1` value in the Vercel environment for
these two variables.** A deployed site cannot reach your computer. The app
refuses to use such a value (see `frontend/js/lib/endpoints.js`), reports it as a
configuration problem, and the build prints a warning — but the correct fix is to
set the deployed service URL. `VITE_API_BASE_URL` normally stays unset because
the Gmail endpoints ship with the site on the same origin.

### 3.2 Vercel — server functions (trusted, `api/gmail/*`)

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | project URL |
| `SUPABASE_PUBLISHABLE_KEY` | verifies the caller's bearer token (`/auth/v1/user`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret.** Reads/writes `gmail_connections` (no browser access) |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth 2.0 *Web application* client |
| `GOOGLE_CLIENT_SECRET` | **secret.** Server-side token exchange only |
| `GOOGLE_OAUTH_REDIRECT_URI` | must exactly equal an Authorised redirect URI on that client |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | **secret.** AES-256-GCM key for stored refresh tokens (`openssl rand -base64 32`) |
| `APP_URL` | where the OAuth callback returns the browser (defaults to the request origin) |

`GOOGLE_CLIENT_ID` is the only one of these that is not sensitive. The rest must
be set as environment variables, never committed and never exposed to the
browser.

### 3.3 Worker host (only if campaigns are enabled — §10)

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | yes | same project |
| `SUPABASE_PUBLISHABLE_KEY` | yes | verifies user access tokens. `SUPABASE_ANON_KEY` is accepted as an alias. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | claims queued campaigns + writes progress. **Secret — worker host only.** |
| `Email`, `GAPP_PASS` | yes | the sending Gmail address and its App Password (SMTP only) |
| `SMTP_HOST`, `SMTP_PORT`, `SEND_DELAY_SECONDS`, `SMTP_TIMEOUT_SECONDS`, `MAX_RETRIES`, `RETRY_DELAY_SECONDS` | no | sending preferences |
| `WORKER_HOST` | yes (hosted) | `0.0.0.0` so the browser can reach it |
| `WORKER_PORT` | no | default `8765` |
| `WORKER_ALLOWED_ORIGINS` | recommended | comma-separated browser origins allowed by CORS |
| `WORKER_QUEUE_CONSUMER` | no | `0` runs the API without the queue consumer |

> **A `VITE_`-prefixed value is never read by the worker.** The worker needs the
> un-prefixed `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`. This is the single most
> common cause of the failure described in §11.

**Where the worker reads these from, in order.** `SUPABASE_*`, `WORKER_*` and
`WORKER_ALLOWED_ORIGINS` always come from the process environment. The mail
settings (`Email`, `GAPP_PASS`, `SMTP_*`, the delays) are read from the worker's
`.env` file when that file defines them, and otherwise from the process
environment:

1. the worker's `.env` file — the local-development source, and the file the
   Settings page writes;
2. the process environment — how every container platform (Docker, Render,
   Railway, Fly.io, Kubernetes) supplies configuration;
3. the built-in default.

So a hosted worker needs **no `.env` file at all**: set the variables above in the
host's dashboard and it is fully configured. Only names this project already knows
are read (`services/settings_service.py → environment_names()`), so an unrelated
variable on the machine cannot wander into the mail configuration. Environment
values are never written back to `.env`, so saving settings from the UI cannot
spill a platform secret onto a disk. Verify with:

```bash
curl -s https://your-worker-host/api/worker/health | python -m json.tool
# "smtp_configured": true   means Email + GAPP_PASS reached the worker
# "import_hygiene_ok": true means no module shadows the standard library (§11d)
```

> **The worker is not deployed by deploying the website.** Nothing in this
> repository can create the host or the host's secrets, and Vercel cannot run it.
> See §10 and §17 for what remains manual.

There is no default email subject. The subject belongs to each campaign and is
required when the campaign is created.

---

## 4. Supabase setup

### 4.1 Apply the migrations

The schema is version-controlled SQL, written to be re-runnable and never to drop
data.

```bash
supabase link --project-ref jptukeybgvuehdzghxfj
supabase db push          # applies supabase/migrations/*.sql in order
```

Or run them by hand in the Supabase SQL editor, in order:

1. `0001_schema.sql` — tables, indexes, constraints, triggers
2. `0002_rls.sql` — Row Level Security + grants
3. `0003_worker_queue.sql` — durable campaign queue, leases, worker heartbeats
4. `0004_gmail.sql` — encrypted Gmail connections + provider message metadata

Verify the policies are in place:

```bash
psql "$SUPABASE_DB_URL" -f supabase/tests/rls_policies.sql
```

### 4.2 Auth URL configuration (dashboard)

Supabase → **Authentication → URL Configuration**:

* **Site URL**: `https://mrseedmail.vercel.app`
* **Redirect URLs** (all of them):
  * `https://mrseedmail.vercel.app/**`
  * `https://seedmail-beta.vercel.app/**`
  * `http://localhost:5173/**` and `http://127.0.0.1:5173/**`
  * `http://localhost:8000/**` and `http://127.0.0.1:8000/**`

Email/password sign-up must be enabled. If email confirmation is on
(recommended), confirmation links point at the current origin, so every deployed
origin must be listed.

### 4.3 Tables

| Table | Purpose |
| --- | --- |
| `profiles` | Display name and timestamps (created by a signup trigger) |
| `recipients` | Company, email, status, per-user unique email |
| `campaigns` | Name, **required subject**, local `template_ref`, status, counters, run snapshot, lease |
| `campaign_recipients` | One job per recipient: attempts, status, last error, provider + provider message id |
| `email_history` | Append-only, sanitized submission log (now with provider metadata) |
| `user_settings` | Non-secret sending preferences — **no credential column exists** |
| `worker_heartbeats` | Liveness rows written by the worker (service-role only) |
| `gmail_connections` | **Server-only.** Linked Gmail address, granted scopes, encrypted refresh token |

Design notes: every user-owned table has `user_id uuid not null default
auth.uid()`, foreign keys with `on delete cascade`/`set null`, check constraints
for statuses and value ranges, per-user indexes, and `updated_at` triggers.

---

## 5. Gmail account connection (OAuth 2.0)

The mailbox uses Google's **official Gmail API**, not SMTP. An App Password does
**not** grant Gmail API access, and no credentials are fabricated: until the
values in §3.2 exist, the app shows a setup card naming the missing variables and
stays inert.

### 5.1 Google Cloud Console (manual, one-off)

1. Create (or select) a project, then **APIs & Services → Library → Gmail API →
   Enable**.
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app
   name and support email. While the app is in *Testing*, add each Google account
   that will connect under **Test users**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   * Application type: **Web application**
   * **Authorised redirect URIs** — add every origin that will use the feature,
     exactly:
     * `https://mrseedmail.vercel.app/api/gmail/callback`
     * `https://seedmail-beta.vercel.app/api/gmail/callback` (if used)
     * `http://localhost:5173/api/gmail/callback` (only if you proxy the API
       locally; the deployed origin is normally the right target)
   * Copy the **client id** and **client secret** into `GOOGLE_CLIENT_ID` and
     `GOOGLE_CLIENT_SECRET` on Vercel.
4. Set `GOOGLE_OAUTH_REDIRECT_URI` to the production callback URL, and
   `GMAIL_TOKEN_ENCRYPTION_KEY` to `openssl rand -base64 32`.
5. Apply migration `0004_gmail.sql`, then **redeploy** — environment changes do
   not reach an existing deployment.

### 5.2 Scopes requested, and why

| Scope | Feature that needs it |
| --- | --- |
| `gmail.readonly` | Inbox and Sent lists, message content, attachment downloads |
| `gmail.send` | Compose Email |
| `gmail.modify` | Mark read / unread (a real Gmail label change) |
| `gmail.compose` | Save a message as a Gmail draft |

Not requested: `gmail.labels`, `gmail.settings.*`, and the all-or-nothing
`https://mail.google.com/` scope.

### 5.3 How the flow works

1. **Profile → Connect Gmail.** The SPA asks the backend (`POST /api/gmail/connect`)
   for a consent URL; the user id is carried in an HMAC-signed, 10-minute
   `state`, and a nonce is planted in an HttpOnly, SameSite=Lax cookie.
2. The browser navigates to Google (`access_type=offline`, `prompt=consent`) so a
   **refresh token** is issued.
3. Google redirects to `/api/gmail/callback`, which verifies the signature *and*
   the cookie nonce, exchanges the code, asks Gmail which account it is, and
   stores the refresh token **encrypted with AES-256-GCM**.
4. `/api/gmail/status` reports the linked address, the granted scopes and which
   features are available. Reauthorisation is requested automatically when Google
   reports `invalid_grant`.

The refresh token is never sent to the browser, never placed in a URL, and never
returned by an API response.

---

## 6. The mailbox features

### Inbox (`#/inbox`)
Real Gmail Inbox, with search (Gmail's own query syntax), pagination through
Gmail's `nextPageToken`, refresh, message reading and attachment download.
Sender, subject, timestamp, snippet and unread state are all Gmail's.

### Compose Email (`#/compose`)
To / Cc / Bcc / Subject / body; HTML or plain text; a starting point from your
local templates; preview; attachments; validation; confirmation before sending to
multiple recipients; a submit lock that prevents double sends; and "Save as Gmail
draft". The message is sent by Gmail as the connected account, so it lands in the
real Sent mailbox.

A successful submit means **Gmail accepted the message**. The UI says exactly
that and never claims inbox delivery.

### Sent (`#/sent`)
Gmail's actual **Sent** label — messages Gmail accepted — with the same search,
paging, reading and refresh support.

This is *not* the campaign history: a queued campaign job is never presented as
sent. Campaign submission state lives on the Campaigns page and in Email History,
and is labelled queued / processing / submitted / failed / unknown.

### Rendering untrusted email safely
Message HTML is never injected into the application DOM. It is rendered in an
`<iframe sandbox="">` — which blocks scripts, forms, popups and same-origin
access — with a strict CSP inside the document. **Remote images are blocked until
the user chooses "Show images"**, because a single tracking pixel reveals that a
message was opened and from where.

### Drafts and history
Drafts are saved with Gmail's `drafts.create`, so they appear in Gmail itself
rather than in an incompatible local-only mailbox. The application's Email
History page is unchanged and stays separate from the Gmail mailbox: deleting a
history record does not delete a Gmail message.

---

## 7. Authentication and authorization

* Implemented entirely with Supabase Auth (PKCE). No custom password storage; no
  password is ever written to the application database.
* Screens: sign in `#/login`, sign up `#/signup`, confirmation `#/verify`, forgot
  password `#/forgot`, new password `#/update-password`, sign out in Profile.
* Sessions are restored on refresh; expired or invalid sessions return the user
  to the sign-in screen with a message. A stalled session check is bounded by a
  timeout and ends in a recoverable "could not check your session" state rather
  than an endless spinner — it is never presented as "signed out".
* Private routes are unreachable without a session: the app shell is not rendered
  at all, so hidden CSS is never the access control.
* No `localStorage` flag is treated as proof of authentication.

For every protected request (both the worker and `api/gmail/*`):

1. the bearer token is taken from the `Authorization` header;
2. it is validated against Supabase Auth (`/auth/v1/user`) with the publishable
   key — not decoded and trusted locally;
3. the user id comes from that verified session and **never** from the request
   body or a query parameter;
4. ownership is enforced again in the database by RLS;
5. invalid, expired or missing tokens are rejected with 401, and an unconfigured
   server with 503 that names the missing variable.

The publishable key itself is never used as a bearer token, and there is no fake
authentication fallback.

---

## 8. Database security

* RLS is enabled **and forced** on every user-owned table; policies use
  `auth.uid()`.
* `SELECT`/`UPDATE`/`DELETE` use `using (auth.uid() = user_id)`;
  `INSERT` uses `with check (auth.uid() = user_id)`.
* `campaign_recipients` additionally requires the parent campaign to belong to
  the caller.
* `email_history` has no `UPDATE` policy: submission records are append-only.
* There is no policy for `anon`, and `anon` privileges are revoked.
* `worker_heartbeats` and `gmail_connections` have **no policy for
  `authenticated` either**. RLS filters rows, not columns, so a user-readable
  connection row would mean exposing the encrypted refresh token to the browser.
  The backend reads it with the service-role key instead, and the UI learns its
  own connection state from `GET /api/gmail/status`.

Verify isolation with two real accounts:

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... \
TEST_USER_A_EMAIL=... TEST_USER_A_PASSWORD=... \
TEST_USER_B_EMAIL=... TEST_USER_B_PASSWORD=... \
npm run test:rls
```

---

## 9. Campaigns

Preserved and repaired, unchanged in principle:

* Dashboard, recipients (add/edit, CSV/JSON import with duplicate detection,
  export), campaigns with a **required per-campaign subject**, custom HTML
  templates with a variable guide, personalisation variables, live progress,
  bounded retries, pause/resume/cancel, and campaign history.
* Recipient lists are validated before a campaign is created; recipients already
  marked `sent` are never resent; an `unknown` outcome (connection dropped
  mid-submission) is recorded but never retried automatically, which is what
  prevents duplicate email; every retry is bounded by `MAX_RETRIES`.
* Progress and job state are persisted in Postgres, so closing the browser loses
  nothing.
* Campaign sending is independent of Compose Email: the two never share a queue.
* Google's sending limits are respected, not evaded. The app reports the
  rejection rather than retrying blindly, and no spam-evasion mechanism exists
  anywhere in this project.
* `sent`/`submitted` means the provider accepted the message. Provider message
  ids are recorded when the channel supplies one (the Gmail API does; SMTP does
  not), and an empty id is displayed as "not reported" — never as delivered.

---

## 10. Campaign execution and the send worker

Vercel functions are short-lived request handlers; a campaign is a long,
sequential, stateful job with a credential that must not live in a browser
bundle. Sending therefore runs in **one** background worker, and the queue lives
in Postgres so no browser needs to stay open:

```
browser --queue--> Supabase (campaigns: status 'queued' + run snapshot)
                        ^                              |
                        |                          atomic claim
                        |                              v
                 progress, jobs, history  <---  worker service (Python, SMTP)
```

`claim_next_campaign()` is an atomic row-locked claim with a renewable lease, so
two workers can never send the same campaign and a crashed worker's campaign is
reclaimed after its lease expires. Pause/resume/cancel are database flags, so
they work from any tab.

Deploy it on any host that keeps a process alive (Render, Railway, Fly.io, a small
VM, Docker):

```bash
pip install -r requirements.txt
export WORKER_HOST=0.0.0.0 WORKER_PORT=8765
python worker/main.py          # API + queue consumer in one process
```

Health and diagnostics:

* `GET /api/worker/health` — unauthenticated and cheap. Reports process liveness,
  `capabilities` (`verify_users`, `campaign_queue`, and whether the Gmail API is
  configured) and `configuration_problems` naming any missing variable.
* `GET /api/worker/status` and `/api/worker/queue/status` — authenticated:
  SMTP configuration plus real queue availability read from worker heartbeats.

> Campaign delivery requires this worker. Ordinary mail does **not**: Inbox,
> Compose and Sent work whenever the Vercel functions are deployed.

---

## 11. Troubleshooting the worker authentication error

### The symptom

Every authenticated worker request failed with:

```
"The worker is not configured with SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY,
 so it cannot verify signed-in users."
```

### The confirmed cause

The message is raised by `worker.auth.TokenVerifier` when the **worker process
itself** has neither variable. It was not a code bug in the request path — the
trace is:

1. the browser sends `Authorization: Bearer <supabase access token>` to the worker;
2. `worker/main.py` builds `TokenVerifier(supabase_url, publishable_key)` from its
   own process environment;
3. the worker's `.env` contained only the Gmail/SMTP values — no `SUPABASE_URL`
   and no `SUPABASE_PUBLISHABLE_KEY` — so `configured` was `False`;
4. every protected endpoint returned 401 with that one generic sentence.

Two compounding reasons it stayed broken:

* **Name drift.** The frontend is configured with `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_PUBLISHABLE_KEY`; the worker needs the un-prefixed names. Setting
  the Vite names on the worker host — the obvious thing to try — leaves the worker
  unconfigured, because Vite values are build-time and are never read there.
* **Placeholders counted as configuration.** `.env.example` shipped with
  `SUPABASE_PUBLISHABLE_KEY=` and prose placeholders, and `bool("your-key-here")`
  is `True`, so a half-configured worker looked configured.

### The fix

* `worker/config.py` is now the single reader for these values. It accepts
  `SUPABASE_PUBLISHABLE_KEY` **or** `SUPABASE_ANON_KEY` (and
  `SUPABASE_SERVICE_ROLE_KEY` **or** `SUPABASE_SECRET_KEY`), trims quotes and
  whitespace, and treats blank or placeholder values as unset.
* The 401 message now **names the variable that is actually missing** and states
  that a `VITE_`-prefixed value is not read here.
* The worker prints a configuration report at startup, and
  `GET /api/worker/health` exposes `capabilities` plus `configuration_problems` —
  secret-free, so a misconfigured host is obvious from its logs and from the UI.
* `.env.example` no longer contains a stray `[TEMPLATE]` header and documents the
  contract, including the note that an App Password does not grant API access.

### To fix an existing deployment

1. Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in the **worker host's**
   environment variables (not the Vercel `VITE_` ones).
2. Set `SUPABASE_SERVICE_ROLE_KEY` if campaign delivery is wanted.
3. Restart the worker and check its startup banner — it prints `ok`/`MISSING` per
   variable, and no value is ever printed.

---

## 11a. Troubleshooting "The send worker is not reachable"

### The symptom

A **deployed** site showed:

```
The send worker is not reachable. For local development, start it with
"python worker/main.py".
```

That is a local-development instruction being shown to production users, which
means the deployed build resolved the worker URL to `127.0.0.1`.

The same sentence also appeared when the worker **was** running and correctly
addressed but answered every request with HTTP 500 — the client reports an
unusable service and an unreachable one the same way. If the URL is right and the
worker is up, read §11d instead.

### The confirmed cause

`frontend/js/lib/worker.js` had a hardcoded `DEFAULT_WORKER_URL =
'http://127.0.0.1:8765'` that was applied to **every** build:

```js
// before
workerBaseUrl()  => import.meta.env.VITE_MAIL_WORKER_URL || 'http://127.0.0.1:8765'
workerIsLocal()  => hostname of workerBaseUrl() is 127.0.0.1   // always true when unset
```

With `VITE_MAIL_WORKER_URL` unset (or left at the `frontend/.env.example`
placeholder value) in the Vercel project, the production bundle pointed at
loopback, `workerIsLocal()` returned `true`, and the UI therefore chose the
local-development wording.

### The fix

URL resolution moved to `frontend/js/lib/endpoints.js`, which is unit tested
(`tests/js/endpoints.test.mjs`):

* a configured URL is used as-is, **except** that a loopback address is rejected
  when the page is not itself served from this machine;
* the loopback default is applied only to a locally served build;
* `http://` service URLs are rejected by an `https://` page (mixed content);
* when nothing usable is configured the resolver returns **no URL** plus a
  reason — it never invents a host.

The reason is surfaced as `config_problem` through `api.js` so Settings and the
Dashboard say *"the configured send worker URL points at this machine … replace
it and redeploy"* instead of reporting an outage. `vite.config.js` also prints
the same warning into the build log when `VERCEL_ENV=production`.

### Notes that matter

* Campaigns are **queued in Supabase**, not held in the browser, so an
  unreachable worker delays delivery rather than losing the campaign. The UI says
  exactly that and no longer claims anything is "sending".
* `python worker/main.py` remains the correct instruction for local development,
  and it is only ever shown when the page is actually served from this machine.
* Production never depends on the developer's computer: the worker is a separate
  host (§10). If you have not deployed one, campaigns stay queued and Settings
  reports "No send worker is configured for this deployment".

---

## 11b. Troubleshooting "The mail service is not deployed at this address"

### The symptom

Inbox / Compose / Sent showed:

```
The mail service is not deployed at this address.
```

(raised by `frontend/js/lib/gmail.js` when `/api/gmail/status` returned a 404
with no JSON body.)

### The confirmed causes

1. **The Vercel build was failing** (see §11c), so the live deployment was an
   older build that predates the `api/gmail` functions entirely. A failed build
   keeps serving the previous deployment — every `/api/gmail/*` request 404s.
2. `frontend/js/lib/gmail.js` fell back to a bare `/api/gmail/…` path with no
   diagnostics, so a 404 from *any* cause produced the same unhelpful sentence.

### The fix

* The build failure was repaired (§11c), which is what makes the functions part
  of the deployment.
* The client now resolves its base through `endpoints.js`, and reports the actual
  condition:
  * the response was **HTML** → the SPA rewrite answered the request, which means
    the functions are absent from that deployment;
  * a bare **404** → the path does not exist on this deployment;
  * a **network failure** → the service is unreachable;
  each with the resolved path and the concrete next step.
* The SPA rewrite in `vercel.json` excludes `api/`, so an API request can never
  be rewritten to `index.html`.

The Gmail endpoints live in the same Vercel project as the site (`api/gmail/*`,
served from the same origin), so **no** API URL needs to be configured in
production. `VITE_API_BASE_URL` exists only for the unusual case of hosting them
elsewhere, and a loopback value is refused there too.

---

## 11c. Troubleshooting "Failed to parse source for import analysis"

### The symptom

The Vercel build stopped during `vite build`:

```
frontend/js/mail-common.js: Failed to parse source for import analysis because
the content contains invalid JS syntax.
```

### The confirmed cause

`frontend/js/mail-common.js` was **truncated mid-statement** in the commit the
build used. The file ended at:

```js
      } catch (error) {
```

with no newline at end of file — leaving the `catch` block, the
`addEventListener` callback, the enclosing `forEach`, and the whole
`openReader` function unterminated. Node reports this precisely:

```
SyntaxError: Unexpected end of input
```

It is not an import problem, a template-literal problem, or a conflict marker:
the file is simply incomplete. `vite build` fails at the import-analysis step
because it cannot parse the module at all.

### The fix

The file was completed (the `catch` body, the `finally` block that restores the
attachment button, and the closing braces of `openReader`, which returns the
modal). The surrounding behaviour is unchanged.

### How to catch it before a deployment

```bash
npm run check:syntax   # node --check every frontend/api/backend module
npm run build          # the same parse step Vercel runs
```

---

## 11d. Troubleshooting: the worker starts but every request returns HTTP 500

### The symptom

`python worker/main.py` printed a completely healthy banner —
`Application startup complete`, the configuration report, `Press Ctrl+C to stop`
— and bound its port. The frontend still reported the worker as unavailable.

Every endpoint failed, including the unauthenticated one:

```
GET /api/worker/health         → HTTP 500  "Internal Server Error"
GET /api/worker/status         → HTTP 500
GET /api/worker/queue/status   → HTTP 500
```

### The confirmed cause

`worker/queue.py` — the campaign-queue data-access module — **shadowed Python's
standard-library `queue`**, and `python worker/main.py` is what triggered it:

```
ImportError: cannot import name 'Queue' from 'queue'
             (C:\...\Email\worker\queue.py)
  File "...\site-packages\anyio\_backends\_asyncio.py", line 46, in <module>
    from queue import Queue
```

Running that file directly puts its own directory first on `sys.path`. A module
file there therefore wins over the standard library for the **entire process**,
whether or not anything imports it on purpose. Starlette runs synchronous
endpoints in a thread pool, and its thread offload (`anyio`) does
`from queue import Queue` at that moment — so it imported `worker/queue.py`,
hit the `ImportError`, and every request became a 500.

This is why the failure was so confusing: the worker's own code was fine, the
banner was honest, the port was open, and nothing in the log mentioned the real
problem. Only the *deferred* import inside anyio failed, one request at a time.

### The fix

1. The module was renamed to **`worker/campaign_queue.py`** (a `git mv`, so the
   history is preserved) and all references updated in `worker/main.py`,
   `worker/queue_worker.py` and `tests/test_queue.py`.
2. `worker.config.shadowed_stdlib_modules()` / `import_hygiene_problem()` now
   detect the hazard, and `worker/main.py` **refuses to start** with exit code 2
   and a named explanation rather than serving 500s:

   ```
   Seed Code Mail — send worker cannot start
   worker/queue.py shadows a Python standard-library module. …
   ```

   The same check is reported as `import_hygiene_ok` by `GET /api/worker/health`
   and in the startup banner.
3. `tests/test_worker_config.py` pins it three ways: no module in `worker/`
   shadows the stdlib, the check fires when one is planted, and a subprocess with
   `worker/` first on `sys.path` proves `import queue` still resolves to the
   standard library and that `anyio._backends._asyncio` imports it successfully.

### Verified behaviour

```
GET /api/worker/health  → 200
{"ok": true, "auth_configured": false, "import_hygiene_ok": true,
 "configuration_problems": ["SUPABASE_URL is not set …", …]}

GET /api/worker/queue/status → 401 {"detail":"Missing access token."}   # correct: unauthenticated
```

The health probe reports a running process *and* its real configuration gaps; it
never reports `ok: true` as if the worker were ready to send.

> Do not reintroduce a `worker/queue.py`. If a new module needs the name, use it
> as a submodule name *inside* the package (e.g. `worker/campaign_queue.py`), and
> run the worker as `python worker/main.py` or `python -m worker.main`.

---

## 12. Profile and About

**Profile** shows the account email, display name (editable), account creation
date, the Gmail connection (address, granted scopes, connect/reconnect/
disconnect), email-change and password-reset actions, and sign out. Disconnecting
Gmail removes mailbox access only: the account, campaigns, recipients, templates
and history are untouched, and no credential or token is ever rendered.

**About** describes the real capabilities, the runtime status of each surface
(Supabase, the Gmail API backend, the campaign worker), the deployment URLs, and
an explicit "not claimed" list. The version comes from `package.json` at build
time.

---

## 13. Deployment

`vercel.json` matches the real framework: Vite, `npm ci`, `npm run build`,
output `dist`, plus the Node functions under `api/`.

1. Import the repository in Vercel.
2. Set §3.1 and §3.2 for **Production, Preview and Development**.
3. Deploy. Changing an environment variable does **not** update an existing
   deployment — redeploy afterwards.

`installCommand` is `npm ci` rather than `npm install`: it installs exactly the
locked dependency graph and fails loudly if `package.json` and
`package-lock.json` ever disagree. The lockfile is platform-complete (it
contains every `@esbuild/*` binary, including `linux-x64`), so it installs
correctly on Vercel's Linux builders even though it was generated on Windows.
`engines.node` is `>=20`.

**The mail API ships with this project.** `api/gmail/*.js` are Vercel Node
functions in the same project as the site, so they are served from the same
origin and no API URL has to be configured. Deploying the frontend is therefore
what deploys the mail API — which is also why a **failed build keeps the previous
deployment live and every `/api/gmail/*` request 404s** until the build is fixed.
The separate Python campaign worker is *not* part of this project and is never
deployed by Vercel (see §10).

Routing: the SPA is hash-routed, so refreshes work by construction. A rewrite
covers real deep links while leaving `api/`, `/assets/*`, `robots.txt` and
`sitemap.xml` untouched (functions are matched before the rewrite, and the
rewrite pattern excludes `api/` explicitly). Security headers (nosniff, frame
denial, referrer policy, HSTS, permissions policy) are set. There is no writable
filesystem usage and no long-running process on Vercel.

**Manual steps that source changes cannot perform:**

* Google Cloud OAuth client + consent screen + redirect URIs (§5.1).
* Supabase Auth URL configuration (§4.2).
* Applying migrations `0003` and `0004` to the live project.
* Setting the Vercel environment variables and redeploying.
* Deploying the campaign worker, if campaigns are used.

---

## 14. Security summary

| Risk | Mitigation |
| --- | --- |
| Cross-user data access | RLS enabled *and forced* on every user-owned table; no `anon` policies |
| Forged user id | `user_id` defaults to `auth.uid()`; never read from the request |
| Gmail credential theft | Refresh tokens encrypted (AES-256-GCM) in a table only `service_role` can read |
| OAuth CSRF / replay | HMAC-signed, expiring `state` plus an HttpOnly nonce cookie |
| XSS from email or templates | `iframe sandbox=""` + strict CSP; remote content blocked by default |
| Tracking pixels | Images stay blocked until the user asks for them |
| Credential leakage to the client | No `VITE_` secret, no token in a response, no token in a URL or log |
| Duplicate mail | `sent` is never resent; `unknown` is never auto-retried; submit lock in Compose |
| Route permission mix-ups | Every `api/gmail/*` route uses `authed()`; `npm run check:api` asserts it |

Not implemented, and therefore not claimed: a Content-Security-Policy for the
application page itself, rate limiting, and audit logging.

### Dependency notes

`npm audit` reports one advisory: **GHSA-67mh-4wv8-2f99**, esbuild `<= 0.24.2` —
"esbuild enables any website to send any requests to the development server and
read the response". It is inherited from `vite@5.4.x` (`esbuild@0.21.5`).

* It affects the **Vite development server** only (`npm run dev`). Production
  serves a pre-built `dist/` from Vercel's static hosting; no dev server runs and
  no request reaches esbuild at runtime.
* Vite's dev server binds to `127.0.0.1` by default, and the advisory requires an
  attacker to reach that server — it is not exposed by this project's
  configuration.
* Removing it requires `vite@7`/`vite@8` (`npm audit fix --force` proposes
  `vite@8`), a two-major upgrade whose Node requirement
  (`^20.19.0 || >=22.12.0`) is not guaranteed by the build host, and which would
  change the very build being repaired here. It is deliberately **not** applied
  in this change: it should be a separate, individually verified upgrade.
* The `esbuild` "install scripts were ignored" notice during `npm install` is
  benign in this project: esbuild's postinstall only verifies the platform
  binary, which arrives through the optional dependency
  (`@esbuild/<platform>`), and `npm run build` completes successfully without it.

Nothing in this project depends on a package with a runtime (production) exploit
path that `npm audit` reports.

#### The esbuild "install scripts were ignored" notice

When that notice appears in a build log it comes from a package manager that
blocks lifecycle scripts by default — **pnpm 10+** prints
`Ignored build scripts: esbuild … Run "pnpm approve-builds"` — or from an
explicitly disabled `ignore-scripts` setting. It is not produced by npm in this
repository: a clean `npm ci` here prints no install-script warning and exits 0.

It is also harmless either way. esbuild's `postinstall` only *verifies* the
platform binary, which is delivered through the normal optional dependency
(`@esbuild/<platform>`, e.g. `@esbuild/win32-x64`), not downloaded by the script.
This project's `package-lock.json` contains all of those platform packages, and
`npm run build` completes with the script skipped.

`vercel.json` now pins `"installCommand": "npm ci"` and the repository tracks
exactly one lockfile (`package-lock.json`), so the deployment installs with npm
and the pnpm-specific notice cannot appear for this project. If it still does,
the Vercel project has an **Install Command** override in Settings → Build &
Development — clear it so the checked-in `vercel.json` applies.

#### Node.js engine requirement

The only engine constraint here is this project's own: `package.json` declares
`"engines": { "node": ">=20" }`, which is what `vite@5` needs
(`^18.0.0 || >=20.0.0`) and what the code uses. Dependencies in the lockfile ask
for `>=12` or lower, so none of them can fail the engine check.

Vercel's default Node runtime satisfies `>=20`, so no `Node.js Version` override
is required in project settings. If a deployment ever needs to pin it, set it in
Settings → General → Node.js Version — not by loosening `engines`, which would
hide a genuine mismatch rather than fix it.

---

## 15. Project structure

```
├── frontend/                    # the web app (Vite root)
│   ├── index.html               # shell + crawlable landing + SEO metadata + nav
│   ├── css/                     # style, components, animations, auth, mail
│   ├── js/
│   │   ├── app.js               # shell, auth gate, router, sidebar
│   │   ├── api.js               # Supabase data layer + profile
│   │   ├── auth.js              # Supabase Auth flows and signed-out screens
│   │   ├── inbox.js             # Gmail Inbox
│   │   ├── compose.js           # Compose Email
│   │   ├── sent.js              # Gmail Sent
│   │   ├── profile.js           # account + Gmail connection
│   │   ├── about.js             # capabilities and runtime status
│   │   ├── mail-common.js       # shared mailbox UI + message reader
│   │   └── lib/                 # endpoints, supabase, gmail, email-html, worker, render, stores
│   └── public/                  # robots.txt, sitemap.xml, favicon.svg, og-image.png
├── api/gmail/                   # Vercel Node functions: the Gmail backend
│   ├── status.js  connect.js  callback.js  disconnect.js
│   ├── inbox.js  sent.js  message.js  modify.js  send.js  attachment.js
├── backend/lib/                 # shared server code (config, crypto, oauth, gmail, mime…)
├── worker/                      # Python campaign worker (FastAPI + SMTP + queue consumer)
│   ├── main.py  auth.py  config.py  sender.py  campaign_queue.py
│   │                            #   ↑ NOT queue.py — see §11d
│   └── queue_worker.py  supabase_client.py  settings_overrides.py
├── services/                    # shared, tested business logic (SMTP engine, templates)
├── app.py                       # legacy local app + static server for ./dist
├── supabase/migrations/         # 0001 schema · 0002 RLS · 0003 queue · 0004 Gmail
├── tests/                       # pytest (worker, backend) and node tests (JS + API routes)
├── tools/check-api.mjs          # imports every api route and checks its auth wiring
├── tools/check-syntax.mjs       # parses every frontend/api/backend module (npm run check:syntax)
└── vercel.json                  # Vite build, functions, SPA rewrite, security headers
```

---

## 16. Known limitations

1. **Gmail features need the deployed functions.** A plain static host can serve
   the UI but not the mailbox; the pages say so rather than faking data.
2. **Sending campaigns needs the worker running.** The site alone cannot send
   bulk mail. Queued campaigns wait and are delivered when it returns.
3. **Templates are local to a browser.** No cross-device sync; export JSON to back
   up. When a campaign is queued, its template is snapshotted onto the user's own
   campaign row (RLS-protected) so the worker can send with the page closed.
4. **App Password is plaintext in the worker's `.env`** (git-ignored, on your
   machine). Storing it encrypted would need a server-side key service; that is
   **not** implemented, so nothing here claims it is.
5. **Microsoft/Gmail sending limits are not bypassed** and can stop a large
   campaign. The app reports the provider's rejection.
6. **Provider message ids are only available for Gmail API sends.** Campaign mail
   goes out over SMTP, which returns no message id, so those records show
   "not reported".
7. **External setup remains necessary.** The Gmail integration is implemented and
   tested against mocked Google APIs, but it cannot be live until the Google Cloud
   OAuth client, the Vercel environment variables, migration `0004` and the worker
   host are configured as described above. Real end-to-end mail delivery has not
   been exercised from this environment — see §17 for exactly what is outstanding.

---

## 17. Deployment state: what is done, what is not

Written to be checkable rather than reassuring. Everything in the "in the
repository" column is code that is present, built and tested here. Everything in
the "still manual" column requires an account, a credential or a dashboard that no
commit can create.

### In the repository, and verified locally

| Item | Evidence |
| --- | --- |
| Vite production build | `npm run build` completes; `npm run check:syntax` parses every module (§11c) |
| Frontend API resolution | `endpoints.js` + `tests/js/endpoints.test.mjs`: no loopback URL can leak into a deployed build (§11a) |
| Gmail backend | `api/gmail/*` implemented against the real Gmail API; `npm run check:api` verifies route wiring and auth |
| Worker API + queue consumer | `python worker/main.py` starts, `/api/worker/health` → 200, authenticated routes → 401 without a token (§11d) |
| Worker container image | `worker/Dockerfile`, built from the repository root. **Not built here** — Docker is unavailable in this environment; the equivalent file set was executed directly and started correctly |
| Worker config from host env vars | `smtp_configured` is `true` with only environment variables set and no `.env` (§3.3). Measured before/after: `false` → `true` |
| Import hygiene | the shadowing module is gone, a guard refuses to start if it returns, `import_hygiene_ok` is reported (§11d) |
| Python suite | `python -m pytest tests/` — 116 passing |
| JS suite | `npm test` — crypto, MIME, email-html, endpoints, api-route tests |

### Still manual — required before the product is fully live

1. **The worker host does not exist yet.** Vercel cannot run it. Create it from
   `render.yaml` (Render → New → Blueprint) or from `worker/Dockerfile` on any host
   that keeps a process alive, and set the variables in §3.3. **Campaigns cannot be
   sent until this is done** — they queue and wait.
2. **`VITE_MAIL_WORKER_URL` must be set on Vercel** to that service's HTTPS URL,
   then the site redeployed. Until then the deployed site correctly reports that no
   send worker is configured.
3. **Vercel environment variables** for the Gmail functions (§3.2): the Google
   OAuth client id/secret, the token-encryption key, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY` and the publishable key.
4. **Google Cloud OAuth client** with the redirect URIs in §5.1, and the consent
   screen published (or the test-user list populated, which limits it to those
   accounts).
5. **Supabase migrations `0001`–`0004`** applied, with Auth's Site URL and
   redirect list set for both domains (§4.2).
6. **A real transaction through Gmail** — one connect, one read, one send — has
   not been performed from this environment and is the last thing to confirm. Until
   it is, treat "working" as "implemented and unit-tested", not "proven in
   production".

### Not claimed

No send is ever marked successful before the SMTP relay accepts it; the worker's
health endpoint never returns a fabricated "online"; and no code path substitutes
mock mail, seeded inbox contents or fake delivery statuses for the real Gmail API.
