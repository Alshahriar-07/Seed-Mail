"""Durable campaign-queue access for the remote send worker.

Unlike `worker.supabase_client` (which speaks to Supabase with the *signed-in
user's* token so Row Level Security applies), this module is for the trusted
background consumer: it uses the project's **service-role key**, which only ever
exists in the worker host's environment — never in the browser bundle, never in
Postgres, never in a response body.

Why the consumer needs privilege at all:

* a background worker has no user session, so it cannot act "as the user";
* it must be able to claim work across accounts (`claim_next_campaign`).

Everything it does is still scoped: reads are filtered by the campaign it just
claimed, and the claim itself is atomic (row-locked in Postgres), so two workers
can never send the same campaign at the same time.

No credential is ever logged: errors are sanitized before they are returned.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from worker import config
from worker.supabase_client import SupabaseRest

DEFAULT_TIMEOUT = 30.0

# Job states that still need work. `sent` is never retried (no duplicate sends)
# and `unknown` is never retried automatically (the relay may have accepted it).
RETRYABLE_JOB_STATUSES = ("pending", "failed")


class QueueError(RuntimeError):
    """Raised when the durable queue cannot be reached or rejected a request."""


class QueueNotConfigured(QueueError):
    """The worker host has no service-role key, so it cannot consume the queue."""


def service_role_key() -> str:
    """The worker's Supabase service-role key (accepts either common name)."""
    return config.service_role_key()


def supabase_url() -> str:
    return config.supabase_url()


def queue_configured() -> bool:
    return config.queue_configured()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _safe(message: Any) -> str:
    """Never echo a credential-shaped value back out."""
    text = str(message or "")
    for marker in ("service_role", "service-role", "apikey", "password", "secret", "bearer"):
        if marker in text.lower():
            return "Supabase rejected the request (details hidden)."
    return text[:300]


