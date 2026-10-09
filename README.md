# Seed Code Mail

Personalised HTML email campaign management — recipients, a template studio,
campaigns with real progress control, and a complete submission history.

Production site: <https://mrseedmail.vercel.app/> · Beta: <https://seedmail-beta.vercel.app/>

> Production is HTTPS-only: a request to `http://mrseedmail.vercel.app/` is
> answered with `308 Permanent Redirect` to `https://mrseedmail.vercel.app/`.
> Verified at the transport level — see [§11](#11-vercel-deployment) for the
> current serving status of the deployment itself.

---

## 1. Architecture (read this first)

The application is **two cooperating parts**. Understanding why avoids most
confusion:

```
┌──────────────────────────────┐        ┌─────────────────────────┐
│  Web app (Vercel, static)    │        │  Supabase                │
│  Vite build of ./frontend    │◄──────►│  Auth + Postgres (RLS)   │
│  • Supabase Auth (sign in)   │        │  • recipients            │
│  • recipients/campaigns/…    │        │  • campaigns + job queue │
│  • email templates (local)   │        │  • email history         │
└──────────────┬───────────────┘        │  • non-secret settings   │
               │  HTTPS + Supabase       └─────────────────────────┘
               │  access token (JWT)
               ▼
┌──────────────────────────────┐
│  Send worker (your machine)  │
│  python worker/main.py       │
│  • Gmail SMTP (sequential)   │
│  • holds the App Password    │
│  • writes progress to        │
│    Supabase as the user      │
└──────────────────────────────┘
```

**Why the split.** Vercel runs short-lived serverless functions; a campaign is a
long, sequential, stateful SMTP job (one message at a time, configurable delay,
bounded retries, pause/resume/cancel). A static frontend plus a worker on a
machine you control is the only architecture here that is both
Vercel-compatible *and* honest about credential handling. A progress bar alone
does not make serverless sending reliable, so sending does not pretend to be
serverless.

**What runs where**

| Concern | Where | Notes |
| --- | --- | --- |
| Sign up / sign in / sessions | Supabase Auth | PKCE, session restored on refresh |
| Recipients, campaigns, queue, history, non-secret settings | Supabase Postgres | Row Level Security per user |
| Email templates | **Your browser (IndexedDB)** | Never uploaded; not in Postgres |
| Gmail SMTP delivery | **Local worker** | The only component holding the App Password |
| App Password | Worker's local `.env` | Never in the browser, Postgres, or git |

The old local-only FastAPI application (`app.py` + `services/`) is retained: it
still serves common business logic, is the source of the SMTP engine the worker
reuses, and can serve a built copy of the site on `127.0.0.1` for offline use.

---

## 2. Local development

Requirements: **Node.js 20+**, **Python 3.12+**, a Gmail account with 2-Step
Verification and an App Password.

```bash
# 1. Frontend dependencies + public configuration
npm install
cp frontend/.env.example frontend/.env      # then paste your Supabase publishable key

# 2. Worker / backend dependencies and private configuration
python -m pip install -r requirements.txt
cp .env.example .env                        # then fill in the Gmail values

# 3a. Develop the site (hot reload, http://127.0.0.1:5173)
npm run dev

# 3b. In a second terminal: run the send worker (http://127.0.0.1:8765)
python worker/main.py
```

On Windows you can instead double-click **`start.bat`**, which checks Python and
dependencies, builds the site once, starts the worker in its own window, serves
the built site on <http://127.0.0.1:8000> and opens the browser.

### Build & test

```bash
npm run build          # production bundle -> ./dist  (this is what Vercel serves)
npm test               # template-renderer tests (node --test)
python -m pytest tests -q   # worker + backend tests (72 tests)
npm run test:rls       # cross-user isolation against a real Supabase project (see §6)
```

No test sends email: SMTP is mocked everywhere, and the worker tests replace
Supabase with an in-memory recorder.

---

## 3. Environment variables

### Public (frontend — `frontend/.env`, and Vercel)

Only `VITE_`-prefixed variables reach the browser. Everything here is public by
design.

| Variable | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | `----------` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | your Supabase **publishable (anon)** key |
| `VITE_MAIL_WORKER_URL` | `http://127.0.0.1:8765` (default) |
| `VITE_SITE_URL` | `https://mrseedmail.vercel.app` |

> Never put a Supabase **secret / service-role** key or a Gmail App Password
> behind a `VITE_` name — Vite inlines those values into public JavaScript.

### Private (worker — `.env`, never committed)

| Variable | Meaning |
| --- | --- |
| `Email` | Sender Gmail address |
| `GAPP_PASS` | Gmail App Password (16 characters) |
| `SENDER_NAME` | Sender display name |
| `GITHUB_URL` | Optional URL used by `{{GITHUB_URL}}` |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.gmail.com` / `465` (SSL) or `587` (STARTTLS) |
| `SEND_DELAY_SECONDS` | Delay between messages |
| `SMTP_TIMEOUT_SECONDS` | Connection timeout |
| `MAX_RETRIES` / `RETRY_DELAY_SECONDS` | Bounded retry policy |
| `SUPABASE_URL` | Same project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Same publishable key |
| `WORKER_HOST` / `WORKER_PORT` | `127.0.0.1` / `8765` |
| `WORKER_ALLOWED_ORIGINS` | Comma-separated origins allowed to call the worker |

There is **no default email subject**. The subject belongs to each campaign and
is required when the campaign is created.

---

## 4. Supabase setup

### 4.1 Apply the migrations

The schema is version-controlled SQL. Apply it to the existing project (it is
written to be re-runnable and never drops data):

```bash
supabase link --project-ref jptukeybgvuehdzghxfj
supabase db push          # applies supabase/migrations/*.sql
```

Or run the two files by hand in the Supabase SQL editor, in order:

1. `supabase/migrations/0001_schema.sql` — tables, indexes, constraints, triggers
2. `supabase/migrations/0002_rls.sql` — Row Level Security + grants

Then verify the policies are actually in place:

```bash
psql "$SUPABASE_DB_URL" -f supabase/tests/rls_policies.sql
```

### 4.2 Auth URL configuration (manual, dashboard)

Supabase → **Authentication → URL Configuration**:

* **Site URL**: `https://mrseedmail.vercel.app`
* **Redirect URLs** (all of them):
  * `https://mrseedmail.vercel.app/**`
  * `https://seedmail-beta.vercel.app/**` (kept for beta testing)
  * `http://localhost:5173/**` and `http://127.0.0.1:5173/**`
  * `http://localhost:8000/**` and `http://127.0.0.1:8000/**` (local build)

Email/password sign-up must be enabled. If email confirmation is on (recommended),
confirm links point at the current origin, so both deployed origins must be
listed above or verification links will fail.

### 4.3 Tables

| Table | Purpose |
| --- | --- |
| `profiles` | Display name, created/updated timestamps (created by a signup trigger) |
| `recipients` | Company, email, status, per-user unique email |
| `campaigns` | Name, **required subject**, local `template_ref`, status, counters |
| `campaign_recipients` | One job per recipient: attempts, status, last error |
| `email_history` | Append-only, sanitized submission log |
| `user_settings` | Non-secret sending preferences — **no credential column exists** |

Design notes: every user-owned table has `user_id uuid not null default auth.uid()`,
foreign keys with `on delete cascade`/`set null`, check constraints for statuses
and value ranges, per-user indexes, and `updated_at` triggers. Templates are
deliberately absent: they live in the browser.

---

## 5. Row Level Security

RLS is enabled **and forced** on every user-owned table. Policies use
`auth.uid()` — never a user id supplied by the browser.

* `SELECT` / `UPDATE` / `DELETE`: `using (auth.uid() = user_id)`
* `INSERT`: `with check (auth.uid() = user_id)`
* `campaign_recipients` additionally requires the parent campaign to belong to
  the caller, so a job cannot be attached to someone else's campaign id.
* `email_history` has no `UPDATE` policy: submission records are append-only.
* There is **no policy for `anon`**, and `anon` privileges are revoked, so an
  anonymous request reads nothing and writes nothing.

Changing a record id (`?id=<someone-else's-uuid>`) therefore returns zero rows
and updates/deletes affect zero rows. Verify it for real with two accounts:

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... \
TEST_USER_A_EMAIL=... TEST_USER_A_PASSWORD=... \
TEST_USER_B_EMAIL=... TEST_USER_B_PASSWORD=... \
npm run test:rls
```

The script (`supabase/tests/rls_isolation.mjs`) signs in as both users and
asserts read/update/delete/insert isolation for recipients, campaigns, jobs,
history and settings, then cleans up. Create the two test accounts first.

---

## 6. Authentication flow

Implemented entirely with Supabase Auth (PKCE). No custom password storage, no
password anywhere in the application database.

| Screen | Route | Notes |
| --- | --- | --- |
| Sign in | `#/login` | Helpful error mapping |
| Sign up | `#/signup` | Display name optional; email confirmation |
| Confirmation notice | `#/verify` | Resend confirmation |
| Forgot password | `#/forgot` | Sends a secure link |
| Choose new password | `#/update-password` | Reachable from the recovery link |
| Sign out | topbar | Clears the session and returns to the landing view |

* Sessions are stored by the Supabase client and **restored after refresh**;
  expired/invalid sessions return the user to the sign-in screen with a message.
* Private routes are unreachable without a session — the app shell is not even
  rendered, so hidden UI is never the access control.
* Tokens are never written to URLs, logs or analytics. Errors from expired links
  are read from `?error=` and the query string is cleaned with `replaceState`.

---

## 7. Email templates (local by design)

* Stored in **IndexedDB** (`seedcode-mail` → `templates`), versioned, with a
  one-time defensive migration if legacy `localStorage` keys are found.
* **Empty on a fresh install** — nothing is preloaded, ever.
* Create, rename, duplicate (with unique names), delete, set default, import
  HTML, import/export **JSON**, export **HTML**.
* Unsaved changes are shown on the page and guarded before navigation.
* The list is per browser profile: templates do **not** appear on another device,
  and clearing browser storage deletes them — export JSON to back up.

Rendering and preview happen client-side (`frontend/js/lib/render.js`), a
faithful port of the original server renderer: only supported variables are
substituted, values are escaped by context (attribute vs text), a URL is
validated before it goes into an attribute, unknown tokens are left visible and
reported, and the saved template is never mutated.

Supported variables: `{{COMPANY_NAME}}`, `{{SENDER_NAME}}`, `{{SENDER_EMAIL}}`,
`{{SUBJECT}}`, `{{GITHUB_URL}}`.

The preview renders inside `<iframe sandbox="">`, so imported templates can
never execute script or touch the application DOM.

---

## 8. Gmail credentials

* The App Password is **never** stored in Postgres, `localStorage`, IndexedDB,
  a URL, a log, or the repository.
* It is written only to the **worker's own `.env`** on your machine, through the
  Settings page (`PUT /api/worker/settings`, authenticated with your Supabase
  token).
* It is never returned by any API response; the UI only ever shows a mask and a
  `has_password` boolean.
* It can be replaced (save a new one) and is the only thing kept when you click
  *Reset defaults*.
* `SUPABASE_PUBLISHABLE_KEY` is used everywhere — no service-role key is needed
  by the web app or the worker.

**Honest limitation:** on the machine running the worker the App Password sits in
a plaintext `.env` file, exactly as in the previous version of this project. That
file is git-ignored, but it is not encrypted at rest. Storing it encrypted would
require a server-side key service (e.g. Supabase Vault or an OS keychain); that
was **not** implemented, so nothing here claims the credential is encrypted.

---

## 9. Sending model and safety

1. You create a campaign in the browser: name, **subject**, local template,
   recipients. The campaign row and its job queue are written to Supabase.
2. *Start* hands the worker the queue, the subject and the **local template
   document** for that run. The template is held in worker memory only and is
   never written to Postgres.
3. The worker sends **one message at a time** with the configured delay, writing
   each attempt to `campaign_recipients`, `email_history` and `recipients` under
   *your* RLS identity.
4. Progress, pause, resume and cancel are all persisted, so the UI shows real
   state rather than an animation.

Guarantees:

* A recipient already marked `sent` is **never** resent automatically.
* An `unknown` outcome (connection dropped mid-submission) is recorded but
  **never** retried — that is what prevents duplicate emails.
* Only definite transient failures (`connection`, `greeting`, `temporary`) are
  retried, within `MAX_RETRIES`.
* **`sent` means the SMTP relay ACCEPTED the message.** It does not mean the
  message reached an inbox. No delivery claim is made anywhere.
* Nothing is sent at startup; there is no background auto-send.
* Behaviour is covered by tests: sequential ordering, retry bounds, no-retry on
  `unknown`, cancellation, and that HTTP 200 never implies "sent".

---

## 10. SEO

Served from `frontend/public/` (copied to the site root at build time):

* `robots.txt` — allows the public landing page, points at the sitemap.
* `sitemap.xml` — the single public URL.
* `og-image.png` — 1200×630 social card (regenerate from `tools/og-card.html`).
* `favicon.svg`.

In `frontend/index.html`: unique title, meta description, canonical URL,
Open Graph + Twitter card metadata, theme color, and truthful
`SoftwareApplication` structured data (no invented ratings or claims).

The signed-out view is **static HTML**, so the landing content is crawlable
without JavaScript. Once a session exists the app sets
`noindex, nofollow` and every private view is a hash route, so no account page
can be indexed. No user data or secret appears in metadata.

> Not claimed: any SEO score or ranking. Nothing here was measured against a
> live crawler.

---

## 11. Vercel deployment

`vercel.json` matches the real framework: Vite, `npm run build`, output `dist`.

1. Import the repository in Vercel.
2. Environment variables — **Production, Preview and Development**:
   * `VITE_SUPABASE_URL` = `https://jptukeybgvuehdzghxfj.supabase.co`
   * `VITE_SUPABASE_PUBLISHABLE_KEY` = your publishable key
   * `VITE_MAIL_WORKER_URL` = `http://127.0.0.1:8765`
   * `VITE_SITE_URL` = `https://mrseedmail.vercel.app`
3. Deploy. Changing an environment variable does **not** update an existing
   deployment — redeploy afterwards.

Routing: the app is a hash-routed SPA, so refreshes work by construction; a
rewrite also covers a real deep link such as `/dashboard` while leaving files
with extensions (`robots.txt`, `sitemap.xml`, `/assets/*`) untouched. Security
headers (nosniff, frame denial, referrer policy, HSTS, permissions policy) are
set. There is no writable filesystem usage and no long-running process on Vercel.

**Current serving status of the production domain (measured, not assumed):**

```
GET http://mrseedmail.vercel.app/    -> 308 Permanent Redirect -> https://mrseedmail.vercel.app/
GET https://mrseedmail.vercel.app/   -> 500  x-vercel-error: FUNCTION_INVOCATION_FAILED
GET https://mrseedmail.vercel.app/robots.txt -> 500 FUNCTION_INVOCATION_FAILED
GET https://seedmail-beta.vercel.app/ -> 307 Temporary Redirect -> https://mrseedmail.vercel.app/
GET https://seedmail.vercel.app/     -> 451 Unavailable For Legal Reasons
```

So: the domain **exists**, TLS/HTTPS **is** available, and HTTP is redirected to
HTTPS. However the deployment behind it currently fails with
`FUNCTION_INVOCATION_FAILED` on **every** path — including `/robots.txt`, which a
static Vite build would serve directly. That means the `mrseedmail` Vercel project
is not (yet) serving this repository's static `dist/` output, and the site is **not**
confirmed working. Do not treat the production URL as live until this is fixed.

**Manual steps still required:**

* Fix the failing `mrseedmail` deployment: check that the Vercel project's
  **Root Directory**, **Build Command** (`npm run build`) and **Output Directory**
  (`dist`) match this repository, and that no leftover serverless function or
  legacy rewrite is catching every request. Re-deploy, then confirm
  `GET /robots.txt` returns 200 with the file contents.
* Confirm `mrseedmail.vercel.app` is assigned to this project (a `*.vercel.app`
  name is only "yours" once the project claim is confirmed).
* `seedmail.vercel.app` currently answers `451` — it is not serving anything and
  should not be used anywhere.
* `seedmail-beta.vercel.app` currently redirects (307) to the production domain,
  so it is **not** an independent beta deployment right now. It is still listed in
  the Supabase redirect URLs, the worker's allowed origins and `.env.example` so
  that it keeps working once it is re-pointed at a beta branch.
* Confirm the Supabase redirect URLs in §4.2 include every deployed origin.

---

## 12. Security summary

| Risk | Mitigation |
| --- | --- |
| Cross-user data access | RLS on every user-owned table, `force row level security`, no `anon` policies |
| Forged user id | `user_id` defaults to `auth.uid()`; never read from the request |
| Credential leakage | App Password only in the worker's local `.env`; never returned by an API |
| XSS from templates | Preview in `sandbox=""` iframe; all injected values HTML-escaped by context |
| SQL/filter injection | PostgREST filters are parameterised; free-text search strips filter syntax |
| Malicious worker calls | Every endpoint except `/health` requires a verified Supabase token; worker binds to `127.0.0.1` |
| Mixed content | The worker is reached over `http://127.0.0.1`, which browsers treat as a secure context |
| Duplicate emails | `sent` is never resent; `unknown` is never retried; one run per campaign |

Not implemented, and therefore not claimed: a Content-Security-Policy (the exact
origins — Supabase, the Google Fonts CDN, unpkg for icons, the local worker —
should be pinned and tested in a browser first), rate limiting, and audit
logging.

---

## 13. Project structure

```
├── frontend/                  # the web app (Vite root)
│   ├── index.html             # shell + crawlable landing + SEO metadata
│   ├── css/│js/               # UI (modules unchanged in shape, data layer replaced)
│   ├── js/api.js              # data layer: Supabase + IndexedDB + worker
│   ├── js/auth.js             # Supabase Auth flows and signed-out screens
│   ├── js/lib/                # supabase client, IndexedDB store, renderer, worker client, exports
│   └── public/                # robots.txt, sitemap.xml, favicon.svg, og-image.png
├── worker/                    # the send worker (FastAPI, local only)
│   ├── main.py                # authenticated HTTP interface
│   ├── sender.py              # sequential campaign runner + Supabase progress
│   ├── auth.py                # Supabase access-token verification
│   ├── supabase_client.py     # REST client used as the user (RLS applies)
│   └── settings_overrides.py  # per-run settings layered over the worker .env
├── services/                  # shared, tested business logic (SMTP engine, settings)
├── app.py                     # legacy local app + static server for ./dist
├── supabase/                  # migrations + RLS verification tests
├── tests/                     # pytest (worker + backend) and node tests (renderer)
├── tools/og-card.html         # source for the social card
├── start.bat                  # Windows launcher
└── vercel.json                # Vite build, SPA rewrite, security headers
```

---

## 14. Known limitations

1. **Templates are local.** No sync between devices or browsers; browser storage
   can be cleared by the user or evicted by the browser (the app requests
   persistent storage, which is a hint, not a guarantee).
2. **Sending needs the worker running.** The hosted site alone cannot send mail;
   if the worker is offline the UI says so instead of faking progress.
3. **App Password is plaintext in the worker's `.env`** (git-ignored, local to
   your machine) — see §8.
4. **Supabase was not applied or end-to-end tested from this environment** (no
   credentials were available). Migrations and the isolation test are provided
   and must be run against the project; authentication is only claimed to be
   implemented, not verified live.
5. **Gmail limits are not enforced.** Google's daily sending limits can stop a
   campaign; the app reports the SMTP rejection rather than retrying blindly.
6. **`user_settings` holds non-secret preferences only**, so an SMTP host/port
   set in Settings is passed to the worker per campaign; the worker's `.env`
   still supplies the default and always supplies the password.
7. **Legacy JSON stores remain on disk** (`data/*.json`) from the previous
   version. They are still read by the retained local application (`app.py`) and
   hold existing recipients, campaigns, history and the saved template, so they
   are deliberately kept rather than deleted. The hosted app does not read them;
   historical recipients/history can also be imported into a Supabase account
   through the normal CSV/JSON import.
