"""Tests for the local agent's reported run outcome and its .env location.

Two behaviours the Local Agent panel depends on:

  * ``CampaignManager.last_finished()`` — the *record* behind "Sending completed"
    and "Sending failed". It must be None until this process has actually
    finished a run, and it must not claim success when recipients failed.
  * ``services.storage.BASE_DIR`` — where `.env` lives. A packaged agent
    (build-agent.bat) must read and write that file next to its executable, not
    inside the bundle, or the Settings page would write configuration the
    startup loader never sees.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services import storage  # noqa: E402
from worker.auth import AuthError  # noqa: E402
from worker.main import create_app  # noqa: E402
from worker.sender import CANCELLED, COMPLETED, PAUSED, RUNNING, CampaignManager, RunState  # noqa: E402

PRODUCTION = "https://mrseedmail.vercel.app"


# --- last_finished ----------------------------------------------------------

def make_manager() -> CampaignManager:
    # `settings`/`rest_factory` are only touched by start(), which these tests do
    # not call: the run state is constructed directly.
    return CampaignManager(settings=None, rest_factory=lambda _token: None)


def finished_state(campaign_id: str, *, status: str, when: str, failed: int = 0) -> RunState:
    state = RunState(campaign_id, {"total": 1, "pending": 0, "sent": 1 - failed, "failed": failed, "processed": 1})
    state.status = status
    state.finished_at = when
    return state


def test_no_run_has_finished_yet():
    assert make_manager().last_finished() is None


def test_a_completed_run_with_no_failures_is_reported_as_ok():
    manager = make_manager()
    manager._runs["c1"] = finished_state("c1", status=COMPLETED, when="2026-10-10T10:00:00+00:00")
    latest = manager.last_finished()
    assert latest["campaign_id"] == "c1"
    assert latest["status"] == COMPLETED
    assert latest["ok"] is True
    assert latest["finished_at"] == "2026-10-10T10:00:00+00:00"


def test_a_completed_run_with_failures_is_not_reported_as_ok():
    manager = make_manager()
    manager._runs["c1"] = finished_state("c1", status=COMPLETED, when="2026-10-10T10:00:00+00:00", failed=2)
    assert manager.last_finished()["ok"] is False


def test_a_cancelled_run_is_finished_but_not_ok():
    manager = make_manager()
    manager._runs["c1"] = finished_state("c1", status=CANCELLED, when="2026-10-10T10:00:00+00:00")
    latest = manager.last_finished()
    assert latest["status"] == CANCELLED
    assert latest["ok"] is False


def test_the_most_recent_terminal_run_wins():
    manager = make_manager()
    manager._runs["older"] = finished_state("older", status=COMPLETED, when="2026-10-10T09:00:00+00:00")
    manager._runs["newer"] = finished_state("newer", status=COMPLETED, when="2026-10-10T11:00:00+00:00")
    assert manager.last_finished()["campaign_id"] == "newer"


def test_a_running_or_paused_run_is_not_a_finished_run():
    manager = make_manager()
    running = finished_state("running", status=RUNNING, when="")
    paused = finished_state("paused", status=PAUSED, when="")
    manager._runs["running"] = running
    manager._runs["paused"] = paused
    # A paused run is still live and will resume, so nothing is reported yet.
    assert manager.last_finished() is None


# --- the status endpoint ----------------------------------------------------

class StubManager:
    """A manager that only answers the two things /status asks for."""

    def active(self):
        return None

    def last_finished(self):
        return {
            "campaign_id": "c1",
            "status": COMPLETED,
            "ok": True,
            "finished_at": "2026-10-10T10:00:00+00:00",
            "counters": {"failed": 0},
        }


class FakeVerifier:
    def verify(self, token):
        if token == "good-token":
            return {"id": "11111111-1111-1111-1111-111111111111", "email": "user@example.com"}
        raise AuthError("Your session is invalid or has expired. Sign in again.")


def test_status_exposes_the_last_run_outcome():
    client = TestClient(create_app(verifier=FakeVerifier(), manager=StubManager(), origins=[PRODUCTION]))
    body = client.get(
        "/api/worker/status",
        headers={"Origin": PRODUCTION, "Host": "127.0.0.1:8765", "Authorization": "Bearer good-token"},
    ).json()
    assert body["last_run"]["ok"] is True
    assert body["sending"] is False


def test_status_tolerates_a_manager_that_cannot_report_a_last_run():
    class Minimal:
        def active(self):
            return None

    client = TestClient(create_app(verifier=FakeVerifier(), manager=Minimal(), origins=[PRODUCTION]))
    body = client.get(
        "/api/worker/status",
        headers={"Origin": PRODUCTION, "Host": "127.0.0.1:8765", "Authorization": "Bearer good-token"},
    ).json()
    assert body["last_run"] is None


# --- .env location ----------------------------------------------------------

def test_env_lives_in_the_project_root_normally():
    assert storage.BASE_DIR == Path(storage.__file__).resolve().parent.parent
    assert storage.ENV_FILE == storage.BASE_DIR / ".env"


def test_a_frozen_build_uses_the_executable_directory(tmp_path, monkeypatch):
    exe = tmp_path / "SeedMailAgent.exe"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))
    reloaded = importlib.reload(storage)
    try:
        assert reloaded.BASE_DIR == tmp_path
        # The value the Settings page writes and the startup loader reads.
        assert reloaded.ENV_FILE == tmp_path / ".env"
    finally:
        monkeypatch.undo()
        importlib.reload(storage)
    # Reloading back leaves the rest of the suite on the project-relative paths.
    assert storage.BASE_DIR == Path(storage.__file__).resolve().parent.parent
