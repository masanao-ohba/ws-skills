"""Collect a Slack conversation through the Slack Web API.

This is the backend to prefer when your workspace lets you install an app: it is
faster, needs no browser, and returns exact timestamps. It requires a token
(`SLACK_TOKEN`, user `xoxp-` or bot `xoxb-`) with, for what is read here:

    channels:history  groups:history  im:history  mpim:history   (message text)
    channels:read     groups:read     im:read     mpim:read      (conversation list)
    users:read                                                   (display names)

A bot token also has to be invited to a private channel before it can read it.
Everything here is read-only: only `*.history`, `*.replies`, `*.list` and
`users.info` are called.

    <tools> slack --channel C0123456789 --since 2026-04-01 --backend api

Output matches the browser backend's snapshot shape. Where it cannot, the
difference is structural, not accidental:

    user_id                 API only — the DOM does not carry user ids
    inline_emoji            browser only — the API renders emoji into the text
    thread_replies_failed   browser only — a failed API read raises instead of
                            returning a thread with its replies missing
    avatar_url              always empty; the scraper downloads avatars, this does not
    reactions[].count       API only, but `image_url` is empty (the API returns
                            emoji names, not URLs, so there is nothing to download)
    attachments[].url       `url_private`, which needs the token to download; there
                            is no `local_path` because nothing is downloaded here

The normalization is covered by fixture tests (`tools/tests/test_slack_api.py`);
the live calls have been exercised against a real workspace with a user token.
Report anything that looks wrong.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import slack_output
import ws_paths

API_BASE = "https://slack.com/api/"
PAGE_SIZE = 200
MAX_RETRIES = 5

TOKEN_HINT = (
    "Create a Slack app, add the history/read scopes, install it to the workspace, "
    "and put the token in SLACK_TOKEN. See the README section 'Slack authorization'."
)


class SlackApiError(RuntimeError):
    pass


# --- pure helpers (covered by tools/tests/test_slack_api.py) ---------------------


def to_iso(ts: str | float) -> str:
    """Slack's `1712345678.123456` epoch string -> ISO 8601 UTC."""
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return str(ts)


def to_epoch(date: str) -> str:
    """`YYYY-MM-DD` -> the epoch second of that day's UTC midnight.

    UTC, so the boundary matches the browser backend's.
    """
    dt = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return str(int(dt.timestamp()))


_MENTION = re.compile(r"<([@#!])([^>|]+)(?:\|([^>]*))?>")
_LINK = re.compile(r"<(https?://[^>|]+)(?:\|([^>]*))?>")


def render_text(text: str, users: dict[str, str] | None = None) -> str:
    """Turn Slack's markup into what a reader saw.

    `<@U123>` becomes the display name when known, `<#C1|general>` becomes
    `#general`, and `<http://x|label>` becomes `label`. Unknown ids are kept as
    `@U123` rather than dropped.
    """
    users = users or {}

    def _mention(m: re.Match) -> str:
        kind, ident, label = m.group(1), m.group(2), m.group(3)
        if kind == "@":
            return "@" + (label or users.get(ident) or ident)
        if kind == "#":
            return "#" + (label or ident)
        return "@" + (label or ident)  # <!here>, <!channel>, <!subteam^...>

    out = _LINK.sub(lambda m: m.group(2) or m.group(1), text or "")
    out = _MENTION.sub(_mention, out)
    return out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def sender_name(raw: dict, users: dict[str, str] | None = None) -> str:
    """Display name for a message: a person, a bot, or the raw id as a last resort."""
    users = users or {}
    if raw.get("user") and users.get(raw["user"]):
        return users[raw["user"]]
    profile = raw.get("bot_profile") or {}
    return raw.get("username") or profile.get("name") or raw.get("user") or raw.get("bot_id") or ""


def normalize_message(raw: dict, users: dict[str, str] | None = None) -> dict:
    """One API message -> the snapshot's message shape (same keys as the scraper)."""
    users = users or {}
    reactions = [
        {"name": r.get("name", ""), "image_url": "", "count": r.get("count", 0)}
        for r in raw.get("reactions", [])
    ]
    attachments = [
        {"name": f.get("name") or f.get("title") or "", "url": f.get("url_private", "")}
        for f in raw.get("files", [])
    ]
    message = {
        "timestamp": to_iso(raw.get("ts", "")),
        "sender": sender_name(raw, users),
        "text": render_text(raw.get("text", ""), users),
        "avatar_url": "",
        "reactions": reactions,
        "attachments": attachments,
        "slack_ts": raw.get("ts", ""),
        "user_id": raw.get("user", ""),
    }
    # The scraper marks thread parents the same way (parser.py).
    if has_thread(raw):
        message["has_thread"] = True
    return message


def has_thread(raw: dict) -> bool:
    """True for a thread parent — a reply carries thread_ts but is not the parent."""
    return bool(raw.get("thread_ts")) and raw.get("thread_ts") == raw.get("ts") and (
        raw.get("reply_count") or 0
    ) > 0


# --- API calls ------------------------------------------------------------------


def token() -> str:
    return ws_paths.require("SLACK_TOKEN", TOKEN_HINT)


