"""Access-token verification for the send worker.

The worker is reachable from the browser, so it must not trust anything the
page says about who the user is. Each request carries the Supabase access
token, which is validated directly against the Supabase Auth API — no JWT
secret is needed and no user id is ever read from the request body.

Successful verifications are cached briefly so a campaign with many requests
does not hit Supabase Auth on every call.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import httpx

CACHE_TTL_SECONDS = 60.0


class AuthError(RuntimeError):
    """Raised when a request cannot be attributed to a verified user."""


class TokenVerifier:
    def __init__(self, supabase_url: str, publishable_key: str, timeout: float = 15.0) -> None:
        self._url = (supabase_url or "").rstrip("/")
        self._key = publishable_key or ""
        self._timeout = timeout
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}

    @property
    def configured(self) -> bool:
        return bool(self._url and self._key)

    def verify(self, token: str) -> dict[str, Any]:
        """Return ``{"id", "email"}`` for a valid token, else raise AuthError."""
        if not token:
            raise AuthError("Missing access token.")
        if not self.configured:
            raise AuthError(
                "The worker is not configured with SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY, "
                "so it cannot verify signed-in users."
            )

        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(token)
            if cached and cached[0] > now:
                return cached[1]

        try:
            response = httpx.get(
                f"{self._url}/auth/v1/user",
                headers={"apikey": self._key, "Authorization": f"Bearer {token}"},
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            raise AuthError(f"Cannot reach Supabase Auth: {exc}") from exc

        if response.status_code in (401, 403):
            raise AuthError("Your session is invalid or has expired. Sign in again.")
        if response.status_code >= 400:
            raise AuthError("Supabase Auth rejected the request.")

        try:
            payload = response.json()
        except ValueError as exc:
            raise AuthError("Supabase Auth returned an unexpected response.") from exc

        user_id = payload.get("id")
        if not user_id:
            raise AuthError("Supabase Auth returned no user for this token.")

        user = {"id": user_id, "email": payload.get("email") or ""}
        with self._lock:
            self._cache[token] = (now + CACHE_TTL_SECONDS, user)
            if len(self._cache) > 128:  # keep the cache bounded
                stale = [key for key, (expiry, _) in self._cache.items() if expiry <= now]
                for key in stale[:64]:
                    self._cache.pop(key, None)
        return user
