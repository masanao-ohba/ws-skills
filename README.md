# ws-skills

Three [Claude Code](https://claude.com/claude-code) skills for pulling work
material out of the tools a team actually leaves its history in — and, for Google,
putting some back:

| skill | what it does |
|---|---|
| `/ws-google` | Google Docs → Markdown, Sheets → JSON, Drive comment threads, Calendar ranges. Writes cell values and appends to Docs, through separate write tokens. |
| `/ws-slack` | Channels, DMs and thread replies → JSON, through the Slack Web API **or** browser automation when your workspace does not hand out tokens. |
| `/ws-backlog` | Backlog issues with every comment, project overviews, issue search, wikis, activities. Read-only by construction. |

Everything retrieved is written to `references/raw-source/` under whatever
directory you run from, so each project accumulates its own material. Nothing is
uploaded anywhere; credentials stay in `~/.config/ws-skills`, chmod 600.

## Install

```bash
npx @masanao-ohba/ws-skills
```

That copies the tooling to `~/.config/ws-skills`, symlinks the three skills into
`~/.claude/skills/`, and walks you through the credentials each one needs. Start a
new Claude Code session afterwards and `/ws-google`, `/ws-slack` and `/ws-backlog`
are available.

Requirements: **Node 18.17+** to run the installer, and **[uv](https://docs.astral.sh/uv/)**
to run the Python side (`brew install uv`, or `curl -LsSf https://astral.sh/uv/install.sh | sh`).
uv fetches its own Python, so you do not need one installed.

```
~/.config/ws-skills/
├── tools/          the CLI the skills call
├── skills/         SKILL.md files (symlinked into ~/.claude/skills/)
├── google/         OAuth clients and tokens        (chmod 600)
├── slack/          the saved browser session       (chmod 600)
└── .env            API keys and settings           (chmod 600)
```

Other commands:

```bash
npx @masanao-ohba/ws-skills setup      # change credentials later
npx @masanao-ohba/ws-skills doctor     # what is installed, authorized, missing
npx @masanao-ohba/ws-skills link       # re-create the symlinks only
npx @masanao-ohba/ws-skills uninstall  # remove the symlinks (--purge: credentials too)
```

`WS_SKILLS_HOME` moves the install home; `CLAUDE_CONFIG_DIR` points at a Claude
Code config directory other than `~/.claude`.

## Authorization

`ws-skills setup` asks for everything below and writes it to `~/.config/ws-skills/.env`.
Settings resolve from the process environment first, then `.env` in the directory
you run from, then that shared file — so a project can override anything locally.

Throughout, `$WS` is the command the skills use:

```bash
WS="uv run --project ~/.config/ws-skills/tools python ~/.config/ws-skills/tools/main.py"
```

### Backlog

Personal Settings → API → register a key, then:

```
BACKLOG_DOMAIN=yourspace.backlog.jp
BACKLOG_API_KEY=...
BACKLOG_API_KEY_ABC123=...      # optional: a key that reaches only project ABC123
BACKLOG_DOMAIN_ABC123=...       # optional: if that project lives in another space
```

A project-scoped key is selected automatically for that project's calls and is
never used for another one — which matters when a colleague shares a key with you
for one project. The client issues `GET` only; there is no write path in it at all.

### Google

One OAuth client per Google organization, because a Workspace client registered as
"Internal" rejects accounts from anywhere else.

1. Google Cloud Console → APIs & Services → **Enable** the Drive, Docs, Sheets and
   Calendar APIs.
2. → Credentials → Create credentials → OAuth client ID → **Desktop app** → download
   the JSON.
3. `ws-skills setup` copies it to `~/.config/ws-skills/google/credentials.json`
   (extra profiles become `credentials_<profile>.json`).
4. Authorize:

```bash
$WS auth                  # read-only token: Calendar, Drive, Docs, Sheets
$WS auth --write sheets   # separate token, only if you need to write cells
$WS auth --write docs     # separate token, only if you need to append to Docs
$WS auth --check          # what exists and whether it is still valid
```

The consent URL is printed rather than opened: authorizing a work domain in
whichever browser the tool happens to launch can invalidate the session in the
browser you actually use. Open it yourself, or pass `--open`.

Read and write are deliberately different credentials. The fetch commands hold a
token whose scopes are read-only, so they cannot write even if something goes
wrong — and there is no Drive write scope anywhere in this package.

### Slack

Two backends, same output.

**API backend** (`SLACK_TOKEN`) — use it if your workspace lets you install an app.
Create one at api.slack.com/apps, add these scopes, install it, copy the token:

```
channels:history  groups:history  im:history  mpim:history
channels:read     groups:read     im:read     mpim:read
users:read
```

A bot token (`xoxb-`) must also be invited to a private channel before it can read
it; a user token (`xoxp-`) sees what you see.

> **Not verified against a live workspace.** The maintainer's own workspace does
> not grant API access, so this backend's normalization is covered by fixture
> tests but its live calls are not. If something looks wrong, please open an issue.

**Browser backend** (no token) — Playwright drives its own Chromium, separate from
the browser you use, so your everyday session is untouched.

```bash
uv run --project ~/.config/ws-skills/tools python -m playwright install chromium
$WS slack-signin --url https://<workspace>.slack.com/    # sign in once, by hand
```

The session is saved to `~/.config/ws-skills/slack/state.json` and reused. Storing
`SLACK_EMAIL` / `SLACK_PASSWORD` enables an unattended scripted login instead
(`SLACK_AUTH_METHOD=sso` or `email_code`) — but a workspace behind Google sign-in
cannot be scripted at all, so `slack-signin` (or `--from-app`) is the way in there.

`--from-app` borrows the desktop app's live session by decrypting its cookie store
through the macOS keychain. It never touches the network, and the exported session
is deleted the moment the run ends. macOS only.

## Usage

The skills describe all of this to Claude, so "fetch this Backlog issue" is enough.
Directly:

```bash
# Google
$WS gdoc https://docs.google.com/document/d/<ID>/edit
$WS gsheet <ID_OR_URL> --list
$WS gsheet <ID_OR_URL> --tab "Summary" --label plan
$WS gcomments <ID_OR_URL> --label review
$WS gcal --from 2026-04-01 --to 2026-04-30 --calendar all
$WS gsheet-write <ID> --range 'Tab!A1' --values '[["a","b"]]'
$WS gdoc-append <ID> --file notes.md

# Slack
$WS channels --query release
$WS slack --channel C0123456789 --since 2026-04-01 --label release
$WS slack --channel C0123456789 --team-id T0123456789 --backend browser --headless

# Backlog
$WS backlog ABC123-45
$WS bl-explore overview --project ABC123
$WS bl-explore issues --project ABC123 --keyword release --since 2026-01-01
$WS bl-digest ABC123-45
```

Two habits worth keeping:

- **Always pass `--since` when collecting a channel.** Without it, collection runs
  to the beginning of the conversation.
- **Get approval before writing.** The Google write commands change a document
  someone else owns; show the target, the range and the content first.

## Troubleshooting

| symptom | cause |
|---|---|
| Google `404` on a file you can open | shared drive, wrong file type, or genuinely no permission — a 404 does not distinguish them. Shared drives are already handled; check the file type first. |
| A Google Doc comes back with only its first section | tabbed document fetched without tab content. This package always asks for tabs; if you see it, the doc has one tab. |
| Review comments missing from a Doc | they live on the Drive item, not in the body, and resolved threads vanish from the UI. Use `gcomments`. |
| Slack channel not in `channels` output | the browser backend lists the sidebar only; muted or unjoined channels are absent. The API backend lists them. |
| Slack collection stops early | the newest message on a freshly opened conversation is your last-read marker. Collection scrolls to the bottom first — trust the snapshot. |
| `uv: command not found` | install uv (see Requirements). |
| Skills do not appear in Claude Code | `ws-skills doctor`, then start a new session. |

## Development

```bash
npm test    # node tests for the installer + fixture tests for the Slack API backend
```

## Credits

The Slack browser backend is adapted from
[masanao-ohba/slack-backup](https://github.com/masanao-ohba/slack-backup).

## License

MIT
