"""Persistence helpers for Seed Code Mail.

Provides project-relative paths, safe JSON reads (tolerant of missing or
malformed files), and atomic writes guarded by per-file locks so that
background campaign workers never clobber simultaneous UI updates.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Paths (always relative to this project, never the terminal working dir)
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
LOGS_DIR = BASE_DIR / "logs"
FRONTEND_DIR = BASE_DIR / "frontend"

ENV_FILE = BASE_DIR / ".env"
ENV_EXAMPLE_FILE = BASE_DIR / ".env.example"

RECIPIENTS_FILE = DATA_DIR / "data.json"
TEMPLATES_FILE = DATA_DIR / "templates.json"
CAMPAIGNS_FILE = DATA_DIR / "campaigns.json"
HISTORY_FILE = DATA_DIR / "email_history.json"


def ensure_directories() -> None:
    """Create the directories the application writes into."""
    for directory in (DATA_DIR, LOGS_DIR):
        directory.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Locking
# ---------------------------------------------------------------------------

_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def lock_for(path: Path | str) -> threading.RLock:
    """Return a reusable re-entrant lock for a given file path."""
    key = str(Path(path).resolve())
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.RLock()
        return _locks[key]


# ---------------------------------------------------------------------------
# JSON read / write
# ---------------------------------------------------------------------------

def read_json(path: Path | str, default: Any = None) -> Any:
    """Read JSON from ``path``.

    Missing files return ``default``.  Malformed JSON is quarantined to a
    ``.corrupt-<timestamp>`` sibling file and ``default`` is returned instead
    of raising, so a single bad file cannot take the whole app down.
    """
    path = Path(path)
    if not path.exists():
        return default

    with lock_for(path):
        text = path.read_text(encoding="utf-8").strip()

    if not text:
        return default

    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        try:
            backup = path.with_suffix(path.suffix + ".corrupt")
            path.replace(backup)
        except OSError:
            pass
        return default


def atomic_write_json(path: Path | str, data: Any) -> None:
    """Write ``data`` as UTF-8 JSON using an atomic replace."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with lock_for(path):
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        serialized = json.dumps(data, indent=2, ensure_ascii=False)
        with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)


def new_id(prefix: str = "") -> str:
    """Return a short, unique, URL-safe identifier."""
    token = uuid.uuid4().hex[:12]
    return f"{prefix}{token}" if prefix else token
