"""Campaign manager for Seed Code Mail.

A campaign is a persisted record plus a background worker thread.  The worker
sends messages one at a time, saves state after every attempt, and honours
pause / resume / cancel requests.  It never resends a recipient already marked
``sent`` and never automatically retries an ``unknown`` outcome.

On startup, any campaign left in ``running`` state is demoted to ``paused`` so
an interrupted send is resumed only by an explicit user action.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any

from services import storage
from services.email_service import EmailService, build_plain_text
from services.history_service import history_service
from services.recipient_service import recipient_service
from services.storage import new_id
from services.template_service import template_service

RUNNING = "running"
PAUSED = "paused"
COMPLETED = "completed"
CANCELLED = "cancelled"
DRAFT = "draft"

_RESULT_PENDING = "pending"
_RESULT_SENT = "sent"
_RESULT_FAILED = "failed"
_RESULT_UNKNOWN = "unknown"
_RESULT_SKIPPED = "skipped"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class CampaignBusy(RuntimeError):
    """Raised when a campaign cannot start because of a conflicting send."""


class CampaignControl:
    def __init__(self) -> None:
        self.resume = threading.Event()
        self.resume.set()
        self.cancel = threading.Event()


class CampaignService:
    def __init__(self, settings, path=storage.CAMPAIGNS_FILE) -> None:
        self._settings = settings
        self._path = path
        self._lock = threading.RLock()
        self._controls: dict[str, CampaignControl] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._active_recipients: set[str] = set()
        self._campaigns: dict[str, dict[str, Any]] = {}
        self._load()

    # -- persistence --------------------------------------------------------

    def _load(self) -> None:
        data = storage.read_json(self._path, {"campaigns": []})
        items = data.get("campaigns", []) if isinstance(data, dict) else data
        self._campaigns = {}
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict) and item.get("id"):
                    if item.get("status") == RUNNING:
                        item["status"] = PAUSED
                        item["interrupted"] = True
                    self._campaigns[item["id"]] = item

    def _save(self) -> None:
        with storage.lock_for(self._path):
            storage.atomic_write_json(self._path, {"campaigns": list(self._campaigns.values())})

    # -- counters -----------------------------------------------------------

    @staticmethod
    def _recount(campaign: dict[str, Any]) -> None:
        results = campaign.get("results", {})
        counts = {_RESULT_PENDING: 0, _RESULT_SENT: 0,
                  _RESULT_FAILED: 0, _RESULT_UNKNOWN: 0, _RESULT_SKIPPED: 0}
        for result in results.values():
            counts[result.get("status", _RESULT_PENDING)] = (
                counts.get(result.get("status", _RESULT_PENDING), 0) + 1
            )
        total = len(results)
        processed = counts[_RESULT_SENT] + counts[_RESULT_FAILED] + counts[_RESULT_UNKNOWN]
        campaign["counters"] = {
            "total": total,
            "processed": processed,
            "sent": counts[_RESULT_SENT],
            "failed": counts[_RESULT_FAILED],
            "unknown": counts[_RESULT_UNKNOWN],
            "pending": counts[_RESULT_PENDING],
            "progress": round(processed / total * 100, 1) if total else 0.0,
        }

    # -- reads --------------------------------------------------------------

    def list_all(self) -> list[dict[str, Any]]:
        with self._lock:
            return sorted(self._campaigns.values(),
                          key=lambda c: c.get("created_at", ""), reverse=True)

    def get(self, campaign_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._campaigns.get(campaign_id)

    def active_campaign(self) -> dict[str, Any] | None:
        with self._lock:
            return next((c for c in self._campaigns.values() if c.get("status") == RUNNING), None)

    # -- creation -----------------------------------------------------------

    def create(self, name: str, subject: str, template_id: str,
               recipient_ids: list[str]) -> dict[str, Any]:
        name = (name or "").strip()
        if not name:
            raise ValueError("Campaign name is required.")

        # The subject lives with the campaign and is required: there is no
        # default subject to fall back to anywhere in the application.
        subject = (subject or "").strip()
        if not subject:
            raise ValueError("Campaign subject is required.")

        template = template_service.get(template_id)
        if template is None:
            raise ValueError("Selected template was not found.")

        unique_ids = list(dict.fromkeys(rid for rid in (recipient_ids or []) if rid))
        if not unique_ids:
            raise ValueError("Select at least one recipient.")

        results: dict[str, dict[str, Any]] = {}
        missing_info: list[str] = []
        for rid in unique_ids:
            recipient = recipient_service.get(rid)
            if recipient is None:
                continue
            # Required recipient information is checked before anything is sent.
            if not str(recipient.get("company_name", "")).strip() or not str(recipient.get("email", "")).strip():
                missing_info.append(recipient.get("id", rid))
                continue
            results[rid] = {
                "recipient_id": rid,
                "company_name": recipient.get("company_name", ""),
                "email": recipient.get("email", ""),
                "status": _RESULT_PENDING,
                "attempts": 0,
                "last_error_category": "",
                "last_error": "",
                "last_attempt_at": None,
            }

        if missing_info:
            raise ValueError(
                f"{len(missing_info)} selected recipient(s) are missing a company name or email address."
            )
        if not results:
            raise ValueError("None of the selected recipients still exist.")

        campaign = {
            "id": new_id("cmp_"),
            "name": name[:120],
            "subject": subject[:200],
            "template_id": template_id,
            "recipient_ids": list(results.keys()),
            "results": results,
            "status": DRAFT,
            "created_at": _now(),
            "updated_at": _now(),
            "started_at": None,
            "finished_at": None,
            "current_recipient": None,
            "interrupted": False,
        }
        self._recount(campaign)
        with self._lock:
            self._campaigns[campaign["id"]] = campaign
            self._save()
        return campaign

    # -- validation helpers -------------------------------------------------

    def _conflicts(self, campaign: dict[str, Any]) -> list[str]:
        """Recipients already owned by another running campaign."""
        with self._lock:
            others = [
                c for c in self._campaigns.values()
                if c.get("id") != campaign["id"] and c.get("status") == RUNNING
            ]
            busy = set()
            for other in others:
                for rid in other.get("recipient_ids", []):
                    result = other.get("results", {}).get(rid, {})
                    if result.get("status") == _RESULT_PENDING:
                        busy.add(rid)
            # A paused campaign still holds its own recipients in
            # _active_recipients; do not treat those as conflicts with itself.
            busy |= (self._active_recipients - set(campaign.get("recipient_ids", [])))
        return [rid for rid in campaign.get("recipient_ids", []) if rid in busy]

    # -- control ------------------------------------------------------------

    def start(self, campaign_id: str) -> dict[str, Any]:
        campaign = self.get(campaign_id)
        if campaign is None:
            raise KeyError("Campaign not found.")
        if campaign.get("status") == RUNNING:
            return campaign
        if campaign.get("status") == COMPLETED:
            pending = [r for r in campaign["recipient_ids"]
                       if campaign["results"][r]["status"] in (_RESULT_PENDING, _RESULT_FAILED, _RESULT_UNKNOWN)]
            if not pending:
                raise CampaignBusy("This campaign has already completed.")

        conflicts = self._conflicts(campaign)
        if conflicts:
            raise CampaignBusy(
                "Another active campaign is already sending to "
                f"{len(conflicts)} of the selected recipients."
            )

        if not self._settings.get("GAPP_PASS", "").strip():
            raise CampaignBusy("Configure the Gmail App Password in Settings before sending.")

        with self._lock:
            control = self._controls.get(campaign_id) or CampaignControl()
            control.resume.set()
            control.cancel.clear()
            self._controls[campaign_id] = control
            campaign["status"] = RUNNING
            campaign["started_at"] = campaign.get("started_at") or _now()
            campaign["interrupted"] = False
            campaign["updated_at"] = _now()
            self._save()

            # If a worker thread for this campaign is still alive (e.g. it was
            # paused mid-run), just unblock it instead of spawning a second one,
            # which would send duplicate emails.
            existing = self._threads.get(campaign_id)
            if existing and existing.is_alive():
                return campaign

            thread = threading.Thread(
                target=self._run, args=(campaign_id,), name=f"campaign-{campaign_id}", daemon=True
            )
            self._threads[campaign_id] = thread
            thread.start()
        return campaign

    def pause(self, campaign_id: str) -> dict[str, Any]:
        campaign = self.get(campaign_id)
        if campaign is None:
            raise KeyError("Campaign not found.")
        control = self._controls.get(campaign_id)
        if control:
            control.resume.clear()
        with self._lock:
            if campaign.get("status") == RUNNING:
                campaign["status"] = PAUSED
                campaign["updated_at"] = _now()
                self._save()
        return campaign

    def resume(self, campaign_id: str) -> dict[str, Any]:
        campaign = self.get(campaign_id)
        if campaign is None:
            raise KeyError("Campaign not found.")
        if campaign.get("status") != PAUSED:
            return campaign
        return self.start(campaign_id)

    def cancel(self, campaign_id: str) -> dict[str, Any]:
        campaign = self.get(campaign_id)
        if campaign is None:
            raise KeyError("Campaign not found.")
        control = self._controls.get(campaign_id)
        if control:
            control.cancel.set()
            control.resume.set()
        with self._lock:
            if campaign.get("status") in (RUNNING, PAUSED):
                campaign["status"] = CANCELLED
                campaign["finished_at"] = _now()
                campaign["updated_at"] = _now()
                self._save()
        return campaign

    def delete(self, campaign_id: str) -> None:
        campaign = self.get(campaign_id)
        if campaign is None:
            raise KeyError("Campaign not found.")
        if campaign.get("status") == RUNNING:
            raise CampaignBusy("Pause or cancel the campaign before deleting it.")
        with self._lock:
            self._campaigns.pop(campaign_id, None)
            self._save()

    # -- worker -------------------------------------------------------------

    def _interruptible_sleep(self, seconds: float, control: CampaignControl) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < deadline:
            if control.cancel.is_set():
                return
            time.sleep(min(0.25, deadline - time.monotonic()))

    def _wait_if_paused(self, control: CampaignControl) -> bool:
        """Block while paused. Returns False if cancelled."""
        while not control.resume.is_set():
            if control.cancel.is_set():
                return False
            time.sleep(0.25)
        return not control.cancel.is_set()

    def _run(self, campaign_id: str) -> None:
        control = self._controls[campaign_id]
        campaign = self.get(campaign_id)
        if campaign is None:
            return

        max_retries = max(0, self._settings.get_int("MAX_RETRIES", 2))
        retry_delay = max(0, self._settings.get_int("RETRY_DELAY_SECONDS", 10))
        send_delay = max(0, self._settings.get_int("SEND_DELAY_SECONDS", 5))
        sender_email = self._settings.get("Email", "")
        sender_name = self._settings.get("SENDER_NAME", "")
        github_url = self._settings.get("GITHUB_URL", "")
        service = EmailService(self._settings)

        template = template_service.get(campaign.get("template_id", ""))
        if template is None:
            with self._lock:
                campaign["status"] = CANCELLED
                campaign["finished_at"] = _now()
                self._save()
            return

        cancelled = False
        with self._lock:
            self._active_recipients.update(campaign["recipient_ids"])

        try:
            for rid in list(campaign.get("recipient_ids", [])):
                if control.cancel.is_set():
                    cancelled = True
                    break
                if not self._wait_if_paused(control):
                    cancelled = True
                    break

                result = campaign["results"].get(rid)
                if result is None or result.get("status") == _RESULT_SENT:
                    continue  # never resend a successful submission

                recipient = recipient_service.get(rid)
                if recipient is None:
                    with self._lock:
                        result["status"] = _RESULT_SKIPPED
                        result["last_error"] = "Recipient no longer exists."
                        self._recount(campaign)
                        self._save()
                    continue

                with self._lock:
                    campaign["current_recipient"] = {
                        "id": rid,
                        "company_name": result.get("company_name", ""),
                        "email": result.get("email", ""),
                    }
                    self._save()

                outcome = self._send_with_retries(
                    service, campaign, template, result, sender_email,
                    sender_name, github_url, max_retries, retry_delay, control,
                )
                if outcome is None:  # cancelled during retries
                    cancelled = True
                    break

                result["status"] = outcome.status
                result["last_error_category"] = outcome.category
                result["last_error"] = outcome.message
                result["last_attempt_at"] = _now()

                history_service.append({
                    "campaign_id": campaign["id"],
                    "campaign_name": campaign.get("name", ""),
                    "recipient_id": rid,
                    "company_name": result.get("company_name", ""),
                    "email": result.get("email", ""),
                    "subject": campaign.get("subject", ""),
                    "attempt": result["attempts"],
                    "status": outcome.status,
                    "error_category": outcome.category,
                    "error_message": outcome.message,
                })
                recipient_status = {
                    _RESULT_SENT: "sent",
                    _RESULT_FAILED: "failed",
                    _RESULT_UNKNOWN: "unknown",
                }.get(outcome.status)
                if recipient_status:
                    recipient_service.set_status(rid, recipient_status)

                with self._lock:
                    campaign["current_recipient"] = None
                    self._recount(campaign)
                    campaign["updated_at"] = _now()
                    self._save()

                self._interruptible_sleep(send_delay, control)
        finally:
            with self._lock:
                self._active_recipients.difference_update(campaign["recipient_ids"])
                result_final = campaign.get("counters", {})
                all_done = result_final.get("pending", 1) == 0
                if cancelled or control.cancel.is_set():
                    campaign["status"] = CANCELLED
                elif all_done:
                    campaign["status"] = COMPLETED
                else:
                    campaign["status"] = PAUSED
                campaign["current_recipient"] = None
                campaign["finished_at"] = _now() if campaign["status"] in (COMPLETED, CANCELLED) else campaign.get("finished_at")
                campaign["updated_at"] = _now()
                self._recount(campaign)
                self._save()
                self._threads.pop(campaign_id, None)

    def _send_with_retries(self, service, campaign, template, result,
                           sender_email, sender_name, github_url, max_retries,
                           retry_delay, control):
        """Return the final SendOutcome, or None if cancelled while retrying."""
        company = result.get("company_name", "")
        email = result.get("email", "")
        subject = campaign.get("subject", "")
        outcome = None

        for attempt in range(max_retries + 1):
            if control.cancel.is_set():
                return None
            result["attempts"] = result.get("attempts", 0) + 1
            html_body = template_service.build_personalized_html(
                template.get("html", ""),
                template.get("design"),
                company,
                sender_name,
                sender_email,
                subject,
                github_url,
            )
            plain_body = build_plain_text(html_body) or subject
            message = EmailService.build_message(
                sender_email, sender_name, email, subject, html_body, plain_body
            )
            outcome = service.send_one(message)
            if outcome.status != "failed" or not outcome.retryable:
                return outcome
            if attempt < max_retries:
                if retry_delay:
                    self._interruptible_sleep(retry_delay, control)
                    if control.cancel.is_set():
                        return None
                else:
                    time.sleep(0)
        return outcome


campaign_service = None  # wired in app.py after settings_service exists
