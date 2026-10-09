"""Read-only settings view.

Non-secret preferences (sender address, SMTP host/port, delay, timeout…) live
in the user's Supabase account and travel with each campaign request. The Gmail
App Password lives only in the worker's environment.

This wrapper layers the per-request values over the worker's own .env so the
existing EmailService / settings helpers can be reused unchanged, while nothing
is ever written to disk.
"""

from __future__ import annotations

from typing import Any


class SettingsOverrides:
    def __init__(self, base, overrides: dict[str, Any] | None = None) -> None:
        self._base = base
        self._overrides = {
            str(key): str(value)
            for key, value in (overrides or {}).items()
            if value is not None and str(value).strip() != ""
        }

    def get(self, key: str, default: str = "") -> str:
        if key in self._overrides:
            return self._overrides[key]
        return self._base.get(key, default)

    def get_int(self, key: str, default: int) -> int:
        raw = self._overrides.get(key)
        if raw is None:
            return self._base.get_int(key, default)
        try:
            return int(str(raw).strip())
        except (TypeError, ValueError):
            return default

    def get_float(self, key: str, default: float) -> float:
        raw = self._overrides.get(key)
        if raw is None:
            return self._base.get_float(key, default)
        try:
            return float(str(raw).strip())
        except (TypeError, ValueError):
            return default

    @property
    def has_password(self) -> bool:
        # The App Password is never overridable — it only exists in the worker.
        return self._base.has_password

    def raw(self) -> dict[str, str]:
        merged = dict(self._base.raw())
        merged.update(self._overrides)
        return merged


def build_overrides(payload: dict[str, Any]) -> dict[str, str]:
    """Map a campaign request to the keys EmailService understands."""
    mapping = {
        "Email": payload.get("sender_email"),
        "SENDER_NAME": payload.get("sender_name"),
        "GITHUB_URL": payload.get("github_url"),
        "SMTP_HOST": payload.get("smtp_host"),
        "SMTP_PORT": payload.get("smtp_port"),
        "SMTP_TIMEOUT_SECONDS": payload.get("smtp_timeout_seconds"),
        "SEND_DELAY_SECONDS": payload.get("send_delay_seconds"),
        "MAX_RETRIES": payload.get("max_retries"),
        "RETRY_DELAY_SECONDS": payload.get("retry_delay_seconds"),
    }
    return {key: value for key, value in mapping.items() if value not in (None, "")}
