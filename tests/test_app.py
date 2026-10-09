"""Focused tests for Seed Code Mail.

SMTP is mocked; no real email is ever sent.  Tests cover: empty template store,
template save/reopen, HTML import, variable guide + substitution/escaping,
preview endpoint, per-campaign subject, settings (no default subject), MIME
structure, campaign safety and data integrity.
"""

from __future__ import annotations

import email
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from services.email_service import EmailService, SendOutcome, build_plain_text
from services.template_service import template_service

SAMPLE_HTML = """<!DOCTYPE html>
<html><body>
<h2>Hello {{COMPANY_NAME}},</h2>
<p>Dear {{COMPANY_NAME}} team,</p>
<a href="{{GITHUB_URL}}">GitHub</a>
<p>Best regards,<br>{{SENDER_NAME}}<br>{{SENDER_EMAIL}}</p>
</body></html>"""

VALID_SETTINGS = {
    "Email": "sender@example.com",
    "GAPP_PASS": "abcd efgh ijkl mnop",
    "SENDER_NAME": "Al Shahriar Sowan",
    "GITHUB_URL": "https://github.com/example",
    "SMTP_HOST": "smtp.gmail.com",
    "SMTP_PORT": 465,
    "SEND_DELAY_SECONDS": 0,
    "SMTP_TIMEOUT_SECONDS": 30,
    "MAX_RETRIES": 0,
    "RETRY_DELAY_SECONDS": 0,
}


def _create_template(client, name="Outreach", html=SAMPLE_HTML):
    res = client.post("/api/templates", json={"name": name, "html": html})
    assert res.status_code == 201, res.text
    return res.json()


# --- health & dashboard ----------------------------------------------------

def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_dashboard_is_backed_by_real_data(client):
    body = client.get("/api/dashboard").json()
    assert body["recipients"]["total"] == 0
    assert body["campaigns"]["total"] == 0
    assert body["smtp"]["has_password"] is False

    client.post("/api/recipients", json={"company_name": "Alpha", "email": "a@example.com"})
    body = client.get("/api/dashboard").json()
    assert body["recipients"]["total"] == 1
    assert body["recipients"]["pending"] == 1


# --- 1. no preloaded templates --------------------------------------------

def test_fresh_installation_has_zero_templates(client):
    data = client.get("/api/templates").json()
    assert data["items"] == []
    # The editor gets the design defaults it needs for a blank document, but no
    # template record and no example HTML.
    assert isinstance(data["default_design"], dict)


def test_nothing_is_auto_imported_as_a_default(client):
    """A default template must never appear without the user creating one."""
    assert client.get("/api/templates").json()["items"] == []
    # Creating a recipient must not seed a template either.
    client.post("/api/recipients", json={"company_name": "Alpha", "email": "a@example.com"})
    assert client.get("/api/templates").json()["items"] == []


# --- 6. save / reopen / validate templates ---------------------------------

def test_create_save_and_reopen_template_preserves_content(client):
    created = _create_template(client, name="Outreach")
    items = client.get("/api/templates").json()["items"]
    assert len(items) == 1
    assert items[0]["name"] == "Outreach"

    full = client.get(f"/api/templates/{created['id']}").json()
    assert full["html"] == SAMPLE_HTML  # persisted exactly, source untouched

    # Editing updates only that record.
    other = _create_template(client, name="Second", html="<p>{{COMPANY_NAME}}</p>")
    updated = client.put(f"/api/templates/{created['id']}", json={"name": "Outreach v2", "html": SAMPLE_HTML + "\n<!-- v2 -->"})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Outreach v2"
    assert client.get(f"/api/templates/{other['id']}").json()["html"] == "<p>{{COMPANY_NAME}}</p>"

    # Reopening returns the edited content.
    assert "v2" in client.get(f"/api/templates/{created['id']}").json()["html"]


