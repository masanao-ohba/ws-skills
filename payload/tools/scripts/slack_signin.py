"""Sign in to a Slack workspace by hand, once, and keep the session.

For when the scripted login does not apply — a workspace behind Google sign-in, or
one that always asks for a second factor. Every later run is then unattended.

    <tools> slack-signin --url https://<workspace>.slack.com/

Cookies already in the saved session are carried into the window and written back
alongside the new ones, so authorizing a second workspace never costs the first.
"""

from __future__ import annotations

import json
import shutil
import sys
import time

from slack_scraper import auth

# Long enough to work through a sign-in that may include a second factor.
SIGNIN_TIMEOUT_S = 420


def signin(url: str) -> None:
    from playwright.sync_api import sync_playwright

    state_file = auth.state_file()
    state_file.parent.mkdir(parents=True, exist_ok=True)
    if state_file.exists():
        backup = state_file.with_name("state.before-signin.json")
        shutil.copy2(state_file, backup)
        print(f"[signin] current session backed up to {backup}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=50)
        context = browser.new_context(
            storage_state=str(state_file) if state_file.exists() else None,
            viewport={"width": 1280, "height": 900},
        )
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)

        print()
        print("=" * 70)
        print("  Complete the sign-in in the browser window that just opened.")
        print("  Waiting until the workspace itself is on screen.")
        print("=" * 70)
        print(flush=True)

        deadline = time.time() + SIGNIN_TIMEOUT_S
        while time.time() < deadline:
            if "/client/" in page.url:
                break
            time.sleep(3)
        else:
            context.close()
            browser.close()
            sys.exit("[signin] the workspace never loaded; nothing was saved")

        page.wait_for_timeout(6_000)
        team_id = next(
            (part for part in page.url.split("/") if part.startswith("T") and len(part) >= 9),
            None,
        )
        state_file.write_text(json.dumps(context.storage_state(), indent=2), encoding="utf-8")
        state_file.chmod(0o600)
        print(f"[signin] session saved to {state_file}")
        print(f"[signin] team id: {team_id}  (put it in SLACK_TEAM_ID, or pass --team-id)")
        print(f"[signin] url: {page.url}")

        context.close()
        browser.close()
