"""Seed Code Mail — durable queue consumer (the production send worker).

This is the process that makes campaign sending work without Python running on
the user's computer:

    python -m worker.queue_worker

It polls Supabase for campaigns the website queued, claims one atomically,
runs the existing, tested delivery logic (`worker.sender.CampaignManager`) and
writes progress, per-recipient job state and email history back to Postgres.
Any browser can then read real progress from the database.

It is deliberately boring infrastructure so it can run anywhere that keeps a
process alive (Render / Railway / Fly.io / a small VM / Docker):

* one campaign at a time per process — no parallel sends from one worker;
* an atomic, row-locked claim plus a renewable lease, so two workers can never
  send the same campaign (and a crashed worker's campaign is retried after its
  lease expires);
* pause / resume / cancel are read from the campaign row while the run is in
  progress, so the buttons in the UI work no matter which worker is running it;
* `sent` recipients are never retried and `unknown` outcomes are never retried
  automatically — duplicate emails are worse than a missing one;
* a heartbeat row is published so the API can report *real* availability.

Environment (worker host only — never the browser):
    SUPABASE_URL                 project URL
    SUPABASE_SERVICE_ROLE_KEY    queue + progress writes (keep this secret)
    WORKER_ID                    optional stable name (default host:pid)
    WORKER_LEASE_SECONDS         lease length (default 300)
    WORKER_POLL_SECONDS          idle poll interval (default 5)
    WORKER_ONCE=1                process at most one campaign, then exit
    GAPP_PASS / SMTP_* / Email   the existing worker settings (.env)
"""

from __future__ import annotations

import os
import signal
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(dotenv_path=ROOT / ".env", override=False)

from services.settings_service import settings_service  # noqa: E402
from worker import config  # noqa: E402
from worker.campaign_queue import (  # noqa: E402
    QueueError,
    QueueNotConfigured,
    WorkerQueue,
    queue_configured,
)

# See worker/config.py: keeps an unencodable character in a log line from killing
# the consumer on a non-UTF-8 console.
config.configure_console_encoding()
from worker.sender import COMPLETED, CANCELLED, PAUSED, RUNNING, CampaignManager  # noqa: E402
from worker.supabase_client import SupabaseRest  # noqa: E402

VERSION = "2.1.0"

# The final campaign status the consumer publishes for each terminal run state.
RELEASE_STATUS = {
    RUNNING: "failed",       # a run that stops while still "running" did not finish
    PAUSED: "paused",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
}


def default_worker_id() -> str:
    return os.getenv("WORKER_ID", "").strip() or f"{socket.gethostname()}:{os.getpid()}"