def test_empty_template_cannot_be_saved_or_overwrite_a_saved_one(client):
    created = _create_template(client, name="Keep me")
    assert client.post("/api/templates", json={"name": "Empty", "html": "   "}).status_code == 400
    blank = client.put(f"/api/templates/{created['id']}", json={"html": ""})
    assert blank.status_code == 400
    # The saved content is intact.
    assert client.get(f"/api/templates/{created['id']}").json()["html"] == SAMPLE_HTML


def test_template_name_is_required(client):
    # Empty name is rejected by request validation; whitespace-only by the service.
    assert client.post("/api/templates", json={"name": "", "html": SAMPLE_HTML}).status_code == 422
    assert client.post("/api/templates", json={"name": "   ", "html": SAMPLE_HTML}).status_code == 400


def test_html_import_creates_a_new_record(client):
    imported = client.post("/api/templates/import", json={"name": "Imported", "content": SAMPLE_HTML})
    assert imported.status_code == 201
    assert len(client.get("/api/templates").json()["items"]) == 1
    assert client.get(f"/api/templates/{imported.json()['id']}").json()["html"] == SAMPLE_HTML


def test_template_delete_requires_existing_record(client):
    created = _create_template(client)
    assert client.delete(f"/api/templates/{created['id']}").status_code == 204
    assert client.get("/api/templates").json()["items"] == []


def test_template_duplicate_and_default_switch(client):
    created = _create_template(client, name="Second")
    assert created["is_default"] is True
    another = _create_template(client, name="Third", html="<p>x</p>")
    assert another["is_default"] is False
    assert client.post(f"/api/templates/{another['id']}/default").json()["is_default"] is True

    clone = client.post(f"/api/templates/{another['id']}/duplicate", json={"name": "Copy"}).json()
    assert clone["name"] == "Copy"
    assert client.delete(f"/api/templates/{clone['id']}").status_code == 204


# --- 2. variable guide -----------------------------------------------------

def test_variable_guide_is_available(client):
    guide = client.get("/api/templates/variables").json()
    names = [v["name"] for v in guide["variables"]]
    assert names == ["COMPANY_NAME", "SENDER_NAME", "SENDER_EMAIL", "SUBJECT", "GITHUB_URL"]
    for entry in guide["variables"]:
        assert entry["summary"]
        assert entry["example"]
    assert "email clients" in guide["preview_note"]


def test_unknown_and_unresolved_variables_are_reported(client):
    result = client.post("/api/templates/preview", json={
        "html": "<p>{{COMPANY_NAME}} {{MYSTERY}} {{SENDER_NAME}} {{SENDER_EMAIL}} <a href=\"{{GITHUB_URL}}\">x</a></p>",
        "company_name": "Acme",
    }).json()
    assert result["unknown_variables"] == ["MYSTERY"]
    # No sender email / GitHub URL is configured in this fresh install, while
    # SENDER_NAME has a default and COMPANY_NAME is supplied.
    assert set(result["unresolved_variables"]) == {"SENDER_EMAIL", "GITHUB_URL"}
    assert "SENDER_NAME" not in result["unresolved_variables"]
    assert "COMPANY_NAME" not in result["unresolved_variables"]


def test_preview_reports_used_variables_and_empty_state(client):
    empty = client.post("/api/templates/preview", json={"html": "   "}).json()
    assert empty["empty"] is True
    filled = client.post("/api/templates/preview", json={"html": SAMPLE_HTML, "company_name": "Acme"}).json()
    assert set(filled["used_variables"]) >= {"COMPANY_NAME", "SENDER_NAME", "SENDER_EMAIL", "GITHUB_URL"}


def test_preview_values_are_temporary_only(client):
    """Preview values never become recipients or a stored default subject."""
    client.post("/api/templates/preview", json={
        "html": "<p>{{COMPANY_NAME}}</p>", "company_name": "TempCo", "subject": "Temp subject",
    })
    assert client.get("/api/recipients").json()["total"] == 0
    assert "Temp subject" not in client.get("/api/settings").text


