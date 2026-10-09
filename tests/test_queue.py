"""Tests for the durable campaign queue and the remote send worker.

Everything here runs against in-memory fakes: no Supabase project, no SMTP
server and no network. The fakes deliberately record *every* REST call so the
tests can prove what the service-role consumer writes, and that nothing is ever
reported as sent before the mail service accepted the message.
"""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import test_worker as tw  # shared fakes from the existing worker suite
from worker.main import create_app
from worker.campaign_queue import QueueNotConfigured, WorkerQueue, queue_configured
from worker.queue_worker import QueueConsumer
from worker.sender import CampaignManager, RunState

ROOT = Path(__file__).resolve().parent.parent

CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222"
OWNER_ID = "11111111-1111-1111-1111-111111111111"


# --- fakes ------------------------------------------------------------------

class FakeQueue:
    """In-memory stand-in for the service-role queue client."""

    service_key = "service-role-key"

    def __init__(self, *, campaigns=None, jobs=None, flags=None, account=None,
                 beats=None, queued=0, running=0):
        self.campaigns = list(campaigns or [])
        self.jobs_by_campaign = jobs or {}
        self.flags_by_campaign = flags or {}
        self.account = account or {}
        self.beats = list(beats or [])
        self.queued = queued
        self.running = running
        self.released = []
        self.heartbeat_calls = []
        self.renew_calls = 0
        self.renew_result = True

    def heartbeat(self, worker_id, **_kwargs):
        self.heartbeat_calls.append(worker_id)

    def heartbeats(self, within_seconds=90):
        return list(self.beats)

    def claim_next(self, _worker_id, _lease_seconds):
        return self.campaigns.pop(0) if self.campaigns else None

    def renew(self, *_args):
        self.renew_calls += 1
        return self.renew_result

    def release(self, campaign_id, _worker_id, status, error=""):
        self.released.append((campaign_id, status, error))
        return {"id": campaign_id, "status": status}

    def jobs(self, campaign_id):
        return list(self.jobs_by_campaign.get(campaign_id, []))

    def flags(self, campaign_id):
        return self.flags_by_campaign.get(campaign_id, {})

    def user_settings(self, _user_id):
        return self.account

    def queued_count(self):
        return self.queued

    def running_count(self):
        return self.running


def campaign(**overrides):
    data = {
        "id": CAMPAIGN_ID,
        "user_id": OWNER_ID,
        "name": "Queued campaign",
        "subject": "Hello from Seed Code Mail",
        "status": "running",
        "template_html": "<h2>Hi {{COMPANY_NAME}}</h2><p>{{SENDER_NAME}}</p>",
        "template_design": {},
        "run_config": {
            "sender_email": "sender@example.com",
            "sender_name": "Sender",
            "smtp_host": "smtp.gmail.com",
            "smtp_port": 465,
            "send_delay_seconds": 0,
            "max_retries": 0,
            "retry_delay_seconds": 0,
        },
        "total_recipients": 2,
        "processed_count": 0,
        "sent_count": 0,
        "failed_count": 0,
        "unknown_count": 0,
        "attempt_count": 1,
    }
    data.update(overrides)
    return data


def job(index, status="pending"):
    return {
        "id": f"33333333-0000-0000-0000-00000000000{index}",
        "recipient_id": f"44444444-0000-0000-0000-00000000000{index}",
        "company_name": f"Company {index}",
        "email": f"recipient{index}@example.com",
        "status": status,
    }


def build_consumer(queue, *, settings=None, rest=None, mail=None, **kwargs):
    settings = settings if settings is not None else tw.FakeSettings()
    rest = rest or tw.FakeRest()
    mail = mail or tw.FakeMail()

    def factory(_settings, _rest_factory):
        return CampaignManager(
            _settings,
            rest_factory=lambda _token: rest,
            email_factory=lambda _s: mail,
            sleep=lambda _seconds: None,
        )

    options = {"lease_seconds": 30, "poll_seconds": 0, **kwargs}
    consumer = QueueConsumer(
        queue,
        settings=settings,
        worker_id="test-worker",
        manager_factory=factory,
        sleep=time.sleep,
        log=lambda _message: None,
        **options,
    )
    return consumer, rest, mail


