"""Snapshot a Backlog issue (with its comments) into references/raw-source/.

Backlog issues are edited and closed over time, so a bare issue-key citation rots.
This freezes the issue and its comments as JSON.

    <tools> backlog ABC123-45

The fetch itself lives in explore_backlog.issue; this module is the short entry point.
"""

from __future__ import annotations

from pathlib import Path


def fetch(issue_key: str) -> Path:
    import explore_backlog

    return explore_backlog.issue(issue_key)
