"""Request-origin protection for the send worker / local agent.

Why this module exists
----------------------
The local agent listens on a loopback port on the user's own computer. A
loopback port is *not* private: any web page the user has open can try to call
``http://127.0.0.1:8765``. Three distinct attacks matter, and each needs a
different control:

1.  **CSRF / a hostile page sending mail through the agent.** A page on any
    origin can issue a cross-origin request to the loopback port. Browsers do
    not stop it; `fetch()` is allowed to *make* the request, and CORS only stops
    the attacker from *reading* the response. So a request that changes state
    must be refused, not merely hidden: the value of a mail-sending endpoint is
    in the side effect itself. The defence is to reject any request whose
    ``Origin`` header names an origin that is not on the allow-list. Every
    browser attaches ``Origin`` to a cross-origin request, so a forged one
    cannot omit it.

2.  **DNS rebinding.** ``evil.example`` can resolve to ``127.0.0.1`` *after* the
    page has loaded, so the browser believes it is still talking to
    ``evil.example`` while the packets arrive at the agent. CORS does not help
    here by itself — the request is "same-origin" as far as the page is
    concerned. The tell is the ``Host`` header: it names ``evil.example`` while
    the socket is on loopback. When the agent is bound to loopback, a browser
    request whose ``Host`` is not a loopback name is therefore refused.

3.  **An unpaired caller.** Origin and Host checks describe *where a request came
    from*; they do not describe *who sent it*. Every state-changing endpoint
    already requires a Supabase access token (see ``worker/auth.py``), which is
    the primary authentication. For deployments that want a second, offline
    factor — a secret the user pastes once into the website, so only that browser
    can drive the agent — an optional pairing token is supported. It is off
    unless ``WORKER_AGENT_TOKEN`` is set, so it never appears as unexplained
    friction; when it is on, ``GET /api/worker/health`` says so
    (``pairing_required``).

Chrome's **Private Network Access** is the fourth requirement, and it is
configured rather than implemented here: a page served from a public origin (the
deployed site) that calls a loopback address triggers a preflight that must be
answered with ``Access-Control-Allow-Private-Network: true``. Starlette's CORS
middleware does this when ``allow_private_network=True`` is passed, which
``worker/main.py`` does; the tests below pin the behaviour so it cannot be
silently dropped.

None of this makes the agent an open relay: mail is only ever sent for a
campaign the caller owns (verified through Supabase), and only via the same
durable queue and lease the hosted worker uses.

The helpers in this module are pure and unit-tested directly; the middleware is a
thin adapter over them (see ``tests/test_worker_security.py``).
"""

from __future__ import annotations

import re
from typing import Iterable, Sequence

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

# Hostnames that always mean "this machine".
LOOPBACK_HOSTNAMES = frozenset({"127.0.0.1", "localhost", "::1"})

# The full, unbracketed IPv6 loopback literal, which a Host header may carry.
IPV6_LOOPBACK = "0:0:0:0:0:0:0:1"

# The whole 127.0.0.0/8 block is loopback (RFC 1122).
_IPV4_LOOPBACK = re.compile(r"^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$")

# The value a browser sends for an opaque origin (a sandboxed frame, a data: URL,
# a local file). It is never this application, so it is refused.
NULL_ORIGIN = "null"


def normalise_origin(value: str | None) -> str:
    """Lower-case an origin and drop a trailing slash, for exact comparison."""
    return str(value or "").strip().rstrip("/").lower()


def is_allowed_origin(origin: str | None, allowed_origins: Iterable[str]) -> bool:
    """True when a browser request may proceed.

    An absent ``Origin`` is allowed: a browser always sends one for a
    cross-origin request, so its absence means the caller is not a page — a
    command-line health check, a monitoring probe, or a test. Those callers still
    have to present a valid Supabase token to reach anything that changes state.
    """
    if not origin:
        return True
    candidate = normalise_origin(origin)
    if candidate == NULL_ORIGIN:
        return False
    return any(normalise_origin(allowed) == candidate for allowed in allowed_origins)


