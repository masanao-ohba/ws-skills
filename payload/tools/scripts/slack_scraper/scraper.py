"""Collect messages from Slack Web by scrolling through the virtualized list."""

from __future__ import annotations

from playwright.sync_api import Page, TimeoutError as PwTimeout

from .browser import (
    human_delay,
    navigate_to_conversation,
    navigate_to_thread,
    reached_conversation_top,
    scroll_message_pane_to_bottom,
    scroll_message_pane_up,
)
from .parser import (
    MSG_LIST_CONTAINER,
    Message,
    extract_thread_replies,
    parse_message_element,
)

# Stop after this many consecutive scrolls that surface nothing new.
MAX_NO_NEW = 10


def collect(page: Page, team_id: str, channel_id: str, since: str | None = None) -> list[Message]:
    """Scroll upward collecting messages, stopping at `since` (YYYY-MM-DD) if given.

    Without a bound, collection runs to the beginning of the conversation — years
    of history on a long-lived channel.
    """
    navigate_to_conversation(page, team_id, channel_id)
    scroll_message_pane_to_bottom(page)

    collected: dict[str, Message] = {}
    no_new = 0
    scrolls = 0

    label = f"back to {since}" if since else "to the beginning of the conversation"
    print(f"[slack] collecting {label}")

    while True:
        new_count = 0
        for msg in extract_visible_messages(page):
            key = dedup_key(msg)
            existing = collected.get(key)
            if existing is None:
                collected[key] = msg
                new_count += 1
            else:
                # Late-render rescue: reply_bar / slack_ts can appear after first sight.
                if msg.has_thread and not existing.has_thread:
                    existing.has_thread = True
                if msg.slack_ts and not existing.slack_ts:
                    existing.slack_ts = msg.slack_ts

        scrolls += 1
        oldest = min((m.timestamp for m in collected.values()), default=None)

        if scrolls % 5 == 0:
            print(f"[slack] scroll #{scrolls}: {len(collected)} messages, oldest {str(oldest)[:10]}")

        # Date boundary: everything older than `since` is out of scope.
        if since and oldest and str(oldest)[:10] < since:
            print(f"[slack] reached {since}; stopping")
            break

        if reached_conversation_top(page):
            print("[slack] reached the beginning of the conversation")
            break

        # Judge exhaustion by what the settled top-of-loop pass found, never by a
        # snapshot taken right after scrolling: the reply bar renders a beat after the
        # message, so an early snapshot locks in has_thread=False and the thread is
        # never fetched.
        if new_count == 0:
            no_new += 1
            if no_new >= MAX_NO_NEW:
                print("[slack] no new messages after repeated scrolls; stopping")
                break
        else:
            no_new = 0

        scroll_message_pane_up(page)
        human_delay(0.5, 1.5)

    messages = sorted(collected.values(), key=lambda m: m.timestamp)
    if since:
        messages = [m for m in messages if str(m.timestamp)[:10] >= since]
        print(f"[slack] {len(messages)} messages within range")

    threaded = [m for m in messages if m.has_thread and m.slack_ts]
    if threaded:
        print(f"[slack] fetching {len(threaded)} threads")
        fetch_all_threads(page, team_id, channel_id, threaded)

    return messages


def extract_visible_messages(page: Page) -> list[Message]:
    """Extract every currently rendered message from the main pane."""
    messages = []
    elements = page.query_selector_all(MSG_LIST_CONTAINER)
    last_sender = ""
    last_avatar = ""

    for el in elements:
        msg = parse_message_element(el, page)
        if msg is None:
            continue

        # Slack groups consecutive messages from the same sender, omitting the
        # sender name and avatar on follow-up messages.
        if not msg.sender:
            msg.sender = last_sender
        else:
            last_sender = msg.sender
        if not msg.avatar_url:
            msg.avatar_url = last_avatar
        else:
            last_avatar = msg.avatar_url

        messages.append(msg)

    return messages


def dedup_key(msg: Message) -> str:
    """Dedup on timestamp + sender + the first 50 characters of the text."""
    return f"{msg.timestamp}|{msg.sender}|{msg.text[:50]}"


def fetch_all_threads(
    page: Page, team_id: str, channel_id: str, threaded_msgs: list[Message]
) -> None:
    """Open each thread and collect its replies."""
    for i, msg in enumerate(threaded_msgs):
        print(f"[thread] ({i + 1}/{len(threaded_msgs)}) opening thread at {msg.timestamp}")

        try:
            if not navigate_to_thread(page, team_id, channel_id, msg.slack_ts):
                print("[thread]   -> thread list not found, skipping")
                continue

            scroll_thread_panel(page)
            msg.thread_replies = extract_thread_replies(page)
            print(f"[thread]   -> {len(msg.thread_replies)} replies collected")

        except (PwTimeout, Exception) as e:
            print(f"[thread]   -> failed: {e}")
            continue

        human_delay(0.5, 1.0)

    navigate_to_conversation(page, team_id, channel_id)