# --- 2. substitution rules -------------------------------------------------

def test_only_documented_variables_are_substituted(isolated):
    rendered = template_service.build_personalized_html(
        "<p>{{COMPANY_NAME}} {{NOT_A_VARIABLE}}</p>", None,
        "Acme", "Sender", "sender@example.com", "Sub", "https://github.com/x",
    )
    assert "Acme" in rendered
    assert "{{NOT_A_VARIABLE}}" in rendered  # left visible, never silently dropped


def test_user_values_are_escaped_in_text_context(isolated):
    rendered = template_service.build_personalized_html(
        "<h2>Hello {{COMPANY_NAME}},</h2>", None,
        '<script>alert("x")</script>', "Sender", "sender@example.com", "Sub", "",
    )
    assert "<script>" not in rendered
    assert "&lt;script&gt;" in rendered


def test_url_variable_is_validated_in_attribute_context(isolated):
    html = '<a href="{{GITHUB_URL}}">x</a>'
    bad = template_service.build_personalized_html(
        html, None, "Acme", "Sender", "sender@example.com", "Sub", "javascript:alert(1)")
    assert "javascript:alert(1)" not in bad

    good = template_service.build_personalized_html(
        html, None, "Acme", "Sender", "sender@example.com", "Sub", "https://github.com/Alshahriar-07")
    assert 'href="https://github.com/Alshahriar-07"' in good


def test_attribute_values_escape_quotes(isolated):
    rendered = template_service.build_personalized_html(
        '<img alt="{{COMPANY_NAME}}">', None,
        'Acme "onerror=alert(1) x', "Sender", "sender@example.com", "Sub", "")
    # Quotes are escaped, so a value can never break out of the attribute.
    assert '&quot;' in rendered
    assert '"onerror' not in rendered
    assert "onerror=alert(1) x'" not in rendered


def test_personalization_is_isolated_per_recipient(isolated):
    stored = template_service.create("Iso", SAMPLE_HTML)
    first = template_service.render_for_template(
        stored["id"], "Alpha", "Sender", "s@example.com", "Sub", "https://github.com/x")
    second = template_service.render_for_template(
        stored["id"], "Beta", "Sender", "s@example.com", "Sub", "https://github.com/x")
    assert "Alpha" in first and "Beta" not in first
    assert "Beta" in second and "Alpha" not in second
    # The stored template is never modified.
    assert client_html_unchanged(isolated, stored["id"])


def client_html_unchanged(isolated, template_id):
    return isolated["templates"].get(template_id)["html"] == SAMPLE_HTML


def test_subject_variable_renders_campaign_subject(isolated):
    rendered = template_service.build_personalized_html(
        "<title>{{SUBJECT}}</title>", None, "Acme", "Sender", "s@example.com", "Quarterly offer", "")
    assert "Quarterly offer" in rendered


# --- 4. settings: no default subject ---------------------------------------

def test_default_email_subject_is_gone_everywhere(client, isolated):
    client.put("/api/settings", json={**VALID_SETTINGS, "MAIL_SUBJECT": "Should be ignored"})
    public = client.get("/api/settings").json()
    assert "MAIL_SUBJECT" not in public["values"]
    assert "MAIL_SUBJECT" not in client.get("/api/settings").text
    assert "MAIL_SUBJECT" not in isolated["settings"]._path.read_text(encoding="utf-8")
    # The supported settings still save correctly.
    assert public["values"]["SENDER_NAME"] == VALID_SETTINGS["SENDER_NAME"]
    assert public["values"]["GITHUB_URL"] == VALID_SETTINGS["GITHUB_URL"]


def test_retired_mail_subject_is_dropped_from_env(client, isolated):
    path = isolated["settings"]._path
    path.write_text("Email=a@example.com\nMAIL_SUBJECT=Legacy default\nGAPP_PASS=x\n", encoding="utf-8")
    isolated["settings"].reload()
    assert "MAIL_SUBJECT" not in isolated["settings"].raw()
    client.put("/api/settings", json={"SENDER_NAME": "Someone"})
    assert "MAIL_SUBJECT" not in path.read_text(encoding="utf-8")


