"""Settings service: reads and writes the project ``.env`` file.

The real Gmail App Password (``GAPP_PASS``) is never returned to clients.
Unknown keys already present in ``.env`` are preserved on write, and the file
is replaced atomically.  Updated values take effect immediately because the
in-memory cache is refreshed on every successful write.
"""

from __future__ import annotations

import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

from services import storage
from services.validators import is_valid_email, is_valid_url

# Recognised keys and their non-secret defaults.
# NOTE: there is deliberately no default email subject.  The subject belongs to
# each campaign and is required when the campaign is created.
DEFAULTS: dict[str, str] = {
    "Email": "",
    "GAPP_PASS": "",
    "SENDER_NAME": "Al Shahriar Sowan",
    "GITHUB_URL": "",
    "SMTP_HOST": "smtp.gmail.com",
    "SMTP_PORT": "465",
    "SEND_DELAY_SECONDS": "5",
    "SMTP_TIMEOUT_SECONDS": "30",
    "MAX_RETRIES": "2",
    "RETRY_DELAY_SECONDS": "10",
}

# Keys that must never leave the server.
SECRET_KEYS = {"GAPP_PASS"}

# Keys that are no longer part of the configuration model.  They are dropped
# from .env on the next write so no dependency on them can linger.
RETIRED_KEYS = {"MAIL_SUBJECT"}

# Keys that survive a "reset non-secret settings".
EDITABLE_KEYS = tuple(DEFAULTS.keys())

_PASSWORD_MASK = "********"


class SettingsError(ValueError):
    """Raised when submitted settings are invalid."""


