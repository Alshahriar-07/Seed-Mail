"""Pytest fixtures for Seed Code Mail.

Each test runs against temporary, isolated JSON stores and a temporary .env so
no real data or credentials are touched.

The template store is intentionally left **empty**: a fresh installation has no
preloaded templates, so tests create the templates they need.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pytest
from fastapi.testclient import TestClient


def settings_service_module():
    """The settings module (imported lazily so app.py's imports stay untouched)."""
    from services import settings_service as module

    return module


@pytest.fixture()
def isolated(tmp_path, monkeypatch):
    import app as app_module
    from services.history_service import history_service
    from services.recipient_service import recipient_service
    from services.settings_service import settings_service
    from services.template_service import template_service

    # SettingsService reads the process environment for any key a .env file does
    # not define, because a hosted worker has no file to read (see README §3.3).
    # That makes the environment part of the configuration, so a test whose
    # temporary .env is empty must ALSO have an empty environment — otherwise it
    # would silently inherit the developer's real .env, which `worker.main`
    # copies into os.environ via load_dotenv() when an earlier test imports it.
    # Clearing it here is what makes the fixture's promise — "no real data or
    # credentials are touched" — true.
    for name in settings_service_module().environment_names():
        monkeypatch.delenv(name, raising=False)

    settings_service._path = tmp_path / ".env"
    settings_service.reload()

    recipient_service._path = tmp_path / "data.json"
    template_service._path = tmp_path / "templates.json"
    history_service._path = tmp_path / "email_history.json"

    campaign_service = app_module.campaign_service
    campaign_service._path = tmp_path / "campaigns.json"
    campaign_service._campaigns = {}
    campaign_service._controls = {}
    campaign_service._threads = {}
    campaign_service._active_recipients = set()

    # No template is bootstrapped: the store starts empty on purpose.

    return {
        "tmp": tmp_path,
        "app": app_module,
        "settings": settings_service,
        "recipients": recipient_service,
        "templates": template_service,
        "history": history_service,
        "campaigns": campaign_service,
    }


@pytest.fixture(autouse=True)
def drain_campaign_threads():
    """Join any background campaign worker before the next test starts.

    Workers keep running after a pause/cancel is observed, so without this a
    late history write could leak into a later test's isolated store.
    """
    yield
    import app as app_module

    service = app_module.campaign_service
    for thread in list(service._threads.values()):
        if thread.is_alive():
            thread.join(timeout=10)
    service._threads.clear()


@pytest.fixture()
def client(isolated):
    return TestClient(isolated["app"].app)
