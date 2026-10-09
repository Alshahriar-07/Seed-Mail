"""The send worker's runtime configuration, read from ONE place.

Why this module exists
----------------------
The worker used to read `os.getenv("SUPABASE_URL")` and
`os.getenv("SUPABASE_PUBLISHABLE_KEY")` inline in three different files. Two
problems followed from that:

1.  **Name drift.** The browser build is configured with `VITE_SUPABASE_URL` /
    `VITE_SUPABASE_PUBLISHABLE_KEY` (see `frontend/.env.example`), while the
    trusted worker needs the *un-prefixed* `SUPABASE_URL` /
    `SUPABASE_PUBLISHABLE_KEY`. An operator who put the Vite names on the worker
    host — the obvious mistake — left the worker with an empty URL and key, and
    every authenticated request failed with
    "The worker is not configured with SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY,
    so it cannot verify signed-in users."

2.  **Blank/placeholder values counted as configuration.** `.env` files ship
    with `SUPABASE_PUBLISHABLE_KEY=` and documentation placeholders such as
    `your-key-here`. `bool("your-key-here")` is `True`, so a half-configured
    worker looked configured until the first real request.

Everything now goes through this module, which

* accepts the documented names plus the common aliases Supabase itself emits
  (`SUPABASE_ANON_KEY` for the publishable key, `SUPABASE_SECRET_KEY` for the
  service role, `GMAIL_*` for Google OAuth);
* trims whitespace and surrounding quotes, which is what `python-dotenv` leaves
  behind for `KEY="value"`;
* treats blank and obvious placeholder values as **unset**;
* never logs or returns a secret value — `diagnose()` reports variable *names*
  and booleans only.

The worker reads its configuration from its own process environment. It
deliberately does NOT read `frontend/.env` or any `VITE_*` variable: Vite
inlines those into the public browser bundle, so they are not a place to keep
server configuration, and a worker deployed on another host never sees them.
"""

from __future__ import annotations

import os

# Values that mean "not really configured". Compared case-insensitively after
# trimming quotes/whitespace.
_PLACEHOLDERS = {
    "",
    "changeme",
    "change-me",
    "placeholder",
    "example",
    "your-key",
    "your-key-here",
    "your-anon-key",
    "your_publishable_key",
    "your-project",
    "none",
    "null",
    "todo",
}


def _clean(value: str | None) -> str:
    """Trim whitespace and one layer of matching quotes, as dotenv leaves them."""
    text = str(value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        text = text[1:-1].strip()
    return text


def _is_real(value: str) -> bool:
    """True when a value is present and is not an obvious placeholder."""
    cleaned = _clean(value)
    if not cleaned:
        return False
    lowered = cleaned.lower()
    if lowered in _PLACEHOLDERS:
        return False
    # Documentation placeholders like <your-key> / your-project.supabase.co
    if lowered.startswith("<") and lowered.endswith(">"):
        return False
    return True


def first_env(*names: str) -> str:
    """First configured value among `names`, else ''.

    Aliases are accepted so an operator can use whichever name Supabase shows
    them (publishable key / anon key) without the worker silently ignoring it.
    """
    for name in names:
        value = _clean(os.getenv(name))
        if _is_real(value):
            return value
    return ""


# --- Supabase ---------------------------------------------------------------

def supabase_url() -> str:
    return first_env("SUPABASE_URL")


def supabase_publishable_key() -> str:
    """Public Data API key, used only to verify a user's bearer token."""
    return first_env(
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_ANON_KEY",
        "SUPABASE_PUBLISHABLE_OR_ANON_KEY",
    )


def service_role_key() -> str:
    """Secret key, only ever on the trusted worker host (never the browser)."""
    return first_env("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY")


def auth_configured() -> bool:
    """True when the worker can verify a signed-in user's access token."""
    return bool(supabase_url() and supabase_publishable_key())


def queue_configured() -> bool:
    """True when the worker can claim queued campaigns."""
    return bool(supabase_url() and service_role_key())


# --- Google (Gmail API) -----------------------------------------------------
#
# Campaign delivery uses SMTP (below). Ordinary mailbox reading/sending uses the
# Gmail API and is served by the Vercel backend under `api/gmail/`; these helpers
# exist so a worker deployment can *report* whether that integration is
# configured when asked, without ever storing a Gmail credential here.

def google_client_id() -> str:
    return first_env("GOOGLE_CLIENT_ID", "GMAIL_CLIENT_ID")


def google_client_secret() -> str:
    return first_env("GOOGLE_CLIENT_SECRET", "GMAIL_CLIENT_SECRET")


def token_encryption_key() -> str:
    return first_env("GMAIL_TOKEN_ENCRYPTION_KEY")


def gmail_api_configured() -> bool:
    return bool(google_client_id() and google_client_secret() and token_encryption_key())


# --- Diagnostics ------------------------------------------------------------

def diagnose() -> dict:
    """A secret-free description of what this process is (mis)configured for.

    Every problem names the exact variable and where to set it, because the
    original failure was invisible: the operator saw one 401 message and had no
    way to tell which of several possible variables was missing.
    """
    url = supabase_url()
    publishable = supabase_publishable_key()
    service_key = service_role_key()

    problems: list[str] = []
    if not url:
        problems.append(
            "SUPABASE_URL is not set in this process's environment "
            "(worker/.env or the host's environment variables)."
        )
    if not publishable:
        problems.append(
            "SUPABASE_PUBLISHABLE_KEY is not set in this process's environment. "
            "Use the project's publishable/anon key with NO VITE_ prefix — a "
            "VITE_SUPABASE_PUBLISHABLE_KEY value is build-time and is not read here."
        )
    if not service_key:
        problems.append(
            "SUPABASE_SERVICE_ROLE_KEY is not set, so this process cannot claim "
            "queued campaigns. Reading/sending mail in the app does not need it; "
            "campaign delivery does."
        )

    return {
        "supabase_url_set": bool(url),
        "supabase_publishable_key_set": bool(publishable),
        "supabase_service_role_key_set": bool(service_key),
        # Booleans only — a value is never echoed, not even a masked one.
        "auth_configured": auth_configured(),
        "queue_configured": queue_configured(),
        "gmail_api_configured": gmail_api_configured(),
        "problems": problems,
    }
