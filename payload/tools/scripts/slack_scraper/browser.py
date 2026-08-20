"""Browser operations for Slack Web — navigation, scrolling, DOM waiting."""

from __future__ import annotations

import random
import time

from playwright.sync_api import Page, TimeoutError as PwTimeout

from .parser import (
    CONVERSATION_TOP_SELECTOR,
    MSG_LIST_CONTAINER,
    THREAD_LIST_SELECTOR,
)

# The message pane scrollbar (2nd slack_kit_scrollbar on the page)
MSG_SCROLL_CONTAINER = '[data-qa="slack_kit_scrollbar"]'


def human_delay(min_s: float = 0.3, max_s: float = 1.0) -> None:
    """Random delay to mimic human browsing speed."""
    time.sleep(random.uniform(min_s, max_s))


def navigate_to_conversation(page: Page, team_id: str, channel_id: str) -> None:
    """Navigate to a channel or DM and wait for messages to render."""
    url = f"https://app.slack.com/client/{team_id}/{channel_id}"
    print(f"[browser] Navigating to {url}")

    page.goto(url, wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function(
        f'() => window.location.href.includes("{channel_id}")',
        timeout=15_000,
    )

    try:
        page.wait_for_selector(MSG_LIST_CONTAINER, timeout=20_000)
    except PwTimeout:
        page.wait_for_selector('[role="list"], [data-qa="slack_kit_list"]', timeout=20_000)

    human_delay(1.0, 2.0)
    print("[browser] Conversation loaded.")


def navigate_to_thread(page: Page, team_id: str, channel_id: str, slack_ts: str) -> bool:
    """Navigate to a thread URL and wait for the thread list to render.

    Returns True if the thread panel loaded, False otherwise.
    """
    thread_url = (
        f"https://app.slack.com/client/{team_id}/{channel_id}"
        f"/thread/{channel_id}-{slack_ts}"
    )
    page.goto(thread_url, wait_until="domcontentloaded", timeout=30_000)

    # Both waits mean the same thing to the caller — the panel did not open — so
    # both answer with False. Letting one of them raise instead made a routine
    # timeout look like a crash and skipped the retry the other one gets.
    try:
        page.wait_for_function('() => window.location.href.includes("thread")', timeout=10_000)
    except PwTimeout:
        return False

    human_delay(2.0, 3.0)

    try:
        page.wait_for_selector(THREAD_LIST_SELECTOR, timeout=10_000)
        return True
    except PwTimeout:
        return False


def scroll_message_pane_up(page: Page) -> None:
    """Scroll the message pane up by manipulating scrollTop directly."""
    page.evaluate('''() => {
        const scrollbars = document.querySelectorAll('[data-qa="slack_kit_scrollbar"]');
        const msgPane = scrollbars.length >= 2 ? scrollbars[1] : scrollbars[0];
        if (msgPane) {
            msgPane.scrollTop = Math.max(0, msgPane.scrollTop - 600);
        }
    }''')


def scroll_message_pane_to_bottom(page: Page, max_iterations: int = 60) -> None:
    """Scroll the message pane all the way down before collecting.

    Slack restores the last-read position, not the newest message. Collection only
    scrolls upward, so without this everything below the landing point is silently
    lost.
    """
    for _ in range(max_iterations):
        moved = page.evaluate('''() => {
            const bars = document.querySelectorAll('[data-qa="slack_kit_scrollbar"]');
            const pane = bars.length >= 2 ? bars[1] : bars[0];
            if (!pane) return false;
            const before = pane.scrollTop;
            pane.scrollTop = pane.scrollHeight;
            return pane.scrollTop > before;
        }''')
        human_delay(0.4, 0.9)
        if not moved:
            return


def reached_conversation_top(page: Page) -> bool:
    """Check whether the beginning of the conversation is on screen."""
    try:
        top_marker = page.query_selector(CONVERSATION_TOP_SELECTOR)
        return top_marker is not None and top_marker.is_visible()
    except Exception:
        return False
