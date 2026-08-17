"""Write a Slack conversation snapshot — one shape for both backends.

The browser backend and the API backend produce the same envelope and the same
per-message keys, so anything reading a snapshot never has to care which one
collected it. `backend` records which did.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import ws_paths


def count_replies(messages: list[dict]) -> int:
    return sum(len(m.get("thread_replies") or []) for m in messages)


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
    return out
