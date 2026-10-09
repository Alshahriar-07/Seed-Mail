"""Seed Code Mail — local send worker (FastAPI).

Run it on the machine that owns the Gmail account:

    python worker/main.py

Every endpoint except the two health probes requires a valid Supabase access
token from the signed-in user, verified against Supabase Auth — so a user id is
never taken from the request body. The Gmail App Password never leaves this
process: it is read from the worker host's environment (managed through the
Settings page, which sends it straight here and nowhere else).

Locally it binds to 127.0.0.1; a hosted deployment sets WORKER_HOST=0.0.0.0 and
restricts access with the WORKER_ALLOWED_ORIGINS allow-list plus the token check.

Deployment: this process is designed to run on a host that keeps it alive
(Render / Railway / Fly.io / a small VM / Docker) — NOT on Vercel, which cannot
run a long-lived SMTP consumer. When SUPABASE_SERVICE_ROLE_KEY is present it also
starts the durable queue consumer in-process (worker/queue_worker.py), so one
deployment both serves the API and sends queued campaigns.

Endpoints
    GET    /api/worker/health                  (no auth)
    GET    /api/worker/status                  (auth)
    GET    /api/worker/queue/status            (auth)
    PUT    /api/worker/settings                (auth)
    POST   /api/worker/settings/reset          (auth)
    POST   /api/worker/test-smtp               (auth)
    POST   /api/worker/campaigns/start         (auth)
    POST   /api/worker/campaigns/{id}/pause    (auth)
    POST   /api/worker/campaigns/{id}/resume   (auth)
    POST   /api/worker/campaigns/{id}/cancel   (auth)
    GET    /api/worker/campaigns/{id}          (auth)
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Import the existing, tested business logic. Running this file directly
# (`python worker/main.py`) puts `worker/` on sys.path, so make the project root
# importable as well.
import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

# The worker's configuration (Gmail credentials, Supabase project, bind address,
# allowed origins) lives in the project's .env file, exactly as documented in
# the README. Nothing else loads that file into the process environment, so do
# it here before the first os.getenv() call. Real environment variables win
# (override=False), which keeps shell/Vercel-provided values authoritative.
load_dotenv(dotenv_path=ROOT / ".env", override=False)

from services.email_service import EmailService  # noqa: E402
from services.settings_service import settings_service  # noqa: E402
from worker import config  # noqa: E402
from worker.auth import AuthError, TokenVerifier  # noqa: E402

# Make console output UTF-8 safe before anything is printed. Without this the
# startup banner could kill the process on a cp1252 Windows console, which the
# browser then reports as an unreachable worker.
config.configure_console_encoding()
from worker.campaign_queue import (  # noqa: E402
    QueueError,
    WorkerQueue,
    queue_configured,
    supabase_url,
)
from worker.sender import CampaignManager  # noqa: E402
from worker.settings_overrides import SettingsOverrides  # noqa: E402
from worker.supabase_client import SupabaseRest  # noqa: E402

VERSION = "2.1.0"

# How long a heartbeat counts as "the consumer is alive". The consumer reports
# every poll, so three missed cycles means something is genuinely wrong.
HEARTBEAT_FRESH_SECONDS = 90
_HEARTBEAT_CACHE_SECONDS = 10.0

DEFAULT_ORIGINS = [
    # Vite dev server and preview
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    # Local build served by app.py (start.bat)
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    # Deployed sites. Production is HTTPS-only (the platform answers an
    # http:// request with a 308 redirect to https://), so the browser origin
    # that reaches the worker is always the https one.
    "https://mrseedmail.vercel.app",
    # Beta is kept deliberately, for testing against the beta deployment.
    "https://seedmail-beta.vercel.app",
]


def allowed_origins() -> list[str]:
    raw = os.getenv("WORKER_ALLOWED_ORIGINS", "").strip()
    if not raw:
        return list(DEFAULT_ORIGINS)
    return [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]


class SettingsIn(BaseModel):
    model_config = {"extra": "ignore"}

    Email: str | None = None
    SENDER_NAME: str | None = None
    GITHUB_URL: str | None = None
    SMTP_HOST: str | None = None
    SMTP_PORT: int | None = None
    SEND_DELAY_SECONDS: int | None = None
    SMTP_TIMEOUT_SECONDS: int | None = None
    MAX_RETRIES: int | None = None
    RETRY_DELAY_SECONDS: int | None = None
    GAPP_PASS: str | None = None


class TestSmtpIn(BaseModel):
    model_config = {"extra": "ignore"}

    Email: str | None = None
    SENDER_NAME: str | None = None
    GITHUB_URL: str | None = None
    SMTP_HOST: str | None = None
    SMTP_PORT: int | None = None
    SMTP_TIMEOUT_SECONDS: int | None = None


class CampaignStartIn(BaseModel):
    model_config = {"extra": "ignore"}

    campaign_id: str = Field(min_length=1, max_length=64)
    name: str = ""
    subject: str = Field(min_length=1, max_length=200)
    sender_name: str | None = None
    sender_email: str | None = None
    github_url: str | None = None
    smtp_host: str | None = None
    smtp_port: int | None = None
    smtp_timeout_seconds: int | None = None
    send_delay_seconds: int | None = None
    max_retries: int | None = None
    retry_delay_seconds: int | None = None
    # Local template document. It is held in memory for this run only and is
    # never written to Supabase.
    template_html: str = ""
    template_design: dict[str, Any] | None = None
    recipients: list[dict[str, Any]] = Field(default_factory=list, max_length=5000)
    counters: dict[str, int] | None = None


def create_app(
    *,
    settings=None,
    rest_factory=None,
    service=None,
    verifier: TokenVerifier | None = None,
    manager: CampaignManager | None = None,
    origins: list[str] | None = None,
    queue=None,
) -> FastAPI:
    settings = settings or settings_service
    # Configuration is resolved through worker.config so the accepted variable
    # names (and the "is this really set?" rule) are identical everywhere. The
    # environment is read at app-construction time, so a changed value needs a
    # worker restart — which the health/status payloads make obvious.
    supabase_url = config.supabase_url()
    publishable_key = config.supabase_publishable_key()

    if rest_factory is None:  # pragma: no cover - trivial wiring
        rest_factory = lambda token: SupabaseRest(supabase_url, publishable_key, token)
    if verifier is None:
        verifier = TokenVerifier()  # reads worker.config
    if service is None:
        service = CampaignManager(settings, rest_factory)
    if manager is None:
        manager = service  # `service` is accepted as an alias for tests

    app = FastAPI(
        title="Seed Code Mail — send worker",
        version=VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins or allowed_origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def require_user(request: Request) -> dict[str, Any]:
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        try:
            return verifier.verify(token)
        except AuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc))

    def access_token(request: Request) -> str:
        header = request.headers.get("authorization", "")
        return header[7:].strip() if header.lower().startswith("bearer ") else ""

    # -- queue / consumer availability ------------------------------------
    #
    # Availability is read from the heartbeat rows the consumer writes, so it
    # reflects the real remote worker rather than an optimistic guess. The
    # result is cached briefly so the unauthenticated health probe stays cheap.

    heartbeat_cache: dict[str, Any] = {"at": 0.0, "value": None}

    def queue_client():
        if queue is not None:
            return queue
        if not queue_configured():
            return None
        try:
            return WorkerQueue()
        except QueueError:
            return None

    def consumer_availability() -> dict[str, Any]:
        import time as _time

        now = _time.monotonic()
        cached = heartbeat_cache.get("value")
        if cached is not None and now - heartbeat_cache["at"] < _HEARTBEAT_CACHE_SECONDS:
            return cached

        if not queue_configured() and queue is None:
            # No service-role key: this deployment cannot consume the queue.
            value = {
                "configured": False,
                "consumer_online": False,
                "last_seen_at": None,
                "workers": [],
                "queued": 0,
                "running": 0,
                "detail": "SUPABASE_SERVICE_ROLE_KEY is not set on the worker host.",
            }
        else:
            client = queue_client()
            value = {
                "configured": True,
                "consumer_online": False,
                "last_seen_at": None,
                "workers": [],
                "queued": 0,
                "running": 0,
                "detail": "",
            }
            try:
                beats = client.heartbeats(within_seconds=HEARTBEAT_FRESH_SECONDS)
                value["workers"] = [str(b.get("worker_id", "")) for b in beats]
                value["last_seen_at"] = beats[0].get("last_seen_at") if beats else None
                value["consumer_online"] = bool(beats)
                value["queued"] = client.queued_count()
                value["running"] = client.running_count()
                if not beats:
                    value["detail"] = (
                        "No send worker has reported in the last "
                        f"{HEARTBEAT_FRESH_SECONDS}s. Start the worker service, or check its logs."
                    )
            except QueueError as exc:
                value["detail"] = str(exc)

        heartbeat_cache["at"] = now
        heartbeat_cache["value"] = value
        return value

    # -- health ----------------------------------------------------------

    @app.get("/api/worker/health")
    def health() -> dict[str, Any]:
        availability = consumer_availability()
        # Secret-free configuration diagnostics. They name the variables that
        # must be set and where — the information that was missing when the
        # "not configured" error was the only clue an operator had.
        diagnostics = config.diagnose()
        return {
            "ok": True,
            "app": "Seed Code Mail send worker",
            "version": VERSION,
            "supabase_configured": diagnostics["auth_configured"],
            # True only when this worker can verify a signed-in user's token.
            "auth_configured": diagnostics["auth_configured"],
            "smtp_configured": settings.has_password and bool(settings.get("Email", "")),
            # Booleans only: this endpoint is unauthenticated.
            "queue_consumer_configured": bool(availability["configured"]),
            "queue_consumer_online": bool(availability["consumer_online"]),
            # Which of the two roles this process can actually perform. Reading
            # and sending ordinary mail does not depend on either of these;
            # campaign delivery needs the queue consumer.
            "capabilities": {
                "verify_users": diagnostics["auth_configured"],
                "campaign_queue": diagnostics["queue_configured"],
                "gmail_api": diagnostics["gmail_api_configured"],
            },
            "import_hygiene_ok": diagnostics["import_hygiene_ok"],
            "configuration_problems": diagnostics["problems"],
        }

    # -- status ----------------------------------------------------------

    @app.get("/api/worker/status")
    def status(_user: dict = Depends(require_user)) -> dict[str, Any]:
        active = manager.active()
        return {
            "configured": settings.has_password and bool(settings.get("Email", "")),
            "has_password": settings.has_password,
            "sender_email": settings.get("Email", ""),
            "sender_name": settings.get("SENDER_NAME", ""),
            "host": settings.get("SMTP_HOST", ""),
            "port": settings.get_int("SMTP_PORT", 465),
            "sending": bool(active),
            "active_campaign_id": active.get("campaign_id") if active else None,
            "current_recipient": active.get("current_recipient") if active else None,
            # Real queue availability for the signed-in user.
            "queue": consumer_availability(),
            "version": VERSION,
        }

    @app.get("/api/worker/queue/status")
    def queue_status(_user: dict = Depends(require_user)) -> dict[str, Any]:
        return {"ok": True, **consumer_availability()}

    # -- settings --------------------------------------------------------

    @app.put("/api/worker/settings")
    def save_settings(payload: SettingsIn, _user: dict = Depends(require_user)) -> dict[str, Any]:
        data = payload.model_dump(exclude_none=True)
        if not data:
            return settings.public()
        try:
            return settings.update(data)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/worker/settings/reset")
    def reset_settings(_user: dict = Depends(require_user)) -> dict[str, Any]:
        return settings.reset_non_secret()

    # -- SMTP diagnostics ------------------------------------------------

    @app.post("/api/worker/test-smtp")
    def test_smtp(payload: TestSmtpIn, _user: dict = Depends(require_user)) -> dict[str, Any]:
        """Connect and authenticate only — never sends an email.

        The submitted values are used for this test alone and are not persisted.
        """
        overrides = {
            "Email": payload.Email,
            "SENDER_NAME": payload.SENDER_NAME,
            "GITHUB_URL": payload.GITHUB_URL,
            "SMTP_HOST": payload.SMTP_HOST,
            "SMTP_PORT": payload.SMTP_PORT,
            "SMTP_TIMEOUT_SECONDS": payload.SMTP_TIMEOUT_SECONDS,
        }
        view = SettingsOverrides(settings, overrides)
        return EmailService(view).test_connection()

    # -- campaigns -------------------------------------------------------

    @app.post("/api/worker/campaigns/start")
    def start_campaign(
        payload: CampaignStartIn, request: Request, _user: dict = Depends(require_user)
    ) -> dict[str, Any]:
        body = payload.model_dump()
        try:
            state = manager.start(access_token(request), body)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"ok": True, **state}

    @app.post("/api/worker/campaigns/{campaign_id}/pause")
    def pause_campaign(campaign_id: str, request: Request, _user: dict = Depends(require_user)) -> dict[str, Any]:
        try:
            return {"ok": True, **manager.pause(access_token(request), campaign_id)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    @app.post("/api/worker/campaigns/{campaign_id}/resume")
    def resume_campaign(campaign_id: str, request: Request, _user: dict = Depends(require_user)) -> dict[str, Any]:
        try:
            return {"ok": True, **manager.resume(access_token(request), campaign_id)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    @app.post("/api/worker/campaigns/{campaign_id}/cancel")
    def cancel_campaign(campaign_id: str, request: Request, _user: dict = Depends(require_user)) -> dict[str, Any]:
        try:
            return {"ok": True, **manager.cancel(access_token(request), campaign_id)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    @app.get("/api/worker/campaigns/{campaign_id}")
    def campaign_state(campaign_id: str, _user: dict = Depends(require_user)) -> dict[str, Any]:
        state = manager.get(campaign_id)
        if state is None:
            raise HTTPException(status_code=404, detail="No run is in progress for this campaign in this worker.")
        return {"ok": True, **state}

    return app


app = create_app()


def start_queue_consumer_thread() -> threading.Thread | None:
    """Runs the durable queue consumer inside this process, when configured.

    One deployment then serves the API *and* sends queued campaigns. Set
    WORKER_QUEUE_CONSUMER=0 to run the API alone (for example when the consumer
    runs as a separate service/process).
    """
    if os.getenv("WORKER_QUEUE_CONSUMER", "1").strip() in ("0", "false", "no"):
        print("  Queue consumer: disabled by WORKER_QUEUE_CONSUMER")
        return None
    if not queue_configured():
        print("  Queue consumer: not configured (SUPABASE_SERVICE_ROLE_KEY missing)")
        print("  Campaigns cannot be sent until it is set. See README -> Deploying the send worker.")
        return None

    from worker.queue_worker import build_consumer

    try:
        consumer = build_consumer()
    except QueueError as exc:  # pragma: no cover - configuration guard
        print(f"  Queue consumer: {exc}")
        return None

    thread = threading.Thread(target=consumer.run_forever, name="queue-consumer", daemon=True)
    thread.start()
    print(f"  Queue consumer: running as {consumer.worker_id}")
    return thread


def print_configuration() -> None:
    """Show, at startup, exactly which roles this process can perform.

    The original failure mode was silent: the worker started fine and only said
    something when a request arrived. Printing it here means a misconfigured
    worker host is obvious from its logs. No value is ever printed.
    """
    diagnostics = config.diagnose()
    mark = lambda ok: "ok  " if ok else "MISSING"  # noqa: E731 - terse by design
    print("  Configuration (from this process's environment):")
    print(f"    [{mark(diagnostics['supabase_url_set'])}] SUPABASE_URL")
    print(f"    [{mark(diagnostics['supabase_publishable_key_set'])}] SUPABASE_PUBLISHABLE_KEY")
    print(f"    [{mark(diagnostics['supabase_service_role_key_set'])}] SUPABASE_SERVICE_ROLE_KEY")
    print(
        "  Capabilities: "
        f"verify_users={diagnostics['auth_configured']}, "
        f"campaign_queue={diagnostics['queue_configured']}, "
        f"gmail_api={diagnostics['gmail_api_configured']}, "
        f"import_hygiene={diagnostics['import_hygiene_ok']}"
    )
    for problem in diagnostics["problems"]:
        print(f"  ! {problem}")
    if not diagnostics["auth_configured"]:
        print(
            "  ! Signed-in requests will be rejected with HTTP 401 until "
            "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are set here."
        )


def run() -> None:
    import uvicorn

    # Refuse to serve from a package that shadows the standard library. Without
    # this the process starts, prints a healthy banner, and answers 500 to every
    # request — the exact silent failure `worker/queue.py` used to cause. Failing
    # loudly here turns a mysterious outage into an obvious, named problem.
    hygiene_problem = config.import_hygiene_problem()
    if hygiene_problem:
        print("=" * 66)
        print("  Seed Code Mail — send worker cannot start")
        print(f"  {hygiene_problem}")
        print("=" * 66)
        raise SystemExit(2)

    # Local runs stay on the loopback interface; a hosted deployment sets
    # WORKER_HOST=0.0.0.0 explicitly (see README -> Deploying the send worker).
    host = os.getenv("WORKER_HOST", "127.0.0.1")
    port = int(os.getenv("WORKER_PORT", "8765") or "8765")
    public = host not in ("127.0.0.1", "localhost")
    print("=" * 66)
    print("  Seed Code Mail — send worker")
    print(f"  Listening on http://{host}:{port}" + ("  (reachable from the deployed site)" if public else "  (this machine only)"))
    print("  Campaign email is sent from here; the website only queues campaigns.")
    print_configuration()
    print("  Press Ctrl+C to stop.")
    print("=" * 66)
    start_queue_consumer_thread()
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    run()
