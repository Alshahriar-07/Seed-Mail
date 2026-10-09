"""SMTP email engine for Seed Code Mail.

Uses Python's standard-library ``email`` and ``smtplib`` modules.  Every
submission is classified as one of:

* ``sent``    - the SMTP server accepted the message for delivery
* ``failed``  - a definite failure (no message was accepted)
* ``unknown`` - the outcome could not be determined (connection dropped or
                timed out during/after DATA).  Callers must NOT blindly retry
                an ``unknown`` submission, because that can duplicate emails.

We never claim inbox delivery: "sent" only means the relay accepted it.
"""

from __future__ import annotations

import html as html_module
import re
import smtplib
import socket
import ssl
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formataddr
from typing import Any

# Categories that are safe (and useful) to retry automatically.
RETRYABLE_CATEGORIES = {"connection", "greeting", "temporary"}


class SendOutcome:
    __slots__ = ("status", "category", "message")

    def __init__(self, status: str, category: str = "", message: str = "") -> None:
        self.status = status
        self.category = category
        self.message = message

    @property
    def retryable(self) -> bool:
        return self.status == "failed" and self.category in RETRYABLE_CATEGORIES

def _clean(message: Any) -> str:
    """Sanitize an error message so no credential-like text is exposed."""
    text = str(message or "").strip()
    for marker in ("password", "GAPP_PASS", "App Password"):
        if marker.lower() in text.lower():
            return "SMTP operation failed (details hidden)."
    return text[:300]