def call(method: str, params: dict | None = None, tok: str | None = None) -> dict:
    """One GET against the Slack Web API, with rate-limit backoff."""
    tok = tok or token()
    query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
    req = urllib.request.Request(
        f"{API_BASE}{method}?{query}",
        method="GET",
        headers={"Authorization": f"Bearer {tok}"},
    )
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < MAX_RETRIES - 1:
                wait = int(e.headers.get("Retry-After") or 0) or 5 * (attempt + 1)
                print(f"[slack-api] rate limited; retrying in {wait}s")
                time.sleep(wait)
                continue
            raise SlackApiError(f"[slack-api] {method} -> HTTP {e.code}") from e

        if body.get("ok"):
            return body
        if body.get("error") == "ratelimited" and attempt < MAX_RETRIES - 1:
            time.sleep(5 * (attempt + 1))
            continue
        raise SlackApiError(f"[slack-api] {method} -> {body.get('error')}")
    raise SlackApiError(f"[slack-api] {method}: gave up after {MAX_RETRIES} attempts")


def _paged(method: str, params: dict, key: str, tok: str) -> list[dict]:
    out: list[dict] = []
    cursor = None
    while True:
        body = call(method, {**params, "limit": PAGE_SIZE, "cursor": cursor}, tok)
        out.extend(body.get(key, []))
        cursor = (body.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            return out


class _Users:
    """Display names, looked up once per id and remembered."""

    def __init__(self, tok: str) -> None:
        self._tok = tok
        self.names: dict[str, str] = {}

    def resolve(self, user_ids: set[str]) -> dict[str, str]:
        for uid in sorted(user_ids):
            if not uid or uid in self.names:
                continue
            try:
                user = call("users.info", {"user": uid}, self._tok)["user"]
            except SlackApiError as e:
                print(f"[slack-api] {e} (keeping the raw id)")
                self.names[uid] = uid
                continue
            profile = user.get("profile") or {}
            self.names[uid] = (
                profile.get("display_name")
                or profile.get("real_name")
                or user.get("real_name")
                or user.get("name")
                or uid
            )
        return self.names


def fetch(
    channel_id: str,
    label: str | None = None,
    since: str | None = None,
    team_id: str | None = None,
) -> Path:
    tok = token()
    team_id = team_id or ws_paths.lookup("SLACK_TEAM_ID") or ""

    params = {"channel": channel_id, "inclusive": "true"}
    if since:
        params["oldest"] = to_epoch(since)
    print(f"[slack-api] channel={channel_id}" + (f" since={since}" if since else ""))

    raw_messages = _paged("conversations.history", params, "messages", tok)
    raw_messages.sort(key=lambda m: float(m.get("ts", 0)))
    print(f"[slack-api] {len(raw_messages)} messages")

    parents = [m for m in raw_messages if has_thread(m)]
    replies: dict[str, list[dict]] = {}
    if parents:
        print(f"[slack-api] fetching {len(parents)} threads")
        for i, parent in enumerate(parents):
            thread = _paged(
                "conversations.replies", {"channel": channel_id, "ts": parent["ts"]}, "messages", tok
            )
            # The first item is the parent message itself.
            replies[parent["ts"]] = [m for m in thread if m.get("ts") != parent["ts"]]
            print(f"[thread] ({i + 1}/{len(parents)}) {len(replies[parent['ts']])} replies")

    user_ids = {m.get("user", "") for m in raw_messages}
    for thread in replies.values():
        user_ids |= {m.get("user", "") for m in thread}
    users = _Users(tok).resolve(user_ids)

    messages: list[dict] = []
    for raw in raw_messages:
        msg = normalize_message(raw, users)
        thread = replies.get(raw.get("ts", ""))
        if thread:
            msg["thread_replies"] = [normalize_message(r, users) for r in thread]
        messages.append(msg)

    if not messages:
        raise SystemExit("[slack-api] no messages found in range")

    return slack_output.write_snapshot(
        messages,
        backend="api",
        team_id=team_id,
        channel_id=channel_id,
        workspace=ws_paths.lookup("SLACK_WORKSPACE"),
        since=since,
        label=label,
    )


def resolve_channel(name: str, team_id: str | None = None) -> str:
    """Look up one channel ID by name.

    There is no name-to-ID endpoint, so this pages `conversations.list` and matches
    exactly. Callers cache the answer.
    """
    import slack_channels

    wanted = slack_channels.normalize(name)
    tok = token()
    convs = _paged(
        "conversations.list",
        {"types": "public_channel,private_channel", "exclude_archived": "false"},
        "channels",
        tok,
    )
    for c in convs:
        if (c.get("name") or "") == wanted:
            print(f"[slack-api] {wanted} -> {c['id']}")
            return c["id"]

    raise SystemExit(
        f"[slack-api] no channel named '{wanted}'. A private channel is only listed "
        "once the token's app has been invited to it."
    )


def list_channels(query: str | None = None) -> list[dict]:
    """List conversations the token can see, with their IDs."""
    tok = token()
    convs = _paged(
        "conversations.list",
        {"types": "public_channel,private_channel,mpim,im", "exclude_archived": "false"},
        "channels",
        tok,
    )

    users = _Users(tok)
    users.resolve({c.get("user", "") for c in convs if c.get("is_im")})

    rows = []
    for c in convs:
        name = c.get("name") or (users.names.get(c.get("user", "")) or c.get("user", ""))
        prefix = "DM " if c.get("is_im") else ("MPDM " if c.get("is_mpim") else "")
        rows.append({"id": c["id"], "name": f"{prefix}{name}"})

    rows.sort(key=lambda r: r["name"])
    if query:
        rows = [r for r in rows if query.lower() in r["name"].lower()]

    for r in rows:
        print(f"{r['id']}\t{r['name']}")
    print(f"[slack-api] {len(rows)} conversations")
    return rows