def test_settings_password_is_masked_and_never_returned(client):
    client.put("/api/settings", json=VALID_SETTINGS)
    public = client.get("/api/settings").json()
    assert "GAPP_PASS" not in public["values"]
    assert public["has_password"] is True
    assert public["password_mask"] == "********"
    assert "abcd efgh ijkl mnop" not in json.dumps(public)

    client.put("/api/settings", json={**VALID_SETTINGS, "GAPP_PASS": ""})
    assert client.get("/api/settings").json()["has_password"] is True
    client.put("/api/settings", json={**VALID_SETTINGS, "GAPP_PASS": "********"})
    assert client.get("/api/settings").json()["has_password"] is True
    assert "GAPP_PASS" not in client.get("/api/settings").text


def test_settings_validation(client):
    assert client.put("/api/settings", json={**VALID_SETTINGS, "Email": "nope"}).status_code == 400
    assert client.put("/api/settings", json={**VALID_SETTINGS, "SMTP_PORT": 99999}).status_code == 400
    assert client.put("/api/settings", json={**VALID_SETTINGS, "GITHUB_URL": "not-a-url"}).status_code == 400
    assert client.put("/api/settings", json={**VALID_SETTINGS, "GITHUB_URL": ""}).status_code == 200


def test_settings_applied_without_restart(client, isolated):
    client.put("/api/settings", json={**VALID_SETTINGS, "SENDER_NAME": "New Name"})
    assert isolated["settings"].get("SENDER_NAME") == "New Name"
    assert client.get("/api/settings").json()["sender_name"] == "New Name"


def test_smtp_test_reports_missing_configuration(client):
    result = client.post("/api/settings/test-smtp").json()
    assert result["ok"] is False
    assert result["category"] == "configuration"


# --- recipients ------------------------------------------------------------

def test_recipient_crud_and_duplicate_detection(client):
    created = client.post("/api/recipients", json={"company_name": "Alpha", "email": "a@example.com"})
    assert created.status_code == 201
    rid = created.json()["id"]

    assert client.post("/api/recipients", json={"company_name": "Alpha 2", "email": "A@Example.com"}).status_code == 400
    assert client.post("/api/recipients", json={"company_name": "Bad", "email": "not-an-email"}).status_code == 400

    updated = client.put(f"/api/recipients/{rid}", json={"company_name": "Alpha Ltd", "email": "a@example.com"})
    assert updated.status_code == 200
    assert updated.json()["company_name"] == "Alpha Ltd"

    assert client.delete(f"/api/recipients/{rid}").status_code == 204
    assert client.get("/api/recipients").json()["total"] == 0


def test_import_preview_and_commit(client):
    csv_content = (
        "company_name,email\n"
        "Alpha,alpha@example.com\n"
        "Beta,beta@example.com\n"
        "Bad,not-an-email\n"
    )
    preview = client.post("/api/recipients/import/preview", json={"format": "csv", "content": csv_content}).json()
    assert preview["total"] == 3
    assert preview["valid_count"] == 2
    assert preview["invalid_count"] == 1

    valid_rows = [r for r in preview["rows"] if r["valid"]]
    committed = client.post("/api/recipients/import", json={"rows": valid_rows}).json()
    assert committed["added"] == 2

    preview2 = client.post("/api/recipients/import/preview", json={"format": "csv", "content": csv_content}).json()
    assert preview2["duplicate_count"] == 2

    again = client.post("/api/recipients/import", json={"rows": valid_rows}).json()
    assert again["added"] == 0
    assert client.get("/api/recipients").json()["total"] == 2