class EmailService:
    """Wraps SMTP connections using the current settings."""

    def __init__(self, settings) -> None:
        self._settings = settings

    # -- configuration helpers ---------------------------------------------

    def _config(self) -> dict[str, Any]:
        s = self._settings
        return {
            "host": s.get("SMTP_HOST", "smtp.gmail.com"),
            "port": s.get_int("SMTP_PORT", 465),
            "timeout": max(5, s.get_int("SMTP_TIMEOUT_SECONDS", 30)),
            "email": s.get("Email", ""),
            "password": s.get("GAPP_PASS", ""),
        }

    def _connect(self):
        cfg = self._config()
        context = ssl.create_default_context()
        if cfg["port"] == 465:
            server = smtplib.SMTP_SSL(
                cfg["host"], cfg["port"], timeout=cfg["timeout"], context=context
            )
        else:
            server = smtplib.SMTP(cfg["host"], cfg["port"], timeout=cfg["timeout"])
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
        server.login(cfg["email"], cfg["password"])
        return server

    # -- connection diagnostics --------------------------------------------

    def test_connection(self) -> dict[str, Any]:
        """Connect, authenticate and disconnect. Sends no email."""
        cfg = self._config()
        if not cfg["email"]:
            return {"ok": False, "category": "configuration",
                    "message": "Sender email address is not configured."}
        if not cfg["password"]:
            return {"ok": False, "category": "configuration",
                    "message": "Gmail App Password is not configured."}
        try:
            server = self._connect()
        except smtplib.SMTPAuthenticationError:
            return {"ok": False, "category": "authentication",
                    "message": "Authentication failed. Check the Gmail App Password "
                               "and that 2-Step Verification is enabled."}
        except smtplib.SMTPConnectError as exc:
            return {"ok": False, "category": "connection", "message": _clean(exc)}
        except socket.gaierror:
            return {"ok": False, "category": "dns",
                    "message": "Could not resolve the SMTP host name."}
        except (socket.timeout, TimeoutError):
            return {"ok": False, "category": "timeout",
                    "message": "The SMTP connection timed out."}
        except ssl.SSLError as exc:
            return {"ok": False, "category": "tls", "message": _clean(exc)}
        except (smtplib.SMTPException, OSError) as exc:
            return {"ok": False, "category": "connection", "message": _clean(exc)}

        try:
            server.quit()
        except (smtplib.SMTPException, OSError):
            try:
                server.close()
            except (smtplib.SMTPException, OSError):
                pass
        return {"ok": True, "category": "ok", "message": "Connected and authenticated successfully."}

    # -- message construction ----------------------------------------------

    @staticmethod
    def build_message(
        sender_email: str,
        sender_name: str,
        recipient_email: str,
        subject: str,
        html_body: str,
        plain_body: str,
    ) -> EmailMessage:
        message = EmailMessage(policy=SMTP)
        message["Subject"] = subject
        message["From"] = formataddr((sender_name or sender_email, sender_email))
        message["To"] = recipient_email
        message.set_content(plain_body)
        message.add_alternative(html_body, subtype="html")
        return message

    # -- sending ------------------------------------------------------------

    def send_one(self, message: EmailMessage) -> SendOutcome:
        """Submit a single message and classify the outcome."""
        cfg = self._config()
        if not cfg["email"] or not cfg["password"]:
            return SendOutcome("failed", "configuration",
                               "SMTP credentials are not configured.")

        try:
            server = self._connect()
        except smtplib.SMTPAuthenticationError:
            return SendOutcome("failed", "authentication",
                               "Authentication failed. Check the Gmail App Password.")
        except smtplib.SMTPRecipientsRefused as exc:
            return SendOutcome("failed", "recipient", _clean(exc))
        except smtplib.SMTPConnectError as exc:
            return SendOutcome("failed", "connection", _clean(exc))
        except socket.gaierror:
            return SendOutcome("failed", "dns", "SMTP host name could not be resolved.")
        except (socket.timeout, TimeoutError):
            return SendOutcome("failed", "connection", "SMTP connection timed out.")
        except ssl.SSLError as exc:
            return SendOutcome("failed", "tls", _clean(exc))
        except (smtplib.SMTPException, OSError) as exc:
            return SendOutcome("failed", "connection", _clean(exc))

        try:
            server.send_message(message)
        except smtplib.SMTPRecipientsRefused as exc:
            outcome = SendOutcome("failed", "recipient", _clean(exc))
        except smtplib.SMTPDataError as exc:
            # Server rejected the DATA payload. Definite non-delivery.
            category = "temporary" if 400 <= int(getattr(exc, "smtp_code", 500)) < 500 else "rejected"
            outcome = SendOutcome("failed", category, _clean(exc))
        except smtplib.SMTPSenderRefused as exc:
            outcome = SendOutcome("failed", "sender", _clean(exc))
        except smtplib.SMTPNotSupportedError as exc:
            outcome = SendOutcome("failed", "unsupported", _clean(exc))
        except smtplib.SMTPServerDisconnected:
            # Connection dropped mid-transaction: outcome is uncertain.
            outcome = SendOutcome("unknown", "disconnected",
                                  "Connection dropped during submission; outcome unknown.")
        except (socket.timeout, TimeoutError):
            outcome = SendOutcome("unknown", "timeout",
                                  "Timed out during submission; outcome unknown.")
        except smtplib.SMTPException as exc:
            outcome = SendOutcome("unknown", "smtp", _clean(exc))
        except OSError as exc:
            outcome = SendOutcome("unknown", "network", _clean(exc))
        else:
            outcome = SendOutcome("sent", "ok", "Accepted by the SMTP server.")

        try:
            server.quit()
        except (smtplib.SMTPException, OSError):
            try:
                server.close()
            except (smtplib.SMTPException, OSError):
                pass
        return outcome


_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style|head)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL
)
_BREAK_RE = re.compile(
    r"<\s*(?:br|/p|/div|/tr|/h[1-6]|/li|/table)\s*/?\s*>", re.IGNORECASE
)
_TAG_RE = re.compile(r"<[^>]*>")
_INLINE_WS_RE = re.compile(r"[ \t\r\f\v]+")


def build_plain_text(html_body: str) -> str:
    """Derive the plain-text alternative from the personalized HTML.

    Nothing template-specific is hard-coded: the text always mirrors whatever
    the user wrote, so an empty template produces an empty plain-text part.
    """
    source = html_body or ""
    source = _SCRIPT_STYLE_RE.sub("", source)
    source = _BREAK_RE.sub("\n", source)
    source = _TAG_RE.sub("", source)
    source = html_module.unescape(source)
    lines = [_INLINE_WS_RE.sub(" ", line).strip() for line in source.splitlines()]
    return "\n".join(line for line in lines if line).strip()
