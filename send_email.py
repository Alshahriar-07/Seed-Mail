import html
import os
import re
import smtplib

from pathlib import Path
from email.message import EmailMessage
from email.policy import SMTP
from dotenv import load_dotenv


# =========================================================
# CONFIGURATION
# =========================================================

BASE_DIR = Path(__file__).resolve().parent

ENV_FILE = BASE_DIR / ".env"
TEMPLATE_FILE = BASE_DIR / "email_template.html"

SENDER_EMAIL = "alshahriarsowan425@gmail.com"
SENDER_NAME = "Al Shahriar Sowan"

EMAIL_SUBJECT = "Strategic Acquisition Proposal - Seed Code"

SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 465


# Load environment variables from the project's .env file.
load_dotenv(dotenv_path=ENV_FILE)


# =========================================================
# INPUT VALIDATION
# =========================================================

def get_required_input(prompt: str) -> str:
    """Get non-empty input from the user."""

    while True:
        value = input(prompt).strip()

        if value:
            return value

        print("This field cannot be empty.")


def get_valid_email(prompt: str) -> str:
    """Get and validate an email address."""

    email_pattern = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"

    while True:
        address = input(prompt).strip()

        if re.fullmatch(email_pattern, address):
            return address

        print("Invalid email address. Please try again.")


# =========================================================
# TEMPLATE PROCESSING
# =========================================================

def load_html_template(company_name: str) -> str:
    """Load the HTML template and personalize the company name."""

    if not TEMPLATE_FILE.is_file():
        raise FileNotFoundError(
            f"HTML template not found: {TEMPLATE_FILE}"
        )

    template = TEMPLATE_FILE.read_text(encoding="utf-8")

    placeholder = "{{COMPANY_NAME}}"

    if placeholder not in template:
        raise ValueError(
            f"Missing {placeholder} in email_template.html"
        )

    # Escape user-provided text before inserting it into HTML.
    company_name_safe = html.escape(company_name)

    return template.replace(placeholder, company_name_safe)


# =========================================================
# EMAIL CONSTRUCTION
# =========================================================

def build_email(
    receiver_email: str,
    company_name: str,
    html_content: str,
) -> EmailMessage:
    """Build a multipart email containing plain text and HTML."""

    message = EmailMessage(policy=SMTP)

    message["Subject"] = EMAIL_SUBJECT
    message["From"] = f"{SENDER_NAME} <{SENDER_EMAIL}>"
    message["To"] = receiver_email

    # Plain-text fallback for email clients that do not display HTML.
    plain_text = f"""Dear {company_name} Corporate Development Team,

My name is {SENDER_NAME}, a software developer from Bangladesh
and the creator and owner of Seed Code Chat and Seed Code CLI.

I am reaching out to explore a potential strategic acquisition
of both products, subject to ownership, licensing and third-party
dependency review.

Seed Code Chat:
https://seedcode-chat.vercel.app/
https://seedcode-app.vercel.app/

Seed Code CLI:
https://seedcode-cli.vercel.app/
https://seedcode-web.vercel.app/

GitHub:
https://github.com/Alshahriar-07

I would welcome the opportunity to provide a product demonstration,
technical overview and further information for your evaluation.

Best regards,
{SENDER_NAME}
{SENDER_EMAIL}
"""

    message.set_content(plain_text)

    # Attach the complete HTML design.
    message.add_alternative(html_content, subtype="html")

    return message


# =========================================================
# EMAIL SENDING
# =========================================================

def send_email(message: EmailMessage, app_password: str) -> None:
    """Authenticate with Gmail and send the email securely."""

    with smtplib.SMTP_SSL(
        SMTP_SERVER,
        SMTP_PORT,
        timeout=30,
    ) as server:

        server.login(SENDER_EMAIL, app_password)
        server.send_message(message)


# =========================================================
# MAIN
# =========================================================

def main() -> None:
    print("=" * 58)
    print("             SEED CODE HTML EMAIL SENDER")
    print("=" * 58)

    # Load Gmail App Password.
    app_password = os.getenv("GAPP_PASS", "").strip()

    if not app_password:
        print("\nERROR: GAPP_PASS was not found in .env.")
        print("Add GAPP_PASS=your_app_password to your .env file.")
        return

    # Collect recipient information.
    company_name = get_required_input("\nCompany Name: ")
    receiver_email = get_valid_email("Receiver Email: ")

    try:
        # Prepare personalized HTML.
        html_content = load_html_template(company_name)

        # Build multipart email.
        message = build_email(
            receiver_email=receiver_email,
            company_name=company_name,
            html_content=html_content,
        )

    except (OSError, ValueError) as error:
        print(f"\nERROR: Could not prepare email: {error}")
        return

    # Display summary and request confirmation.
    print("\n" + "-" * 58)
    print("EMAIL SUMMARY")
    print("-" * 58)
    print(f"Sender:   {SENDER_NAME} <{SENDER_EMAIL}>")
    print(f"Company:  {company_name}")
    print(f"Receiver: {receiver_email}")
    print(f"Subject:  {EMAIL_SUBJECT}")
    print("Format:   HTML + Plain Text")
    print("-" * 58)

    confirmation = input(
        "\nType YES to send this email: "
    ).strip()

    if confirmation != "YES":
        print("\nEmail sending cancelled.")
        return

    try:
        print("\nConnecting to Gmail SMTP...")

        send_email(message, app_password)

        print("\nSUCCESS: Email sent successfully!")
        print(f"Recipient: {receiver_email}")

    except smtplib.SMTPAuthenticationError:
        print("\nERROR: Gmail authentication failed.")
        print("Check GAPP_PASS and your Google Account settings.")

    except smtplib.SMTPRecipientsRefused:
        print("\nERROR: Gmail rejected the recipient address.")

    except (smtplib.SMTPException, OSError) as error:
        print(f"\nERROR: Email could not be sent: {error}")


if __name__ == "__main__":
    main()
