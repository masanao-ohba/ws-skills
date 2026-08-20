"""Tests for output-path handling — the git guard in particular.

Snapshots land inside whatever project Claude Code is working in, so the
directory has to arrive already excluded from version control. What could go
wrong quietly is the guard not being written at all, or being written over a
decision the project already made.

    python3 payload/tools/tests/test_ws_paths.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import ws_paths  # noqa: E402


class GitGuardTest(unittest.TestCase):
    def test_new_directory_is_created_and_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = ws_paths.ensure_output_dir(Path(tmp) / "references" / "raw-source")
            guard = out / ".gitignore"
            self.assertTrue(out.is_dir())
            self.assertTrue(guard.exists())
            # `*` covers the guard itself, so the whole directory stays invisible
            # to git rather than leaving a tracked file behind.
            self.assertIn("*", guard.read_text(encoding="utf-8").splitlines())

    def test_existing_gitignore_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "raw-source"
            out.mkdir()
            (out / ".gitignore").write_text("!keep.json\n", encoding="utf-8")
            ws_paths.ensure_output_dir(out)
            self.assertEqual((out / ".gitignore").read_text(encoding="utf-8"), "!keep.json\n")

    def test_unique_path_writes_the_guard(self):
        """Every snapshot writer reaches the directory through unique_path."""
        with tempfile.TemporaryDirectory() as tmp:
            out = ws_paths.unique_path(Path(tmp) / "raw-source", "backlog-ABC123-45.json")
            self.assertTrue((out.parent / ".gitignore").exists())

    def test_a_second_snapshot_never_replaces_the_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = ws_paths.unique_path(Path(tmp) / "raw-source", "gcal-2026-04-01_2026-04-30.json")
            first.write_text("{}", encoding="utf-8")
            second = ws_paths.unique_path(first.parent, first.name)
            self.assertNotEqual(first, second)
            self.assertTrue(first.exists())

    def test_a_dotted_title_keeps_its_name(self):
        """A Doc titled `v1.2 design` must not become `v1-2.2 design.md`."""
        with tempfile.TemporaryDirectory() as tmp:
            first = ws_paths.unique_path(Path(tmp) / "raw-source", "v1.2 design.md")
            first.write_text("#", encoding="utf-8")
            second = ws_paths.unique_path(first.parent, "v1.2 design.md")
            self.assertEqual(second.name, "v1.2 design-2.md")

    def test_guard_lands_in_the_configured_output_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["WS_OUTPUT_DIR"] = str(Path(tmp) / "elsewhere")
            try:
                target = ws_paths.ensure_output_dir(ws_paths.raw_source())
            finally:
                del os.environ["WS_OUTPUT_DIR"]
            self.assertEqual(target, Path(tmp) / "elsewhere")
            self.assertTrue((target / ".gitignore").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
