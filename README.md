# Seed Code Mail

A local, professional email management application for running personalised HTML
outreach campaigns from a Gmail account. Built with **FastAPI** on the backend
and plain **HTML / CSS / JavaScript (ES modules)** on the frontend.

Everything runs locally on `127.0.0.1`. Recipients, templates, campaigns and
history are stored as JSON files; SMTP credentials live in `.env` and never
leave the server.

---

## Features

- **Dashboard** – live totals, active campaign progress, SMTP status, recent activity (all from real backend data).
- **Recipients** – search, filter, sort, add/edit/delete, bulk actions, CSV/JSON import with preview + duplicate detection, CSV/JSON export.
- **Templates** – list, create, rename, duplicate, delete, set default, import/export HTML. **Nothing is preloaded**: the list is empty on a fresh installation and only templates you save appear.
- **Email Editor** – full HTML source editing, visual customization for token-mapped design properties, a collapsible **Template Variables** guide with copy buttons, and an isolated sandboxed preview workspace (desktop / tablet / mobile, zoom, fit-to-width, actual size).
- **Campaigns** – 4-step wizard, **required per-campaign subject**, sequential sending with delay, live progress, pause / resume / cancel, safe recovery after restart.
- **Email History** – search, status / campaign / date filters, pagination, details, CSV/JSON export. The campaign subject is preserved in every record.
- **Settings** – sender identity, optional GitHub URL, SMTP host/port, delay, timeout and retry settings; masked App Password; SMTP connection test. Saved to `.env` atomically without restarting.

## Requirements

- Windows 10/11 (also runs on macOS/Linux)
- Python 3.12+
- A Gmail account with **2-Step Verification** and an **App Password**

## Installation

```bat
cd path\to\SeedCodeMail
python -m pip install -r requirements.txt
```

Create your `.env` from the template and fill in the values (or use the Settings
page after launch):

```bat
copy .env.example .env
```

`.env` keys (exact names are required):

| Key | Meaning |
| --- | --- |
| `Email` | Sender Gmail address |
| `GAPP_PASS` | Gmail App Password |
| `SENDER_NAME` | Sender display name |
| `GITHUB_URL` | Optional GitHub profile/project URL used by `{{GITHUB_URL}}` |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` (SSL) or `587` (STARTTLS) |
| `SEND_DELAY_SECONDS` | Delay between sends |
| `SMTP_TIMEOUT_SECONDS` | Connection timeout |
| `MAX_RETRIES` | Retries for definite transient failures |
| `RETRY_DELAY_SECONDS` | Delay between retries |

> There is **no default email subject** setting. The subject is entered for each
> campaign and stored with it.

## Template variables

Templates are plain HTML. You can personalise them with these variables, which
are replaced per recipient when a campaign generates an email:

| Variable | Value |
| --- | --- |
| `{{COMPANY_NAME}}` | The recipient company's name |
| `{{SENDER_NAME}}` | The configured sender display name |
| `{{SENDER_EMAIL}}` | The configured sender email address |
| `{{SUBJECT}}` | The current campaign subject |
| `{{GITHUB_URL}}` | The GitHub URL from Settings, if configured |

```html
<h2>Hello {{COMPANY_NAME}},</h2>
<p>Dear {{COMPANY_NAME}} team,</p>
<p>Best regards,<br>{{SENDER_NAME}}<br>{{SENDER_EMAIL}}</p>
```

Only the variables above are supported. Unknown variables are left in place and
reported in the editor, and used-but-empty values are flagged before sending.
Values are HTML-escaped for their context (text vs. attribute), URLs are
validated before being placed in `href`, and the saved template is never
modified – a fresh document is generated for every recipient.

## Running

**Windows:** double-click `start.bat` (checks Python + dependencies, starts the
server, opens the browser).

**Manual / PowerShell / macOS / Linux:**

```powershell
python app.py
# or
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Then open <http://127.0.0.1:8000>.

**Optional desktop window (PyWebView):**

```powershell
python -m pip install -r requirements-dev.txt
python desktop.py
```

## Testing

```powershell
python -m pytest tests -v
```

Tests mock SMTP and **never send real email**.

## Project structure

```
SeedCodeMail/
├── app.py                     # FastAPI app + routes
├── desktop.py                 # optional PyWebView launcher
├── start.bat                  # Windows launcher
├── requirements.txt
├── .env.example               # placeholder config (safe to share)
├── frontend/                  # index.html + css/ + js/ (ES modules)
├── services/                  # business logic + persistence
├── data/                      # data.json, templates.json, campaigns.json, email_history.json
└── tests/
```

## Security notes

- Server binds to `127.0.0.1` only.
- The App Password is never returned to the browser; the UI shows a mask.
- Secrets are never written to `localStorage` / `sessionStorage` or logs.
- State-changing API calls reject cross-origin requests.
- The email preview runs in a sandboxed iframe (`sandbox=""`): imported scripts
  never execute and the preview cannot touch the application DOM.
- The preview never reads local filesystem paths.

## Safety model for sending

- Emails are sent **one at a time**, sequentially, with a configurable delay.
- State is saved after **every** attempt; campaigns resume after a restart as
  **paused** and only continue on explicit user action.
- A recipient marked `sent` is **never** resent automatically.
- An `unknown` outcome (connection dropped mid-submission) is recorded but not
  retried automatically, to avoid duplicate emails.
- "Sent" means the SMTP server **accepted** the message — not guaranteed inbox
  delivery.