def _parse_env(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip()
    return values


class SettingsService:
    """Thread-safe .env backed configuration store."""

    def __init__(self, env_path: Path = storage.ENV_FILE) -> None:
        self._path = Path(env_path)
        self._lock = threading.RLock()
        self._cache: dict[str, str] = {}
        self.reload()

    # -- internal -----------------------------------------------------------

    def reload(self) -> None:
        with self._lock:
            raw: dict[str, str] = {}
            if self._path.exists():
                try:
                    raw = _parse_env(self._path.read_text(encoding="utf-8"))
                except OSError:
                    raw = {}
            merged = dict(DEFAULTS)
            merged.update({k: v for k, v in raw.items() if k in DEFAULTS})
            merged.update({k: v for k, v in raw.items() if k not in DEFAULTS})
            for retired in RETIRED_KEYS:
                merged.pop(retired, None)
            self._cache = merged

    def _write(self, values: dict[str, str]) -> None:
        """Persist ``values`` to .env, preserving unrelated/unknown lines."""
        path = self._path
        existing_lines: list[str] = []
        if path.exists():
            try:
                existing_lines = path.read_text(encoding="utf-8").splitlines()
            except OSError:
                existing_lines = []

        seen: set[str] = set()
        out_lines: list[str] = []
        for line in existing_lines:
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key = stripped.split("=", 1)[0].strip()
                if key in RETIRED_KEYS:
                    continue  # retired setting removed from the config model
                if key in values and key not in seen:
                    out_lines.append(f"{key}={values[key]}")
                    seen.add(key)
                    continue
                if key in seen:
                    continue
            out_lines.append(line)

        for key in EDITABLE_KEYS:
            if key in values and key not in seen:
                out_lines.append(f"{key}={values[key]}")
                seen.add(key)

        for key, value in values.items():
            if key not in seen:
                out_lines.append(f"{key}={value}")
                seen.add(key)

        content = "\n".join(out_lines).rstrip("\n") + "\n"
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)

    # -- public API ---------------------------------------------------------

    def raw(self) -> dict[str, str]:
        with self._lock:
            return dict(self._cache)

    def get(self, key: str, default: str = "") -> str:
        with self._lock:
            return self._cache.get(key, default)

    def get_int(self, key: str, default: int) -> int:
        try:
            return int(str(self.get(key, "")).strip())
        except (TypeError, ValueError):
            return default

    def get_float(self, key: str, default: float) -> float:
        try:
            return float(str(self.get(key, "")).strip())
        except (TypeError, ValueError):
            return default

    @property
    def has_password(self) -> bool:
        return bool(self.get("GAPP_PASS", "").strip())

    def public(self) -> dict[str, Any]:
        """Return settings safe to expose to the browser."""
        with self._lock:
            data = {k: self._cache.get(k, "") for k in EDITABLE_KEYS}
        data.pop("GAPP_PASS", None)
        return {
            "values": data,
            "has_password": self.has_password,
            "password_mask": _PASSWORD_MASK if self.has_password else "",
            "email": self.get("Email", ""),
            "sender_name": self.get("SENDER_NAME", DEFAULTS["SENDER_NAME"]),
        }

    def update(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Validate and persist submitted settings.

        A missing / blank ``GAPP_PASS`` keeps the existing password.  Passing
        the literal mask string is also treated as "unchanged".
        """
        with self._lock:
            current = dict(self._cache)
            candidate = dict(current)

        def _get(key: str) -> str:
            return str(payload.get(key, candidate.get(key, ""))).strip()

        email = _get("Email")
        if email and not is_valid_email(email):
            raise SettingsError("Sender email address is not valid.")

        github_url = _get("GITHUB_URL")
        if github_url and not is_valid_url(github_url):
            raise SettingsError("GitHub URL must be a full http(s) address, or left blank.")

        smtp_host = _get("SMTP_HOST")
        if not smtp_host:
            raise SettingsError("SMTP host is required.")

        try:
            smtp_port = int(_get("SMTP_PORT"))
        except (TypeError, ValueError):
            raise SettingsError("SMTP port must be a whole number.")
        if not (1 <= smtp_port <= 65535):
            raise SettingsError("SMTP port must be between 1 and 65535.")

        def _non_negative_int(key: str, label: str, allow_zero: bool = True) -> int:
            raw = _get(key)
            try:
                value = int(float(raw))
            except (TypeError, ValueError):
                raise SettingsError(f"{label} must be a whole number.")
            if value < 0 or (value == 0 and not allow_zero):
                raise SettingsError(f"{label} must be a positive number.")
            return value

        send_delay = _non_negative_int("SEND_DELAY_SECONDS", "Sending delay")
        timeout = _non_negative_int("SMTP_TIMEOUT_SECONDS", "Connection timeout", allow_zero=False)
        retries = _non_negative_int("MAX_RETRIES", "Maximum retries")
        retry_delay = _non_negative_int("RETRY_DELAY_SECONDS", "Retry delay")

        sender_name = _get("SENDER_NAME")

        updates: dict[str, str] = {
            "Email": email,
            "SENDER_NAME": sender_name,
            "GITHUB_URL": github_url,
            "SMTP_HOST": smtp_host,
            "SMTP_PORT": str(smtp_port),
            "SEND_DELAY_SECONDS": str(send_delay),
            "SMTP_TIMEOUT_SECONDS": str(timeout),
            "MAX_RETRIES": str(retries),
            "RETRY_DELAY_SECONDS": str(retry_delay),
        }

        submitted_password = str(payload.get("GAPP_PASS", "")).strip()
        if submitted_password and submitted_password != _PASSWORD_MASK:
            updates["GAPP_PASS"] = submitted_password

        with self._lock:
            merged = dict(self._cache)
            merged.update(updates)
            self._write(merged)
            self._cache = merged

        return self.public()

    def reset_non_secret(self) -> dict[str, Any]:
        """Reset non-secret settings to their defaults, keeping credentials."""
        with self._lock:
            merged = dict(self._cache)
            for key, value in DEFAULTS.items():
                if key in SECRET_KEYS:
                    continue
                merged[key] = value
            self._write(merged)
            self._cache = merged
        return self.public()


settings_service = SettingsService()