def host_is_loopback(host_header: str | None) -> bool:
    """True when a ``Host`` header names this machine (optionally with a port).

    Parsed by hand rather than with ``urlsplit``: a Host header may be
    ``127.0.0.1:8765``, ``localhost``, ``[::1]:8765`` or a bare ``::1``, and
    ``urlsplit`` only understands the bracketed IPv6 form.
    """
    text = str(host_header or "").strip().lower()
    if not text:
        return False
    if text.startswith("["):
        text = text[1:].split("]", 1)[0]
    elif text.count(":") > 1:
        # An unbracketed IPv6 literal: only the loopback address is accepted.
        return text in ("::1", IPV6_LOOPBACK)
    else:
        text = text.split(":", 1)[0]
    return text in LOOPBACK_HOSTNAMES or bool(_IPV4_LOOPBACK.match(text))


def origin_problem(
    *,
    origin: str | None,
    host: str | None,
    allowed_origins: Sequence[str],
    loopback_bind: bool,
) -> str:
    """The reason a browser request must be refused, or '' when it may proceed.

    Only browser requests (those carrying an ``Origin``) are scrutinised: the
    rules exist to describe a page, and a page always identifies itself.
    """
    if not origin:
        return ""

    if not is_allowed_origin(origin, allowed_origins):
        return (
            f"The origin {origin} is not allowed to talk to this send worker. "
            "Add it to WORKER_ALLOWED_ORIGINS if it is a site you control."
        )

    # DNS rebinding: the socket is on loopback but the Host names somewhere else,
    # which means the browser followed a domain that now points at this machine.
    if loopback_bind and not host_is_loopback(host) and host:
        return (
            f"The Host header ({host}) does not name this machine. This worker is bound to "
            "loopback, so a request that reached it under another hostname is refused "
            "(this is what stops DNS rebinding)."
        )

    return ""


def token_problem(request_token: str | None, expected: str) -> str:
    """The reason a pairing token is unacceptable, or '' when it is fine."""
    if not expected:
        return ""
    if not request_token:
        return (
            "This send worker requires a pairing token. Open the website's Local Agent panel "
            "and paste the token shown by the worker, or unset WORKER_AGENT_TOKEN to disable "
            "pairing."
        )
    # Constant-time comparison is not strictly required here (the value is local
    # and short-lived), but it removes a timing side channel for free.
    if not _constant_time_equals(str(request_token), expected):
        return "The pairing token is not correct."
    return ""


def _constant_time_equals(left: str, right: str) -> bool:
    import hmac

    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


class OriginGuardMiddleware(BaseHTTPMiddleware):
    """Refuses browser requests that are not from an allowed origin.

    Also enforces the optional pairing token on every endpoint except the two
    unauthenticated probes (``health`` and the CORS preflight), so the website
    can always discover whether an agent is running before it is paired.
    """

    # Endpoints that must answer without a pairing token, so the site can detect
    # the agent (and tell the user it needs pairing) at all.
    OPEN_PATHS = ("/api/worker/health",)

    def __init__(
        self,
        app,
        *,
        allowed_origins: Sequence[str],
        loopback_bind: bool,
        agent_token: str = "",
    ) -> None:
        super().__init__(app)
        self.allowed_origins = list(allowed_origins)
        self.loopback_bind = bool(loopback_bind)
        self.agent_token = str(agent_token or "")

    async def dispatch(self, request: Request, call_next) -> Response:
        origin = request.headers.get("origin")
        host = request.headers.get("host")

        problem = origin_problem(
            origin=origin,
            host=host,
            allowed_origins=self.allowed_origins,
            loopback_bind=self.loopback_bind,
        )
        if problem:
            return _refused(problem)

        # A CORS preflight carries header *names*, never their values, so it can
        # never present the pairing token. It is allowed to pass so the browser
        # can learn which headers are permitted; the real request that follows
        # is still refused without a valid token.
        path = request.url.path
        preflight = request.method == "OPTIONS"
        if self.agent_token and not preflight and not any(
            path == open_path for open_path in self.OPEN_PATHS
        ):
            supplied = request.headers.get("x-seedmail-agent-token")
            problem = token_problem(supplied, self.agent_token)
            if problem:
                return _refused(problem)

        return await call_next(request)


def _refused(message: str) -> JSONResponse:
    # Deliberately no CORS headers on the refusal: an unlisted origin must not
    # even be able to read this explanation, and the browser should block the
    # request entirely.
    return JSONResponse({"detail": message, "code": "origin_not_allowed"}, status_code=403)
