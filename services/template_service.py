"""Template studio service.

Stores templates in ``data/templates.json``.  A template is a full HTML
document plus a ``design`` dictionary used by the Visual Customization
controls.  Design values are substituted into ``{{D_*}}`` tokens, and the
supported personalization variables are substituted per recipient.

The store starts **empty** on a fresh installation: nothing is preloaded, no
sample/demo template is created and no external HTML file is auto-imported.
Only templates the user explicitly saves appear in the list.

Rendering never mutates a stored template: every call returns a brand new
string so one recipient's data cannot leak into another's message.
"""

from __future__ import annotations

import copy
import html as html_module
import re
from datetime import datetime, timezone
from typing import Any

from services import storage
from services.storage import new_id
from services.validators import is_valid_email, is_valid_url

# Mapping of design key -> placeholder token used inside template HTML.
DESIGN_TOKENS: dict[str, str] = {
    "email_bg": "{{D_EMAIL_BG}}",
    "container_bg": "{{D_CONTAINER_BG}}",
    "primary_text": "{{D_PRIMARY_TEXT}}",
    "secondary_text": "{{D_SECONDARY_TEXT}}",
    "muted_text": "{{D_MUTED_TEXT}}",
    "accent": "{{D_ACCENT}}",
    "font_family": "{{D_FONT_FAMILY}}",
    "font_size": "{{D_FONT_SIZE}}",
    "container_width": "{{D_CONTAINER_WIDTH}}",
    "border_radius": "{{D_BORDER_RADIUS}}",
    "logo_url": "{{D_LOGO_URL}}",
    "button_label": "{{D_BUTTON_LABEL}}",
    "button_bg": "{{D_BUTTON_BG}}",
    "footer_text": "{{D_FOOTER_TEXT}}",
}

DEFAULT_DESIGN: dict[str, str] = {
    "email_bg": "#F7F7F7",
    "container_bg": "#FFFFFF",
    "primary_text": "#111111",
    "secondary_text": "#444444",
    "muted_text": "#737373",
    "accent": "#111111",
    "font_family": "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    "font_size": "16px",
    "container_width": "600px",
    "border_radius": "12px",
    "logo_url": "",
    "button_label": "Learn more",
    "button_bg": "#111111",
    "footer_text": "",
}

# The variables users may place inside a template, in the order they are
# documented.  This is the single source of truth for the variable guide and
# for substitution, so undocumented variables are never silently supported.
VARIABLE_GUIDE: list[dict[str, str]] = [
    {
        "name": "COMPANY_NAME",
        "group": "Recipient",
        "summary": "The recipient company's name.",
        "example": "<h2>Hello {{COMPANY_NAME}},</h2>",
        "example_label": "HTML greeting",
    },
    {
        "name": "SENDER_NAME",
        "group": "Sender",
        "summary": "The configured sender's display name.",
        "example": "<p>Best regards,<br>{{SENDER_NAME}}</p>",
        "example_label": "Signature name",
    },
    {
        "name": "SENDER_EMAIL",
        "group": "Sender",
        "summary": "The configured sender's email address.",
        "example": "<a href=\"mailto:{{SENDER_EMAIL}}\">{{SENDER_EMAIL}}</a>",
        "example_label": "Signature email",
    },
    {
        "name": "SUBJECT",
        "group": "Campaign",
        "summary": "The subject of the current campaign.",
        "example": "<title>{{SUBJECT}}</title>",
        "example_label": "Document title",
    },
    {
        "name": "GITHUB_URL",
        "group": "Sender",
        "summary": "The GitHub profile or project URL configured in Settings (if set).",
        "example": "<a href=\"{{GITHUB_URL}}\">GitHub</a>",
        "example_label": "Link button",
    },
]

PERSONALIZATION_VARS = tuple(item["name"] for item in VARIABLE_GUIDE)

# Variables that must resolve to a safe absolute URL inside attributes.
URL_VARIABLES = frozenset({"GITHUB_URL"})

# Matches {{NAME}} / {{ NAME }} personalization tokens.
VARIABLE_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")

