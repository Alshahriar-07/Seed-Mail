"""Tests for the local agent's request protections (``worker/security.py``).

The agent listens on a loopback port on the user's own computer, and a loopback
port is reachable by any page the user has open. These tests pin the three
controls that make that safe, and the one compatibility requirement that makes
the agent usable from the deployed site at all:

  * a request from an origin that is not allowed is refused (CSRF / a hostile
    page trying to send mail through the agent);
  * a browser request that arrived under a non-loopback Host is refused, which
    is the tell for DNS rebinding;
  * an optional pairing token is required on everything except the public health
    probe — but never on a CORS preflight, which cannot carry header values;
  * Chrome's Private Network Access preflight is answered, or the deployed site
    could not reach the agent in any browser that implements it.

No test opens a socket: SMTP, Supabase and Google are untouched, and the
TestClient only exercises the middleware.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from worker import config, security  # noqa: E402
from worker.auth import AuthError  # noqa: E402
from worker.main import create_app  # noqa: E402

PRODUCTION = "https://mrseedmail.vercel.app"
EVIL = "https://evil.example"
ALLOWED = ["http://127.0.0.1:5173", PRODUCTION]


class FakeVerifier:
    """Accepts exactly one token, so the guard can be tested ahead of auth."""

    def verify(self, token):
        if token == "good-token":
            return {"id": "11111111-1111-1111-1111-111111111111", "email": "user@example.com"}
        raise AuthError("Your session is invalid or has expired. Sign in again.")


@pytest.fixture()
def loopback_env(monkeypatch):
    """A default local agent: loopback bind, no pairing token."""
    monkeypatch.delenv("WORKER_HOST", raising=False)
    monkeypatch.delenv("WORKER_AGENT_TOKEN", raising=False)
    return monkeypatch


# --- pure helpers -----------------------------------------------------------

def test_loopback_hosts_are_recognised_including_the_whole_127_range():
    for host in ("127.0.0.1", "127.0.0.1:8765", "localhost", "localhost:8765", "::1", "[::1]:8765", "127.0.0.53"):
        assert security.host_is_loopback(host) is True, host
    for host in ("evil.example", "evil.example:8765", "mrseedmail.vercel.app", "10.0.0.5", ""):
        assert security.host_is_loopback(host) is False, host


def test_allowed_origin_matching_is_exact_and_case_insensitive():
    assert security.is_allowed_origin(PRODUCTION, ALLOWED) is True
    assert security.is_allowed_origin("https://MRSEEDMAIL.vercel.app/", ALLOWED) is True
    assert security.is_allowed_origin(EVIL, ALLOWED) is False
    # A truncated or prefixed host must not match by substring.
    assert security.is_allowed_origin("https://mrseedmail.vercel.app.evil.example", ALLOWED) is False


def test_an_absent_origin_is_not_a_browser_and_is_allowed_through():
    # curl, a monitoring probe or a test: there is nothing to describe, and the
    # endpoint's own token check still applies.
    assert security.is_allowed_origin("", ALLOWED) is True
    assert security.is_allowed_origin(None, ALLOWED) is True


def test_a_null_origin_is_refused():
    # A sandboxed frame or a data: URL reports `Origin: null`. It is never this
    # application.
    assert security.is_allowed_origin("null", ALLOWED) is False


def test_origin_problem_reports_dns_rebinding_separately_from_a_bad_origin():
    rebinding = security.origin_problem(
        origin=PRODUCTION, host="evil.example:8765", allowed_origins=ALLOWED, loopback_bind=True
    )
    assert "Host header" in rebinding

    bad_origin = security.origin_problem(
        origin=EVIL, host="127.0.0.1:8765", allowed_origins=ALLOWED, loopback_bind=True
    )
    assert "not allowed" in bad_origin

    assert security.origin_problem(
        origin=PRODUCTION, host="127.0.0.1:8765", allowed_origins=ALLOWED, loopback_bind=True
    ) == ""


def test_a_non_loopback_bind_does_not_impose_the_host_rule():
    # A hosted worker behind a proxy legitimately sees a service hostname.
    assert security.origin_problem(
        origin=PRODUCTION, host="seed-mail-worker.onrender.com", allowed_origins=ALLOWED, loopback_bind=False
    ) == ""


def test_pairing_token_is_optional_and_compared_exactly():
    assert security.token_problem(None, "") == ""
    assert security.token_problem("anything", "") == ""
    assert security.token_problem("secret", "secret") == ""
    assert "requires a pairing token" in security.token_problem("", "secret")
    assert "not correct" in security.token_problem("wrong", "secret")


# --- through the HTTP layer -------------------------------------------------

def test_a_hostile_origin_is_refused_before_anything_else_runs(loopback_env):
    # Origin is not on the allow-list, so the request never reaches the health
    # handler — and no CORS header is returned, so the page cannot read why.
    client = TestClient(create_app(verifier=FakeVerifier(), origins=ALLOWED))
    response = client.get("/api/worker/health", headers={"Origin": EVIL})
    assert response.status_code == 403
    assert "access-control-allow-origin" not in {key.lower() for key in response.headers}


def test_the_deployed_site_may_reach_the_loopback_agent(loopback_env):
    client = TestClient(create_app(verifier=FakeVerifier(), origins=ALLOWED))
    response = client.get(
        "/api/worker/health", headers={"Origin": PRODUCTION, "Host": "127.0.0.1:8765"}
    )
    assert response.status_code == 200
    assert response.json()["agent"] is True


def test_a_browser_request_under_another_hostname_is_refused(loopback_env):
    # Same allowed origin, but the Host says the socket was reached by a name
    # that is not this machine: the DNS-rebinding case.
    client = TestClient(create_app(verifier=FakeVerifier(), origins=ALLOWED))
    response = client.get(
        "/api/worker/health", headers={"Origin": PRODUCTION, "Host": "evil.example:8765"}
    )
    assert response.status_code == 403
    assert "Host header" in response.json()["detail"]


def test_private_network_access_preflight_is_answered(loopback_env):
    # Without this header Chrome blocks an https page from reaching loopback
    # before the request is sent, so the agent would be silently unreachable.
    client = TestClient(create_app(verifier=FakeVerifier(), origins=ALLOWED))
    response = client.options(
        "/api/worker/status",
        headers={
            "Origin": PRODUCTION,
            "Host": "127.0.0.1:8765",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert response.status_code in (200, 204)
    assert response.headers.get("access-control-allow-private-network") == "true"


def test_pairing_leaves_the_health_probe_open_but_guards_everything_else(loopback_env):
    loopback_env.setenv("WORKER_AGENT_TOKEN", "the-pairing-secret")
    client = TestClient(create_app(verifier=FakeVerifier(), origins=ALLOWED))

    # Detection must work before pairing, otherwise the user could never learn
    # that a token is needed.
    health = client.get("/api/worker/health", headers={"Origin": PRODUCTION, "Host": "127.0.0.1:8765"})
    assert health.status_code == 200
    assert health.json()["pairing_required"] is True

    unpaired = client.get("/api/worker/status", headers={"Origin": PRODUCTION, "Host": "127.0.0.1:8765"})
    assert unpaired.status_code == 403
    assert "pairing token" in unpaired.json()["detail"]

    wrong = client.get(
        "/api/worker/status",
        headers={"Origin": PRODUCTION, "Host": "127.0.0.1:8765", "X-Seedmail-Agent-Token": "nope"},
    )
    assert wrong.status_code == 403

    paired = client.get(
        "/api/worker/status",
        headers={
            "Origin": PRODUCTION,
            "Host": "127.0.0.1:8765",
            "X-Seedmail-Agent-Token": "the-pairing-secret",
            "Authorization": "Bearer good-token",
        },
    )
    # Passed the guard, and then authenticated by the verifier.
    assert paired.status_code == 200
    assert paired.json()["agent"] is True


def test_a_preflight_is_never_blocked_by_pairing(loopback_env):
    # A preflight carries header *names*, never values, so it can never present
    # the token. Refusing it would break pairing entirely.
    loopback_env.setenv("WORKER_AGENT_TOKEN", "the-pairing-secret")
    client = TestClient(create_app(verifier=FakeVerifier(), origins=ALLOWED))
    response = client.options(
        "/api/worker/settings",
        headers={
            "Origin": PRODUCTION,
            "Host": "127.0.0.1:8765",
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "authorization,content-type,x-seedmail-agent-token",
        },
    )
    assert response.status_code in (200, 204)
    allowed_headers = response.headers.get("access-control-allow-headers", "").lower()
    assert "x-seedmail-agent-token" in allowed_headers


def test_status_reports_the_agent_shape_and_no_run_yet(loopback_env):
    client = TestClient(create_app(verifier=FakeVerifier(), origins=ALLOWED))
    body = client.get(
        "/api/worker/status",
        headers={
            "Origin": PRODUCTION,
            "Host": "127.0.0.1:8765",
            "Authorization": "Bearer good-token",
        },
    ).json()
    assert body["agent"] is True
    assert body["pairing_required"] is False
    assert body["last_run"] is None
    # No credential is ever echoed.
    assert "GAPP_PASS" not in body


def test_a_hosted_bind_does_not_require_a_loopback_host(loopback_env):
    loopback_env.setenv("WORKER_HOST", "0.0.0.0")
    client = TestClient(create_app(verifier=FakeVerifier(), origins=ALLOWED))
    response = client.get(
        "/api/worker/health",
        headers={"Origin": PRODUCTION, "Host": "seed-mail-worker.onrender.com"},
    )
    assert response.status_code == 200
    assert response.json()["bind_loopback"] is False
