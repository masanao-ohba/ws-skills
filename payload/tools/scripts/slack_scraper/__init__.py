"""Playwright-driven Slack scraping.

Vendored from https://github.com/masanao-ohba/slack-backup (MIT), adapted so the
saved session lives in the config home rather than the checkout's working
directory. Used when no Slack API token is available — Slack's Web API needs an
app installed in the workspace, which many organizations do not grant.
"""

from .parser import Message  # noqa: F401
