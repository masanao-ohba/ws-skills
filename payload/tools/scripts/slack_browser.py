"""Collect a Slack conversation by driving a browser (no API token needed).

Slack's Web API needs an app installed in the workspace, which plenty of
organizations do not grant. This backend drives a Playwright-owned Chromium
instead — a separate browser profile, so the browser you sign in with day to day
is untouched.

    <tools> slack --channel C0123456789 --since 2026-04-01 --label release
    <tools> slack --channel D0123456789 --from-app --team-id T0123456789
    <tools> channels --query release

Sessions: `state.json` in the tooling home (written by `slack-signin`, or by the
scripted login when SLACK_EMAIL / SLACK_PASSWORD are set). `--from-app` borrows the
desktop app's live session instead, which is the only way in for a workspace that
signs in through Google — Playwright cannot drive that flow.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import slack_output
import ws_paths
from slack_scraper import auth, browser as browser_mod, downloader, scraper


def _settings(team_id: str | None) -> dict:
    return {
        "workspace": ws_paths.lookup("SLACK_WORKSPACE") or "",
        "email": ws_paths.lookup("SLACK_EMAIL") or "",
        "password": ws_paths.lookup("SLACK_PASSWORD") or "",
        # The `d` cookie authenticates app.slack.com as a whole, so any workspace the
        # account belongs to is reachable at app.slack.com/client/<team>/<channel>.
        # --team-id overrides the default to collect from a second workspace.
        "team_id": team_id or ws_paths.lookup("SLACK_TEAM_ID") or "",
        "method": ws_paths.lookup("SLACK_AUTH_METHOD") or "sso",
    }


def _state_path(from_app: bool) -> tuple[str | None, Path | None]:
    """Return (storage_state path, temp file to delete afterwards)."""
    if not from_app:
        saved = auth.state_file()
        return (str(saved) if saved.exists() else None, None)

    import slack_cookies

    # Auth cookies: written to a temp file and deleted as soon as the run ends.
    fd, tmp = tempfile.mkstemp(suffix="-slack-app-state.json")
    os.close(fd)
    app_state = Path(tmp)
    slack_cookies.export_state(app_state)
    print("[slack] using the Slack desktop app session (no scripted login)")
    return str(app_state), app_state


def fetch(
    channel_id: str,
    label: str | None = None,
    headless: bool = False,
    since: str | None = None,
    team_id: str | None = None,
    from_app: bool = False,
) -> Path:
    from playwright.sync_api import sync_playwright

    cfg = _settings(team_id)
    if not cfg["team_id"]:
        raise SystemExit(
            "[slack] no team id: pass --team-id T0123456789 or set SLACK_TEAM_ID "
            "(the T... segment of a conversation URL)"
        )

    state_path, temp_state = _state_path(from_app)
    print(f"[slack] channel={cfg['team_id']}/{channel_id}")

    messages = []
    try:
        with sync_playwright() as p:
            chromium = p.chromium.launch(headless=headless, slow_mo=100)
            context = chromium.new_context(
                storage_state=state_path,
                viewport={"width": 1280, "height": 900},
                locale=ws_paths.lookup("SLACK_LOCALE") or "en-US",
            )
            page = context.new_page()
            try:
                if not from_app:
                    auth.authenticate(
                        page, cfg["workspace"], cfg["email"], cfg["password"], cfg["method"]
                    )
                messages = scraper.collect(page, cfg["team_id"], channel_id, since)
                if messages:
                    downloader.download_assets(messages, ws_paths.raw_source())
            finally:
                context.close()
                chromium.close()
    finally:
        if temp_state and temp_state.exists():
            temp_state.unlink()

    if not messages:
        sys.exit("[slack] no messages found in range")

    return slack_output.write_snapshot(
        [m.to_dict() for m in messages],
        backend="browser",
        team_id=cfg["team_id"],
        channel_id=channel_id,
        workspace=cfg["workspace"] or None,
        since=since,
        label=label,
    )


def list_channels(query: str | None = None, headless: bool = False) -> list[dict]:
    """Print the sidebar's channels and DMs with their IDs.

    Conversation IDs are otherwise only visible by opening each one by hand, which
    is the blocker whenever a conversation moves to a newly created channel. Only
    what the sidebar shows is listed — muted or unjoined channels will not appear.
    """
    from playwright.sync_api import sync_playwright

    cfg = _settings(None)
    if not cfg["team_id"]:
        raise SystemExit("[slack] SLACK_TEAM_ID is not set")
    state_path = str(auth.state_file()) if auth.state_file().exists() else None

    with sync_playwright() as p:
        chromium = p.chromium.launch(headless=headless, slow_mo=100)
        context = chromium.new_context(
            storage_state=state_path,
            viewport={"width": 1280, "height": 900},
            locale=ws_paths.lookup("SLACK_LOCALE") or "en-US",
        )
        page = context.new_page()
        try:
            auth.authenticate(page, cfg["workspace"], cfg["email"], cfg["password"], cfg["method"])
            page.goto(
                f"https://app.slack.com/client/{cfg['team_id']}",
                wait_until="domcontentloaded",
                timeout=30_000,
            )
            page.wait_for_selector('[data-qa="virtual-list-item"]', timeout=30_000)
            page.wait_for_timeout(8_000)  # rows keep appearing well after the first renders

            # Slack restores the sidebar's previous scroll position, usually near the
            # bottom. Rewind to the top so the downward sweep covers the whole list.
            page.evaluate("""() => {
                const pane = document.querySelector('[data-qa="slack_kit_scrollbar"]');
                if (pane) pane.scrollTop = 0;
            }""")
            browser_mod.human_delay(1.0, 1.5)

            seen: dict[str, str] = {}
            # Sidebar rows are divs, not anchors — the ID lives in a data attribute.
            # The list is virtualised, so entries exist in the DOM only while on screen.
            for _ in range(40):
                for item in page.eval_on_selector_all(
                    "[data-qa-channel-sidebar-channel-id]",
                    """els => els.map(e => ({
                        id: e.getAttribute('data-qa-channel-sidebar-channel-id'),
                        name: e.innerText.trim(),
                    }))""",
                ):
                    cid = item["id"]
                    if cid and cid not in seen:
                        seen[cid] = (item["name"] or "").split("\n")[0]
                moved = page.evaluate("""() => {
                    const pane = document.querySelector('[data-qa="slack_kit_scrollbar"]');
                    if (!pane) return false;
                    const before = pane.scrollTop;
                    pane.scrollTop = before + 300;
                    return pane.scrollTop > before;
                }""")
                browser_mod.human_delay(0.5, 0.9)
                if not moved:
                    break
        finally:
            context.close()
            chromium.close()

    rows = [{"id": cid, "name": name} for cid, name in sorted(seen.items(), key=lambda kv: kv[1])]
    if query:
        rows = [r for r in rows if query.lower() in r["name"].lower()]

    for r in rows:
        print(f"{r['id']}\t{r['name']}")
    print(f"[slack] {len(rows)} conversations")
    return rows
