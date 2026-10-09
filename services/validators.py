"""Shared validation helpers for Seed Code Mail."""

from __future__ import annotations

import re

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_URL_RE = re.compile(r"^https?://[^\s\"'<>]+$", re.IGNORECASE)


def is_valid_email(address: str) -> bool:
    """Return True for a syntactically plausible email address."""
    if not address or len(address) > 254:
        return False
    return bool(_EMAIL_RE.fullmatch(address.strip()))


def is_valid_url(url: str) -> bool:
    """Return True for an absolute http(s) URL."""
    if not url or len(url) > 2048:
        return False
    return bool(_URL_RE.fullmatch(url.strip()))


def normalize_company(name: str) -> str:
    """Trim and collapse whitespace in a company name."""
    return re.sub(r"\s+", " ", (name or "").strip())


def is_valid_company(name: str) -> bool:
    """Return True for a non-empty, sane-length company name."""
    cleaned = normalize_company(name)
    return 0 < len(cleaned) <= 200