def test_json_import_export(client):
    payload = json.dumps({"recipients": [{"company_name": "Gamma", "email": "g@example.com"}]})
    preview = client.post("/api/recipients/import/preview", json={"format": "json", "content": payload}).json()
    assert preview["valid_count"] == 1
    client.post("/api/recipients/import", json={"rows": [r for r in preview["rows"] if r["valid"]]})

    exported = client.get("/api/recipients/export?format=csv")
    assert exported.status_code == 200
    assert "g@example.com" in exported.text
    assert "attachment" in exported.headers["content-disposition"]


# --- MIME structure & plain text -------------------------------------------

def test_message_mime_structure():
    message = EmailService.build_message(
        "sender@example.com", "Sender", "recipient@example.com",
        "Subject", "<p>HTML body</p>", "Plain body",
    )
    assert message["To"] == "recipient@example.com"
    assert message["From"] == "Sender <sender@example.com>"
    assert "Cc" not in message and "Bcc" not in message
    assert message.is_multipart()
    parsed = email.message_from_string(message.as_string())
    types = {part.get_content_type() for part in parsed.walk()}
    assert "text/plain" in types
    assert "text/html" in types


def test_plain_text_is_derived_from_the_html_body():
    text = build_plain_text("<h2>Hello Acme,</h2><p>Dear Acme team,</p>")
    assert "Hello Acme," in text
    assert "Dear Acme team," in text
    assert "<h2>" not in text


def test_unknown_outcomes_are_not_retryable():
    assert SendOutcome("unknown", "disconnected", "x").retryable is False
    assert SendOutcome("failed", "connection", "x").retryable is True
    assert SendOutcome("failed", "authentication", "x").retryable is False
    assert SendOutcome("sent", "ok", "x").retryable is False


# --- campaigns -------------------------------------------------------------

def _run_campaign(client, monkeypatch, outcomes, count=2):
    from services import email_service

    client.put("/api/settings", json=VALID_SETTINGS)
    template = _create_template(client)
    calls = []

    def fake_send(self, message):  # noqa: ANN001
        calls.append(message)
        index = len(calls) - 1
        result = outcomes[min(index, len(outcomes) - 1)]
        return result() if callable(result) else result

    monkeypatch.setattr(email_service.EmailService, "send_one", fake_send)

    recipients = [
        client.post("/api/recipients", json={"company_name": f"Company {i}", "email": f"c{i}@example.com"}).json()
        for i in range(count)
    ]
    campaign = client.post("/api/campaigns", json={
        "name": "Test campaign", "subject": "Hello from Seed Code",
        "template_id": template["id"], "recipient_ids": [r["id"] for r in recipients],
    }).json()
    return campaign, calls


