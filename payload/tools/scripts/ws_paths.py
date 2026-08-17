"""Path and environment resolution for the ws-* skills.

Nothing here depends on a repository or a project layout. Values resolve in this
order: the process environment, a `.env` in the current working directory, then
the shared `.env` in the tooling home (chmod 600, written by `ws-skills setup`).

Output paths default to the current working directory, so each project collects
into its own `references/raw-source/` unless WS_OUTPUT_DIR says otherwise.
"""

from __future__ import annotations

import os
from pathlib import Path


def _xdg_config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def home() -> Path:
    """Tooling home: credentials, the shared .env, and the installed tools."""
    return Path(os.environ.get("WS_SKILLS_HOME") or _xdg_config_home() / "ws-skills")


def shared_env_file() -> Path:
    return home() / ".env"


def dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        values[name.strip()] = value.strip().strip("'\"")
    return values


def lookup(name: str, default: str | None = None) -> str | None:
    return (
        os.environ.get(name)
        or dotenv(Path.cwd() / ".env").get(name)
        or dotenv(shared_env_file()).get(name)
        or default
    )


def require(name: str, hint: str = "") -> str:
    """Return a setting or exit with an actionable message — never a bare KeyError."""
    value = lookup(name)
    if not value:
        raise SystemExit(
            f"[ws] {name} is not set. Add it to the environment, to ./.env, or to "
            f"{shared_env_file()} (run `ws-skills setup` to fill it in)."
            + (f"\n     {hint}" if hint else "")
        )
    return value


def raw_source() -> Path:
    """Where snapshots land. Per-project by default, overridable per run."""
    return Path(lookup("WS_OUTPUT_DIR") or Path.cwd() / "references" / "raw-source")


def notes() -> Path:
    return Path(lookup("WS_NOTES_DIR") or Path.cwd() / "references" / "working-notes")


def google_dir() -> Path:
    return Path(lookup("WS_GOOGLE_DIR") or home() / "google")


def slack_dir() -> Path:
    return Path(lookup("WS_SLACK_DIR") or home() / "slack")


def slack_state_file() -> Path:
    """Playwright storage_state for the browser backend's saved Slack session."""
    return Path(lookup("WS_SLACK_STATE_FILE") or slack_dir() / "state.json")


def unique_path(directory: Path, name: str) -> Path:
    """`name` inside `directory`, suffixed until it does not collide.

    Two runs on the same day used to overwrite each other; a narrower re-run
    silently replacing a wider earlier one destroys material already retrieved.
    """
    directory.mkdir(parents=True, exist_ok=True)
    stem, dot, ext = name.partition(".")
    out = directory / name
    seq = 2
    while out.exists():
        out = directory / f"{stem}-{seq}{dot}{ext}"
        seq += 1
    return out
