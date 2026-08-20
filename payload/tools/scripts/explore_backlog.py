"""Explore a Backlog project read-only.

The API key is resolved per project by backlog_client.

    <tools> bl-explore overview   --project ABC123
    <tools> bl-explore issues     --project ABC123 --keyword release --since 2026-01-01
    <tools> bl-explore issue      ABC123-45
    <tools> bl-explore wikis      --project ABC123
    <tools> bl-explore activities --project ABC123

`overview` / `issue` / `--save` write JSON into references/raw-source/; `issues`,
`wikis` and `activities` print a listing so candidates can be triaged before any
snapshot is taken.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import ws_paths
from backlog_client import Backlog, BacklogError  # noqa: F401  (re-exported for callers)


def _save(name: str, payload: dict) -> Path:
    stamp = datetime.now(tz=timezone.utc)
    out = ws_paths.unique_path(ws_paths.raw_source(), f"{name}-{stamp.strftime('%Y%m%d')}.json")
    payload = {"source": "backlog", "fetched_at": stamp.isoformat(), **payload}
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def _project_id(bl: Backlog, project: str) -> int:
    return bl.get(f"projects/{project}")["id"]


def overview(project: str) -> Path:
    """Project master data — the map needed before any issue search makes sense."""
    bl = Backlog(project)
    proj = bl.get(f"projects/{project}")
    data = {
        "domain": bl.domain,
        "project_key": project,
        "project": proj,
        "users": bl.get(f"projects/{project}/users"),
        "issue_types": bl.get(f"projects/{project}/issueTypes"),
        "categories": bl.get(f"projects/{project}/categories"),
        "milestones": bl.get(f"projects/{project}/versions"),
        "statuses": bl.get(f"projects/{project}/statuses"),
        "issue_count": bl.get("issues/count", **{"projectId[]": proj["id"]}),
    }
    out = _save(f"backlog-{project}-overview", data)
    print(f"[backlog] {project}: {proj['name']}")
    print(f"  users      : {len(data['users'])}")
    print(f"  issue types: {', '.join(t['name'] for t in data['issue_types'])}")
    print(f"  issues     : {data['issue_count'].get('count')}")
    print(f"  -> {out}")
    return out


def issues(
    project: str,
    keyword: str | None = None,
    since: str | None = None,
    until: str | None = None,
    user: str | None = None,
    limit: int = 100,
    save: bool = False,
) -> list:
    """List issues matching the filters. Dates apply to the update timestamp."""
    bl = Backlog(project)
    pid = _project_id(bl, project)
    params: dict = {
        "projectId[]": pid,
        "keyword": keyword,
        "updatedSince": since,
        "updatedUntil": until,
        "sort": "updated",
        "order": "desc",
        # Backlog defaults to open issues only; pass every status so closed history is visible.
        "statusId[]": [1, 2, 3, 4],
    }
    if user:
        params["createdUserId[]"] = user
    found = bl.paged("issues", limit=limit, **params)

    for i in found:
        assignee = (i.get("assignee") or {}).get("name", "-")
        print(
            f"{i['issueKey']:<14} {i['updated'][:10]}  {i['status']['name']:<6} "
            f"{assignee:<10} {i['summary']}"
        )
    print(f"[backlog] {len(found)} issues")
    if save:
        out = _save(
            f"backlog-{project}-search",
            {"project_key": project, "domain": bl.domain, "filters": params, "issues": found},
        )
        print(f"  -> {out}")
    return found


def issue(issue_key: str) -> Path:
    """Freeze one issue and all of its comments."""
    bl = Backlog(issue_key)
    data = bl.get(f"issues/{issue_key}")

    comments: list = []
    min_id = None
    while True:
        params = {"count": 100, "order": "asc"}
        if min_id is not None:
            params["minId"] = min_id
        batch = bl.get(f"issues/{issue_key}/comments", **params)
        comments.extend(batch)
        if len(batch) < 100:
            break
        min_id = batch[-1]["id"]

    out = _save(
        f"backlog-{issue_key}",
        {"domain": bl.domain, "issue_key": issue_key, "issue": data, "comments": comments},
    )
    print(f"[backlog] {issue_key}: {len(comments)} comments -> {out}")
    return out


def wikis(project: str, save: bool = False) -> list:
    bl = Backlog(project)
    pages = bl.get("wikis", projectIdOrKey=project)
    for p in pages:
        print(f"{p['id']:<10} {p['updated'][:10]}  {p['name']}")
    print(f"[backlog] {len(pages)} wiki pages")
    if save:
        print(f"  -> {_save(f'backlog-{project}-wikis', {'project_key': project, 'wikis': pages})}")
    return pages


def activities(project: str, limit: int = 100, save: bool = False) -> list:
    """Recent activity on the project — who moved what, useful for dating an event."""
    bl = Backlog(project)
    acts = bl.get(f"projects/{project}/activities", count=min(limit, 100))
    for a in acts:
        who = (a.get("createdUser") or {}).get("name", "-")
        content = a.get("content") or {}
        title = content.get("summary") or content.get("name") or ""
        print(f"{a['created'][:16]}  type={a['type']:<3} {who:<10} {title}")
    print(f"[backlog] {len(acts)} activities")
    if save:
        print(
            f"  -> {_save(f'backlog-{project}-activities', {'project_key': project, 'activities': acts})}"
        )
    return acts
