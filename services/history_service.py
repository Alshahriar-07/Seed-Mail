"""Email history service backed by ``data/email_history.json``.

Only sanitized, non-secret information is recorded.  Historical records are
appended, never overwritten, so history survives restarts and new campaigns.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from typing import Any

from services import storage
from services.storage import new_id


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class HistoryService:
    def __init__(self, path=storage.HISTORY_FILE, max_records: int = 20000) -> None:
        self._path = path
        self._max = max_records

    def _load(self) -> list[dict[str, Any]]:
        data = storage.read_json(self._path, {"history": []})
        items = data.get("history", []) if isinstance(data, dict) else data
        return items if isinstance(items, list) else []

    def append(self, record: dict[str, Any]) -> dict[str, Any]:
        entry = {
            "id": new_id("hist_"),
            "timestamp": record.get("timestamp") or _now(),
            "campaign_id": record.get("campaign_id", ""),
            "campaign_name": record.get("campaign_name", ""),
            "recipient_id": record.get("recipient_id", ""),
            "company_name": record.get("company_name", ""),
            "email": record.get("email", ""),
            "subject": record.get("subject", ""),
            "attempt": int(record.get("attempt", 1) or 1),
            "status": record.get("status", ""),
            "error_category": record.get("error_category", ""),
            "error_message": self.sanitize(record.get("error_message", "")),
        }
        with storage.lock_for(self._path):
            items = self._load()
            items.append(entry)
            if len(items) > self._max:
                items = items[-self._max:]
            storage.atomic_write_json(self._path, {"history": items})
        return entry

    @staticmethod
    def sanitize(message: Any) -> str:
        """Strip anything that could resemble a credential before storing."""
        text = str(message or "")
        for marker in ("GAPP_PASS", "password", "App Password"):
            if marker.lower() in text.lower():
                return "Email could not be submitted (details hidden)."
        return text[:400]

    def query(
        self,
        search: str = "",
        status: str = "",
        campaign_id: str = "",
        date_from: str = "",
        date_to: str = "",
        page: int = 1,
        page_size: int = 25,
    ) -> dict[str, Any]:
        items = list(reversed(self._load()))
        term = (search or "").strip().lower()

        def matches(entry: dict[str, Any]) -> bool:
            if status and str(entry.get("status", "")) != status:
                return False
            if campaign_id and str(entry.get("campaign_id", "")) != campaign_id:
                return False
            ts = str(entry.get("timestamp", ""))
            if date_from and ts < date_from:
                return False
            if date_to and ts > (date_to + "T23:59:59"):
                return False
            if term:
                haystack = " ".join([
                    str(entry.get("company_name", "")),
                    str(entry.get("email", "")),
                    str(entry.get("subject", "")),
                    str(entry.get("campaign_name", "")),
                ]).lower()
                if term not in haystack:
                    return False
            return True

        filtered = [entry for entry in items if matches(entry)]
        page = max(1, int(page or 1))
        page_size = min(max(1, int(page_size or 25)), 200)
        start = (page - 1) * page_size
        return {
            "items": filtered[start:start + page_size],
            "total": len(filtered),
            "page": page,
            "page_size": page_size,
            "pages": max(1, (len(filtered) + page_size - 1) // page_size),
        }

    def export(self, fmt: str, **filters: Any) -> str:
        filters.pop("page", None)
        filters.pop("page_size", None)
        items = self.query(page=1, page_size=10**9, **filters)["items"]
        if fmt == "json":
            return json.dumps({"history": items}, indent=2, ensure_ascii=False)
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow([
            "id", "timestamp", "campaign_id", "campaign_name", "recipient_id",
            "company_name", "email", "subject", "attempt", "status",
            "error_category", "error_message",
        ])
        for entry in items:
            writer.writerow([
                entry.get("id", ""),
                entry.get("timestamp", ""),
                entry.get("campaign_id", ""),
                entry.get("campaign_name", ""),
                entry.get("recipient_id", ""),
                entry.get("company_name", ""),
                entry.get("email", ""),
                entry.get("subject", ""),
                entry.get("attempt", 1),
                entry.get("status", ""),
                entry.get("error_category", ""),
                entry.get("error_message", ""),
            ])
        return buffer.getvalue()

    def clear(self) -> int:
        with storage.lock_for(self._path):
            count = len(self._load())
            storage.atomic_write_json(self._path, {"history": []})
        return count


history_service = HistoryService()
