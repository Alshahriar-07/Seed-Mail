"""Seed Code Mail — local send worker (FastAPI).

Run it on the machine that owns the Gmail account:

    python worker/main.py

It binds to 127.0.0.1 only and every endpoint except the health probe requires
a valid Supabase access token from the signed-in user. The Gmail App Password
never leaves this process — it is read from the worker's own ``.env`` (managed
through the Settings page, which sends it straight here and nowhere else).

Endpoints
    GET    /api/worker/health                  (no auth)
    GET    /api/worker/status                  (auth)
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
from worker.auth import AuthError, TokenVerifier  # noqa: E402
from worker.sender import CampaignManager  # noqa: E402
from worker.settings_overrides import SettingsOverrides  # noqa: E402
from worker.supabase_client import SupabaseRest  # noqa: E402

VERSION = "2.0.0"

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
) -> FastAPI:
    settings = settings or settings_service
    supabase_url = os.getenv("SUPABASE_URL", "")
    publishable_key = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")

    if rest_factory is None:  # pragma: no cover - trivial wiring
        rest_factory = lambda token: SupabaseRest(supabase_url, publishable_key, token)
    if verifier is None:
        verifier = TokenVerifier(supabase_url, publishable_key)
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

    # -- health ----------------------------------------------------------

    @app.get("/api/worker/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "app": "Seed Code Mail send worker",
            "version": VERSION,
            "supabase_configured": bool(supabase_url and publishable_key),
            "smtp_configured": settings.has_password and bool(settings.get("Email", "")),
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
            "version": VERSION,
        }

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


def run() -> None:
    import uvicorn

    host = os.getenv("WORKER_HOST", "127.0.0.1")
    port = int(os.getenv("WORKER_PORT", "8765") or "8765")
    print("=" * 62)
    print("  Seed Code Mail — send worker")
    print(f"  Listening on http://{host}:{port}  (this machine only)")
    print("  Emails are sent from here; the website only queues them.")
    print("  Press Ctrl+C to stop.")
    print("=" * 62)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    run()
