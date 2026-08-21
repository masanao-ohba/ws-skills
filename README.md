# ws-skills

**Three [Claude Code](https://claude.com/claude-code) skills that fetch your team's
working history out of Google Workspace, Slack and Backlog — and, for Google, write
some back.** One `npx` command installs them and takes you through every credential
they need.

[![npm](https://img.shields.io/npm/v/@masanao-ohba/ws-skills?logo=npm&color=cb3837)](https://www.npmjs.com/package/@masanao-ohba/ws-skills)
[![node](https://img.shields.io/badge/node-%E2%89%A518.17-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![python via uv](https://img.shields.io/badge/python-via%20uv-DE5FE9?logo=python&logoColor=white)](https://docs.astral.sh/uv/)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```bash
npx @masanao-ohba/ws-skills
```

---

## What you get

| skill | what it does |
|---|---|
| **`/ws-google`** | Docs → Markdown · Sheets → JSON · Drive comment threads · Calendar ranges. Also writes cells and appends to Docs. |
| **`/ws-slack`** | Channels, DMs and thread replies → JSON. Works **with or without** a Slack API token. |
| **`/ws-backlog`** | Issues with every comment · project overviews · issue search · wikis · activities. Read-only. |

Everything is written to `references/raw-source/` under the directory Claude Code is
running in, so each project keeps its own material. That directory is created with a
`.gitignore` of its own, so fetched workspace material never rides along in a commit.
Nothing is uploaded anywhere; credentials stay on your machine in
`~/.config/ws-skills`, chmod 600.

## Requirements

| | |
|---|---|
| **A skills-aware agent** | the skills install into `~/.agents/skills/`, which Claude Code reaches through a link of its own. See [Which agents can use these](#which-agents-can-use-these). |
| **Node ≥ 18.17** | runs the installer (nothing else — it has no dependencies) |
| **[uv](https://docs.astral.sh/uv/)** | runs the Python side. `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh`. It brings its own Python. |

## Setup

```bash
npx @masanao-ohba/ws-skills
```

That single command copies the tooling, links the skills into Claude Code, asks which
of the three you want and collects their credentials — then walks you through the
steps that need a person: the Google consent screen, the Slack sign-in, the one-time
Chromium download. Skip any of them and it says so; nothing is left for you to piece
together from a terminal afterwards.

Then **start a new Claude Code session** and the skills are there.

Have the relevant piece below to hand before you start.

<details>
<summary><b>Google</b> — an OAuth client JSON</summary>

1. Google Cloud Console → APIs & Services → **enable** the Drive, Docs, Sheets and Calendar APIs.
2. → Credentials → Create credentials → OAuth client ID → **Desktop app** → download the JSON.
3. Setup asks for that file's path, then offers to authorize.

**Reading and writing are deliberately different credentials.** The fetch side holds a
token whose scopes are read-only, so it cannot write even if something goes wrong — and
no Drive write scope exists anywhere in this package. Writing to Sheets or Docs is a
second, separate authorization that setup only runs if you ask for it.

The consent URL is printed rather than opened: authorizing a work domain in whichever
browser the tool happens to launch can invalidate the session in the browser you
actually use.

Working with two Google organizations? Add a second **profile** during setup, with its
own client JSON. A Workspace OAuth client registered as "Internal" rejects accounts
from anywhere else, so each organization needs its own.
</details>

<details>
<summary><b>Slack</b> — a token, or nothing at all</summary>

**With a token** (faster, exact timestamps, no browser). Create an app at
[api.slack.com/apps](https://api.slack.com/apps), add these scopes and install it:

```
channels:history  groups:history  im:history  mpim:history
channels:read     groups:read     im:read     mpim:read
users:read
```

A bot token (`xoxb-`) must also be invited to a private channel before it can read it;
a user token (`xoxp-`) sees what you see.

> This backend's normalization is covered by fixture tests and has been exercised
> against a live workspace with a user token. Please open an issue if anything
> looks wrong.

**Without a token** — Playwright drives its own Chromium, separate from your
everyday browser, so your normal session is untouched. Setup downloads Chromium
(~150 MB) and then asks where the Slack session should come from:

| session | when |
|---|---|
| the **desktop app's** session (macOS) | the workspace signs in through Google — Google refuses to authenticate inside an automated browser, so this is the only way in. Keep the app signed in; nothing else to do |
| a one-time sign-in in a Chromium window | password or SAML sign-in |
| a stored email and password | unattended, where no MFA or Google sign-in is in the way |

Borrowing the desktop app's session decrypts its cookie store through the macOS
keychain. It never touches the network, and the exported session is deleted the moment
the run ends.
</details>

<details>
<summary><b>Backlog</b> — an API key</summary>

Personal Settings → API → register a key. Setup asks for your space host
(`yourspace.backlog.jp`) and that key. Nothing else to authorize.

If a colleague shared a key that reaches only one project, add it too: it is selected
automatically for that project's calls and **never used for another one**. The client
issues `GET` only — there is no write path in it at all.
</details>

## Using the skills

In Claude Code, just ask. The skills tell Claude the rest — which tool to reach for,
what it can and cannot see, and where to put what comes back.

> *"Snapshot Backlog issue ABC123-45."*
> *"Save #release since April 1 and summarise what changed."*
> *"Fetch this Google Doc and list the comments nobody resolved."*

Or address one directly as a slash command, followed by instructions in your own words:

```text
/ws-slack     save #release since 2026-04-01
/ws-google    put these figures in the Q2 tab of <sheet URL>
/ws-backlog   what moved on ABC123-45 in the last month
```

A few things to expect:

- **Say how far back you want a channel.** Without a date, collection runs all the way
  to the beginning of the conversation.
- **Name a Slack channel however you like.** `#release`, `release` or the raw ID all
  work; the name is looked up once per workspace and remembered afterwards.
- **Writing to Google asks first.** The skill shows the file, the range and the exact
  content, and waits for your go-ahead.

## Managing the install

| | |
|---|---|
| `npx @masanao-ohba/ws-skills` | install: copy the tooling, install the skills, ask for credentials, authorize |
| `… auth` | run the authorization steps again (`--force` re-runs finished ones) |
| `… setup` | change credentials |
| `… doctor` | what is installed, authorized, and missing |
| `… link` | re-install the skills only, leaving credentials alone |
| `… uninstall` | remove the skills (`--purge` deletes the tooling and credentials too) |

## Where things live

```
~/.agents/skills/
├── ws-skills-tools/   the CLI the skills call (one copy, shared)
├── ws-google/         SKILL.md + tools -> ../ws-skills-tools
├── ws-slack/          SKILL.md + tools -> ../ws-skills-tools
└── ws-backlog/        SKILL.md + tools -> ../ws-skills-tools

~/.claude/skills/
└── ws-*  ->  ../../.agents/skills/ws-*    Claude Code reads only its own directory

~/.config/ws-skills/
├── google/   OAuth clients and tokens   (chmod 600)
├── slack/    the saved browser session  (chmod 600)
└── .env      API keys and settings      (chmod 600)
```

A skill and the code it runs sit together, so every command in a SKILL.md is a path
inside that skill. The config directory holds credentials and settings only — nothing
there has to be found or read to run a skill.

There is one real copy of each skill, and agents that read a directory of their own
get a link to it. Nothing is duplicated, so an upgrade cannot leave two versions of a
skill disagreeing with each other.

Settings resolve in this order: process environment → `.env` in the directory the agent
is running in → that shared `.env`. So a project can override anything locally.
`WS_SKILLS_HOME` moves the credentials directory, `WS_AGENTS_DIR` the skills directory,
and `CLAUDE_CONFIG_DIR` points at a Claude Code config other than `~/.claude`.

## Which agents can use these

The skills are [Agent Skills](https://agentskills.io), the format Anthropic released as
an open standard, so they are not tied to one agent.

| | |
|---|---|
| **GitHub Copilot** | reads `~/.agents/skills/` directly — CLI, cloud agent, code review, VS Code and JetBrains agent mode. Nothing extra to install. |
| **Claude Code** | reads only `~/.claude/skills/`, so the installer links each skill into it. |
| **Other agents** | Cursor, Gemini CLI, Codex and others read `~/.agents/skills/` too. |

Verify what an agent picked up with its own listing — `copilot skill list` for Copilot,
`/skills` for Claude Code.

## Troubleshooting

| symptom | cause |
|---|---|
| Skills do not appear in Claude Code | run `doctor`, then start a new session |
| `uv: command not found` | install uv (see [Requirements](#requirements)) |
| Google `404` on a file you can open | shared drive, wrong file type, or genuinely no permission — a 404 does not distinguish them |
| Doc comments missing | they live on the Drive item, not in the body, and resolved threads vanish from the UI — ask for the comments explicitly |
| A Slack channel is missing from the list | listing without a token only sees the sidebar, so muted and unjoined channels are absent — asking for the channel by name still reaches it |
| A Slack channel name resolves to the wrong conversation | it was renamed after being looked up — delete `~/.config/ws-skills/slack/channels.json` |
| Slack collection seems to stop early | the newest message on a freshly opened conversation is your last-read marker, not the newest — collection scrolls to the bottom first, so trust the snapshot |
| A Slack snapshot warns about threads | opening a thread occasionally fails even after retries; the affected messages are marked `thread_replies_failed` and re-running collects them |

## Development

```bash
npm test    # installer tests (node:test) + Python fixture tests (unittest)
```

## Credits

The Slack browser backend is adapted from
[masanao-ohba/slack-backup](https://github.com/masanao-ohba/slack-backup).

## License

[MIT](LICENSE)
