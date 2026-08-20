"""Thin a Backlog issue snapshot into a per-issue Markdown digest for reading.

The thinning is **purely mechanical** — nothing is summarised:

- drop comments with an empty body whose change log touches only bookkeeping fields
- keep every comment that has a body, verbatim
- keep every field change except those bookkeeping ones — the list of what matters
  is not fixed, so anything not named as noise is reproduced
- keep the issue description verbatim

    <tools> bl-digest ABC123-45 [ABC123-46 ...]
    <tools> bl-digest --project ABC123        # every snapshot of that project
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import ws_paths

# Bookkeeping fields: a bodyless comment touching only these is dropped.
NOISE_FIELDS = {"actualHours", "notification", "attachment"}


def _latest_snapshot(issue_key: str) -> Path:
    hits = sorted(ws_paths.raw_source().glob(f"backlog-{issue_key}-*.json"))
    if not hits:
        raise SystemExit(
            f"[digest] no snapshot for {issue_key} — run `backlog {issue_key}` first"
        )
    return hits[-1]


def digest(issue_key: str) -> Path:
    snapshot = _latest_snapshot(issue_key)
    data = json.loads(snapshot.read_text(encoding="utf-8"))
    issue = data["issue"]

    kept: list[str] = []
    dropped = 0
    for c in data["comments"]:
        body = (c.get("content") or "").strip()
        changes = c.get("changeLog") or []
        fields = {ch.get("field") for ch in changes}
        if not body and not (fields - NOISE_FIELDS):
            dropped += 1
            continue

        who = (c.get("createdUser") or {}).get("name", "-")
        line = [f"### {c['created'][:16].replace('T', ' ')} — {who} (comment-{c['id']})"]
        for ch in changes:
            if ch.get("field") in NOISE_FIELDS:
                continue
            if ch.get("field"):
                old = (ch.get("originalValue") or ch.get("oldValue") or "") or "(none)"
                new = (ch.get("newValue") or "") or "(none)"
                line.append(f"- changed `{ch['field']}`: {old} -> {new}")
        if body:
            line.append("")
            line.append(body)
        kept.append("\n".join(line))

    cf = {c["name"]: c.get("value") for c in issue.get("customFields", []) if c.get("value")}
    header = [
        f"# {issue_key} {issue['summary']}",
        "",
        f"> Mechanically thinned digest. Original snapshot: `{snapshot}`.",
        f"> **{dropped}** comments with no body and only bookkeeping changes were dropped; "
        f"the remaining **{len(kept)}** are reproduced verbatim (no summarising).",
        "",
        f"- type: {issue['issueType']['name']} / status: {issue['status']['name']}"
        f" / assignee: {(issue.get('assignee') or {}).get('name', '-')}",
        f"- created: {issue['created'][:10]} / start: {(issue.get('startDate') or '-')[:10]}"
        f" / due: {(issue.get('dueDate') or '-')[:10]} / logged hours: {issue.get('actualHours')}",
        f"- parent issue id: {issue.get('parentIssueId') or '-'}"
        f" / milestones: {', '.join(m['name'] for m in issue.get('milestone', [])) or '-'}",
    ]
    for k, v in cf.items():
        header.append(f"- {k}: {v}")
    desc = (issue.get("description") or "").strip()
    if desc:
        header += ["", "## Description (verbatim)", "", desc]
    header += ["", "---", ""]

    notes = ws_paths.ensure_output_dir(ws_paths.notes())
    out = notes / f"digest-{issue_key}.md"
    out.write_text("\n".join(header) + "\n\n".join(kept) + "\n", encoding="utf-8")
    print(f"[digest] {issue_key}: {len(kept)} kept / {dropped} dropped -> {out}")
    return out


def digest_project(project: str) -> list[Path]:
    """Digest every snapshot of a project found in the output directory."""
    pattern = re.compile(rf"backlog-({re.escape(project)}-\d+)-")
    keys = sorted(
        {m.group(1) for f in ws_paths.raw_source().glob(f"backlog-{project}-*.json")
         if (m := pattern.match(f.name))}
    )
    if not keys:
        raise SystemExit(f"[digest] no snapshots for {project} in {ws_paths.raw_source()}")
    return [digest(k) for k in keys]
