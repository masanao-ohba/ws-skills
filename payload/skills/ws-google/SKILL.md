---
name: ws-google
description: Read and write Google Workspace data. Fetching (Docs, Sheets, Drive comments, Calendar) uses a read-only token; writing (Sheets cell updates, Docs append) uses separate per-service write tokens. Use when the user wants to fetch, save, update, or append Google Docs/Sheets content, retrieve Drive comments, or query calendars. Also invocable as a command via /ws-google followed by instructions.
---

# ws-google

Google Workspace retrieval and updates through one CLI.

**Read and write are separate credentials.** Fetching holds a read-only token, so
the fetch commands cannot write even by mistake. Writing uses per-service tokens
(`token_sheets.json`, `token_docs.json`) authorized on their own. There is no
Drive write scope at all.

## Running the tools

```bash
T=~/.agents/skills/ws-google/tools
WS="uv run --project $T python $T/main.py"

$WS auth --check     # status of every profile and token
$WS auth --whoami    # which account a token belongs to
```

If `WS_SKILLS_HOME` is set, the tools live there instead of `~/.config/ws-skills`.

**Never run `auth` to authorize.** It prints a consent URL and then blocks until a
person approves it in a browser. If `auth --check` shows a token that is missing or
invalid, say so and ask the user to run `npx @masanao-ohba/ws-skills auth` — then
stop until they confirm it is done.

Multiple accounts are supported through profiles (`--profile <name>`), one per
Google organization. `auth --check` lists the ones that exist.

## Fetch (read-only token)

```bash
$WS gdoc <DOC_ID_OR_URL>                       # Doc -> Markdown (every tab)
$WS gsheet <SHEET_ID_OR_URL> --list            # tab names
$WS gsheet <URL> --tab "Summary" --label plan  # cell values -> JSON
$WS gcomments <DOC_OR_FILE_ID> --label review  # comment threads (resolved + deleted included)
$WS gcal --from 2026-04-01 --to 2026-04-30 --calendar all
```

Output lands in `references/raw-source/` under the current working directory
(`WS_OUTPUT_DIR` overrides it). The directory is created with a `.gitignore` that
excludes it from the project's repository. Fetching the same document twice never
overwrites the earlier file — a suffix is added. The one exception is `gdoc` with an
explicit output path, which writes exactly where it is told.

## Write (write tokens)

```bash
# Sheets: overwrite a range (--append writes after the range's table instead)
$WS gsheet-write <SHEET> --range 'Tab!A1' --values '[["a","b"],["c","d"]]'
$WS gsheet-write <SHEET> --range 'Tab!A1' --csv data.csv --append

# Docs: append text at the end of the document
$WS gdoc-append <DOC> --text "text to append"
$WS gdoc-append <DOC> --file notes.md
```

**Always get the user's approval before writing** — show the target file, the range,
and the exact content first.

## Pitfalls

- **A 404 does not identify the cause**: deleted, no permission, wrong file type, or
  a missing `supportsAllDrives` all answer 404. Team material is usually on a shared
  drive, which the tooling already handles — but a 404 is not proof of lost access.
- Docs need `includeTabsContent` or only the first tab comes back (handled here).
  Review exchanges often live in comments, and resolved threads disappear from the
  UI — fetch them separately with `gcomments`.
- A new OAuth scope must be registered in Google Cloud Console -> Data Access before
  its consent screen will accept it.
- Sheets tabs that are charts or timelines have no cell grid; they are skipped.
