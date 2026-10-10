"""Seed Code Mail - FastAPI application.

Run locally with:  python app.py   (or uvicorn app:app --host 127.0.0.1 --port 8000)
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from services import storage
from services.campaign_service import CampaignBusy, CampaignService
from services.email_service import EmailService
from services.history_service import history_service
from services.recipient_service import recipient_service
from services.settings_service import SettingsError, settings_service
from services.template_service import DEFAULT_DESIGN, template_service

storage.ensure_directories()

APP_HOST = os.getenv("APP_HOST", "127.0.0.1")
APP_PORT = int(os.getenv("APP_PORT", "8000") or "8000")

campaign_service = CampaignService(settings_service)

app = FastAPI(title="Seed Code Mail", version="1.0.0", docs_url=None, redoc_url=None)

# Same-origin only: the frontend is served by this app, so CORS is locked to
# local origins and no remote site can read API responses.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://127.0.0.1:{APP_PORT}", f"http://localhost:{APP_PORT}"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)

_ALLOWED_ORIGIN_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}


@app.middleware("http")
async def local_only_guard(request: Request, call_next):
    """Reject cross-origin state-changing requests (basic CSRF protection)."""
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        if origin:
            host = origin.split("://", 1)[-1].split("/")[0]
            hostname = host.rsplit(":", 1)[0] if ":" in host and not host.startswith("[") else host
            if hostname not in _ALLOWED_ORIGIN_HOSTS:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Cross-origin requests are not allowed."},
                )
    return await call_next(request)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class RecipientIn(BaseModel):
    company_name: str = Field(min_length=1, max_length=200)
    email: str = Field(min_length=3, max_length=254)


class ImportIn(BaseModel):
    format: str = Field(pattern="^(csv|json)$")
    content: str = Field(min_length=1)


class ImportCommitIn(BaseModel):
    rows: list[dict[str, Any]] = Field(default_factory=list)


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    html: str = ""
    description: str = ""
    design: dict[str, Any] | None = None


class TemplateUpdateIn(BaseModel):
    name: str | None = None
    html: str | None = None
    description: str | None = None
    design: dict[str, Any] | None = None


class TemplatePreviewIn(BaseModel):
    """Preview payload.

    The preview values (company/sender/subject/URL) are used only to render a
    sample message.  They are never persisted and never create a recipient.
    """
    html: str = ""
    design: dict[str, Any] | None = None
    company_name: str = ""
    template_id: str | None = None
    subject: str = ""
    sender_name: str | None = None
    sender_email: str | None = None
    github_url: str | None = None


class TemplateImportIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1)
    description: str = ""


class SettingsIn(BaseModel):
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


class CampaignIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    # The subject is required per campaign; there is no global default.
    subject: str = Field(min_length=1, max_length=200)
    template_id: str
    recipient_ids: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Error helper
# ---------------------------------------------------------------------------

def _error(status: int, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail=message)


# ---------------------------------------------------------------------------
# Health & dashboard
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "app": "Seed Code Mail", "version": "1.0.0"}


@app.get("/api/dashboard")
def dashboard() -> dict[str, Any]:
    recipients = recipient_service.list_all()
    campaigns = campaign_service.list_all()
    active = campaign_service.active_campaign()
    recent = history_service.query(page=1, page_size=8)["items"]
    configured = settings_service.has_password and bool(settings_service.get("Email"))

    return {
        "recipients": {
            "total": len(recipients),
            "pending": sum(1 for r in recipients if r.get("status") == "pending"),
            "sent": sum(1 for r in recipients if r.get("status") == "sent"),
            "failed": sum(1 for r in recipients if r.get("status") == "failed"),
            "unknown": sum(1 for r in recipients if r.get("status") == "unknown"),
        },
        "campaigns": {
            "total": len(campaigns),
            "active": active["id"] if active else None,
            "active_name": active["name"] if active else None,
            "active_counters": active.get("counters") if active else None,
        },
        "smtp": {
            "configured": configured,
            "has_password": settings_service.has_password,
            "sender_email": settings_service.get("Email", ""),
            "sender_name": settings_service.get("SENDER_NAME", ""),
            "host": settings_service.get("SMTP_HOST", ""),
            "port": settings_service.get_int("SMTP_PORT", 465),
        },
        "recent_activity": recent,
    }


# ---------------------------------------------------------------------------
# Recipients
# ---------------------------------------------------------------------------

@app.get("/api/recipients")
def list_recipients(
    search: str = "",
    status: str = "",
    sort: str = "created_at",
    order: str = "desc",
) -> dict[str, Any]:
    items = recipient_service.list_all()
    term = search.strip().lower()
    if term:
        items = [
            r for r in items
            if term in str(r.get("company_name", "")).lower()
            or term in str(r.get("email", "")).lower()
        ]
    if status:
        items = [r for r in items if r.get("status") == status]

    reverse = order != "asc"
    key_map = {
        "company_name": lambda r: str(r.get("company_name", "")).lower(),
        "email": lambda r: str(r.get("email", "")).lower(),
        "status": lambda r: str(r.get("status", "")),
        "created_at": lambda r: str(r.get("created_at", "")),
        "updated_at": lambda r: str(r.get("updated_at", "")),
    }
    items = sorted(items, key=key_map.get(sort, key_map["created_at"]), reverse=reverse)
    return {"items": items, "total": len(items)}


@app.post("/api/recipients", status_code=201)
def create_recipient(payload: RecipientIn) -> dict[str, Any]:
    try:
        return recipient_service.add(payload.company_name, payload.email)
    except ValueError as exc:
        raise _error(400, str(exc))


@app.put("/api/recipients/{recipient_id}")
def update_recipient(recipient_id: str, payload: RecipientIn) -> dict[str, Any]:
    try:
        return recipient_service.update(
            recipient_id,
            {"company_name": payload.company_name, "email": payload.email},
        )
    except KeyError as exc:
        raise _error(404, str(exc))
    except ValueError as exc:
        raise _error(400, str(exc))


@app.delete("/api/recipients/{recipient_id}", status_code=204)
def delete_recipient(recipient_id: str):
    try:
        recipient_service.delete(recipient_id)
    except KeyError as exc:
        raise _error(404, str(exc))
    return None


class BulkDeleteIn(BaseModel):
    ids: list[str] = Field(default_factory=list)


@app.post("/api/recipients/delete-many")
def delete_recipients(payload: BulkDeleteIn) -> dict[str, int]:
    return {"deleted": recipient_service.delete_many(payload.ids)}


class StatusResetIn(BaseModel):
    ids: list[str] = Field(default_factory=list)


@app.post("/api/recipients/reset-status")
def reset_recipient_status(payload: StatusResetIn) -> dict[str, int]:
    """Return eligible (failed/unknown) recipients to ``pending`` for retry."""
    changed = 0
    for rid in payload.ids:
        record = recipient_service.get(rid)
        if record and record.get("status") in ("failed", "unknown"):
            recipient_service.update(rid, {"status": "pending"})
            changed += 1
    return {"reset": changed}


@app.post("/api/recipients/import/preview")
def preview_import(payload: ImportIn) -> dict[str, Any]:
    try:
        return recipient_service.preview_import(payload.content, payload.format)
    except ValueError as exc:
        raise _error(400, str(exc))


@app.post("/api/recipients/import")
def commit_import(payload: ImportCommitIn) -> dict[str, int]:
    if not payload.rows:
        raise _error(400, "No rows to import.")
    return recipient_service.commit_import(payload.rows)


@app.get("/api/recipients/export")
def export_recipients(format: str = Query("csv", pattern="^(csv|json)$")):
    content = recipient_service.export(format)
    media = "text/csv" if format == "csv" else "application/json"
    return PlainTextResponse(
        content,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="recipients.{format}"'},
    )


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

@app.get("/api/templates")
def list_templates() -> dict[str, Any]:
    """Saved templates plus the default design values used by new templates."""
    return {
        "items": template_service.list_summary(),
        "default_design": DEFAULT_DESIGN,
    }


@app.get("/api/templates/variables")
def template_variables() -> dict[str, Any]:
    """Documented personalization variables shown in the editor guide."""
    return {
        "variables": template_service.variable_guide(),
        "preview_note": "Preview may differ slightly across email clients.",
    }


@app.get("/api/templates/{template_id}")
def get_template(template_id: str) -> dict[str, Any]:
    template = template_service.get(template_id)
    if template is None:
        raise _error(404, "Template not found.")
    return template


@app.post("/api/templates", status_code=201)
def create_template(payload: TemplateIn) -> dict[str, Any]:
    try:
        return template_service.create(payload.name, payload.html, payload.description, payload.design)
    except ValueError as exc:
        raise _error(400, str(exc))


@app.put("/api/templates/{template_id}")
def update_template(template_id: str, payload: TemplateUpdateIn) -> dict[str, Any]:
    fields = payload.model_dump(exclude_none=True)
    try:
        return template_service.update(template_id, fields)
    except KeyError as exc:
        raise _error(404, str(exc))
    except ValueError as exc:
        raise _error(400, str(exc))


@app.delete("/api/templates/{template_id}", status_code=204)
def delete_template(template_id: str):
    try:
        template_service.delete(template_id)
    except KeyError as exc:
        raise _error(404, str(exc))
    return None


class DuplicateIn(BaseModel):
    name: str = ""


@app.post("/api/templates/{template_id}/duplicate", status_code=201)
def duplicate_template(template_id: str, payload: DuplicateIn) -> dict[str, Any]:
    try:
        return template_service.duplicate(template_id, payload.name)
    except KeyError as exc:
        raise _error(404, str(exc))


@app.post("/api/templates/{template_id}/default")
def set_default_template(template_id: str) -> dict[str, Any]:
    try:
        return template_service.set_default(template_id)
    except KeyError as exc:
        raise _error(404, str(exc))


@app.post("/api/templates/preview")
def preview_template(payload: TemplatePreviewIn) -> dict[str, Any]:
    html_content = payload.html
    design = payload.design
    if not html_content and payload.template_id:
        template = template_service.get(payload.template_id)
        if template is None:
            raise _error(404, "Template not found.")
        html_content = template.get("html", "")
        design = design or template.get("design")

    # Preview values override settings for this render only -- nothing is saved.
    company = payload.company_name or "Example Company"
    sender_name = payload.sender_name if payload.sender_name is not None else settings_service.get("SENDER_NAME", "")
    sender_email = payload.sender_email if payload.sender_email is not None else settings_service.get("Email", "")
    github_url = payload.github_url if payload.github_url is not None else settings_service.get("GITHUB_URL", "")
    subject = payload.subject or ""

    values = {
        "COMPANY_NAME": company,
        "SENDER_NAME": sender_name,
        "SENDER_EMAIL": sender_email,
        "SUBJECT": subject,
        "GITHUB_URL": github_url,
    }
    rendered = template_service.build_personalized_html(
        html_content, design, company, sender_name, sender_email, subject, github_url,
    )
    return {
        "html": rendered,
        "used_variables": template_service.used_variables(html_content or ""),
        "missing_variables": template_service.missing_variables(html_content or ""),
        "unknown_variables": template_service.unknown_variables(html_content or ""),
        "unresolved_variables": template_service.unresolved_variables(html_content or "", values),
        "empty": not (html_content or "").strip(),
    }


@app.post("/api/templates/import", status_code=201)
def import_template(payload: TemplateImportIn) -> dict[str, Any]:
    try:
        return template_service.create(payload.name, payload.content, payload.description)
    except ValueError as exc:
        raise _error(400, str(exc))


@app.get("/api/templates/{template_id}/export")
def export_template(template_id: str):
    template = template_service.get(template_id)
    if template is None:
        raise _error(404, "Template not found.")
    filename = "".join(c for c in template.get("name", "template") if c.isalnum() or c in " -_").strip() or "template"
    return PlainTextResponse(
        template.get("html", ""),
        media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="{filename}.html"'},
    )


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return settings_service.public()


@app.put("/api/settings")
def update_settings(payload: SettingsIn) -> dict[str, Any]:
    data = payload.model_dump(exclude_none=True)
    try:
        return settings_service.update(data)
    except SettingsError as exc:
        raise _error(400, str(exc))


@app.post("/api/settings/test-smtp")
def test_smtp() -> dict[str, Any]:
    return EmailService(settings_service).test_connection()


@app.post("/api/settings/reset")
def reset_settings() -> dict[str, Any]:
    return settings_service.reset_non_secret()


# ---------------------------------------------------------------------------
# Campaigns
# ---------------------------------------------------------------------------

@app.get("/api/campaigns")
def list_campaigns() -> dict[str, Any]:
    items = campaign_service.list_all()
    for campaign in items:
        campaign_service._recount(campaign)
    return {"items": items}


@app.get("/api/campaigns/{campaign_id}")
def get_campaign(campaign_id: str) -> dict[str, Any]:
    campaign = campaign_service.get(campaign_id)
    if campaign is None:
        raise _error(404, "Campaign not found.")
    campaign_service._recount(campaign)
    return campaign


@app.post("/api/campaigns", status_code=201)
def create_campaign(payload: CampaignIn) -> dict[str, Any]:
    try:
        return campaign_service.create(
            payload.name, payload.subject, payload.template_id, payload.recipient_ids
        )
    except ValueError as exc:
        raise _error(400, str(exc))


@app.post("/api/campaigns/{campaign_id}/start")
def start_campaign(campaign_id: str) -> dict[str, Any]:
    try:
        return campaign_service.start(campaign_id)
    except KeyError as exc:
        raise _error(404, str(exc))
    except CampaignBusy as exc:
        raise _error(409, str(exc))


@app.post("/api/campaigns/{campaign_id}/pause")
def pause_campaign(campaign_id: str) -> dict[str, Any]:
    try:
        return campaign_service.pause(campaign_id)
    except KeyError as exc:
        raise _error(404, str(exc))


@app.post("/api/campaigns/{campaign_id}/resume")
def resume_campaign(campaign_id: str) -> dict[str, Any]:
    try:
        return campaign_service.resume(campaign_id)
    except KeyError as exc:
        raise _error(404, str(exc))
    except CampaignBusy as exc:
        raise _error(409, str(exc))


@app.post("/api/campaigns/{campaign_id}/cancel")
def cancel_campaign(campaign_id: str) -> dict[str, Any]:
    try:
        return campaign_service.cancel(campaign_id)
    except KeyError as exc:
        raise _error(404, str(exc))


@app.delete("/api/campaigns/{campaign_id}", status_code=204)
def delete_campaign(campaign_id: str):
    try:
        campaign_service.delete(campaign_id)
    except KeyError as exc:
        raise _error(404, str(exc))
    except CampaignBusy as exc:
        raise _error(409, str(exc))
    return None


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------

@app.get("/api/history")
def get_history(
    search: str = "",
    status: str = "",
    campaign_id: str = "",
    date_from: str = "",
    date_to: str = "",
    page: int = 1,
    page_size: int = 25,
) -> dict[str, Any]:
    return history_service.query(
        search=search, status=status, campaign_id=campaign_id,
        date_from=date_from, date_to=date_to, page=page, page_size=page_size,
    )


@app.get("/api/history/export")
def export_history(
    format: str = Query("csv", pattern="^(csv|json)$"),
    search: str = "",
    status: str = "",
    campaign_id: str = "",
    date_from: str = "",
    date_to: str = "",
):
    content = history_service.export(
        format, search=search, status=status, campaign_id=campaign_id,
        date_from=date_from, date_to=date_to,
    )
    media = "text/csv" if format == "csv" else "application/json"
    return PlainTextResponse(
        content,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="email_history.{format}"'},
    )


@app.delete("/api/history", status_code=200)
def clear_history() -> dict[str, int]:
    return {"cleared": history_service.clear()}


# ---------------------------------------------------------------------------
# Frontend static files (mounted last so /api takes precedence)
# ---------------------------------------------------------------------------
#
# The browser application is built by Vite (`npm run build` -> ./dist) and served
# as a static site — on Vercel and, locally, by this module. Serving the raw
# `frontend/` sources is NOT supported: they rely on Vite to inline the public
# VITE_* configuration, so an unbundled copy would fail in the browser. When no
# build is present we say so plainly rather than serving a page that cannot work.

_DIST_DIR = storage.BASE_DIR / "dist"
_PUBLIC_DIR = storage.FRONTEND_DIR / "public"
_BUILD_READY = (_DIST_DIR / "index.html").exists()

if _BUILD_READY:
    # A single mount serves index.html, the bundled assets, and the public files
    # (robots.txt, sitemap.xml, the favicon/brand icons, og-image.png,
    # manifest.webmanifest).
    app.mount("/", StaticFiles(directory=_DIST_DIR, html=True), name="frontend")
else:
    @app.get("/")
    def build_required():
        return PlainTextResponse(
            "Seed Code Mail has not been built yet.\n\n"
            "Run these two commands in the project folder, then reload:\n\n"
            "    npm install\n    npm run build\n\n"
            "(start.bat performs this automatically on first launch.)\n",
            status_code=503,
        )

    # Keep the genuinely static public files available even before a build.
    if _PUBLIC_DIR.exists():
        app.mount("/", StaticFiles(directory=_PUBLIC_DIR), name="public-fallback")


def run() -> None:
    import uvicorn

    uvicorn.run(app, host=APP_HOST, port=APP_PORT, log_level="info")


if __name__ == "__main__":
    run()