def scroll_thread_panel(page: Page, max_iterations: int = 40) -> None:
    """Force every reply in a virtualized thread panel into the DOM.

    Slack's thread panel uses virtual scrolling: only items near the viewport are
    mounted, and items scrolled out of view are unmounted, so a single DOM snapshot
    misses most replies. This walks the scroller from top to bottom in small steps,
    cloning each newly mounted listitem into a hidden cache appended to the thread
    list. After the walk the cache holds every listitem that was ever mounted, so a
    subsequent extract_thread_replies sees them all.
    """
    page.evaluate('''() => {
        const tl = document.querySelector('[role="list"][aria-label*="Thread"]');
        if (!tl) return;
        // Remove any leftover cache from a previous thread.
        const old = tl.querySelector(':scope > [data-thread-cache="1"]');
        if (old) old.remove();
        const cache = document.createElement('div');
        cache.setAttribute('data-thread-cache', '1');
        cache.style.display = 'none';
        tl.appendChild(cache);
        const seen = new Set();
        const harvest = () => {
            const items = tl.querySelectorAll(':scope > [role="listitem"]');
            for (const it of items) {
                const t = it.querySelector('.c-timestamp[data-ts]');
                const key = t ? t.getAttribute('data-ts') : (it.getAttribute('data-qa-unprocessed-ts') || it.id || '');
                if (!key || seen.has(key)) continue;
                seen.add(key);
                const clone = it.cloneNode(true);
                cache.appendChild(clone);
            }
        };
        window.__threadHarvest = harvest;
        window.__threadCacheKeys = seen;
        harvest();
    }''')

    last_count = -1
    stable = 0
    for _ in range(max_iterations):
        result = page.evaluate('''() => {
            const tl = document.querySelector('[role="list"][aria-label*="Thread"]');
            if (!tl) return { count: 0 };
            let scroller = tl.parentElement;
            while (scroller && scroller !== document.body) {
                const cs = getComputedStyle(scroller);
                if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && scroller.scrollHeight > scroller.clientHeight) {
                    break;
                }
                scroller = scroller.parentElement;
            }
            if (!scroller || scroller === document.body) {
                return { count: (window.__threadCacheKeys || new Set()).size };
            }
            return {
                scrollHeight: scroller.scrollHeight,
                clientHeight: scroller.clientHeight,
            };
        }''')
        scroll_height = result.get('scrollHeight', 0)
        client_height = result.get('clientHeight', 0)
        if scroll_height and client_height:
            step = max(int(client_height * 0.4), 100)
            pos = 0
            while pos <= scroll_height + step:
                page.evaluate(f'''() => {{
                    const tl = document.querySelector('[role="list"][aria-label*="Thread"]');
                    if (!tl) return;
                    let s = tl.parentElement;
                    while (s && s !== document.body) {{
                        const cs = getComputedStyle(s);
                        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && s.scrollHeight > s.clientHeight) break;
                        s = s.parentElement;
                    }}
                    if (s && s !== document.body) s.scrollTop = {pos};
                    if (window.__threadHarvest) window.__threadHarvest();
                }}''')
                page.wait_for_timeout(200)
                pos += step
        count = page.evaluate('() => (window.__threadCacheKeys || new Set()).size')
        if count == last_count:
            stable += 1
            if stable >= 2:
                break
        else:
            stable = 0
        last_count = count

    # Move every cached listitem out of the cache so it becomes a direct child of the
    # thread list, where extract_thread_replies expects to find it.
    page.evaluate('''() => {
        const tl = document.querySelector('[role="list"][aria-label*="Thread"]');
        if (!tl) return;
        const cache = tl.querySelector(':scope > [data-thread-cache="1"]');
        if (!cache) return;
        // Collect existing live items keyed by data-ts so we can dedup.
        const liveKeys = new Set();
        for (const it of tl.querySelectorAll(':scope > [role="listitem"]')) {
            const t = it.querySelector('.c-timestamp[data-ts]');
            if (t) liveKeys.add(t.getAttribute('data-ts'));
        }
        const cached = Array.from(cache.children);
        for (const c of cached) {
            const t = c.querySelector('.c-timestamp[data-ts]');
            const key = t ? t.getAttribute('data-ts') : '';
            if (key && liveKeys.has(key)) continue;
            c.style.display = '';
            tl.appendChild(c);
        }
        cache.remove();
        // Re-sort children by data-ts ascending so the first item (the parent message)
        // and its replies appear in chronological order.
        const items = Array.from(tl.querySelectorAll(':scope > [role="listitem"]'));
        items.sort((a, b) => {
            const ta = a.querySelector('.c-timestamp[data-ts]');
            const tb = b.querySelector('.c-timestamp[data-ts]');
            const va = ta ? parseFloat(ta.getAttribute('data-ts')) : 0;
            const vb = tb ? parseFloat(tb.getAttribute('data-ts')) : 0;
            return va - vb;
        });
        for (const it of items) tl.appendChild(it);
    }''')
