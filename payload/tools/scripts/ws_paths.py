"""Path and environment resolution for the ws-* skills.

Settings resolve in this order: the process environment, a `.env` in the current
working directory, then the shared `.env` in the config home. Output paths
default to the current working directory unless WS_OUTPUT_DIR says otherwise.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _xdg_config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def home() -> Path:
    """Credentials and the shared .env. The tooling itself lives with the skills."""
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
            f"{shared_env_file()} (run `npx @masanao-ohba/ws-skills` to fill it in)."
            + (f"\n     {hint}" if hint else "")
        )
    return value


def raw_source() -> Path:
    """Where snapshots land. Per-project by default, overridable per run."""
    return Path(lookup("WS_OUTPUT_DIR") or Path.cwd() / "references" / "raw-source")


_GITIGNORE = (
    "# Written by ws-skills. Fetched workspace material is not for a commit.\n"
    "# Delete this file if these snapshots really do belong in the repository.\n"
    "*\n"
)


def ensure_output_dir(directory: Path) -> Path:
    """Create an output directory and keep what lands in it out of git.

    An existing .gitignore is never touched.
    """
    directory.mkdir(parents=True, exist_ok=True)
    guard = directory / ".gitignore"
    if not guard.exists():
        try:
            guard.write_text(_GITIGNORE, encoding="utf-8")
        except OSError as err:
            print(f"[ws] could not write {guard}: {err}", file=sys.stderr)
    return directory


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

    Split on the last dot: a document title carries dots of its own, and
    splitting on the first one would move half the title into the extension.
    """
    ensure_output_dir(directory)
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    out = directory / name
    seq = 2
    while out.exists():
        out = directory / f"{stem}-{seq}{dot}{ext}"
        seq += 1
    return out
