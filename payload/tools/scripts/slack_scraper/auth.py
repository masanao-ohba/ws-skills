"""Slack Web authentication via Playwright.

The saved session (a Playwright storage_state) lives in the config home, not in
the working directory, so collection can be run from any project.
"""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import Page, TimeoutError as PwTimeout

import ws_paths


def state_file() -> Path:
    return ws_paths.slack_state_file()


def try_restore_session(page: Page, workspace: str) -> bool:
    """Navigate to Slack and check whether saved cookies give an active session."""
    slack_url = f"https://{workspace}.slack.com"
    page.goto(slack_url, wait_until="domcontentloaded", timeout=30_000)
    try:
        page.wait_for_selector(
            '[data-qa="message_input"], [data-qa="channel_sidebar"]', timeout=15_000
        )
        return True
    except PwTimeout:
        return False


def login_sso(page: Page, workspace: str, email: str, password: str) -> None:
    """Log in through a SAML/SSO identity provider (Entra ID, Okta, Google...)."""
    slack_url = f"https://{workspace}.slack.com"
    page.goto(slack_url, wait_until="domcontentloaded", timeout=30_000)

    # Slack shows various SSO buttons; try the common patterns.
    sso_btn = page.locator(
        'a[data-qa="sign_in_with_saml"], '
        'a[href*="saml"], '
        'a:has-text("Microsoft"), '
        'a:has-text("Okta"), '
        'a:has-text("SSO")'
    ).first
    sso_btn.click(timeout=10_000)

    # An account picker may appear when several accounts are cached in the browser.
    # Click the tile matching `email`; if there is no picker, fall through.
    try:
        picker_tile = page.locator(
            f'div[data-test-id="account-tile"]:has-text("{email}"), '
            f'div[role="button"]:has-text("{email}"), '
            f'[role="link"]:has-text("{email}"), '
            f'div.tile:has-text("{email}"), '
            f'small:has-text("{email}")'
        ).first
        picker_tile.wait_for(state="visible", timeout=5_000)
        picker_tile.click()
        print(f"[auth] Account picker: clicked tile for {email}")
    except PwTimeout:
        pass

    # Identity provider login page — fill the email if it is asked for.
    try:
        email_input = page.locator('input[type="email"], input[name="loginfmt"]')
        email_input.wait_for(state="visible", timeout=10_000)
        email_input.fill(email)
        page.locator('input[type="submit"], button[type="submit"]').first.click()
    except PwTimeout:
        pass  # may be auto-filled from a device session

    # Password page, if there is one.
    try:
        pw_input = page.locator('input[type="password"], input[name="passwd"]')
        pw_input.wait_for(state="visible", timeout=10_000)
        pw_input.fill(password)
        page.locator('input[type="submit"], button[type="submit"]').first.click()
    except PwTimeout:
        pass  # may be skipped (device SSO)

    # "Stay signed in?" prompt.
    try:
        page.locator('input[type="submit"][value="Yes"], button:has-text("Yes")').click(timeout=5_000)
    except PwTimeout:
        pass

    print("[auth] Waiting for Slack to load after SSO login...")
    print("[auth] If MFA is required, complete it in the browser window.")
    page.wait_for_selector(
        '[data-qa="message_input"], [data-qa="channel_sidebar"]', timeout=120_000
    )
    print("[auth] Login successful.")


def login_email_code(page: Page, workspace: str, email: str, password: str) -> None:
    """Log in with email + password + the verification code Slack emails."""
    slack_url = f"https://{workspace}.slack.com"
    page.goto(slack_url, wait_until="domcontentloaded", timeout=30_000)

    page.locator('input[data-qa="login_email"], input[type="email"]').first.fill(email)
    page.locator('input[data-qa="login_password"], input[type="password"]').first.fill(password)
    page.locator('button[data-qa="signin_button"], button[type="submit"]').first.click()

    print("[auth] Check your email for a verification code from Slack.")
    code = input("[auth] Enter the verification code: ").strip()

    code_input = page.locator(
        'input[data-qa="confirmation_code_input"], input[inputmode="numeric"]'
    ).first
    code_input.fill(code)

    # Some flows auto-submit; if not, click confirm.
    try:
        page.locator(
            'button[data-qa="confirmation_code_submit"], button[type="submit"]'
        ).first.click(timeout=3_000)
    except PwTimeout:
        pass

    page.wait_for_selector(
        '[data-qa="message_input"], [data-qa="channel_sidebar"]', timeout=60_000
    )
    print("[auth] Login successful.")


def save_storage_state(page: Page) -> None:
    """Save cookies/storage so later runs are unattended."""
    path = state_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(page.context.storage_state(), indent=2))
    path.chmod(0o600)
    print(f"[auth] Session saved to {path}")


def authenticate(page: Page, workspace: str, email: str, password: str, method: str) -> None:
    """Restore the saved session if it still works, otherwise log in and save one."""
    if state_file().exists():
        print("[auth] Attempting session restore from saved state...")
        if try_restore_session(page, workspace):
            print("[auth] Session restored successfully.")
            return
        print("[auth] Saved session expired. Proceeding with login...")

    if not email or not password:
        raise SystemExit(
            "[auth] no usable session and no SLACK_EMAIL / SLACK_PASSWORD to log in with.\n"
            "       Run `slack-signin --url https://<workspace>.slack.com/` once to sign in "
            "by hand, or use --from-app to borrow the desktop app's session."
        )

    if method == "email_code":
        login_email_code(page, workspace, email, password)
    else:
        login_sso(page, workspace, email, password)

    save_storage_state(page)