_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_SIZE_RE = re.compile(r"^\d{1,4}(px|pt|em|rem|%)$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _attribute_context(source: str, index: int) -> bool:
    """Return True when position ``index`` sits inside an HTML tag attribute.

    Uses only the raw source text, so malformed markup degrades to "text
    context" instead of raising.
    """
    tag_start = source.rfind("<", 0, index)
    if tag_start == -1:
        return False
    tag_end = source.rfind(">", 0, index)
    if tag_end > tag_start:
        return False  # we are between tags, i.e. plain text content
    fragment = source[tag_start:index]
    if not re.match(r"<[a-zA-Z!/]", fragment):
        return False
    return fragment.count('"') % 2 == 1 or fragment.count("'") % 2 == 1


class TemplateService:
    def __init__(self, path=storage.TEMPLATES_FILE) -> None:
        # Intentionally does NOT create any template: a fresh installation has
        # an empty template store.
        self._path = path

    # -- persistence --------------------------------------------------------

    def _load(self) -> list[dict[str, Any]]:
        data = storage.read_json(self._path, {"templates": []})
        items = data.get("templates", []) if isinstance(data, dict) else data
        return items if isinstance(items, list) else []

    def _save(self, items: list[dict[str, Any]]) -> None:
        storage.atomic_write_json(self._path, {"templates": items})

    # -- reads --------------------------------------------------------------

    def list_all(self) -> list[dict[str, Any]]:
        return self._load()

    def list_summary(self) -> list[dict[str, Any]]:
        """Lightweight list without the (potentially huge) HTML body."""
        summaries = []
        for template in self._load():
            summaries.append({
                "id": template.get("id"),
                "name": template.get("name"),
                "description": template.get("description", ""),
                "is_default": bool(template.get("is_default")),
                "design": template.get("design", copy.deepcopy(DEFAULT_DESIGN)),
                "size": len(template.get("html", "")),
                "created_at": template.get("created_at"),
                "updated_at": template.get("updated_at"),
            })
        return summaries

    def get(self, template_id: str) -> dict[str, Any] | None:
        return next((t for t in self._load() if t.get("id") == template_id), None)

    # -- writes -------------------------------------------------------------

    def _clean_design(self, design: dict[str, Any] | None) -> dict[str, str]:
        cleaned = copy.deepcopy(DEFAULT_DESIGN)
        if not isinstance(design, dict):
            return cleaned
        for key, value in design.items():
            if key not in DESIGN_TOKENS:
                continue
            text = str(value).strip()
            if key in ("email_bg", "container_bg", "primary_text", "secondary_text",
                       "muted_text", "accent", "button_bg"):
                if _COLOR_RE.match(text):
                    cleaned[key] = text
            elif key in ("font_size", "container_width", "border_radius"):
                if _SIZE_RE.match(text):
                    cleaned[key] = text
            elif key == "logo_url":
                if not text or text.startswith(("http://", "https://", "data:image/")):
                    cleaned[key] = text
            else:
                cleaned[key] = text[:400]
        return cleaned

    def create(self, name: str, html_content: str, description: str = "",
               design: dict[str, Any] | None = None) -> dict[str, Any]:
        name = (name or "").strip()
        if not name:
            raise ValueError("Template name is required.")
        if not (html_content or "").strip():
            # An empty document is never stored, so it can never replace a
            # saved template by accident.
            raise ValueError("Template HTML cannot be empty.")
        with storage.lock_for(self._path):
            items = self._load()
            template = {
                "id": new_id("tpl_"),
                "name": name[:120],
                "description": (description or "")[:300],
                "html": html_content or "",
                "design": self._clean_design(design),
                "is_default": not any(t.get("is_default") for t in items),
                "created_at": _now(),
                "updated_at": _now(),
            }
            items.append(template)
            self._save(items)
            return template

    def update(self, template_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        with storage.lock_for(self._path):
            items = self._load()
            target = next((t for t in items if t.get("id") == template_id), None)
            if target is None:
                raise KeyError("Template not found.")

            if "name" in fields and str(fields["name"]).strip():
                target["name"] = str(fields["name"]).strip()[:120]
            if "description" in fields:
                target["description"] = str(fields["description"])[:300]
            if "html" in fields:
                incoming = str(fields["html"])
                if not incoming.strip():
                    # Never let an empty editor silently wipe a saved template.
                    raise ValueError("Refusing to overwrite a saved template with empty HTML.")
                target["html"] = incoming
            if "design" in fields:
                target["design"] = self._clean_design(fields["design"])
            target["updated_at"] = _now()
            self._save(items)
            return target

    def duplicate(self, template_id: str, new_name: str = "") -> dict[str, Any]:
        with storage.lock_for(self._path):
            items = self._load()
            source = next((t for t in items if t.get("id") == template_id), None)
            if source is None:
                raise KeyError("Template not found.")
            clone = copy.deepcopy(source)
            clone["id"] = new_id("tpl_")
            clone["name"] = (new_name or f"{source.get('name', 'Template')} (copy)")[:120]
            clone["is_default"] = False
            clone["created_at"] = _now()
            clone["updated_at"] = _now()
            items.append(clone)
            self._save(items)
            return clone

    def set_default(self, template_id: str) -> dict[str, Any]:
        with storage.lock_for(self._path):
            items = self._load()
            target = None
            for template in items:
                template["is_default"] = template.get("id") == template_id
                if template.get("id") == template_id:
                    target = template
            if target is None:
                raise KeyError("Template not found.")
            self._save(items)
            return target

    def delete(self, template_id: str) -> None:
        with storage.lock_for(self._path):
            items = self._load()
            target = next((t for t in items if t.get("id") == template_id), None)
            if target is None:
                raise KeyError("Template not found.")
            was_default = bool(target.get("is_default"))
            items = [t for t in items if t.get("id") != template_id]
            if was_default and items:
                items[0]["is_default"] = True
            self._save(items)

    # -- rendering ----------------------------------------------------------

    @staticmethod
    def apply_design(html_content: str, design: dict[str, Any] | None) -> str:
        merged = copy.deepcopy(DEFAULT_DESIGN)
        if isinstance(design, dict):
            for key, value in design.items():
                if key in DESIGN_TOKENS and value not in (None, ""):
                    merged[key] = str(value)
        result = html_content
        for key, token in DESIGN_TOKENS.items():
            result = result.replace(token, merged.get(key, ""))
        return result

    @staticmethod
    def substitute_variables(html_content: str, values: dict[str, str]) -> str:
        """Replace supported variables, escaping according to HTML context.

        Only documented variables are substituted; anything else is left
        untouched so it stays visible (and is reported as unknown) instead of
        being silently dropped.  The template itself is never escaped -- only
        the injected user-provided values are.
        """
        source = html_content or ""
        out: list[str] = []
        position = 0
        for match in VARIABLE_RE.finditer(source):
            name = match.group(1)
            out.append(source[position:match.start()])
            if name not in values:
                out.append(match.group(0))  # unknown token: keep as-is
                position = match.end()
                continue

            raw = values.get(name) or ""
            if _attribute_context(source, match.start()):
                if name in URL_VARIABLES:
                    # Never place an unvalidated URL inside a link attribute.
                    out.append(html_module.escape(raw, quote=True) if is_valid_url(raw) else "")
                else:
                    out.append(html_module.escape(raw, quote=True))
            else:
                out.append(html_module.escape(raw, quote=False))
            position = match.end()
        out.append(source[position:])
        return "".join(out)

    @staticmethod
    def used_variables(html_content: str) -> list[str]:
        return sorted(set(VARIABLE_RE.findall(html_content or "")))

    @staticmethod
    def missing_variables(html_content: str) -> list[str]:
        """Supported variables that the template does not use at all."""
        used = set(VARIABLE_RE.findall(html_content or ""))
        return [name for name in PERSONALIZATION_VARS if name not in used]

    @staticmethod
    def unknown_variables(html_content: str) -> list[str]:
        """Tokens that look like variables but are not supported."""
        tokens = set(VARIABLE_RE.findall(html_content or ""))
        return sorted(
            token for token in tokens
            if token not in PERSONALIZATION_VARS and not token.startswith("D_")
        )

    @staticmethod
    def unresolved_variables(html_content: str, values: dict[str, str]) -> list[str]:
        """Supported variables used in the template whose value is empty."""
        used = set(VARIABLE_RE.findall(html_content or "")) & set(PERSONALIZATION_VARS)
        return sorted(name for name in used if not str(values.get(name) or "").strip())

    @classmethod
    def variable_guide(cls) -> list[dict[str, str]]:
        return copy.deepcopy(VARIABLE_GUIDE)

    def build_personalized_html(
        self,
        template_html: str,
        design: dict[str, Any] | None,
        company_name: str,
        sender_name: str,
        sender_email: str,
        subject: str,
        github_url: str = "",
    ) -> str:
        """Return a fresh personalized HTML document.

        The stored template is never modified, and a new string is produced on
        every call so one recipient's data can never appear in another's
        message.
        """
        rendered = self.apply_design(template_html or "", design)
        values = {
            "COMPANY_NAME": company_name or "",
            "SENDER_NAME": sender_name or "",
            "SENDER_EMAIL": sender_email if is_valid_email(sender_email or "") else "",
            "SUBJECT": subject or "",
            "GITHUB_URL": github_url if is_valid_url(github_url or "") else "",
        }
        return self.substitute_variables(rendered, values)

    def render_for_template(
        self,
        template_id: str,
        company_name: str,
        sender_name: str,
        sender_email: str,
        subject: str,
        github_url: str = "",
    ) -> str:
        template = self.get(template_id)
        if template is None:
            raise KeyError("Template not found.")
        return self.build_personalized_html(
            template.get("html", ""),
            template.get("design"),
            company_name,
            sender_name,
            sender_email,
            subject,
            github_url,
        )


template_service = TemplateService()
