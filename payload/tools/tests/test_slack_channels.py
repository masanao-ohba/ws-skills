"""Tests for turning a channel name into an ID.

The lookup itself needs a workspace, so what is pinned here is everything around
it: what counts as an ID, what the cache does, and — the part that decides whether
a run is fast or takes a minute — that a remembered name never reaches a backend.

    python3 payload/tools/tests/test_slack_channels.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import fetch_slack  # noqa: E402
import slack_channels  # noqa: E402


def stub_browser(test, resolve):
    """Stand in for the browser backend, which needs Playwright and a workspace.

    The backend is imported inside the function under test, so a module in
    sys.modules is what it picks up.
    """
    module = types.ModuleType("slack_browser")
    module.resolve_channel = resolve
    previous = sys.modules.get("slack_browser")
    sys.modules["slack_browser"] = module

    def restore():
        if previous is None:
            sys.modules.pop("slack_browser", None)
        else:
            sys.modules["slack_browser"] = previous

    test.addCleanup(restore)


class SandboxedHome(unittest.TestCase):
    """Each test gets its own config home, so no cache survives into the next."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._saved = {k: os.environ.get(k) for k in ("WS_SKILLS_HOME", "SLACK_TEAM_ID")}
        os.environ["WS_SKILLS_HOME"] = self._tmp.name
        os.environ["SLACK_TEAM_ID"] = "T0123456789"

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


class NameTest(unittest.TestCase):
    def test_ids_are_recognised(self):
        for value in ("C0123456789", "D0123456789", "G0123456789"):
            self.assertTrue(slack_channels.looks_like_id(value), value)

    def test_names_are_not_mistaken_for_ids(self):
        for value in ("release", "ops-alerts", "#release", "Costs2026"):
            self.assertFalse(slack_channels.looks_like_id(value), value)

    def test_leading_hash_is_dropped(self):
        self.assertEqual(slack_channels.normalize("#release"), "release")
        self.assertEqual(slack_channels.normalize("  release "), "release")


class CacheTest(SandboxedHome):
    def test_round_trip_is_scoped_to_a_workspace(self):
        slack_channels.remember("T1", "release", "C111")
        slack_channels.remember("T2", "release", "C222")
        self.assertEqual(slack_channels.cached("T1", "release"), "C111")
        self.assertEqual(slack_channels.cached("T2", "release"), "C222")
        self.assertIsNone(slack_channels.cached("T3", "release"))

    def test_hash_prefixed_name_finds_the_same_entry(self):
        slack_channels.remember("T1", "release", "C111")
        self.assertEqual(slack_channels.cached("T1", "#release"), "C111")

    def test_a_damaged_cache_costs_a_lookup_not_the_run(self):
        path = slack_channels.cache_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{ this is not json", encoding="utf-8")
        self.assertIsNone(slack_channels.cached("T1", "release"))

    def test_the_cache_is_not_world_readable(self):
        slack_channels.remember("T1", "release", "C111")
        self.assertEqual(slack_channels.cache_file().stat().st_mode & 0o777, 0o600)


class ResolveTest(SandboxedHome):
    def test_an_id_is_returned_untouched(self):
        self.assertEqual(fetch_slack.resolve_channel("C0123456789"), "C0123456789")

    def test_a_remembered_name_never_reaches_a_backend(self):
        slack_channels.remember("T0123456789", "release", "C0000000001")

        def explode(*a, **kw):  # pragma: no cover - reaching this is the failure
            raise AssertionError("a cached name should not start a lookup")

        stub_browser(self, explode)
        self.assertEqual(
            fetch_slack.resolve_channel("release", backend="browser"), "C0000000001"
        )

    def test_a_fresh_name_is_looked_up_once_and_remembered(self):
        calls = []
        stub_browser(self, lambda name, **kw: (calls.append(name), "C0000000002")[1])

        self.assertEqual(fetch_slack.resolve_channel("alerts", backend="browser"), "C0000000002")
        self.assertEqual(fetch_slack.resolve_channel("alerts", backend="browser"), "C0000000002")
        self.assertEqual(calls, ["alerts"], "the second call should come from the cache")
        self.assertEqual(slack_channels.cached("T0123456789", "alerts"), "C0000000002")

    def test_a_name_is_remembered_per_workspace(self):
        stub_browser(self, lambda name, **kw: "C0000000003")
        fetch_slack.resolve_channel("alerts", team_id="T9999999999", backend="browser")

        self.assertEqual(slack_channels.cached("T9999999999", "alerts"), "C0000000003")
        self.assertIsNone(slack_channels.cached("T0123456789", "alerts"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
