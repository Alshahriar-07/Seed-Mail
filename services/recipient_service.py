"""Recipient store backed by ``data/data.json``.

Records are keyed by an immutable id; email addresses are treated as unique
case-insensitively.  Imports are validated and previewed before being saved.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from typing import Any

from services import storage
from services.storage import new_id
from services.validators import is_valid_company, is_valid_email, normalize_company

PENDING = "pending"
SENT = "sent"
FAILED = "failed"
UNKNOWN = "unknown"
VALID_STATUSES = {PENDING, SENT, FAILED, UNKNOWN}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RecipientService:
    def __init__(self, path=storage.RECIPIENTS_FILE) -> None:
        self._path = path

    def _load(self) -> list[dict[str, Any]]:
        data = storage.read_json(self._path, {"recipients": []})
        if isinstance(data, dict):
            items = data.get("recipients", [])
        elif isinstance(data, list):
            items = data
        else:
            items = []
        return items if isinstance(items, list) else []

    def _save(self, items: list[dict[str, Any]]) -> None:
        storage.atomic_write_json(self._path, {"recipients": items})

    # -- reads --------------------------------------------------------------

    def list_all(self) -> list[dict[str, Any]]:
        return self._load()

    def get(self, recipient_id: str) -> dict[str, Any] | None:
        return next((r for r in self._load() if r.get("id") == recipient_id), None)

    def email_index(self) -> dict[str, dict[str, Any]]:
        return {str(r.get("email", "")).strip().lower(): r for r in self._load()}

    # -- writes -------------------------------------------------------------

    def add(self, company_name: str, email: str) -> dict[str, Any]:
        company_name = normalize_company(company_name)
        email = (email or "").strip()
        if not is_valid_company(company_name):
            raise ValueError("Company name is required.")
        if not is_valid_email(email):
            raise ValueError("A valid email address is required.")

        with storage.lock_for(self._path):
            items = self._load()
            existing = {str(r.get("email", "")).strip().lower() for r in items}
            if email.lower() in existing:
                raise ValueError("A recipient with this email already exists.")

            record = {
                "id": new_id("rcp_"),
                "company_name": company_name,
                "email": email,
                "status": PENDING,
                "created_at": _now(),
                "updated_at": _now(),
                "last_attempt_at": None,
            }
            items.append(record)
            self._save(items)
            return record

    def update(self, recipient_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        with storage.lock_for(self._path):
            items = self._load()
            target = next((r for r in items if r.get("id") == recipient_id), None)
            if target is None:
                raise KeyError("Recipient not found.")

            if "company_name" in fields:
                company = normalize_company(str(fields["company_name"]))
                if not is_valid_company(company):
                    raise ValueError("Company name is required.")
                target["company_name"] = company

            if "email" in fields:
                email = str(fields["email"]).strip()
                if not is_valid_email(email):
                    raise ValueError("A valid email address is required.")
                conflict = any(
                    r.get("id") != recipient_id
                    and str(r.get("email", "")).strip().lower() == email.lower()
                    for r in items
                )
                if conflict:
                    raise ValueError("Another recipient already uses this email.")
                target["email"] = email

            if "status" in fields:
                status = str(fields["status"]).strip().lower()
                if status not in VALID_STATUSES:
                    raise ValueError("Unknown recipient status.")
                target["status"] = status
                target["last_attempt_at"] = _now()

            target["updated_at"] = _now()
            self._save(items)
            return target

    def delete(self, recipient_id: str) -> None:
        with storage.lock_for(self._path):
            items = self._load()
            remaining = [r for r in items if r.get("id") != recipient_id]
            if len(remaining) == len(items):
                raise KeyError("Recipient not found.")
            self._save(remaining)

    def delete_many(self, ids: list[str]) -> int:
        wanted = set(ids)
        with storage.lock_for(self._path):
            items = self._load()
            remaining = [r for r in items if r.get("id") not in wanted]
            removed = len(items) - len(remaining)
            self._save(remaining)
            return removed

    def set_status(self, recipient_id: str, status: str) -> None:
        if status not in VALID_STATUSES:
            return
        with storage.lock_for(self._path):
            items = self._load()
            for record in items:
                if record.get("id") == recipient_id:
                    record["status"] = status
                    record["last_attempt_at"] = _now()
                    record["updated_at"] = _now()
                    break
            self._save(items)

    # -- import / export ----------------------------------------------------

    @staticmethod
    def parse_records(text: str, fmt: str) -> list[dict[str, str]]:
        """Parse raw CSV or JSON text into ``{company_name, email}`` rows."""
        text = (text or "").lstrip("\ufeff")
        rows: list[dict[str, str]] = []

        if fmt == "json":
            try:
                payload = json.loads(text)
            except ValueError as exc:
                raise ValueError(f"Invalid JSON: {exc}") from exc
            if isinstance(payload, dict):
                payload = payload.get("recipients", payload.get("data", []))
            if not isinstance(payload, list):
                raise ValueError("JSON must be an array of recipient objects.")
            for item in payload:
                if not isinstance(item, dict):
                    continue
                rows.append({
                    "company_name": str(item.get("company_name", item.get("company", ""))).strip(),
                    "email": str(item.get("email", item.get("address", ""))).strip(),
                })
        elif fmt == "csv":
            reader = csv.DictReader(io.StringIO(text))
            if not reader.fieldnames:
                raise ValueError("CSV file has no header row.")
            field_map = {name.strip().lower(): name for name in reader.fieldnames if name}
            company_key = next(
                (field_map[k] for k in ("company_name", "company", "name", "organization")
                 if k in field_map),
                None,
            )
            email_key = next(
                (field_map[k] for k in ("email", "email_address", "address", "mail")
                 if k in field_map),
                None,
            )
            if email_key is None:
                raise ValueError("CSV must contain an 'email' column.")
            for raw in reader:
                rows.append({
                    "company_name": str(raw.get(company_key, "") if company_key else "").strip(),
                    "email": str(raw.get(email_key, "")).strip(),
                })
        else:
            raise ValueError("Unsupported import format.")
        return rows

    def preview_import(self, text: str, fmt: str) -> dict[str, Any]:
        """Validate parsed rows and flag problems without saving anything."""
        rows = self.parse_records(text, fmt)
        existing = self.email_index()
        seen_in_batch: set[str] = set()

        preview: list[dict[str, Any]] = []
        valid_count = invalid_count = duplicate_count = 0

        for index, row in enumerate(rows, start=1):
            company = normalize_company(row.get("company_name", ""))
            email = (row.get("email", "") or "").strip()
            key = email.lower()
            issues: list[str] = []

            if not is_valid_company(company):
                issues.append("Missing company name")
            if not is_valid_email(email):
                issues.append("Invalid email address")
            elif key in existing:
                issues.append("Duplicate of existing recipient")
            elif key in seen_in_batch:
                issues.append("Duplicate within import file")

            if key:
                seen_in_batch.add(key)

            valid = not issues
            if valid:
                valid_count += 1
            elif "Duplicate" in " ".join(issues):
                duplicate_count += 1
            else:
                invalid_count += 1

            preview.append({
                "row": index,
                "company_name": company,
                "email": email,
                "valid": valid,
                "issues": issues,
            })

        return {
            "rows": preview,
            "total": len(preview),
            "valid_count": valid_count,
            "invalid_count": invalid_count,
            "duplicate_count": duplicate_count,
        }

    def commit_import(self, rows: list[dict[str, str]]) -> dict[str, int]:
        """Add the valid subset of a previewed import. Never overwrites."""
        added = skipped = 0
        with storage.lock_for(self._path):
            items = self._load()
            existing = {str(r.get("email", "")).strip().lower() for r in items}
            for row in rows:
                company = normalize_company(row.get("company_name", ""))
                email = (row.get("email", "") or "").strip()
                key = email.lower()
                if not is_valid_company(company) or not is_valid_email(email) or key in existing:
                    skipped += 1
                    continue
                items.append({
                    "id": new_id("rcp_"),
                    "company_name": company,
                    "email": email,
                    "status": PENDING,
                    "created_at": _now(),
                    "updated_at": _now(),
                    "last_attempt_at": None,
                })
                existing.add(key)
                added += 1
            self._save(items)
        return {"added": added, "skipped": skipped}

    def export(self, fmt: str) -> str:
        items = self._load()
        if fmt == "json":
            return json.dumps({"recipients": items}, indent=2, ensure_ascii=False)
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow([
            "id", "company_name", "email", "status",
            "created_at", "updated_at", "last_attempt_at",
        ])
        for record in items:
            writer.writerow([
                record.get("id", ""),
                record.get("company_name", ""),
                record.get("email", ""),
                record.get("status", ""),
                record.get("created_at", ""),
                record.get("updated_at", ""),
                record.get("last_attempt_at") or "",
            ])
        return buffer.getvalue()


recipient_service = RecipientService()
