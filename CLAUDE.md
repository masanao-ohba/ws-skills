# CLAUDE.md

Guidance for working in this repository.

## What this is

An npm package (`@masanao-ohba/ws-skills`) that installs three agent skills —
`/ws-google`, `/ws-slack`, `/ws-backlog` — plus the Python CLI they call, and walks
the user through the credentials each one needs.

Two languages, one job each:

- **Node (`bin/`, `src/`)** — the installer only. Zero runtime dependencies, so
  `npx` starts immediately. It copies `payload/` into `~/.agents/skills/`, links that
  into each agent that reads a directory of its own, and writes the credentials into
  `~/.config/ws-skills/`.
- **Python (`payload/tools/`)** — everything that touches an API. Run through `uv`;
  the user never installs Python packages by hand.

## Layout

```
bin/cli.mjs              entry point
src/cli.mjs              argument parsing and dispatch
src/commands/            install, update, auth, doctor, uninstall
                         setup.mjs is the credentials wizard install runs,
                         not a command of its own
src/lib/                 paths, prompts, .env rendering, skill installation,
                         prerequisites, and tools.mjs — the only place that
                         spawns the Python CLI
payload/skills/<name>/SKILL.md   what the agent reads
payload/tools/main.py            the CLI's argparse surface
payload/tools/scripts/           one module per source; slack_scraper/ is vendored
test/                    node:test for the installer
payload/tools/tests/     unittest for output paths, channel resolution, and the
                         Slack API backend's normalization
```

After installation:

```
~/.agents/skills/ws-skills-tools/       the Python CLI, one shared copy
~/.agents/skills/ws-*/SKILL.md          the skill
~/.agents/skills/ws-*/tools  ->  ../ws-skills-tools
~/.claude/skills/ws-*  ->  ../../.agents/skills/ws-*
~/.config/ws-skills/{google,slack,.env} credentials and settings only
```

A skill carries the code it runs, so every command a SKILL.md documents is a path
inside that skill — nothing has to go looking through a config directory to find
the implementation. The tooling is shared rather than copied per skill because the
virtualenv uv builds runs to hundreds of megabytes.

The skills live in `~/.agents/skills/` because that is the vendor-neutral personal
location in the [Agent Skills](https://agentskills.io) format: Copilot and the other
adopters read it directly. Claude Code reads only its own directory, so it gets a
link — `AGENT_LINKS` in `paths.mjs` is the whole list of agents needing one, and an
agent that reads `~/.agents/skills` itself belongs nowhere in it. Keeping exactly one
real copy is what lets a SKILL.md name an absolute path to its own tooling; two copies
would need the path rewritten per location and could drift apart on an upgrade.

Neither location may be inside the package: `npx` unpacks into a cache that gets
wiped, and what is installed has to outlive it.

## Rules that hold across the codebase

- **Nothing organization-specific.** No real workspace names, team IDs, channel
  IDs, project keys, domains, or account addresses — in code, comments, docs or
  tests. Examples use `ABC123`, `C0123456789`, `T0123456789`, `example.backlog.jp`.
- **Read and write are separate credentials.** The Google fetch commands hold a
  read-only token by construction; writing uses per-service write tokens. The
  Backlog client issues `GET` only. Do not add a write path to either without
  saying so loudly in the skill docs.
- **Secrets are chmod 600**, live only under the install home, and are never echoed
  by a prompt or printed by `doctor`.
- **Both Slack backends emit the same snapshot shape** (`slack_output.write_snapshot`),
  down to the per-message fields. The differences are structural, not accidental:
  `thread_replies_failed` is browser-only (an API read that fails raises rather than
  returning a thread with its replies missing), `inline_emoji` is browser-only (the
  API renders emoji into the text), and `user_id` is API-only (the DOM does not
  carry user ids).
- **A partial collection says it is partial.** Scraping a thread fails now and then;
  retrying is not enough on its own, because a run nobody watched still has to leave
  the gap visible in the file. Anything that can come back short belongs in the
  snapshot as a count, not only in the log.
- **Output never overwrites.** Snapshots get a numeric suffix rather than replacing
  an earlier, possibly wider, collection. The output directory is created with its
  own `.gitignore`, so fetched material cannot ride along in a commit.
- **A channel name is a first-class argument.** `--channel` accepts a name or an ID,
  and both Slack backends resolve names (`slack_channels.resolve` caches the answer
  per workspace). Nothing in the skills should send the reader hunting for an ID by
  other means.
- **English everywhere** in the package: code, comments, docs, prompts.
- **The Python CLI is not a user surface.** People drive `npx @masanao-ohba/ws-skills`;
  the agent drives `main.py` through the skills. Anything a person has to do — a consent
  screen, a sign-in, a browser download — is run *for* them by `commands/auth.mjs`, never
  printed as a command to copy. Keep raw `uv run …` lines out of the README, out of the
  installer's output, and out of what the skills tell users to do.

## Testing

```bash
npm test    # node:test installer suite + Python fixture tests
```

The installer tests run against a throwaway `HOME`, plus a `WS_SKILLS_HOME` and a
`CLAUDE_CONFIG_DIR` inside it, so they never touch the developer's real skills or
config. `~/.agents/skills` has no setting of its own — a SKILL.md names an absolute
path to its own tooling, so the location cannot move — and a home of our own is what
keeps a run off the real one. Keep it that way: a test hook in `src/` would be a
setting users could find.

The Slack **API** backend's normalization is fixture-driven — any change to
`slack_api.py` needs a matching case in `payload/tools/tests/test_slack_api.py`.
The fixtures are the regression net.

`payload/tools/scripts/slack_scraper/` is vendored from
[masanao-ohba/slack-backup](https://github.com/masanao-ohba/slack-backup); keep
changes there small and portable back upstream.

## Release

`payload/tools/uv.lock` is committed and shipped; `.venv` and `__pycache__` are
excluded from both git and the tarball. Check `npm pack --dry-run` before
publishing — the `files` allowlist plus `.npmignore` decide what ships.

No test code ships. The Node suite is left out by omission (`test/` is not in
`files`); the Python suite needs the explicit `!payload/tools/tests` negation,
because `payload` is listed wholesale. Exclusions inside a directory that
`files` names have to be written as a `files` negation or a nested `.npmignore` —
the root `.npmignore` does not reach in there, which is also why `prepack`
clears `__pycache__` rather than leaving it to the ignore file.
