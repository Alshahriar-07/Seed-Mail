"""Tests for the send worker.

SMTP is fully mocked and Supabase is replaced with an in-memory recorder, so
these tests never open a socket and never send an email.

They cover exactly what the browser relies on:
  * the health probe is public, everything else requires a valid token;
  * a campaign run sends sequentially and persists progress;
  * a definite transient failure is retried within the configured bound;
  * an "unknown" outcome is recorded but never retried (no duplicate emails);
  * "sent" is only ever recorded from the SMTP outcome, never from HTTP 200;
  * cancellation stops the run and marks it cancelled.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.email_service import SendOutcome  # noqa: E402
from worker.auth import AuthError  # noqa: E402
from worker.main import create_app  # noqa: E402
from worker.sender import CampaignManager, RunState  # noqa: E402

VALID_TOKEN = "test-token"
SENT = SendOutcome("sent", "ok", "Accepted by the SMTP server.")


class FakeSettings:
    def __init__(self, **overrides):
        self.values = {
            "Email": "sender@example.com",
            "GAPP_PASS": "abcd efgh ijkl mnop",
            "SENDER_NAME": "Sender",
            "GITHUB_URL": "",
            "SMTP_HOST": "smtp.gmail.com",
            "SMTP_PORT": "465",
            "SEND_DELAY_SECONDS": "0",
            "SMTP_TIMEOUT_SECONDS": "30",
            "MAX_RETRIES": "0",
            "RETRY_DELAY_SECONDS": "0",
        }
        self.values.update({k: str(v) for k, v in overrides.items()})

    def get(self, key, default=""):
        return self.values.get(key, default)

    def get_int(self, key, default):
        try:
            return int(self.values.get(key, default))
        except (TypeError, ValueError):
            return default

    def get_float(self, key, default):
        try:
            return float(self.values.get(key, default))
        except (TypeError, ValueError):
            return default

    @property
    def has_password(self):
        return bool(self.values.get("GAPP_PASS", "").strip())

    def raw(self):
        return dict(self.values)

    def public(self):
        data = {k: v for k, v in self.values.items() if k != "GAPP_PASS"}
        return {"values": data, "has_password": self.has_password, "email": self.values.get("Email", ""),
                "sender_name": self.values.get("SENDER_NAME", "")}

    def update(self, payload):
        # Mirror the validation the real SettingsService performs, without
        # touching any file on disk.
        if payload.get("SMTP_PORT") is not None:
            port = int(payload["SMTP_PORT"] or 0)
            if not (1 <= port <= 65535):
                raise ValueError("SMTP port must be between 1 and 65535.")
        for key, value in payload.items():
            if key == "GAPP_PASS" and not str(value).strip():
                continue
            self.values[key] = str(value)
        return self.public()

    def reset_non_secret(self):
        return self.public()


class FakeVerifier:
    def __init__(self):
        self.seen = []

    def verify(self, token):
        self.seen.append(token)
        if token == VALID_TOKEN:
            return {"id": "11111111-1111-1111-1111-111111111111", "email": "user@example.com"}
        raise AuthError("Your session is invalid or has expired. Sign in again.")


class FakeRest:
    """Records every REST call the runner makes."""

    def __init__(self):
        self.updates = []
        self.inserts = []

    def select(self, *_args, **_kwargs):
        return []

    def insert(self, table, payload, returning=False):
        self.inserts.append((table, payload))
        return []

    def update(self, table, filters, payload):
        self.updates.append((table, filters, payload))
        return []

    def delete(self, *_args, **_kwargs):
        return []

    def campaign_statuses(self):
        return [payload.get("status") for table, _f, payload in self.updates if table == "campaigns"]

    def history(self):
        return [payload for table, payload in self.inserts if table == "email_history"]


class FakeMail:
    """Stand-in for EmailService; records messages instead of sending them."""

    def __init__(self, outcomes=None, on_send=None):
        self.outcomes = list(outcomes or [])
        self.on_send = on_send
        self.messages = []

    def send_one(self, message):
        self.messages.append(message)
        if self.on_send:
            self.on_send(len(self.messages))
        if self.outcomes:
            return self.outcomes.pop(0)
        return SENT


def build_app(settings=None, mail=None, rest=None):
    settings = settings or FakeSettings()
    rest = rest or FakeRest()
    mail = mail or FakeMail()
    manager = CampaignManager(
        settings,
        rest_factory=lambda _token: rest,
        email_factory=lambda _settings: mail,
        sleep=lambda _seconds: None,
    )
    app = create_app(
        settings=settings,
        rest_factory=lambda _token: rest,
        verifier=FakeVerifier(),
        service=manager,
        origins=["http://localhost:5173"],
    )
    return TestClient(app), manager, rest, mail


def auth_header(token=VALID_TOKEN):
    return {"Authorization": f"Bearer {token}"}


def recipient(index, email=None):
    return {
        "job_id": f"00000000-0000-0000-0000-00000000000{index}",
        "recipient_id": f"11111111-0000-0000-0000-00000000000{index}",
        "company_name": f"Company {index}",
        "email": email or f"recipient{index}@example.com",
    }


def start_payload(**overrides):
    payload = {
        "campaign_id": "22222222-2222-2222-2222-222222222222",
        "name": "Test campaign",
        "subject": "Hello from Seed Code Mail",
        "template_html": "<h2>Hi {{COMPANY_NAME}}</h2><p>{{SENDER_NAME}}</p>",
        "template_design": {},
        "recipients": [recipient(1), recipient(2)],
    }
    payload.update(overrides)
    return payload


def wait_for_finish(manager, campaign_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = manager.get(campaign_id)
        if state and state["status"] in ("completed", "cancelled", "paused"):
            return state
        time.sleep(0.02)
    raise AssertionError("the campaign run did not finish in time")


# --- authentication ---------------------------------------------------------

def test_health_is_public():
    client, *_ = build_app()
    response = client.get("/api/worker/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


@pytest.mark.parametrize("method,path", [
    ("get", "/api/worker/status"),
    ("get", "/api/worker/campaigns/abc"),
    ("post", "/api/worker/campaigns/start"),
    ("post", "/api/worker/campaigns/abc/pause"),
    ("post", "/api/worker/campaigns/abc/resume"),
    ("post", "/api/worker/campaigns/abc/cancel"),
    ("post", "/api/worker/test-smtp"),
    ("put", "/api/worker/settings"),
    ("post", "/api/worker/settings/reset"),
])
def test_private_endpoints_require_a_token(method, path):
    client, *_ = build_app()
    response = client.request(method.upper(), path, json={})
    assert response.status_code == 401


def test_invalid_token_is_rejected():
    client, *_ = build_app()
    response = client.get("/api/worker/status", headers=auth_header("wrong-token"))
    assert response.status_code == 401
    assert "sign in" in response.json()["detail"].lower()


def test_status_reports_configuration_without_leaking_the_password():
    client, *_ = build_app()
    body = client.get("/api/worker/status", headers=auth_header()).json()
    assert body["has_password"] is True
    assert body["configured"] is True
    assert body["sender_email"] == "sender@example.com"
    assert "GAPP_PASS" not in body
    assert "abcd efgh ijkl mnop" not in str(body)


def test_settings_endpoint_never_returns_the_password():
    settings = FakeSettings()
    client, *_ = build_app(settings=settings)
    response = client.put("/api/worker/settings", json={"GAPP_PASS": "new-app-password"}, headers=auth_header())
    assert response.status_code == 200
    assert "new-app-password" not in response.text
    assert settings.values["GAPP_PASS"] == "new-app-password"


def test_settings_endpoint_rejects_invalid_values():
    client, *_ = build_app()
    response = client.put("/api/worker/settings", json={"SMTP_PORT": 0}, headers=auth_header())
    assert response.status_code == 400


def test_test_smtp_without_a_password_reports_configuration_error():
    # No password configured -> the check returns before any socket is opened.
    client, *_ = build_app(settings=FakeSettings(GAPP_PASS=""))
    body = client.post("/api/worker/test-smtp", json={}, headers=auth_header()).json()
    assert body["ok"] is False
    assert body["category"] == "configuration"


# --- campaign execution -----------------------------------------------------

def test_campaign_sends_sequentially_and_persists_progress():
    client, manager, rest, mail = build_app()
    response = client.post("/api/worker/campaigns/start", json=start_payload(), headers=auth_header())
    assert response.status_code == 200
    campaign_id = response.json()["campaign_id"]

    state = wait_for_finish(manager, campaign_id)
    assert state["status"] == "completed"
    assert state["counters"]["sent"] == 2
    assert state["counters"]["pending"] == 0

    assert len(mail.messages) == 2
    assert [m["To"] for m in mail.messages] == ["recipient1@example.com", "recipient2@example.com"]

    history = rest.history()
    assert len(history) == 2
    assert all(entry["status"] == "sent" for entry in history)
    assert all("app-password" not in entry["error_message"] for entry in history)

    # jobs are updated individually and the campaign ends up completed
    job_updates = [payload for table, _f, payload in rest.updates if table == "campaign_recipients"]
    assert [update["status"] for update in job_updates] == ["sent", "sent"]
    assert "completed" in rest.campaign_statuses()


def test_personalisation_uses_the_per_campaign_subject_and_company():
    client, manager, _rest, mail = build_app()
    client.post("/api/worker/campaigns/start", json=start_payload(), headers=auth_header())
    wait_for_finish(manager, "22222222-2222-2222-2222-222222222222")

    assert mail.messages[0]["Subject"] == "Hello from Seed Code Mail"
    body = mail.messages[0].get_body("plain").get_payload(decode=True).decode("utf-8")
    assert "Company 1" in body
    assert "{{COMPANY_NAME}}" not in body
    assert "Sender" in body


def test_retryable_failure_is_retried_then_recorded():
    mail = FakeMail(outcomes=[
        SendOutcome("failed", "connection", "SMTP connection timed out."),
        SendOutcome("sent", "ok", "Accepted by the SMTP server."),
    ])
    client, manager, rest, _mail = build_app(settings=FakeSettings(MAX_RETRIES=1, RETRY_DELAY_SECONDS=0), mail=mail)
    client.post("/api/worker/campaigns/start", json=start_payload(recipients=[recipient(1)]), headers=auth_header())
    state = wait_for_finish(manager, "22222222-2222-2222-2222-222222222222")

    assert state["counters"]["sent"] == 1
    assert len(mail.messages) == 2  # one retry
    job_update = [p for t, _f, p in rest.updates if t == "campaign_recipients"][0]
    assert job_update["attempts"] == 2


def test_unknown_outcome_is_recorded_but_never_retried():
    mail = FakeMail(outcomes=[SendOutcome("unknown", "disconnected", "Connection dropped during submission; outcome unknown.")])
    client, manager, rest, _mail = build_app(settings=FakeSettings(MAX_RETRIES=3), mail=mail)
    client.post("/api/worker/campaigns/start", json=start_payload(recipients=[recipient(1)]), headers=auth_header())
    state = wait_for_finish(manager, "22222222-2222-2222-2222-222222222222")

    assert state["counters"]["unknown"] == 1
    assert len(mail.messages) == 1, "an unknown outcome must not be retried (duplicate risk)"
    assert rest.history()[0]["status"] == "unknown"


def test_non_retryable_failure_is_not_retried():
    mail = FakeMail(outcomes=[SendOutcome("failed", "authentication", "Authentication failed.")])
    client, manager, rest, _mail = build_app(settings=FakeSettings(MAX_RETRIES=3), mail=mail)
    client.post("/api/worker/campaigns/start", json=start_payload(recipients=[recipient(1)]), headers=auth_header())
    wait_for_finish(manager, "22222222-2222-2222-2222-222222222222")

    assert len(mail.messages) == 1
    assert rest.history()[0]["status"] == "failed"


def test_start_requires_a_configured_password():
    client, *_ = build_app(settings=FakeSettings(GAPP_PASS=""))
    response = client.post("/api/worker/campaigns/start", json=start_payload(), headers=auth_header())
    assert response.status_code == 400
    assert "App Password" in response.json()["detail"]


def test_start_rejects_an_empty_queue():
    client, *_ = build_app()
    response = client.post("/api/worker/campaigns/start", json=start_payload(recipients=[]), headers=auth_header())
    assert response.status_code == 400


def test_cancellation_stops_the_run():
    holder = {}

    def cancel_after_first(count):
        if count == 1:
            holder["manager"].cancel(VALID_TOKEN, "22222222-2222-2222-2222-222222222222")

    mail = FakeMail(on_send=cancel_after_first)
    client, manager, _rest, _mail = build_app(mail=mail)
    holder["manager"] = manager

    client.post("/api/worker/campaigns/start", json=start_payload(recipients=[recipient(1), recipient(2)]), headers=auth_header())
    state = wait_for_finish(manager, "22222222-2222-2222-2222-222222222222")

    assert state["status"] == "cancelled"
    assert len(mail.messages) == 1, "no further emails after cancellation"


def test_pause_and_resume_endpoints_require_a_live_run():
    client, *_ = build_app()
    assert client.post("/api/worker/campaigns/does-not-exist/pause", headers=auth_header()).status_code == 404
    assert client.post("/api/worker/campaigns/does-not-exist/cancel", headers=auth_header()).status_code == 404


def test_paused_run_waits_for_resume():
    state = RunState("c", {"total": 1, "processed": 0, "sent": 0, "failed": 0, "unknown": 0, "pending": 1})
    manager = CampaignManager(FakeSettings(), rest_factory=lambda _t: FakeRest(), sleep=lambda _s: None)
    state.resume.clear()

    def release():
        time.sleep(0.05)
        state.resume.set()

    thread = threading.Thread(target=release)
    thread.start()
    started = time.monotonic()
    assert manager._wait_if_paused(state) is True
    thread.join()
    assert time.monotonic() - started >= 0.02

    state.cancel.set()
    assert manager._wait_if_paused(state) is False


def test_resume_is_exposed_for_the_browser():
    client, manager, _rest, mail = build_app()
    client.post("/api/worker/campaigns/start", json=start_payload(recipients=[recipient(1)]), headers=auth_header())
    wait_for_finish(manager, "22222222-2222-2222-2222-222222222222")
    response = client.post("/api/worker/campaigns/22222222-2222-2222-2222-222222222222/resume", headers=auth_header())
    assert response.status_code == 200
    assert response.json()["ok"] is True
