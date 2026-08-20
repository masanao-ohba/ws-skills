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
T=~/.claude/skills/ws-slack/tools
WS="uv run --project $T python $T/main.py"

# a channel by name, bounded by date — this is the normal call
$WS slack --channel release --since 2026-04-01

# an ID works the same way
$WS slack --channel C0123456789 --since 2026-04-01 --label release

# a second workspace (the saved session reaches every workspace the account is in)
$WS slack --channel release --team-id T0123456789 --since 2026-04-01

# browser backend, unattended
$WS slack --channel D0123456789 --headless

# browser backend, borrowing the desktop app's live session (macOS)
$WS slack --channel release --from-app --team-id T0123456789

# browse what exists, when the name is not known yet
$WS channels --query release
```

**`--channel` takes the name the user said.** `release`, `#release` and
`C0123456789` are all accepted; a name is resolved through Slack's own deep link,
which takes one page load and finds muted and unjoined channels too. The answer is
kept in `~/.config/ws-skills/slack/channels.json` per workspace, so the same name
costs nothing on every later run. Delete that file if a channel is renamed and a
stale entry starts pointing at the wrong conversation.

There is never a reason to go looking for a channel ID any other way. Reading the
Slack desktop app's local files, opening a browser by some other route, or reading
this tooling's own source is not part of the job — pass the name to `--channel`
and let the lookup happen. If it fails, the name is wrong or the account cannot see
the channel; say so rather than starting a search.

Output lands in `references/raw-source/` under the current working directory
(`WS_OUTPUT_DIR` overrides it). The directory is created with a `.gitignore` that
excludes it from the project's repository. Re-running on the same day never
overwrites an earlier snapshot — a suffix is added.

**Always pass `--since` for a channel.** Without it, collection runs to the very
beginning of the conversation, which on a long-lived channel is hundreds of
messages and, on the browser backend, hundreds of scrolls.

## Sessions (browser backend)

Setup decides where the session comes from, and it is already in place before a
collection runs:

- `SLACK_FROM_APP=1` — the Slack **desktop app's** live session is decrypted and
  used (macOS). This is the only way into a workspace that signs in through
  Google, which refuses to authenticate inside an automated browser. Nothing to
  do per run; just keep the desktop app signed in.
- a saved `~/.config/ws-skills/slack/state.json`, from a one-time manual sign-in
- `SLACK_EMAIL` / `SLACK_PASSWORD`, driving a scripted login

**Never run `slack-signin` yourself** — it opens a browser window and waits for a
person. If a run fails for want of a session, ask the user to run
`npx @masanao-ohba/ws-skills auth`, which walks them through it.

`--from-app` forces the desktop-app session for one run even when the setting is off.

## Pitfalls

- `channels` sweeps the sidebar, which takes about a minute and only sees what the
  sidebar shows — a muted or unjoined channel is not there (the API backend lists
  those too). It is for browsing, not for looking up a name already known.
- Browser backend: the newest timestamp on a freshly opened conversation is the
  *last-read* position, not the newest message. Collection scrolls to the bottom
  first, so trust the snapshot rather than the window.
- Browser backend: opening a thread fails intermittently. It is retried three
  times; if it still will not open, the message carries `thread_replies_failed`,
  the envelope's `thread_failure_count` says how many, and the run ends with a
  warning. **A snapshot with a non-zero count is incomplete** — re-run it before
  drawing conclusions, and say so if you report from it anyway.
- API backend: a bot token must be invited to a private channel before it can read
  it, and history scopes are per conversation type (`channels:` public, `groups:`
  private, `im:` DMs, `mpim:` group DMs).
- After leaving a workspace, its channels are unreachable; DMs may remain.
