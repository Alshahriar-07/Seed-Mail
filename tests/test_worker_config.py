"""Tests for the worker's runtime configuration.

These cover the failure this project had in production: the worker answering
every authenticated request with

    "The worker is not configured with SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY,
     so it cannot verify signed-in users."

The cause is environmental (the worker host was missing the two variables), so
the tests pin the *contract* instead of the outcome:

  * the accepted variable names (including the aliases Supabase itself uses);
  * that a blank or placeholder value counts as unset, not as configuration;
  * that the 401 message names the variable that is actually missing;
  * that the health probe reports what the process can really do, without ever
    returning a value.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
from worker import config  # noqa: E402
from worker.auth import TokenVerifier, configuration_error  # noqa: E402
from worker.main import create_app  # noqa: E402


@pytest.fixture()
def clean_env(monkeypatch):
    """Start from an environment with none of the relevant names set."""
    for name in (
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_ANON_KEY",
        "SUPABASE_PUBLISHABLE_OR_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SECRET_KEY",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GMAIL_TOKEN_ENCRYPTION_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


# --- reading values ---------------------------------------------------------

def test_publishable_key_accepts_the_anon_alias(clean_env):
    clean_env.setenv("SUPABASE_URL", "https://example.supabase.co")
    clean_env.setenv("SUPABASE_ANON_KEY", "real-anon-key")
    assert config.supabase_publishable_key() == "real-anon-key"
    assert config.auth_configured() is True


def test_publishable_key_wins_over_the_alias_when_both_are_set(clean_env):
    clean_env.setenv("SUPABASE_URL", "https://example.supabase.co")
    clean_env.setenv("SUPABASE_PUBLISHABLE_KEY", "publishable")
    clean_env.setenv("SUPABASE_ANON_KEY", "anon")
    assert config.supabase_publishable_key() == "publishable"


def test_quotes_and_whitespace_are_trimmed(clean_env):
    clean_env.setenv("SUPABASE_URL", '  "https://example.supabase.co"  ')
    assert config.supabase_url() == "https://example.supabase.co"


@pytest.mark.parametrize("value", ["", "   ", "your-key-here", "<your-key>", "TODO", "changeme"])
def test_placeholder_values_are_treated_as_unset(clean_env, value):
    clean_env.setenv("SUPABASE_URL", "https://example.supabase.co")
    clean_env.setenv("SUPABASE_PUBLISHABLE_KEY", value)
    assert config.supabase_publishable_key() == ""
    assert config.auth_configured() is False


def test_vite_prefixed_names_are_never_read(clean_env):
    """The browser's Vite variables are public build-time values, not worker config."""
    clean_env.setenv("VITE_SUPABASE_URL", "https://example.supabase.co")
    clean_env.setenv("VITE_SUPABASE_PUBLISHABLE_KEY", "browser-key")
    assert config.supabase_url() == ""
    assert config.supabase_publishable_key() == ""
    assert config.auth_configured() is False


def test_service_role_accepts_the_secret_key_alias(clean_env):
    clean_env.setenv("SUPABASE_URL", "https://example.supabase.co")
    clean_env.setenv("SUPABASE_SECRET_KEY", "service-secret")
    assert config.service_role_key() == "service-secret"
    assert config.queue_configured() is True


# --- diagnostics ------------------------------------------------------------

def test_diagnose_names_every_missing_variable(clean_env):
    diagnostics = config.diagnose()
    assert diagnostics["auth_configured"] is False
    assert diagnostics["queue_configured"] is False
    joined = " ".join(diagnostics["problems"])
    assert "SUPABASE_URL" in joined
    assert "SUPABASE_PUBLISHABLE_KEY" in joined
    assert "SUPABASE_SERVICE_ROLE_KEY" in joined
    # A VITE_ value must not be presented as a way to satisfy the worker.
    assert "VITE_" in joined


def test_diagnose_is_clean_when_everything_is_set(clean_env):
    clean_env.setenv("SUPABASE_URL", "https://example.supabase.co")
    clean_env.setenv("SUPABASE_PUBLISHABLE_KEY", "publishable")
    clean_env.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
    diagnostics = config.diagnose()
    assert diagnostics["problems"] == []
    assert diagnostics["auth_configured"] is True
    assert diagnostics["queue_configured"] is True


def test_diagnose_never_returns_a_value(clean_env):
    clean_env.setenv("SUPABASE_URL", "https://example.supabase.co")
    clean_env.setenv("SUPABASE_PUBLISHABLE_KEY", "super-secret-publishable")
    clean_env.setenv("SUPABASE_SERVICE_ROLE_KEY", "super-secret-service")
    rendered = str(config.diagnose())
    assert "super-secret-publishable" not in rendered
    assert "super-secret-service" not in rendered


