---
name: ws-backlog
description: Fetch issues, comments, wiki pages, and activities from Backlog (backlog.jp / backlog.com), read-only. Use when the user wants Backlog data retrieved, an issue snapshotted, or a project explored. Also invocable as a command via /ws-backlog followed by instructions.
---

# ws-backlog

Retrieve Backlog material with a **GET-only** client — there is no POST/PATCH/DELETE
path in it, so a key shared with you cannot be used to write even by mistake.

## Credentials

Resolved from the process environment, then `.env` in the current directory, then
`~/.config/ws-skills/.env` (chmod 600):

- `BACKLOG_DOMAIN` / `BACKLOG_API_KEY` — the default pair
- `BACKLOG_API_KEY_<PROJECT>` — a key scoped to one project, selected automatically
  for that project's calls and never used for another. `BACKLOG_DOMAIN_<PROJECT>`
  too, if that project lives in a different space.

## Usage

```bash
WS="uv run --project ~/.config/ws-skills/tools python ~/.config/ws-skills/tools/main.py"

# snapshot one issue with every comment
$WS backlog ABC123-45

# explore a project
$WS bl-explore overview   --project ABC123
$WS bl-explore issues     --project ABC123 --keyword release --since 2026-01-01
$WS bl-explore issue      ABC123-45
$WS bl-explore wikis      --project ABC123
$WS bl-explore activities --project ABC123

# thin a snapshot for reading (comment bodies kept verbatim, no summarising)
$WS bl-digest ABC123-45
$WS bl-digest --project ABC123
```

Output lands in `references/raw-source/` under the current working directory
(digests go to `references/working-notes/`; `WS_OUTPUT_DIR` / `WS_NOTES_DIR`
override both).

- `issues` / `wikis` / `activities` only print a listing — add `--save` to write it.
- `issues` searches every status, not just open ones, and sorts by last update.
- Rate limiting (429) is retried automatically with backoff.

## Pitfalls

- Issues are edited and closed over time, so a link to an issue key goes stale.
  Take a snapshot of anything you need to keep.
- A digest keeps every comment that has a body, verbatim, and drops only the
  bodiless bookkeeping ones (logged-hours bumps and the like). It is a filter, not
  a summary — do not treat what it drops as "nothing happened".
- If a Backlog MCP server is configured, browsing through it is fine; use this skill
  when the MCP server cannot reach a project (a scoped key), or when you need a
  frozen snapshot on disk.