def _wait(client, campaign_id, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = client.get(f"/api/campaigns/{campaign_id}").json()
        if data["status"] != "running":
            return data
        time.sleep(0.05)
    return client.get(f"/api/campaigns/{campaign_id}").json()


def test_campaign_requires_a_subject(client):
    template = _create_template(client)
    recipient = client.post("/api/recipients", json={"company_name": "C", "email": "c@example.com"}).json()
    base = {"name": "No subject", "template_id": template["id"], "recipient_ids": [recipient["id"]]}

    assert client.post("/api/campaigns", json=base).status_code == 422
    assert client.post("/api/campaigns", json={**base, "subject": ""}).status_code == 422
    assert client.post("/api/campaigns", json={**base, "subject": "   "}).status_code == 400
    created = client.post("/api/campaigns", json={**base, "subject": "A real subject"})
    assert created.status_code == 201
    assert created.json()["subject"] == "A real subject"


def test_campaign_subject_is_used_and_kept_in_history(client, monkeypatch):
    campaign, calls = _run_campaign(client, monkeypatch, [SendOutcome("sent", "ok", "accepted")], count=1)
    client.post(f"/api/campaigns/{campaign['id']}/start")
    _wait(client, campaign["id"])

    assert calls[0]["Subject"] == "Hello from Seed Code"
    history = client.get("/api/history").json()["items"]
    assert history[0]["subject"] == "Hello from Seed Code"
    # The rendered body used the campaign subject (not a global default).
    html = calls[0].get_payload()[1].get_payload(decode=True).decode("utf-8")
    assert "{{SUBJECT}}" not in html


def test_campaign_rejects_recipients_missing_required_information(client, isolated):
    template = _create_template(client)
    # Bypass the recipient service validation to simulate a malformed record.
    path = isolated["recipients"]._path
    path.write_text(json.dumps({"recipients": [
        {"id": "rcp_bad", "company_name": "", "email": "bad@example.com", "status": "pending"}
    ]}), encoding="utf-8")

    res = client.post("/api/campaigns", json={
        "name": "Bad info", "subject": "Hi", "template_id": template["id"], "recipient_ids": ["rcp_bad"],
    })
    assert res.status_code == 400
    assert "missing" in res.json()["detail"].lower()


def test_campaign_sends_once_per_recipient(client, monkeypatch):
    campaign, calls = _run_campaign(client, monkeypatch, [SendOutcome("sent", "ok", "accepted")], count=3)
    client.post(f"/api/campaigns/{campaign['id']}/start")
    data = _wait(client, campaign["id"])
    assert data["status"] == "completed"
    assert data["counters"]["sent"] == 3
    assert len(calls) == 3
    assert len({m["To"] for m in calls}) == 3


def test_completed_campaign_is_not_resent(client, monkeypatch):
    campaign, calls = _run_campaign(client, monkeypatch, [SendOutcome("sent", "ok", "accepted")], count=2)
    client.post(f"/api/campaigns/{campaign['id']}/start")
    _wait(client, campaign["id"])
    assert len(calls) == 2

    again = client.post(f"/api/campaigns/{campaign['id']}/start")
    assert again.status_code == 409
    assert len(calls) == 2


def test_campaign_records_failures_and_continues(client, monkeypatch):
    campaign, calls = _run_campaign(
        client, monkeypatch,
        [SendOutcome("failed", "authentication", "auth failed"),
         SendOutcome("unknown", "disconnected", "unknown")],
        count=2,
    )
    client.post(f"/api/campaigns/{campaign['id']}/start")
    data = _wait(client, campaign["id"])
    assert data["status"] == "completed"
    assert data["counters"]["failed"] == 1
    assert data["counters"]["unknown"] == 1
    assert data["counters"]["processed"] == 2


def test_campaign_pause_then_resume(client, monkeypatch):
    from services import email_service

    client.put("/api/settings", json=VALID_SETTINGS)
    template = _create_template(client)
    calls = []

    def slow_send(self, message):  # noqa: ANN001
        calls.append(message)
        time.sleep(0.4)
        return SendOutcome("sent", "ok", "accepted")

    monkeypatch.setattr(email_service.EmailService, "send_one", slow_send)
    recipients = [
        client.post("/api/recipients", json={"company_name": f"C{i}", "email": f"p{i}@example.com"}).json()
        for i in range(3)
    ]
    campaign = client.post("/api/campaigns", json={
        "name": "Pause test", "subject": "Hi",
        "template_id": template["id"], "recipient_ids": [r["id"] for r in recipients],
    }).json()

    client.post(f"/api/campaigns/{campaign['id']}/start")
    time.sleep(0.5)
    client.post(f"/api/campaigns/{campaign['id']}/pause")
    paused = client.get(f"/api/campaigns/{campaign['id']}").json()
    assert paused["status"] in ("paused", "running")
    time.sleep(0.3)
    assert client.get(f"/api/campaigns/{campaign['id']}").json()["status"] == "paused"

    client.post(f"/api/campaigns/{campaign['id']}/resume")
    data = _wait(client, campaign["id"])
    assert data["status"] == "completed"
    assert data["counters"]["sent"] == 3
    assert len(calls) == 3


def test_campaign_cancel_stops_remaining(client, monkeypatch):
    from services import email_service

    client.put("/api/settings", json=VALID_SETTINGS)
    template = _create_template(client)

    def slow_send(self, message):  # noqa: ANN001
        time.sleep(0.3)
        return SendOutcome("sent", "ok", "accepted")

    monkeypatch.setattr(email_service.EmailService, "send_one", slow_send)
    recipients = [
        client.post("/api/recipients", json={"company_name": f"C{i}", "email": f"x{i}@example.com"}).json()
        for i in range(4)
    ]
    campaign = client.post("/api/campaigns", json={
        "name": "Cancel test", "subject": "Hi",
        "template_id": template["id"], "recipient_ids": [r["id"] for r in recipients],
    }).json()

    client.post(f"/api/campaigns/{campaign['id']}/start")
    time.sleep(0.4)
    client.post(f"/api/campaigns/{campaign['id']}/cancel")
    data = _wait(client, campaign["id"])
    assert data["status"] == "cancelled"
    assert data["counters"]["sent"] < 4
    assert data["counters"]["pending"] > 0


def test_running_campaign_becomes_paused_after_restart(client, monkeypatch, isolated):
    campaign_service = isolated["campaigns"]
    template = _create_template(client)
    campaign = client.post("/api/campaigns", json={
        "name": "Interrupted", "subject": "Hi", "template_id": template["id"],
        "recipient_ids": [client.post("/api/recipients", json={"company_name": "C", "email": "i@example.com"}).json()["id"]],
    }).json()

    stored = campaign_service.get(campaign["id"])
    stored["status"] = "running"
    campaign_service._save()
    campaign_service._load()

    recovered = campaign_service.get(campaign["id"])
    assert recovered["status"] == "paused"
    assert recovered["interrupted"] is True


# --- history ---------------------------------------------------------------

def test_history_persists_and_filters(client, monkeypatch, isolated):
    campaign, _ = _run_campaign(client, monkeypatch, [SendOutcome("sent", "ok", "accepted")], count=2)
    client.post(f"/api/campaigns/{campaign['id']}/start")
    _wait(client, campaign["id"])

    history = client.get("/api/history").json()
    assert history["total"] == 2
    assert all(item["campaign_id"] == campaign["id"] for item in history["items"])

    isolated["history"]._path.touch()
    assert client.get("/api/history").json()["total"] == 2

    filtered = client.get(f"/api/history?campaign_id={campaign['id']}&status=sent").json()
    assert filtered["total"] == 2
    assert client.get("/api/history?search=nomatch").json()["total"] == 0

    exported = client.get("/api/history/export?format=csv")
    assert exported.status_code == 200
    assert "c0@example.com" in exported.text


def test_history_does_not_store_credentials(isolated):
    entry = isolated["history"].append({
        "company_name": "C", "email": "c@example.com",
        "status": "failed", "error_message": "login failed for GAPP_PASS=abcd",
    })
    assert "abcd" not in entry["error_message"]


# --- data integrity --------------------------------------------------------

def test_malformed_json_recovers(client, isolated):
    path = isolated["recipients"]._path
    path.write_text("{ this is not valid json", encoding="utf-8")
    res = client.get("/api/recipients")
    assert res.status_code == 200
    assert res.json()["total"] == 0
    assert (path.parent / (path.name + ".corrupt")).exists()


def test_cross_origin_state_change_is_blocked(client):
    res = client.post("/api/recipients",
                      json={"company_name": "X", "email": "x@example.com"},
                      headers={"Origin": "https://evil.example"})
    assert res.status_code == 403


def test_app_imports_from_any_working_directory(isolated):
    root = Path(__file__).resolve().parent.parent
    result = subprocess.run(
        [sys.executable, "-c", "import app; print(app.APP_HOST, app.APP_PORT)"],
        cwd=str(isolated["tmp"]), capture_output=True, text=True,
        env={**__import__("os").environ, "PYTHONPATH": str(root)},
    )
    assert result.returncode == 0, result.stderr
    assert "127.0.0.1" in result.stdout
