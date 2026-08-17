# CLAUDE.md

Guidance for working in this repository.

## What this is

An npm package (`@masanao-ohba/ws-skills`) that installs three Claude Code skills —
`/ws-google`, `/ws-slack`, `/ws-backlog` — plus the Python CLI they call, and walks
the user through the credentials each one needs.

Two languages, one job each:

- **Node (`bin/`, `src/`)** — the installer only. Zero runtime dependencies, so
  `npx` starts immediately. It copies `payload/` into the install home, symlinks
  the skills into `~/.claude/skills/`, and writes `.env`.
- **Python (`payload/tools/`)** — everything that touches an API. Run through `uv`;
  the user never installs Python packages by hand.

## Layout

```
bin/cli.mjs              entry point
src/cli.mjs              argument parsing and dispatch
src/commands/            install, setup, link, doctor, uninstall
src/lib/                 paths, prompts, .env rendering, symlinks, prerequisites
payload/skills/<name>/SKILL.md   what Claude reads
payload/tools/main.py            the CLI's argparse surface
payload/tools/scripts/           one module per source; slack_scraper/ is vendored
test/                    node:test for the installer
payload/tools/tests/     unittest for the Slack API backend's normalization
```

After installation:

```
~/.config/ws-skills/{tools,skills,google,slack,.env}
~/.claude/skills/ws-*  ->  ~/.config/ws-skills/skills/ws-*   (symlinks)
```

The install home must never be inside the package: `npx` unpacks into a cache that
gets wiped, and the symlinks have to keep pointing at something that stays.

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
- **Both Slack backends emit the same snapshot shape** (`slack_output.write_snapshot`).
  If one gains a field, either give the other the same field or document the gap in
  `payload/skills/ws-slack/SKILL.md` and the README.
- **Output never overwrites.** Snapshots get a numeric suffix rather than replacing
  an earlier, possibly wider, collection.
- **English everywhere** in the package: code, comments, docs, prompts.

## Testing

```bash
npm test    # node:test installer suite + Python fixture tests
```

The installer tests run against a throwaway `WS_SKILLS_HOME` / `CLAUDE_CONFIG_DIR`,
so they never touch the developer's real Claude Code config. Keep it that way.

The Slack **API** backend has not been verified against a live workspace. Its
normalization is therefore fixture-driven — any change
to `slack_api.py` needs a matching case in `payload/tools/tests/test_slack_api.py`,
and the "not verified against a live workspace" note in the README stays until it is.

`payload/tools/scripts/slack_scraper/` is vendored from
[masanao-ohba/slack-backup](https://github.com/masanao-ohba/slack-backup); keep
changes there small and portable back upstream.

## Release

`payload/tools/uv.lock` is committed and shipped; `.venv` and `__pycache__` are
excluded from both git and the tarball. Check `npm pack --dry-run` before
publishing — the `files` allowlist plus `.npmignore` decide what ships.
