"""Campaign runner for the send worker.

Why this exists as a separate process instead of a Vercel function:

* Gmail SMTP delivery is a long, sequential, stateful job (one connection per
  message, a configurable delay, bounded retries, pause/resume/cancel). Serverless
  functions are short-lived and cannot hold that state.
* The Gmail App Password must never reach the browser bundle or Supabase.

The runner keeps the safety guarantees of the original local application:

* emails are sent one at a time, sequentially, with a configurable delay;
* state is written to Supabase after every attempt;
* a recipient already marked ``sent`` is never resent;
* an ``unknown`` outcome (connection dropped mid-submission) is recorded but
  never retried automatically, to avoid duplicate emails;
* "sent" only ever means the SMTP relay ACCEPTED the message — never inbox
  delivery;
* nothing is sent on startup, and pause/cancel are honoured between attempts.

Progress is written with the user's own access token, so Row Level Security
applies and no service-role key is needed anywhere.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

from services.email_service import EmailService, build_plain_text
from services.template_service import template_service

from worker.settings_overrides import SettingsOverrides, build_overrides

PENDING = "pending"
SENT = "sent"
FAILED = "failed"
UNKNOWN = "unknown"
SKIPPED = "skipped"

RUNNING = "running"
PAUSED = "paused"
COMPLETED = "completed"
CANCELLED = "cancelled"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sanitize(message: Any) -> str:
    """Strip anything that could resemble a credential before it is stored."""
    text = str(message or "")
    for marker in ("GAPP_PASS", "password", "App Password"):
        if marker.lower() in text.lower():
            return "Email could not be submitted (details hidden)."
    return text[:400]


class RunState:
    """Live control + counters for one campaign run."""

    def __init__(self, campaign_id: str, counters: dict[str, int]) -> None:
        self.campaign_id = campaign_id
        self.resume = threading.Event()
        self.resume.set()
        self.cancel = threading.Event()
        self.counters = dict(counters)
        self.status = RUNNING
        self.current_recipient: dict[str, Any] | None = None
        self.error = ""
        self.lock = threading.RLock()

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "campaign_id": self.campaign_id,
                "status": self.status,
                "counters": dict(self.counters),
                "current_recipient": self.current_recipient,
                "error": self.error,
                "sending": self.status == RUNNING,
            }


class CampaignManager:
    def __init__(
        self,
        settings,
        rest_factory: Callable[[str], Any],
        email_factory: Callable[[Any], EmailService] = EmailService,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._settings = settings
        self._rest_factory = rest_factory
        self._email_factory = email_factory
        self._sleep = sleep
        self._runs: dict[str, RunState] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._lock = threading.RLock()

    # -- reads -------------------------------------------------------------

    def get(self, campaign_id: str) -> dict[str, Any] | None:
        with self._lock:
            state = self._runs.get(campaign_id)
        return state.snapshot() if state else None

    def active(self) -> dict[str, Any] | None:
        with self._lock:
            for state in self._runs.values():
                if state.status == RUNNING:
                    return state.snapshot()
        return None

    # -- control -----------------------------------------------------------

    def start(self, access_token: str, payload: dict[str, Any]) -> dict[str, Any]:
        campaign_id = str(payload.get("campaign_id") or "")
        if not campaign_id:
            raise ValueError("campaign_id is required.")
        recipients = payload.get("recipients") or []
        if not recipients:
            raise ValueError("There is nothing left to send in this campaign.")
        if not self._settings.get("GAPP_PASS", "").strip():
            raise ValueError(
                "Configure the Gmail App Password in Settings (it is stored by this worker only) "
                "before sending."
            )

        counters = _initial_counters(payload, len(recipients))

        with self._lock:
            existing_thread = self._threads.get(campaign_id)
            if existing_thread and existing_thread.is_alive():
                # Never spawn a second worker for the same campaign — that would
                # risk duplicate emails, so just unblock the running one.
                state = self._runs[campaign_id]
                state.resume.set()
                state.cancel.clear()
                state.status = RUNNING
                return state.snapshot()

            state = RunState(campaign_id, counters)
            self._runs[campaign_id] = state
            thread = threading.Thread(
                target=self._run,
                args=(state, dict(payload), access_token),
                name=f"campaign-{campaign_id}",
                daemon=True,
            )
            self._threads[campaign_id] = thread
            thread.start()

        return state.snapshot()

    def pause(self, access_token: str, campaign_id: str) -> dict[str, Any]:
        state = self._require(campaign_id)
        state.resume.clear()
        with state.lock:
            if state.status == RUNNING:
                state.status = PAUSED
        self._patch_campaign(access_token, state, status=PAUSED)
        return state.snapshot()

    def resume(self, access_token: str, campaign_id: str) -> dict[str, Any]:
        state = self._require(campaign_id)
        with self._lock:
            thread = self._threads.get(campaign_id)
        if thread and thread.is_alive():
            state.status = RUNNING
            state.resume.set()
            self._patch_campaign(access_token, state, status=RUNNING)
            return state.snapshot()
        # The worker was restarted (or finished): rebuild the queue from the
        # page and start a fresh run. Already-sent recipients are filtered out
        # by the caller, so nothing is resent.
        return self.get(campaign_id) or {"campaign_id": campaign_id, "status": "unknown"}

    def cancel(self, access_token: str, campaign_id: str) -> dict[str, Any]:
        state = self._require(campaign_id)
        state.cancel.set()
        state.resume.set()
        with state.lock:
            if state.status in (RUNNING, PAUSED):
                state.status = CANCELLED
        self._patch_campaign(access_token, state, status=CANCELLED, finished=True)
        return state.snapshot()

    def _require(self, campaign_id: str) -> RunState:
        with self._lock:
            state = self._runs.get(campaign_id)
        if state is None:
            raise KeyError("No run is in progress for this campaign in this worker.")
        return state

    # -- persistence -------------------------------------------------------

    def _patch_campaign(
        self,
        access_token: str,
        state: RunState,
        *,
        status: str,
        finished: bool = False,
        extra: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "status": status,
            "updated_at": _now(),
            "total_recipients": state.counters.get("total", 0),
            "processed_count": state.counters.get("processed", 0),
            "sent_count": state.counters.get("sent", 0),
            "failed_count": state.counters.get("failed", 0),
            "unknown_count": state.counters.get("unknown", 0),
        }
        if finished:
            payload["finished_at"] = _now()
        if extra:
            payload.update(extra)
        self._safe_write(lambda rest: rest.update("campaigns", {"id": state.campaign_id}, payload), access_token)

    def _safe_write(self, action: Callable[[Any], Any], access_token: str) -> None:
        """Persist best-effort: a network blip must not abort the whole run."""
        try:
            rest = self._rest_factory(access_token)
            action(rest)
        except Exception as exc:  # noqa: BLE001 - deliberately non-fatal
            print(f"[worker] could not persist progress: {_sanitize(exc)}")

    # -- the run loop ------------------------------------------------------

    def _run(self, state: RunState, payload: dict[str, Any], access_token: str) -> None:
        campaign_id = state.campaign_id
        # Per-request preferences (sender address, SMTP host/port, timeout) are
        # layered over the worker's own environment; the App Password is only
        # ever read from the worker's environment.
        settings = SettingsOverrides(self._settings, build_overrides(payload))
        send_delay = max(0, settings.get_int("SEND_DELAY_SECONDS", 5))
        max_retries = max(0, settings.get_int("MAX_RETRIES", 2))
        retry_delay = max(0, settings.get_int("RETRY_DELAY_SECONDS", 10))
        sender_email = str(payload.get("sender_email") or settings.get("Email", ""))
        sender_name = str(payload.get("sender_name") or settings.get("SENDER_NAME", ""))
        github_url = str(payload.get("github_url") or settings.get("GITHUB_URL", ""))
        subject = str(payload.get("subject") or "")
        template_html = str(payload.get("template_html") or "")
        design = payload.get("template_design") or {}
        email_service = self._email_factory(settings)

        cancelled = False
        try:
            for recipient in payload["recipients"]:
                if state.cancel.is_set():
                    cancelled = True
                    break
                if not self._wait_if_paused(state):
                    cancelled = True
                    break

                job_id = str(recipient.get("job_id") or "")
                recipient_id = recipient.get("recipient_id")
                company = str(recipient.get("company_name") or "")
                address = str(recipient.get("email") or "")
                if not address:
                    self._record_skipped(state, access_token, job_id, "Recipient has no email address.")
                    continue

                with state.lock:
                    state.current_recipient = {"id": recipient_id, "company_name": company, "email": address}

                outcome, attempts = self._send_with_retries(
                    email_service, state, template_html, design, company, address,
                    subject, sender_name, sender_email, github_url, max_retries, retry_delay,
                )
                if outcome is None:  # cancelled while retrying
                    cancelled = True
                    break

                self._record_outcome(state, access_token, job_id, recipient_id, company, address, subject, outcome, attempts)

                with state.lock:
                    state.current_recipient = None

                self._interruptible_sleep(send_delay, state)

        except Exception as exc:  # noqa: BLE001 - the run must always persist its final state
            with state.lock:
                state.error = _sanitize(exc)
        finally:
            with state.lock:
                state.current_recipient = None
                if cancelled or state.cancel.is_set():
                    state.status = CANCELLED
                elif state.counters.get("pending", 0) <= 0:
                    state.status = COMPLETED
                else:
                    state.status = PAUSED
                final_status = state.status
            self._patch_campaign(
                access_token,
                state,
                status=final_status,
                finished=final_status in (COMPLETED, CANCELLED),
            )
            with self._lock:
                self._threads.pop(campaign_id, None)

    def _record_skipped(self, state: RunState, access_token: str, job_id: str, reason: str) -> None:
        with state.lock:
            state.counters["processed"] = state.counters.get("processed", 0) + 1
            state.counters["pending"] = max(0, state.counters.get("pending", 0) - 1)
        if job_id:
            self._safe_write(
                lambda rest: rest.update(
                    "campaign_recipients",
                    {"id": job_id},
                    {"status": SKIPPED, "last_error": reason, "last_attempt_at": _now()},
                ),
                access_token,
            )

    def _record_outcome(
        self, state: RunState, access_token: str, job_id: str, recipient_id: Any,
        company: str, address: str, subject: str, outcome: Any, attempts: int,
    ) -> None:
        status = outcome.status  # sent | failed | unknown
        with state.lock:
            state.counters["processed"] = state.counters.get("processed", 0) + 1
            state.counters["pending"] = max(0, state.counters.get("pending", 0) - 1)
            state.counters[status] = state.counters.get(status, 0) + 1

        def write(rest) -> None:
            if job_id:
                rest.update(
                    "campaign_recipients",
                    {"id": job_id},
                    {
                        "status": status,
                        "attempts": attempts,
                        "last_error_category": outcome.category or "",
                        "last_error": _sanitize(outcome.message),
                        "last_attempt_at": _now(),
                    },
                )
            rest.insert(
                "email_history",
                {
                    "campaign_id": state.campaign_id,
                    "recipient_id": recipient_id,
                    "company_name": company,
                    "email": address,
                    "subject": subject,
                    "status": status,
                    "attempt": attempts,
                    "error_category": outcome.category or "",
                    "error_message": _sanitize(outcome.message),
                },
            )
            if recipient_id:
                rest.update(
                    "recipients",
                    {"id": recipient_id},
                    {"status": status, "last_attempt_at": _now()},
                )

        self._safe_write(write, access_token)
        self._patch_campaign(access_token, state, status=RUNNING)

    def _send_with_retries(
        self, email_service, state: RunState, template_html: str, design: Any,
        company: str, address: str, subject: str, sender_name: str,
        sender_email: str, github_url: str, max_retries: int, retry_delay: int,
    ):
        """Return ``(outcome, attempts)``, or ``(None, attempts)`` if cancelled."""
        attempts = 0
        outcome = None

        for attempt in range(max_retries + 1):
            if state.cancel.is_set():
                return None, attempts
            attempts += 1

            # A fresh document per recipient: the saved template is never
            # mutated and one company's data cannot leak into another's email.
            html_body = template_service.build_personalized_html(
                template_html, design, company, sender_name, sender_email, subject, github_url,
            )
            plain_body = build_plain_text(html_body) or subject
            message = EmailService.build_message(
                sender_email, sender_name, address, subject, html_body, plain_body,
            )
            outcome = email_service.send_one(message)

            if outcome.status != FAILED or not outcome.retryable:
                return outcome, attempts
            if attempt < max_retries and retry_delay:
                self._interruptible_sleep(retry_delay, state)
                if state.cancel.is_set():
                    return None, attempts

        return outcome, attempts

    # -- timing ------------------------------------------------------------

    def _interruptible_sleep(self, seconds: float, state: RunState) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < deadline:
            if state.cancel.is_set():
                return
            remaining = deadline - time.monotonic()
            self._sleep(min(0.2, max(0.0, remaining)))

    def _wait_if_paused(self, state: RunState) -> bool:
        """Block while paused. Returns False when the run was cancelled."""
        while not state.resume.is_set():
            if state.cancel.is_set():
                return False
            self._sleep(0.2)
        return not state.cancel.is_set()


def _initial_counters(payload: dict[str, Any], queue_size: int) -> dict[str, int]:
    stored = payload.get("counters") or {}
    counters = {
        "total": int(stored.get("total") or queue_size),
        "processed": int(stored.get("processed") or 0),
        "sent": int(stored.get("sent") or 0),
        "failed": int(stored.get("failed") or 0),
        "unknown": int(stored.get("unknown") or 0),
        "pending": int(stored.get("pending") or queue_size),
    }
    if counters["total"] < queue_size:
        counters["total"] = queue_size
    if counters["pending"] <= 0:
        counters["pending"] = queue_size
    return counters
