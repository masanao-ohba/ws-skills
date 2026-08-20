"""Snapshot a Backlog issue and its comments as JSON in references/raw-source/.

    <tools> backlog ABC123-45
"""

from __future__ import annotations

from pathlib import Path


def fetch(issue_key: str) -> Path:
    import explore_backlog

    return explore_backlog.issue(issue_key)