class WorkerQueue:
    """Queue operations, all performed with the service-role key."""

    def __init__(
        self,
        url: str | None = None,
        key: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._url = (url if url is not None else supabase_url()).rstrip("/")
        self._key = key if key is not None else service_role_key()
        self._timeout = timeout
        if not self._url or not self._key:
            raise QueueNotConfigured(
                "The worker is not configured to consume the queue. Set "
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the worker host's "
                "environment (see README → Deploying the send worker)."
            )

    @property
    def service_key(self) -> str:
        """The service-role key this consumer writes with (worker host only)."""
        return self._key

    # -- transport ---------------------------------------------------------

    def _headers(self, prefer: str | None = None) -> dict[str, str]:
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        return headers

    def _request(self, method: str, path: str, *, params: dict[str, Any] | None = None, payload: Any = None, prefer: str | None = None) -> httpx.Response:
        try:
            response = httpx.request(
                method,
                f"{self._url}{path}",
                params=params or {},
                content=json.dumps(payload) if payload is not None else None,
                headers=self._headers(prefer),
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            raise QueueError(f"Cannot reach Supabase: {_safe(exc)}") from exc
        if response.status_code >= 400:
            raise QueueError(f"Supabase rejected the request ({response.status_code}): {_safe(_detail(response))}")
        return response

    def _json(self, method: str, path: str, **kwargs: Any) -> Any:
        response = self._request(method, path, **kwargs)
        if not response.content:
            return None
        return response.json()

    def rpc(self, function: str, payload: dict[str, Any]) -> Any:
        return self._json("POST", f"/rest/v1/rpc/{function}", payload=payload)

    # -- heartbeats --------------------------------------------------------

    def heartbeat(
        self,
        worker_id: str,
        *,
        kind: str = "queue",
        version: str = "",
        detail: dict[str, Any] | None = None,
    ) -> None:
        """Publishes liveness so the API can report real worker availability."""
        body = {
            "worker_id": worker_id,
            "kind": kind,
            "version": version,
            "detail": detail or {},
            "last_seen_at": _now().isoformat(),
        }
        try:
            self._request(
                "POST",
                "/rest/v1/worker_heartbeats",
                params={"on_conflict": "worker_id"},
                payload=body,
                prefer="resolution=merge-duplicates,return=minimal",
            )
        except QueueError:
            # Liveness reporting must never take the consumer down.
            pass

    def heartbeats(self, within_seconds: int = 90) -> list[dict[str, Any]]:
        cutoff = (_now() - timedelta(seconds=within_seconds)).isoformat()
        return self._json(
            "GET",
            "/rest/v1/worker_heartbeats",
            params={"select": "*", "last_seen_at": f"gte.{cutoff}", "order": "last_seen_at.desc"},
        ) or []

    # -- claim / lease -----------------------------------------------------

    def claim_next(self, worker_id: str, lease_seconds: int) -> dict[str, Any] | None:
        rows = self.rpc(
            "claim_next_campaign",
            {"p_worker": worker_id, "p_lease_seconds": int(lease_seconds)},
        )
        if isinstance(rows, list) and rows:
            return rows[0]
        return None

    def renew(self, campaign_id: str, worker_id: str, lease_seconds: int) -> bool:
        result = self.rpc(
            "renew_campaign_lease",
            {"p_campaign": campaign_id, "p_worker": worker_id, "p_lease_seconds": int(lease_seconds)},
        )
        return bool(result)

    def release(self, campaign_id: str, worker_id: str, status: str, error: str = "") -> dict[str, Any] | None:
        return self.rpc(
            "release_campaign",
            {
                "p_campaign": campaign_id,
                "p_worker": worker_id,
                "p_status": status,
                "p_error": error or "",
            },
        )

    # -- reads -------------------------------------------------------------

    def campaign(self, campaign_id: str) -> dict[str, Any] | None:
        rows = self._json(
            "GET",
            "/rest/v1/campaigns",
            params={"select": "*", "id": f"eq.{campaign_id}", "limit": "1"},
        )
        return rows[0] if rows else None

    def flags(self, campaign_id: str) -> dict[str, Any]:
        """Cooperative control flags, read between delivery attempts."""
        rows = self._json(
            "GET",
            "/rest/v1/campaigns",
            params={"select": "status,pause_requested,cancel_requested", "id": f"eq.{campaign_id}", "limit": "1"},
        )
        return rows[0] if rows else {}

    def jobs(self, campaign_id: str) -> list[dict[str, Any]]:
        """Recipients that still need a delivery attempt (never `sent`)."""
        statuses = ",".join(RETRYABLE_JOB_STATUSES)
        return self._json(
            "GET",
            "/rest/v1/campaign_recipients",
            params={
                "select": "id,recipient_id,company_name,email,status,attempts",
                "campaign_id": f"eq.{campaign_id}",
                "status": f"in.({statuses})",
                "order": "created_at.asc",
            },
        ) or []

    def user_settings(self, user_id: str) -> dict[str, Any]:
        rows = self._json(
            "GET",
            "/rest/v1/user_settings",
            params={"select": "*", "user_id": f"eq.{user_id}", "limit": "1"},
        )
        return rows[0] if rows else {}

    def queued_count(self) -> int:
        response = self._request(
            "GET",
            "/rest/v1/campaigns",
            params={"select": "id", "status": "eq.queued", "limit": "1"},
            prefer="count=exact",
        )
        return _count_from(response)

    def running_count(self) -> int:
        response = self._request(
            "GET",
            "/rest/v1/campaigns",
            params={"select": "id", "status": "eq.running", "limit": "1"},
            prefer="count=exact",
        )
        return _count_from(response)


def _count_from(response: httpx.Response) -> int:
    content_range = response.headers.get("content-range", "")
    if "/" in content_range:
        tail = content_range.rsplit("/", 1)[-1].strip()
        if tail.isdigit():
            return int(tail)
    try:
        return len(response.json() or [])
    except ValueError:
        return 0


def _detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return "request rejected"
    if isinstance(body, dict):
        return str(body.get("message") or body.get("hint") or body.get("details") or "")
    return str(body)
