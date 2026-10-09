"""Minimal Supabase REST client for the send worker.

Every request carries the signed-in user's access token, so Row Level Security
applies exactly as it would for a request from the browser. The worker is NOT a
privileged back door:

* no service-role / secret key is used or required;
* a user can only ever read and write their own rows;
* the most the worker *could* do with a forged token is what that token's owner
  can already do.

Only the endpoints the worker needs are implemented.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

DEFAULT_TIMEOUT = 30.0


class SupabaseError(RuntimeError):
    """Raised when a Supabase request fails."""


class SupabaseRest:
    def __init__(
        self,
        supabase_url: str,
        publishable_key: str,
        access_token: str,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._url = (supabase_url or "").rstrip("/")
        self._key = publishable_key or ""
        self._token = access_token or ""
        self._timeout = timeout
        if not self._url or not self._key:
            raise SupabaseError(
                "Supabase is not configured for the worker. Set SUPABASE_URL and "
                "SUPABASE_PUBLISHABLE_KEY in the worker's .env."
            )

    # -- internals ---------------------------------------------------------

    def _headers(self, prefer: str | None = None) -> dict[str, str]:
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        return headers

    def _request(
        self,
        method: str,
        table: str,
        *,
        params: dict[str, str] | None = None,
        payload: Any = None,
        prefer: str | None = None,
    ) -> Any:
        url = f"{self._url}/rest/v1/{table}"
        try:
            response = httpx.request(
                method,
                url,
                params=params or {},
                content=json.dumps(payload) if payload is not None else None,
                headers=self._headers(prefer),
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            raise SupabaseError(f"Cannot reach Supabase: {exc}") from exc

        if response.status_code >= 400:
            detail = _safe_detail(response)
            raise SupabaseError(f"Supabase rejected the request ({response.status_code}): {detail}")

        if not response.content:
            return None
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            return response.json()
        return response.text

    # -- filters -----------------------------------------------------------

    @staticmethod
    def eq(column: str, value: Any) -> tuple[str, str]:
        return column, f"eq.{value}"

    @staticmethod
    def _filters(filters: dict[str, Any] | None, extra: dict[str, str] | None = None) -> dict[str, str]:
        params: dict[str, str] = dict(extra or {})
        for column, expression in (filters or {}).items():
            if isinstance(expression, tuple):
                params[expression[0]] = expression[1]
            else:
                params[column] = f"eq.{expression}"
        return params

    # -- API ---------------------------------------------------------------

    def select(self, table: str, filters: dict[str, Any] | None = None, **extra: str) -> list[dict[str, Any]]:
        params = self._filters(filters)
        params["select"] = extra.pop("select", "*")
        params.update({k: str(v) for k, v in extra.items()})
        result = self._request("GET", table, params=params)
        return result or []

    def insert(self, table: str, payload: Any, *, returning: bool = False) -> list[dict[str, Any]]:
        prefer = "return=representation" if returning else "return=minimal"
        result = self._request("POST", table, payload=payload, prefer=prefer)
        return result or []

    def update(self, table: str, filters: dict[str, Any], payload: dict[str, Any]) -> list[dict[str, Any]]:
        params = self._filters(filters)
        result = self._request(
            "PATCH", table, params=params, payload=payload, prefer="return=representation"
        )
        return result or []

    def delete(self, table: str, filters: dict[str, Any]) -> list[dict[str, Any]]:
        params = self._filters(filters)
        result = self._request("DELETE", table, params=params, prefer="return=representation")
        return result or []


def _safe_detail(response: httpx.Response) -> str:
    """Never echo credentials or tokens back out of an error."""
    try:
        body = response.json()
    except ValueError:
        return "request rejected"

    if isinstance(body, dict):
        message = str(body.get("message") or body.get("hint") or body.get("details") or "")
    else:
        message = str(body)

    lowered = message.lower()
    for marker in ("password", "token", "apikey", "app password", "secret"):
        if marker in lowered:
            return "request rejected (details hidden)"
    return message[:200] or "request rejected"