# --- verification behaviour -------------------------------------------------

def test_configuration_error_names_only_the_missing_variable(clean_env):
    clean_env.setenv("SUPABASE_URL", "https://example.supabase.co")
    message = configuration_error()
    assert "SUPABASE_PUBLISHABLE_KEY" in message
    # The URL *is* set, so it must not be blamed.
    assert "SUPABASE_URL is not set" not in message
    assert "VITE_" in message


def test_unconfigured_verifier_rejects_every_token(clean_env):
    verifier = TokenVerifier()
    assert verifier.configured is False
    with pytest.raises(Exception) as excinfo:
        verifier.verify("any-token")
    assert "SUPABASE_PUBLISHABLE_KEY" in str(excinfo.value)


def test_verifier_prefers_the_process_environment(clean_env):
    clean_env.setenv("SUPABASE_URL", "https://example.supabase.co")
    clean_env.setenv("SUPABASE_PUBLISHABLE_KEY", "publishable")
    assert TokenVerifier().configured is True


def test_health_reports_capabilities_and_problems_without_values(clean_env):
    clean_env.setenv("SUPABASE_URL", "https://example.supabase.co")
    clean_env.setenv("SUPABASE_PUBLISHABLE_KEY", "publishable-secret-value")
    app = create_app(origins=["http://localhost:5173"])
    body = TestClient(app).get("/api/worker/health").json()

    assert body["auth_configured"] is True
    assert body["capabilities"]["verify_users"] is True
    # The service-role key is absent, so campaign delivery is reported as off.
    assert body["capabilities"]["campaign_queue"] is False
    assert any("SUPABASE_SERVICE_ROLE_KEY" in problem for problem in body["configuration_problems"])
    assert "publishable-secret-value" not in str(body)


def test_health_reports_an_unconfigured_worker_honestly(clean_env):
    app = create_app(origins=["http://localhost:5173"])
    body = TestClient(app).get("/api/worker/health").json()
    assert body["ok"] is True  # the process is alive ...
    assert body["auth_configured"] is False  # ... but it cannot verify users
    assert len(body["configuration_problems"]) >= 2


# --- import hygiene ---------------------------------------------------------
#
# `python worker/main.py` puts worker/ first on sys.path. A module file there
# named after a stdlib module silently replaces it process-wide, which is how
# every endpoint came to answer HTTP 500 while the worker looked healthy.


def test_no_worker_module_shadows_the_standard_library():
    assert config.shadowed_stdlib_modules() == []
    assert config.import_hygiene_problem() == ""


def test_health_reports_import_hygiene(clean_env):
    app = create_app(origins=["http://localhost:5173"])
    body = TestClient(app).get("/api/worker/health").json()
    assert body["import_hygiene_ok"] is True


def test_queue_resolves_to_the_standard_library_with_worker_on_path():
    """The regression itself: `import queue` must never find worker/queue.py.

    This is checked in a subprocess with the worker directory first on
    sys.path, which is exactly how `python worker/main.py` runs. anyio's
    `from queue import Queue` is then executed for real, because that import
    failure is what turned every request into a 500.
    """
    import subprocess

    worker_dir = str(ROOT / "worker")
    script = (
        "import sys, os; sys.path.insert(0, sys.argv[1]); "
        "import queue; "
        "resolved = os.path.realpath(queue.__file__); "
        "assert os.path.dirname(resolved) != os.path.realpath(sys.argv[1]), resolved; "
        "assert os.path.basename(resolved).startswith('queue.'), resolved; "
        "from queue import Queue; "
        "import anyio._backends._asyncio as backend; "
        "assert backend.Queue is Queue\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script, worker_dir],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    assert result.returncode == 0, result.stderr


def test_import_hygiene_check_detects_a_shadowing_module(monkeypatch, tmp_path):
    """The guard has to actually fire, or it proves nothing."""
    fake_package = tmp_path / "worker"
    fake_package.mkdir()
    (fake_package / "queue.py").write_text("MARKER = 'shadow'\n", encoding="utf-8")
    (fake_package / "config.py").write_text("", encoding="utf-8")

    monkeypatch.setattr(config, "__file__", str(fake_package / "config.py"))
    assert config.shadowed_stdlib_modules() == ["queue"]
    problem = config.import_hygiene_problem()
    assert "worker/queue.py" in problem
    assert "sys.path" in problem