class QueueConsumer:
    """Claims queued campaigns and runs them, one at a time."""

    def __init__(
        self,
        queue: WorkerQueue,
        *,
        settings=None,
        worker_id: str | None = None,
        lease_seconds: int | None = None,
        poll_seconds: float | None = None,
        manager_factory: Callable[[Any, Callable[[str], Any]], Any] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        log: Callable[[str], None] | None = None,
    ) -> None:
        self._queue = queue
        self._settings = settings or settings_service
        self.worker_id = worker_id or default_worker_id()
        self.lease_seconds = int(lease_seconds or os.getenv("WORKER_LEASE_SECONDS", "300") or 300)
        self.poll_seconds = float(poll_seconds if poll_seconds is not None else os.getenv("WORKER_POLL_SECONDS", "5") or 5)
        # The manager is created with a service-role REST factory: the consumer
        # has no user session, and it writes progress for the campaign it owns.
        self._manager_factory = manager_factory or (
            lambda settings, rest_factory: CampaignManager(settings, rest_factory)
        )
        self._sleep = sleep
        self._log = log or (lambda message: print(f"[queue] {message}", flush=True))
        self._stop = threading.Event()
        self._manager: Any = None

    # -- lifecycle ---------------------------------------------------------

    def stop(self) -> None:
        self._stop.set()

    def run_forever(self) -> None:
        self._log(f"worker {self.worker_id} polling every {self.poll_seconds:g}s (lease {self.lease_seconds}s)")
        self._stop.clear()
        while not self._stop.is_set():
            try:
                outcome = self.run_once()
            except QueueNotConfigured as exc:
                self._log(f"configuration missing: {exc}")
                return
            except QueueError as exc:
                self._log(f"queue error (will retry): {exc}")
                outcome = "error"
            if outcome == "idle":
                self._sleep(self.poll_seconds)
        self._log("stopped.")

    # -- one campaign ------------------------------------------------------

    def run_once(self) -> str:
        """Claims and processes at most one campaign.

        Returns ``idle`` when there was nothing to do, otherwise the status the
        campaign was released with.
        """
        self._queue.heartbeat(self.worker_id, version=VERSION, detail={"queued": self._safe_count()})
        campaign = self._queue.claim_next(self.worker_id, self.lease_seconds)
        if not campaign:
            return "idle"

        campaign_id = str(campaign.get("id"))
        owner_id = str(campaign.get("user_id") or "")
        self._log(f"claimed campaign {campaign_id} (attempt {campaign.get('attempt_count')})")

        try:
            jobs = self._queue.jobs(campaign_id)
            if not jobs:
                self._queue.release(campaign_id, self.worker_id, "completed", "")
                self._log(f"campaign {campaign_id} had nothing left to send")
                return "completed"

            if not str(self._settings.get("GAPP_PASS", "")).strip():
                # Configuration missing is a *failed* run, reported accurately —
                # never a fake "sent" and never a silent success.
                message = (
                    "The worker has no Gmail App Password configured, so nothing was sent. "
                    "Add it in Settings (stored by the worker host only)."
                )
                self._queue.release(campaign_id, self.worker_id, "failed", message)
                self._log(f"campaign {campaign_id}: {message}")
                return "failed"

            payload = self._payload(campaign, owner_id, jobs)
            self._start(payload)
            # `start()` returns a JSON snapshot (that is what the HTTP API
            # needs). Pause/resume/cancel live on the campaign's RunState, so
            # read that object back instead of the snapshot.
            self._watch(campaign_id, self._live(campaign_id))
            return self._finish(campaign_id)
        except Exception as exc:  # noqa: BLE001 - never leave a campaign claimed
            message = str(exc)[:400]
            try:
                self._queue.release(campaign_id, self.worker_id, "failed", message)
            except QueueError:
                pass
            self._log(f"campaign {campaign_id} failed: {message}")
            return "failed"

    # -- internals ---------------------------------------------------------

    def _safe_count(self) -> int:
        try:
            return self._queue.queued_count()
        except QueueError:
            return 0

    def _payload(self, campaign: dict[str, Any], owner_id: str, jobs: list[dict[str, Any]]) -> dict[str, Any]:
        """The same shape the HTTP start endpoint accepts, sourced from Postgres."""
        config = campaign.get("run_config") or {}
        account = self._queue.user_settings(owner_id) if owner_id else {}
        return {
            "campaign_id": str(campaign.get("id")),
            # Ownership is recorded so every row the run writes can carry it:
            # the consumer is service-role, so there is no auth.uid() to default to.
            "owner_id": owner_id,
            "name": campaign.get("name") or "",
            "subject": campaign.get("subject") or "",
            "sender_name": config.get("sender_name") or account.get("sender_display_name") or "",
            "sender_email": config.get("sender_email") or account.get("sender_email") or "",
            "github_url": config.get("github_url") or account.get("github_url") or "",
            "smtp_host": config.get("smtp_host") or account.get("smtp_host") or "",
            "smtp_port": config.get("smtp_port") or account.get("smtp_port"),
            "smtp_timeout_seconds": config.get("smtp_timeout_seconds") or account.get("smtp_timeout_seconds"),
            "send_delay_seconds": config.get("send_delay_seconds", account.get("send_delay_seconds")),
            "max_retries": config.get("max_retries", account.get("max_retries")),
            "retry_delay_seconds": config.get("retry_delay_seconds", account.get("retry_delay_seconds")),
            "template_html": campaign.get("template_html") or "",
            "template_design": campaign.get("template_design") or {},
            "counters": {
                "total": campaign.get("total_recipients") or len(jobs),
                "processed": campaign.get("processed_count") or 0,
                "sent": campaign.get("sent_count") or 0,
                "failed": campaign.get("failed_count") or 0,
                "unknown": campaign.get("unknown_count") or 0,
                "pending": len(jobs),
            },
            "recipients": [
                {
                    "job_id": str(job.get("id")),
                    "recipient_id": job.get("recipient_id"),
                    "company_name": job.get("company_name") or "",
                    "email": job.get("email") or "",
                }
                for job in jobs
            ],
        }

    def _start(self, payload: dict[str, Any]) -> Any:
        key = self._queue.service_key  # privileged writes; worker host only
        rest_factory = lambda _token: SupabaseRest(  # noqa: E731 - tiny adapter
            os.getenv("SUPABASE_URL", ""), key, key
        )
        self._manager = self._manager_factory(self._settings, rest_factory)
        return self._manager.start(key, payload)

    def _live(self, campaign_id: str) -> Any:
        """The live RunState for this run, or None if the manager has none."""
        control = getattr(self._manager, "control", None)
        return control(campaign_id) if control else None

    def _watch(self, campaign_id: str, state: Any = None) -> None:
        """Renews the lease and mirrors the UI control flags onto the run."""
        state = state if state is not None else self._live(campaign_id)
        interval = max(2.0, self.lease_seconds / 3.0)
        last_renew = time.monotonic()
        while self._run_alive(campaign_id):
            self._apply_flags(campaign_id, state or self._live(campaign_id))
            now = time.monotonic()
            if now - last_renew >= interval:
                last_renew = now
                if not self._queue.renew(campaign_id, self.worker_id, self.lease_seconds):
                    # Another worker took the lease (this one stalled). Stop
                    # immediately so the campaign cannot be sent twice.
                    self._log(f"lease for {campaign_id} was taken over — stopping this run")
                    live = state or self._live(campaign_id)
                    if live is not None:
                        live.cancel.set()
                        live.resume.set()
                    return
            self._sleep(1.0)

    def _run_alive(self, campaign_id: str) -> bool:
        is_active = getattr(self._manager, "is_active", None)
        if is_active is not None:
            return bool(is_active(campaign_id))
        thread = getattr(self._manager, "_threads", {}).get(campaign_id)
        return bool(thread and thread.is_alive())

    def _apply_flags(self, campaign_id: str, state: Any) -> None:
        if state is None or not hasattr(state, "resume"):
            return
        try:
            flags = self._queue.flags(campaign_id)
        except QueueError:
            return
        if flags.get("cancel_requested") or flags.get("status") == "cancelled":
            state.cancel.set()
            state.resume.set()
            return
        if flags.get("pause_requested") or flags.get("status") == "paused":
            state.resume.clear()
        else:
            state.resume.set()

    def _finish(self, campaign_id: str) -> str:
        snapshot = self._manager.get(campaign_id) or {}
        run_status = snapshot.get("status") or RUNNING
        error = snapshot.get("error") or ""
        status = RELEASE_STATUS.get(run_status, "failed")
        if status == "failed" and not error:
            error = "The run stopped before every recipient was processed. Resume the campaign to continue."
        released = self._queue.release(campaign_id, self.worker_id, status, error)
        self._log(f"campaign {campaign_id} released as {status}")
        return (released or {}).get("status") or status


def build_consumer() -> QueueConsumer:
    if not queue_configured():
        raise QueueNotConfigured(
            "The send worker cannot start without SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY. Set them in the worker host's environment."
        )
    return QueueConsumer(WorkerQueue())


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    once = "--once" in argv or os.getenv("WORKER_ONCE") == "1"
    if not queue_configured():
        print("=" * 66)
        print("  Seed Code Mail — queue consumer cannot start")
        print("  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
        print("  Only the worker host needs the service-role key; keep it secret.")
        print("=" * 66)
        return 2

    consumer = build_consumer()

    def shutdown(_signum, _frame) -> None:
        consumer.stop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, shutdown)
        except (ValueError, OSError):  # pragma: no cover - not on the main thread
            pass

    print("=" * 66)
    print("  Seed Code Mail — send worker (durable queue consumer)")
    print(f"  worker id: {consumer.worker_id}")
    print("  Claims queued campaigns from Supabase and sends them with Gmail SMTP.")
    print("=" * 66)

    if once:
        outcome = consumer.run_once()
        print(f"[queue] single pass: {outcome}")
        return 0 if outcome in ("idle", "completed", "paused", "cancelled") else 1

    consumer.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
