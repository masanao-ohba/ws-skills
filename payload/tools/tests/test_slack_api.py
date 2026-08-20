"""Fixture tests for the Slack API backend's normalization and snapshot writing.

The live API calls cannot be exercised here (they need a workspace token), so the
parts that can go wrong silently — timestamp conversion, markup rendering, sender
resolution, the snapshot envelope — are pinned against recorded API payloads.

    python3 payload/tools/tests/test_slack_api.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import slack_api  # noqa: E402
import slack_output  # noqa: E402

# A conversations.history payload, trimmed to the fields the backend reads.
HISTORY_FIXTURE = {
    "ok": True,
    "messages": [
        {
            "type": "message",
            "user": "U01AAAA",
            "text": "Hi <@U01BBBB>, see <https://example.com/spec|the spec> in <#C01CCCC|general>",
            "ts": "1775000000.000100",
            "thread_ts": "1775000000.000100",
            "reply_count": 2,
            "reactions": [{"name": "eyes", "users": ["U01BBBB"], "count": 1}],
        },
        {
            "type": "message",
            "subtype": "bot_message",
            "bot_id": "B01DDDD",
            "username": "Deploy Bot",
            "text": "release 1.2.0 shipped &amp; verified",
            "ts": "1775000600.000200",
            "files": [
                {"name": "log.txt", "url_private": "https://files.slack.com/files-pri/T-A/log.txt"}
            ],
        },
    ],
}

USERS = {"U01AAAA": "alice", "U01BBBB": "bob"}


class RenderTextTest(unittest.TestCase):
    def test_user_mention_uses_the_display_name(self):
        self.assertEqual(slack_api.render_text("hi <@U01BBBB>", USERS), "hi @bob")

    def test_unknown_user_keeps_the_raw_id(self):
        self.assertEqual(slack_api.render_text("hi <@U09ZZZZ>", USERS), "hi @U09ZZZZ")

    def test_inline_label_wins_over_the_lookup(self):
        self.assertEqual(slack_api.render_text("hi <@U01BBBB|robert>", USERS), "hi @robert")

    def test_channel_mention(self):
        self.assertEqual(slack_api.render_text("in <#C01CCCC|general>"), "in #general")

    def test_special_mention(self):
        self.assertEqual(slack_api.render_text("<!here> ping"), "@here ping")

    def test_link_with_label_becomes_the_label(self):
        self.assertEqual(slack_api.render_text("<https://x.test/a|docs>"), "docs")

    def test_bare_link_keeps_the_url(self):
        self.assertEqual(slack_api.render_text("<https://x.test/a>"), "https://x.test/a")

    def test_html_entities_are_decoded(self):
        self.assertEqual(slack_api.render_text("a &amp; b &lt;c&gt;"), "a & b <c>")

    def test_empty_text_is_safe(self):
        self.assertEqual(slack_api.render_text(""), "")
        self.assertEqual(slack_api.render_text(None), "")


class TimestampTest(unittest.TestCase):
    def test_slack_ts_to_iso_utc(self):
        self.assertEqual(slack_api.to_iso("1775000000.000100"), "2026-03-31T23:33:20.000100+00:00")

    def test_unparseable_ts_is_passed_through(self):
        self.assertEqual(slack_api.to_iso("not-a-ts"), "not-a-ts")

    def test_since_date_becomes_utc_midnight(self):
        self.assertEqual(slack_api.to_iso(slack_api.to_epoch("2026-04-01")), "2026-04-01T00:00:00+00:00")


class SenderTest(unittest.TestCase):
    def test_known_user(self):
        self.assertEqual(slack_api.sender_name({"user": "U01AAAA"}, USERS), "alice")

    def test_unknown_user_falls_back_to_the_id(self):
        self.assertEqual(slack_api.sender_name({"user": "U09ZZZZ"}, USERS), "U09ZZZZ")

    def test_bot_username(self):
        self.assertEqual(
            slack_api.sender_name({"bot_id": "B01DDDD", "username": "Deploy Bot"}), "Deploy Bot"
        )

    def test_bot_profile_name(self):
        self.assertEqual(
            slack_api.sender_name({"bot_id": "B01DDDD", "bot_profile": {"name": "CI"}}), "CI"
        )


class NormalizeTest(unittest.TestCase):
    def test_message_shape_matches_the_snapshot_contract(self):
        msg = slack_api.normalize_message(HISTORY_FIXTURE["messages"][0], USERS)
        self.assertEqual(
            set(msg),
            {
                "timestamp", "sender", "text", "avatar_url",
                "reactions", "attachments", "slack_ts", "user_id", "has_thread",
            },
        )
        self.assertEqual(msg["sender"], "alice")
        self.assertEqual(msg["text"], "Hi @bob, see the spec in #general")
        self.assertEqual(msg["reactions"], [{"name": "eyes", "image_url": "", "count": 1}])
        self.assertEqual(msg["slack_ts"], "1775000000.000100")

    def test_files_become_attachments(self):
        msg = slack_api.normalize_message(HISTORY_FIXTURE["messages"][1], USERS)
        self.assertEqual(
            msg["attachments"],
            [{"name": "log.txt", "url": "https://files.slack.com/files-pri/T-A/log.txt"}],
        )
        self.assertEqual(msg["sender"], "Deploy Bot")

    def test_thread_parent_is_detected(self):
        self.assertTrue(slack_api.has_thread(HISTORY_FIXTURE["messages"][0]))

    def test_thread_parent_is_marked_like_the_scraper(self):
        # parser.py sets has_thread on thread parents; the shapes must match.
        msg = slack_api.normalize_message(HISTORY_FIXTURE["messages"][0], USERS)
        self.assertIs(msg["has_thread"], True)

    def test_a_plain_message_carries_no_thread_mark(self):
        msg = slack_api.normalize_message(HISTORY_FIXTURE["messages"][1], USERS)
        self.assertNotIn("has_thread", msg)

    def test_a_reply_is_not_a_thread_parent(self):
        reply = {"ts": "1775000100.000000", "thread_ts": "1775000000.000100", "reply_count": 0}
        self.assertFalse(slack_api.has_thread(reply))

    def test_a_plain_message_is_not_a_thread_parent(self):
        self.assertFalse(slack_api.has_thread(HISTORY_FIXTURE["messages"][1]))


class SnapshotTest(unittest.TestCase):
    def test_envelope_and_counts(self):
        users = USERS
        messages = []
        for raw in HISTORY_FIXTURE["messages"]:
            msg = slack_api.normalize_message(raw, users)
            if slack_api.has_thread(raw):
                msg["thread_replies"] = [
                    slack_api.normalize_message(
                        {"user": "U01BBBB", "text": "on it", "ts": "1775000100.000000"}, users
                    )
                ]
            messages.append(msg)

        with tempfile.TemporaryDirectory() as tmp:
            os.environ["WS_OUTPUT_DIR"] = tmp
            try:
                out = slack_output.write_snapshot(
                    messages,
                    backend="api",
                    team_id="T0123456789",
                    channel_id="C0123456789",
                    workspace="example",
                    since="2026-04-01",
                    label="release",
                )
            finally:
                del os.environ["WS_OUTPUT_DIR"]

            data = json.loads(Path(out).read_text(encoding="utf-8"))

        self.assertTrue(out.name.startswith("slack-release-"))
        self.assertEqual(data["source"], "slack")
        self.assertEqual(data["backend"], "api")
        self.assertEqual(data["team_id"], "T0123456789")
        self.assertEqual(data["range_from"], "2026-04-01")
        self.assertEqual(data["message_count"], 2)
        self.assertEqual(data["thread_reply_count"], 1)
        self.assertEqual(data["messages"][0]["thread_replies"][0]["sender"], "bob")

    def test_a_second_run_never_overwrites_the_first(self):
        messages = [slack_api.normalize_message(HISTORY_FIXTURE["messages"][0], USERS)]
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["WS_OUTPUT_DIR"] = tmp
            try:
                first = slack_output.write_snapshot(
                    messages, backend="api", team_id="T1", channel_id="C1", label="dup"
                )
                second = slack_output.write_snapshot(
                    messages, backend="api", team_id="T1", channel_id="C1", label="dup"
                )
            finally:
                del os.environ["WS_OUTPUT_DIR"]
            self.assertNotEqual(first, second)
            self.assertTrue(first.exists() and second.exists())


class ThreadFailureTest(unittest.TestCase):
    """A thread that could not be read must not read as a thread with no replies.

    The browser backend drops one intermittently; when it does, the snapshot has to
    say so, or a later reader counts the gap as a fact about the conversation.
    """

    def test_failures_are_counted_in_the_envelope(self):
        messages = [
            {"timestamp": "2026-08-18T02:29:32+00:00", "sender": "a", "text": "one"},
            {
                "timestamp": "2026-08-18T02:37:20+00:00",
                "sender": "b",
                "text": "two",
                "thread_replies_failed": True,
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["WS_OUTPUT_DIR"] = tmp
            try:
                out = slack_output.write_snapshot(
                    messages, backend="browser", team_id="T1", channel_id="C1"
                )
            finally:
                del os.environ["WS_OUTPUT_DIR"]
            written = json.loads(out.read_text(encoding="utf-8"))

        self.assertEqual(written["thread_failure_count"], 1)
        self.assertTrue(written["messages"][1]["thread_replies_failed"])

    def test_a_clean_run_still_carries_the_count(self):
        messages = [{"timestamp": "2026-08-18T02:29:32+00:00", "sender": "a", "text": "one"}]
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["WS_OUTPUT_DIR"] = tmp
            try:
                out = slack_output.write_snapshot(
                    messages, backend="api", team_id="T1", channel_id="C1"
                )
            finally:
                del os.environ["WS_OUTPUT_DIR"]
            written = json.loads(out.read_text(encoding="utf-8"))

        # Zero has to be written, not omitted: absent would be indistinguishable
        # from a snapshot taken before the count existed.
        self.assertEqual(written["thread_failure_count"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
