"""Pick a Slack backend and hand the work to it.

    api      Slack Web API. Needs SLACK_TOKEN, and an app installed in the workspace.
    browser  Playwright scraping. Needs no token; drives its own Chromium.

Default: `api` when SLACK_TOKEN is set, otherwise `browser`. Override per run with
--backend, or for good with WS_SLACK_BACKEND.
"""

from __future__ import annotations

from pathlib import Path

import ws_paths

BACKENDS = ("api", "browser")


def resolve_backend(requested: str | None = None) -> str:
    backend = requested or ws_paths.lookup("WS_SLACK_BACKEND")
    if not backend:
        backend = "api" if ws_paths.lookup("SLACK_TOKEN") else "browser"
    if backend not in BACKENDS:
        raise SystemExit(f"[slack] unknown backend '{backend}'. Known: {', '.join(BACKENDS)}")
    return backend


def fetch(
    channel_id: str,
    label: str | None = None,
    headless: bool = False,
    since: str | None = None,
    team_id: str | None = None,
    from_app: bool = False,
    backend: str | None = None,
) -> Path:
    backend = resolve_backend(backend)
    if backend == "api":
        if from_app:
            print("[slack] --from-app applies to the browser backend only; ignoring it")
        import slack_api

        return slack_api.fetch(channel_id, label=label, since=since, team_id=team_id)

    import slack_browser

    return slack_browser.fetch(channel_id, label, headless, since, team_id, from_app)


def list_channels(
    query: str | None = None, headless: bool = False, backend: str | None = None
) -> list[dict]:
    backend = resolve_backend(backend)
    if backend == "api":
        import slack_api

        return slack_api.list_channels(query)

    import slack_browser

    return slack_browser.list_channels(query, headless)
