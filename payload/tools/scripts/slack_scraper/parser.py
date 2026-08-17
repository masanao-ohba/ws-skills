"""Parse Slack DOM elements into structured message data."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from playwright.sync_api import Page


@dataclass
class Message:
    timestamp: str
    sender: str
    text: str
    slack_ts: str = ""
    avatar_url: str = ""
    reactions: list[dict] = field(default_factory=list)      # [{name, image_url}]
    inline_emoji: list[dict] = field(default_factory=list)   # [{name, image_url}]
    attachments: list[dict] = field(default_factory=list)    # [{name, url}]
    thread_replies: list["Message"] = field(default_factory=list)
    has_thread: bool = False

    def to_dict(self) -> dict:
        d = {
            "timestamp": self.timestamp,
            "sender": self.sender,
            "text": self.text,
            "avatar_url": self.avatar_url,
            "reactions": self.reactions,
            "attachments": self.attachments,
        }
        if self.inline_emoji:
            d["inline_emoji"] = self.inline_emoji
        if self.thread_replies:
            d["thread_replies"] = [r.to_dict() for r in self.thread_replies]
        return d


# --- Selector constants (centralized for easy maintenance) ---

MSG_LIST_CONTAINER = '[data-qa="message_container"]'
SENDER_SELECTOR = '[data-qa="message_sender_name"], .c-message_kit__sender button'
TEXT_SELECTOR = '[data-qa="message-text"], .c-message_kit__text .p-rich_text_section'
TIME_SELECTOR = '[data-qa="message_time"], time, a[data-ts]'
AVATAR_SELECTOR = '.c-message_kit__avatar img'
REACTION_SELECTOR = 'button.c-reaction'
ATTACHMENT_SELECTOR = '[data-qa="message_file_title"], .c-message_attachment__title'
REPLY_BAR_SELECTOR = '[data-qa="reply_bar"]'
# Thread panel list. In a DM the panel is labelled "Thread with <person>", but in a
# channel it is "Thread in <channel> (...)" — matching on the common prefix "Thread"
# covers both. (A "Thread with"-only selector silently skips every channel thread.)
THREAD_LIST_SELECTOR = '[role="list"][aria-label*="Thread"]'
CONVERSATION_TOP_SELECTOR = (
    '[data-qa="beginning_of_conversation"], '
    '.c-virtual_list__scroll_container [data-qa="channel_intro"], '
    'i18n-msg:has-text("beginning of your direct message")'
)


def parse_message_element(el, page) -> Message | None:
    """Extract a Message from a Slack message DOM element."""
    try:
        # Timestamp
        ts = ""
        raw_ts = ""
        time_el = el.query_selector(TIME_SELECTOR)
        if time_el:
            data_ts = time_el.get_attribute("data-ts")
            if data_ts:
                raw_ts = data_ts
                try:
                    ts = datetime.fromtimestamp(float(data_ts), tz=timezone.utc).isoformat()
                except (ValueError, OSError):
                    ts = data_ts
            else:
                dt = time_el.get_attribute("datetime")
                ts = dt if dt else time_el.inner_text().strip()

        # Sender
        sender = ""
        sender_el = el.query_selector(SENDER_SELECTOR)
        if sender_el:
            sender = sender_el.inner_text().strip()

        # Text content (preserve inline emoji as :name: text)
        text = ""
        inline_emoji = []
        text_el = el.query_selector(TEXT_SELECTOR)
        if text_el:
            text_data = text_el.evaluate('''el => {
                const emoji = [];
                const clone = el.cloneNode(true);
                clone.querySelectorAll('img').forEach(img => {
                    const alt = img.getAttribute('alt') || '';
                    const src = img.getAttribute('src') || '';
                    if (alt) emoji.push({name: alt, image_url: src});
                    img.replaceWith(document.createTextNode(alt));
                });
                return {text: clone.innerText.trim(), emoji};
            }''')
            text = text_data.get("text", "")
            inline_emoji = text_data.get("emoji", [])

        if not text and not sender:
            return None

        # Avatar
        avatar_url = ""
        avatar_el = el.query_selector(AVATAR_SELECTOR)
        if avatar_el:
            avatar_url = avatar_el.get_attribute("src") or ""

        # Reactions (with image URL for custom emoji)
        reactions = []
        for container in el.query_selector_all(REACTION_SELECTOR):
            img = container.query_selector("img")
            if img:
                name = img.get_attribute("alt") or ""
                image_url = img.get_attribute("src") or ""
            else:
                emoji_span = container.query_selector(".c-reaction__emoji")
                name = emoji_span.inner_text().strip() if emoji_span else ""
                image_url = ""
            if name:
                reactions.append({"name": name, "image_url": image_url})

        # Attachments (with download URL)
        attachments = []
        for a_el in el.query_selector_all(ATTACHMENT_SELECTOR):
            name = a_el.inner_text().strip()
            url = a_el.evaluate(
                'el => { const a = el.closest("a"); return a ? a.href : ""; }'
            ) or ""
            if name:
                attachments.append({"name": name, "url": url})

        # Thread indicator
        has_thread = el.query_selector(REPLY_BAR_SELECTOR) is not None

        return Message(
            timestamp=ts,
            sender=sender,
            text=text,
            slack_ts=raw_ts,
            avatar_url=avatar_url,
            reactions=reactions,
            inline_emoji=inline_emoji,
            attachments=attachments,
            has_thread=has_thread,
        )
    except Exception:
        return None


def extract_thread_replies(page: Page) -> list[Message]:
    """Extract reply messages from the currently open thread panel."""
    js = f'''() => {{
        const SENDER_SEL = '{SENDER_SELECTOR}';
        const TEXT_SEL = '{TEXT_SELECTOR}';
        const TIME_SEL = '{TIME_SELECTOR}';
        const AVATAR_SEL = '{AVATAR_SELECTOR}';
        const REACTION_SEL = '{REACTION_SELECTOR}';
        const ATTACH_SEL = '{ATTACHMENT_SELECTOR}';

        const threadList = document.querySelector('{THREAD_LIST_SELECTOR}');
        if (!threadList) return [];

        const items = threadList.querySelectorAll(':scope > [role="listitem"]');
        const results = [];
        let isFirst = true;

        for (const item of items) {{
            const doc = item.querySelector('[role="document"]');
            if (!doc) continue;

            if (isFirst) {{
                isFirst = false;
                continue;
            }}

            const senderEl = doc.querySelector(SENDER_SEL);
            const sender = senderEl ? senderEl.innerText.trim() : '';

            // Text (preserve inline emoji as :name:)
            let text = '';
            const inlineEmoji = [];
            const textEl = doc.querySelector(TEXT_SEL);
            if (textEl) {{
                const clone = textEl.cloneNode(true);
                clone.querySelectorAll('img').forEach(img => {{
                    const alt = img.getAttribute('alt') || '';
                    const src = img.getAttribute('src') || '';
                    if (alt) inlineEmoji.push({{name: alt, image_url: src}});
                    img.replaceWith(document.createTextNode(alt));
                }});
                text = clone.innerText.trim();
            }}

            const timeEl = doc.querySelector(TIME_SEL);
            let timestamp = '';
            let slackTs = '';
            if (timeEl) {{
                const dataTs = timeEl.getAttribute('data-ts');
                if (dataTs) {{
                    slackTs = dataTs;
                    const d = new Date(parseFloat(dataTs) * 1000);
                    timestamp = d.toISOString();
                }} else {{
                    const dt = timeEl.getAttribute('datetime');
                    timestamp = dt || timeEl.innerText.trim();
                }}
            }}

            // Avatar (search in listitem, not just document)
            const avatarImg = item.querySelector(AVATAR_SEL);
            const avatarUrl = avatarImg ? avatarImg.getAttribute('src') || '' : '';

            // Reactions
            const reactions = [];
            for (const rc of doc.querySelectorAll(REACTION_SEL)) {{
                const img = rc.querySelector('img');
                let name = '';
                let imageUrl = '';
                if (img) {{
                    name = img.getAttribute('alt') || '';
                    imageUrl = img.getAttribute('src') || '';
                }} else {{
                    const span = rc.querySelector('.c-reaction__emoji');
                    if (span) name = span.innerText.trim();
                }}
                if (name) reactions.push({{ name, imageUrl }});
            }}

            // Attachments
            const attachments = [];
            for (const ae of doc.querySelectorAll(ATTACH_SEL)) {{
                const name = ae.innerText.trim();
                const aTag = ae.closest('a');
                const url = aTag ? aTag.href : '';
                if (name) attachments.push({{ name, url }});
            }}

            if (!text && !sender) continue;
            results.push({{ timestamp, slackTs, sender, text, avatarUrl, reactions, attachments, inlineEmoji }});
        }}
        return results;
    }}'''

    replies_data = page.evaluate(js)

    replies = []
    last_sender = ""
    last_avatar = ""
    for rd in replies_data:
        sender = rd["sender"] or last_sender
        avatar = rd.get("avatarUrl", "") or last_avatar
        if rd["sender"]:
            last_sender = rd["sender"]
            last_avatar = rd.get("avatarUrl", "") or last_avatar

        # Normalize reaction keys from JS (imageUrl -> image_url)
        reactions = [
            {"name": r["name"], "image_url": r.get("imageUrl", "")}
            for r in rd.get("reactions", [])
        ]
        inline_emoji = [
            {"name": e["name"], "image_url": e.get("image_url", "")}
            for e in rd.get("inlineEmoji", [])
        ]
        attachments = rd.get("attachments", [])

        replies.append(Message(
            timestamp=rd["timestamp"],
            sender=sender,
            text=rd["text"],
            slack_ts=rd.get("slackTs", ""),
            avatar_url=avatar,
            reactions=reactions,
            inline_emoji=inline_emoji,
            attachments=attachments,
        ))

    return replies