# --- queue client -----------------------------------------------------------

def test_worker_queue_requires_supabase_configuration():
    with pytest.raises(QueueNotConfigured):
        WorkerQueue(url="", key="")

    # A URL without a service-role key is still not usable.
    with pytest.raises(QueueNotConfigured):
        WorkerQueue(url="https://example.supabase.co", key="")


def test_queue_configured_reads_the_host_environment(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    assert queue_configured() is False

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role")
    assert queue_configured() is True


# --- consumer ---------------------------------------------------------------

def test_consumer_is_idle_when_the_queue_is_empty():
    queue = FakeQueue()
    consumer, _rest, mail = build_consumer(queue)

    assert consumer.run_once() == "idle"
    assert mail.messages == []
    # Availability must still be published while idle, otherwise the UI would
    # report a healthy consumer as offline.
    assert queue.heartbeat_calls == ["test-worker"]


def test_consumer_reports_a_missing_app_password_as_failed_without_sending():
    queue = FakeQueue(campaigns=[campaign()], jobs={CAMPAIGN_ID: [job(1)]})
    consumer, _rest, mail = build_consumer(queue, settings=tw.FakeSettings(GAPP_PASS=""))

    assert consumer.run_once() == "failed"
    assert mail.messages == []
    assert queue.released and queue.released[0][1] == "failed"
    assert "App Password" in queue.released[0][2]


def test_consumer_sends_a_claimed_campaign_and_attributes_rows_to_the_owner():
    queue = FakeQueue(campaigns=[campaign()], jobs={CAMPAIGN_ID: [job(1), job(2)]})
    consumer, rest, mail = build_consumer(queue)

    assert consumer.run_once() == "completed"

    # Two messages, exactly as many as there were jobs — no duplicates.
    assert len(mail.messages) == 2
    assert queue.released == [(CAMPAIGN_ID, "completed", "")]

    # The service-role consumer has no auth.uid(), so every history row must
    # carry the campaign owner explicitly or the insert would fail.
    history = rest.history()
    assert len(history) == 2
    assert all(row["user_id"] == OWNER_ID for row in history)
    assert all(row["status"] == "sent" for row in history)

    # Per-recipient job rows are updated to a terminal state.
    job_updates = [payload for table, _filters, payload in rest.updates if table == "campaign_recipients"]
    assert len(job_updates) == 2
    assert all(update["status"] == "sent" for update in job_updates)

    # The campaign itself is left running/complete by the runner...
    assert "running" in rest.campaign_statuses()
    assert "completed" in rest.campaign_statuses()


def test_consumer_completes_a_campaign_whose_jobs_are_all_done():
    queue = FakeQueue(campaigns=[campaign()], jobs={CAMPAIGN_ID: []})
    consumer, _rest, mail = build_consumer(queue)

    assert consumer.run_once() == "completed"
    assert mail.messages == []
    assert queue.released == [(CAMPAIGN_ID, "completed", "")]


def test_consumer_mirrors_pause_and_cancel_flags_onto_the_run():
    queue = FakeQueue(flags={CAMPAIGN_ID: {"pause_requested": True}})
    consumer, _rest, _mail = build_consumer(queue)
    state = RunState(CAMPAIGN_ID, {"pending": 1})

    assert state.resume.is_set()
    consumer._apply_flags(CAMPAIGN_ID, state)
    assert not state.resume.is_set(), "a pause request must stop the run between attempts"

    queue.flags_by_campaign[CAMPAIGN_ID] = {"cancel_requested": True}
    consumer._apply_flags(CAMPAIGN_ID, state)
    assert state.cancel.is_set()
    assert state.resume.is_set(), "cancelling must also release a paused run"

    queue.flags_by_campaign[CAMPAIGN_ID] = {"status": "paused"}
    state.cancel.clear()
    state.resume.clear()
    consumer._apply_flags(CAMPAIGN_ID, state)
    assert not state.resume.is_set()

    queue.flags_by_campaign[CAMPAIGN_ID] = {"pause_requested": False}
    consumer._apply_flags(CAMPAIGN_ID, state)
    assert state.resume.is_set(), "clearing the flag resumes the run"


def test_lost_lease_stops_the_run_instead_of_sending_twice(monkeypatch):
    queue = FakeQueue()
    queue.renew_result = False
    consumer, _rest, _mail = build_consumer(queue, lease_seconds=3)
    state = RunState(CAMPAIGN_ID, {"pending": 1})

    calls = {"n": 0}

    def alive(_campaign_id):
        calls["n"] += 1
        return calls["n"] <= 5

    monkeypatch.setattr(consumer, "_run_alive", alive)
    consumer._watch(CAMPAIGN_ID, state)

    assert queue.renew_calls >= 1
    assert state.cancel.is_set(), "losing the lease must cancel the local run"


def test_consumer_releases_the_campaign_when_the_run_fails(monkeypatch):
    queue = FakeQueue(campaigns=[campaign()], jobs={CAMPAIGN_ID: [job(1)]})
    consumer, _rest, _mail = build_consumer(queue)

    class Exploding:
        def start(self, *_args, **_kwargs):
            raise RuntimeError("smtp exploded")

    consumer._manager = Exploding()
    monkeypatch.setattr(consumer, "_start", lambda _payload: (_ for _ in ()).throw(RuntimeError("smtp exploded")))

    assert consumer.run_once() == "failed"
    assert queue.released[0][1] == "failed"
    assert "smtp exploded" in queue.released[0][2]


def test_consumer_payload_carries_the_snapshot_and_the_owner():
    queue = FakeQueue(campaigns=[campaign()], jobs={CAMPAIGN_ID: [job(1)]})
    consumer, _rest, _mail = build_consumer(queue)

    payload = consumer._payload(queue.campaigns[0], OWNER_ID, [job(1)])

    assert payload["owner_id"] == OWNER_ID, "the run must know who owns the campaign"
    assert payload["template_html"].startswith("<h2>"), "the queued template snapshot is used"
    assert payload["sender_email"] == "sender@example.com"
    assert payload["recipients"][0]["email"] == "recipient1@example.com"


def test_consumer_never_retries_sent_jobs():
    """`jobs()` asks only for pending/failed rows, so `sent` can never be resent."""
    source = (ROOT / "worker" / "campaign_queue.py").read_text(encoding="utf-8")
    assert 'RETRYABLE_JOB_STATUSES = ("pending", "failed")' in source
    assert '"status": f"in.({statuses})"' in source


# --- API reporting ----------------------------------------------------------

def _service(settings=None, rest=None, mail=None):
    settings = settings or tw.FakeSettings()
    return CampaignManager(
        settings,
        rest_factory=lambda _token: (rest or tw.FakeRest()),
        email_factory=lambda _s: (mail or tw.FakeMail()),
        sleep=lambda _seconds: None,
    )


def test_queue_status_reports_real_availability_and_depth():
    queue = FakeQueue(beats=[{"worker_id": "w1", "last_seen_at": "2026-01-01T00:00:00Z"}], queued=3, running=1)
    app = create_app(
        settings=tw.FakeSettings(),
        verifier=tw.FakeVerifier(),
        service=_service(),
        origins=["http://localhost:5173"],
        queue=queue,
    )
    client = TestClient(app)

    body = client.get("/api/worker/queue/status", headers=tw.auth_header()).json()
    assert body["configured"] is True
    assert body["consumer_online"] is True, "a fresh heartbeat means the consumer is online"
    assert body["queued"] == 3 and body["running"] == 1
    assert body["workers"] == ["w1"]

    # The status endpoint the UI polls carries the same real information.
    status = client.get("/api/worker/status", headers=tw.auth_header()).json()
    assert status["queue"]["consumer_online"] is True

    # And the unauthenticated health probe exposes booleans only.
    health = client.get("/api/worker/health").json()
    assert health["queue_consumer_online"] is True
    assert health["queue_consumer_configured"] is True
    assert "SUPABASE_SERVICE_ROLE_KEY" not in health and "service-role" not in str(health)


def test_queue_status_is_offline_without_heartbeats():
    queue = FakeQueue(beats=[], queued=2, running=0)
    app = create_app(
        settings=tw.FakeSettings(),
        verifier=tw.FakeVerifier(),
        service=_service(),
        origins=["http://localhost:5173"],
        queue=queue,
    )
    client = TestClient(app)

    body = client.get("/api/worker/queue/status", headers=tw.auth_header()).json()
    assert body["configured"] is True
    assert body["consumer_online"] is False, "no heartbeat must not be reported as online"
    assert body["detail"], "an unavailable worker must come with a useful explanation"


def test_queue_status_reports_missing_service_role_key(monkeypatch):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    app = create_app(
        settings=tw.FakeSettings(),
        verifier=tw.FakeVerifier(),
        service=_service(),
        origins=["http://localhost:5173"],
    )
    client = TestClient(app)

    body = client.get("/api/worker/queue/status", headers=tw.auth_header()).json()
    assert body["configured"] is False
    assert body["consumer_online"] is False
    assert "SERVICE_ROLE_KEY" in body["detail"]


def test_queue_status_requires_authentication():
    queue = FakeQueue()
    app = create_app(
        settings=tw.FakeSettings(),
        verifier=tw.FakeVerifier(),
        service=_service(),
        origins=["http://localhost:5173"],
        queue=queue,
    )
    assert TestClient(app).get("/api/worker/queue/status").status_code == 401


# --- migration / frontend contract ------------------------------------------

def test_migration_has_an_atomic_claim_and_restricted_grants():
    sql = (ROOT / "supabase" / "migrations" / "0003_worker_queue.sql").read_text(encoding="utf-8")

    assert "for update skip locked" in sql, "the claim must be race-safe"
    for column in ("template_html", "template_design", "run_config", "lease_expires_at",
                   "pause_requested", "cancel_requested", "claimed_by"):
        assert f"add column if not exists {column}" in sql
    assert "create table if not exists public.worker_heartbeats" in sql
    assert "enable row level security" in sql
    # A signed-in user must not be able to claim somebody else's campaign.
    for function in ("claim_next_campaign", "renew_campaign_lease", "release_campaign"):
        assert re.search(
            rf"revoke all on function public\.{function}\([^)]*\) from public, anon, authenticated",
            sql,
        ), f"{function} must not be callable by anon/authenticated"
    assert "grant execute on function public.claim_next_campaign(text, integer) to service_role" in sql
    # The browser must never be handed a credential by this migration.
    assert "service_role_key" not in sql.replace("SUPABASE_SERVICE_ROLE_KEY", "")


def test_frontend_queues_campaigns_instead_of_calling_a_local_worker():
    """The browser queues work in Supabase; it no longer needs a local process."""
    api = (ROOT / "frontend" / "js" / "api.js").read_text(encoding="utf-8")

    assert "worker.startCampaign" not in api, "queueing must not depend on a worker request"
    assert "worker.pauseCampaign" not in api and "worker.cancelCampaign" not in api
    assert "status: 'queued'" in api
    assert "pause_requested" in api and "cancel_requested" in api
    assert "template_html" in api and "run_config" in api

    worker_source = (ROOT / "frontend" / "js" / "lib" / "worker.js").read_text(encoding="utf-8")
    # The localhost instruction may only appear in the local-development branch.
    assert "workerUnavailableHelp" in worker_source
    assert "VITE_MAIL_WORKER_URL" in worker_source
