# Security Policy

## Reporting a vulnerability

Please report security issues privately. Do **not** open a public issue for a
suspected vulnerability.

- Use GitHub's private vulnerability reporting on the repository
  (`Security` → `Report a vulnerability`), or contact the maintainers directly.

Include: what you found, the steps to reproduce it, the affected surface (web
app, Vercel functions, send worker, or Windows desktop application), and any
version you tested. You will get an acknowledgement, and we will keep you
informed as the report is investigated and fixed.

Please give a reasonable window to fix the issue before any public disclosure.

## What is in scope

- Authentication and authorization: Supabase session handling, bearer-token
  verification, Row Level Security, and ownership checks.
- The Vercel serverless functions in `api/` (the Gmail endpoints), including
  OAuth state handling and token storage.
- The send worker and local agent (`worker/`), including its origin/host guards,
  pairing token, and process handling.
- The Windows desktop application (`desktop/`), including the bundled worker,
  the preload bridge, local HTTP server, and credential store.
- Any way a secret could reach a client: the Supabase service-role key, the
  Google OAuth client secret, the Gmail token-encryption key, a Gmail App
  Password, or a refresh token.

## What is out of scope

- Google's own services and the Gmail API.
- Supabase's platform.
- Sending limits, spam classification, or deliverability decisions made by
  Google — the application respects these and offers no evasion.

## How secrets are handled

These rules are load-bearing; a change that breaks one is a security regression.

- **Nothing secret is prefixed with `VITE_`.** Anything `VITE_`-prefixed is
  inlined into the public browser bundle.
- **The Supabase service-role key, the Google OAuth client secret, and the
  Gmail token-encryption key live only server-side** (the Vercel functions and,
  where required, the worker host).
- **Gmail refresh tokens are encrypted with AES-256-GCM and stored in a table
  the browser role cannot read.** They are never returned by an API response or
  placed in a URL.
- **The Gmail App Password** is used only by the SMTP sender. It is never sent
  to Supabase, never written to browser storage, and never logged.
- **The Windows desktop application does not embed any cloud secret.** The
  service-role key is entered by the user once and stored encrypted for their
  operating-system account; the desktop app calls authenticated backend
  endpoints instead of holding provider keys.
- **Dependency artifacts and release binaries are build outputs**, not sources
  of configuration. Reproduce them rather than trusting a committed binary.

## Supported versions

Security fixes are applied to the current production deployment and the latest
release of the Windows desktop application. Older builds are not maintained.
