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
import sys
from pathlib import Path

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


def configure_console_encoding() -> None:
    """Make console output unable to crash the worker on non-UTF-8 terminals.

    On Windows the console code page is often cp1252, which cannot represent
    characters such as ``U+2192`` (RIGHTWARDS ARROW) or ``U+2026`` (HORIZONTAL
    ELLIPSIS). ``print()`` then raises ``UnicodeEncodeError`` — and because the
    startup banner is printed before the HTTP server is started, the worker died
    before binding its port:

        UnicodeEncodeError: 'charmap' codec can't encode character '\\u2192'

    That failure looks, from the browser, exactly like an offline worker
    ("the send worker is not reachable"), which is why it is fixed here rather
    than by remembering to keep every log line ASCII forever.

    Reconfiguring stdout/stderr to UTF-8 with ``errors="replace"`` means any
    unencodable character degrades to a replacement glyph instead of terminating
    the process. A library error message, a recipient's name, or an email address
    can therefore never take the worker down.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:  # replaced by a wrapper (e.g. pytest capture)
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):  # pragma: no cover - platform dependent
            # Never let a cosmetic fix break startup.
            pass


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


# --- Import hygiene ---------------------------------------------------------
#
# `python worker/main.py` puts THIS directory first on `sys.path`, so any module
# file here shares a namespace with the standard library. A file called
# `queue.py` therefore *replaces* the stdlib `queue` for the entire process.
#
# That is exactly the failure this project shipped: `worker/queue.py` (the
# campaign-queue data access module) shadowed the stdlib, so `anyio`'s
# `from queue import Queue` blew up with
#
#     ImportError: cannot import name 'Queue' from 'queue'
#
# and — because Starlette uses anyio to run sync endpoints in a thread pool —
# EVERY HTTP endpoint answered 500 while the process itself started cleanly and
# printed a healthy banner. It looked like an offline worker from the browser.
# The module is now `worker/campaign_queue.py` (see the note at its top), and the
# check below keeps the situation from returning unnoticed.

# Extra names to treat as protected, for runtimes where `sys.stdlib_module_names`
# is unavailable or incomplete. Only modules that a dep could plausibly import.
_EXTRA_STDLIB_NAMES = frozenset(
    {
        "abc", "asyncio", "base64", "copy", "csv", "dataclasses", "email",
        "hashlib", "hmac", "html", "http", "io", "json", "logging", "queue",
        "re", "secrets", "select", "signal", "socket", "ssl", "string",
        "tempfile", "threading", "time", "token", "types", "typing", "uuid",
        "warnings", "zipfile",
    }
)


def _stdlib_module_names() -> frozenset[str]:
    names = set(getattr(sys, "stdlib_module_names", ()))
    names |= _EXTRA_STDLIB_NAMES
    return frozenset(names)


def shadowed_stdlib_modules() -> list[str]:
    """Module names in this package that would shadow a standard-library module.

    Returns a sorted list of names, e.g. ``['queue']``. Empty is correct and
    expected. Non-empty means the worker must not be started with this directory
    on ``sys.path`` (the documented ``python worker/main.py`` start), because
    dependencies would silently import the wrong module.
    """
    package_dir = Path(__file__).resolve().parent
    protected = _stdlib_module_names()
    shadowing: list[str] = []
    for path in sorted(package_dir.glob("*.py")):
        name = path.stem
        if name.startswith("_") or not name.isidentifier():
            continue
        if name in protected:
            shadowing.append(name)
    return shadowing


def import_hygiene_problem() -> str:
    """A human-readable description of an import-shadowing hazard, else ''."""
    shadowing = shadowed_stdlib_modules()
    if not shadowing:
        return ""
    names = ", ".join(f"worker/{name}.py" for name in shadowing)
    return (
        f"{names} shadows a Python standard-library module. Because `python "
        "worker/main.py` puts worker/ first on sys.path, dependencies that import "
        f"it (e.g. anyio's `from {shadowing[0]} import ...`) would get the wrong "
        "module and every HTTP endpoint would fail. Rename the file."
    )


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

    hygiene = import_hygiene_problem()
    if hygiene:
        problems.append(hygiene)

    return {
        "supabase_url_set": bool(url),
        "supabase_publishable_key_set": bool(publishable),
        "supabase_service_role_key_set": bool(service_key),
        # Booleans only — a value is never echoed, not even a masked one.
        "auth_configured": auth_configured(),
        "queue_configured": queue_configured(),
        "gmail_api_configured": gmail_api_configured(),
        "import_hygiene_ok": not hygiene,
        "problems": problems,
    }
