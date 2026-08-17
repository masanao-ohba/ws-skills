---
name: ws-slack
description: Fetch Slack channels, DMs, and threads as JSON, through either the Slack Web API (with a token) or browser automation (no token needed). Use when the user wants Slack logs retrieved, a channel saved, or a conversation archived. Also invocable as a command via /ws-slack followed by instructions.
---

# ws-slack

Collect Slack messages, thread replies, and reactions into JSON.

## Two backends

| backend | needs | when |
|---|---|---|
| `api` | `SLACK_TOKEN` with the history/read scopes | the workspace lets you install an app. Faster, exact timestamps, no browser |
| `browser` | a saved Slack session | no app permission — Playwright drives its own Chromium |

Default: `api` when `SLACK_TOKEN` is set, otherwise `browser`. Override per run with
`--backend`, or set `WS_SLACK_BACKEND`.

Both write the same snapshot shape, so downstream reading never has to care which
one ran. Two documented differences on the API side: reaction `image_url` is empty
(the API returns emoji names, not URLs), and attachment URLs are `url_private`,
which needs the token to download.

## Usage

```bash
WS="uv run --project ~/.config/ws-skills/tools python ~/.config/ws-skills/tools/main.py"

# a channel, bounded by date
$WS slack --channel C0123456789 --since 2026-04-01 --label release

# a second workspace (the saved session reaches every workspace the account is in)
$WS slack --channel C0123456789 --team-id T0123456789 --since 2026-04-01

# browser backend, unattended
$WS slack --channel D0123456789 --headless

# browser backend, borrowing the desktop app's live session (macOS)
$WS slack --channel C0123456789 --from-app --team-id T0123456789

# conversation IDs
$WS channels --query release
```

Output lands in `references/raw-source/` under the current working directory
(`WS_OUTPUT_DIR` overrides it). Re-running on the same day never overwrites an
earlier snapshot — a suffix is added.

**Always pass `--since` for a channel.** Without it, collection runs to the very
beginning of the conversation, which on a long-lived channel is hundreds of
messages and, on the browser backend, hundreds of scrolls.

## Sessions (browser backend)

```bash
$WS slack-signin --url https://<workspace>.slack.com/   # sign in by hand, once
```

The saved session is `~/.config/ws-skills/slack/state.json`. A scripted login runs
instead when `SLACK_EMAIL` / `SLACK_PASSWORD` are set (`SLACK_AUTH_METHOD=sso` or
`email_code`). A workspace behind Google sign-in cannot be scripted at all — use
`slack-signin`, or `--from-app`.

## Pitfalls

- Resolving a channel ID: `https://<workspace>.slack.com/app_redirect?channel=<name>`,
  or `channels`. The sidebar sweep only sees what the sidebar shows — a muted or
  unjoined channel will not appear there (the API backend lists those too).
- Browser backend: the newest timestamp on a freshly opened conversation is the
  *last-read* position, not the newest message. Collection scrolls to the bottom
  first, so trust the snapshot rather than the window.
- API backend: a bot token must be invited to a private channel before it can read
  it, and history scopes are per conversation type (`channels:` public, `groups:`
  private, `im:` DMs, `mpim:` group DMs).
- After leaving a workspace, its channels are unreachable; DMs may remain.
