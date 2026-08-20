"""Collect a Slack conversation by driving a browser (no API token needed).

Drives a Playwright-owned Chromium on its own profile, leaving the everyday
browser untouched.

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
import re
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

import slack_channels
import slack_output
import ws_paths
from slack_scraper import auth, browser as browser_mod, downloader, scraper

# app.slack.com/client/<team>/<conversation> — what a deep link settles on.
CONVERSATION_URL = re.compile(r"/client/[^/]+/([CGD][A-Z0-9]+)")

# The conversation header's title, read to confirm where a deep link landed.
CHANNEL_HEADER = '[data-qa="channel_name"], .p-view_header__channel_title'


def _settings(team_id: str | None) -> dict:
    return {
        "workspace": ws_paths.lookup("SLACK_WORKSPACE") or "",
        "email": ws_paths.lookup("SLACK_EMAIL") or "",
        "password": ws_paths.lookup("SLACK_PASSWORD") or "",
        # The `d` cookie authenticates app.slack.com as a whole, so every workspace
        # the account belongs to is reachable — `team_id` picks which one.
        "team_id": team_id or ws_paths.lookup("SLACK_TEAM_ID") or "",
        "method": ws_paths.lookup("SLACK_AUTH_METHOD") or "sso",
    }


def _use_app_session(from_app: bool) -> bool:
    """--from-app, or SLACK_FROM_APP for a workspace that always needs it."""
    if from_app:
        return True
    return (ws_paths.lookup("SLACK_FROM_APP") or "").strip() == "1"


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


def _require_team(cfg: dict) -> str:
    if not cfg["team_id"]:
        raise SystemExit(
            "[slack] no team id: pass --team-id T0123456789 or set SLACK_TEAM_ID "
            "(the T... segment of a conversation URL)"
        )
    return cfg["team_id"]


@contextmanager
def _session(cfg: dict, from_app: bool, headless: bool):
    """A Slack page that is already signed in, closed when the block ends."""
    from playwright.sync_api import sync_playwright

    state_path, temp_state = _state_path(from_app)
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
                yield page
            finally:
                context.close()
                chromium.close()
    finally:
        if temp_state and temp_state.exists():
            temp_state.unlink()


def resolve_channel(
    name: str,
    team_id: str | None = None,
    headless: bool = True,
    from_app: bool = False,
) -> str:
    """Look up one channel ID by name, through Slack's own deep link.

    Reaches channels the sidebar never shows: muted, unjoined, or below the fold.
    """
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    cfg = _settings(team_id)
    team = _require_team(cfg)
    from_app = _use_app_session(from_app)
    name = slack_channels.normalize(name)

    with _session(cfg, from_app, headless) as page:
        page.goto(
            f"https://slack.com/app_redirect?channel={quote(name)}&team={team}",
            wait_until="domcontentloaded",
            timeout=60_000,
        )
        try:
            page.wait_for_url(CONVERSATION_URL, timeout=30_000)
        except PlaywrightTimeout:
            raise SystemExit(
                f"[slack] could not resolve '{name}' in {team}. The name may be wrong, "
                "or the account may not be able to see that channel."
            ) from None
        found = CONVERSATION_URL.search(page.url)

        # The URL only proves this is *a* conversation, not the one asked for.
        try:
            header = page.wait_for_selector(CHANNEL_HEADER, timeout=15_000)
        except PlaywrightTimeout:
            raise SystemExit(
                f"[slack] resolved '{name}' to a conversation but could not read its "
                "header to confirm it — not caching this ID"
            ) from None
        landed = slack_channels.normalize(header.inner_text())
        if landed != name:
            raise SystemExit(
                f"[slack] asked for '{name}' but the deep link landed on '{landed}' "
                f"in {team} — not caching this ID"
            )

    channel_id = found.group(1)
    print(f"[slack] {name} -> {channel_id}")
    return channel_id


def fetch(
    channel_id: str,
    label: str | None = None,
    headless: bool = False,
    since: str | None = None,
    team_id: str | None = None,
    from_app: bool = False,
) -> Path:
    cfg = _settings(team_id)
    _require_team(cfg)
    from_app = _use_app_session(from_app)
    print(f"[slack] channel={cfg['team_id']}/{channel_id}")

    messages = []
    with _session(cfg, from_app, headless) as page:
        messages = scraper.collect(page, cfg["team_id"], channel_id, since)
        if messages:
            downloader.download_assets(
                messages, ws_paths.ensure_output_dir(ws_paths.raw_source())
            )

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


def list_channels(
    query: str | None = None,
    headless: bool = False,
    team_id: str | None = None,
    from_app: bool = False,
) -> list[dict]:
    """Print the sidebar's channels and DMs with their IDs, for browsing what is there.

    A name that is already known goes through `resolve_channel` instead.
    """
    cfg = _settings(team_id)
    team = _require_team(cfg)
    from_app = _use_app_session(from_app)

    seen: dict[str, str] = {}
    with _session(cfg, from_app, headless) as page:
        page.goto(
            f"https://app.slack.com/client/{team}",
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

    rows = [{"id": cid, "name": name} for cid, name in sorted(seen.items(), key=lambda kv: kv[1])]
    if query:
        rows = [r for r in rows if query.lower() in r["name"].lower()]

    for r in rows:
        print(f"{r['id']}\t{r['name']}")
    print(f"[slack] {len(rows)} conversations")
    return rows
