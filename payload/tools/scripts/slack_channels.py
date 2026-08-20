"""Turn what a person says (`#alerts`) into a channel ID (`C0123456789`).

A name is looked up once per workspace and remembered in `channels.json` next to
the saved session. Delete that file if a channel is renamed and the stale entry
starts pointing at the wrong place.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import ws_paths

# Conversation IDs: C public, G private (legacy), D direct message.
ID_PATTERN = re.compile(r"^[CGD][A-Z0-9]{6,}$")


def looks_like_id(value: str) -> bool:
    return bool(ID_PATTERN.match(value.strip()))


def normalize(value: str) -> str:
    """`#alerts` and `alerts` are the same request."""
    return value.strip().lstrip("#")


def cache_file() -> Path:
    return ws_paths.slack_dir() / "channels.json"


def _read_cache() -> dict:
    path = cache_file()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}  # a damaged cache costs one lookup, not a failed run


def cached(team_id: str, name: str) -> str | None:
    return _read_cache().get(team_id, {}).get(normalize(name))


def remember(team_id: str, name: str, channel_id: str) -> None:
    data = _read_cache()
    data.setdefault(team_id, {})[normalize(name)] = channel_id
    path = cache_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    path.chmod(0o600)
