"""Write a Slack conversation snapshot — one envelope and one message shape for
both backends, with `backend` recording which one collected it.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import ws_paths


def count_replies(messages: list[dict]) -> int:
    return sum(len(m.get("thread_replies") or []) for m in messages)


def count_thread_failures(messages: list[dict]) -> int:
    """Threads that could not be read — replies that are missing, not absent."""
    return sum(1 for m in messages if m.get("thread_replies_failed"))


def write_snapshot(
    messages: list[dict],
    *,
    backend: str,
    team_id: str,
    channel_id: str,
    workspace: str | None = None,
    since: str | None = None,
    label: str | None = None,
) -> Path:
    stamp = datetime.now(tz=timezone.utc)
    name = f"slack-{label or channel_id}-{stamp.strftime('%Y%m%d')}.json"
    out = ws_paths.unique_path(ws_paths.raw_source(), name)
    failures = count_thread_failures(messages)

    out.write_text(
        json.dumps(
            {
                "source": "slack",
                "backend": backend,
                "workspace": workspace,
                "team_id": team_id,
                "channel_id": channel_id,
                "range_from": since,
                "fetched_at": stamp.isoformat(),
                "message_count": len(messages),
                "thread_reply_count": count_replies(messages),
                # Always present, including as 0, so "none failed" reads differently
                # from "this snapshot predates the count".
                "thread_failure_count": failures,
                "messages": messages,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    span = f"{str(messages[0]['timestamp'])[:10]} - {str(messages[-1]['timestamp'])[:10]}"
    print(
        f"[slack] {len(messages)} messages + {count_replies(messages)} thread replies "
        f"({span}) -> {out}"
    )
    if failures:
        # Last line of the run: the snapshot is incomplete.
        print(
            f"[slack] WARNING: {failures} thread(s) could not be read and are marked "
            '"thread_replies_failed" in the snapshot. Re-run to collect them.'
        )
    return out
