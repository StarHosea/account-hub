from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from services.register import openai_register  # noqa: E402
from services.register_diag_service import (  # noqa: E402
    _all_recording_dirs,
    delete_recordings_for_emails,
    find_recording_dir,
)


class RegisterRecordingCleanupTest(unittest.TestCase):
    def test_all_recording_dirs_finds_multiple_attempts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            email = "a@b.com"
            first = root / "a-b.com-111"
            second = root / "a-b.com-222"
            first.mkdir()
            second.mkdir()
            (first / "manifest.jsonl").write_text("{}", encoding="utf-8")
            (second / "manifest.jsonl").write_text("{}", encoding="utf-8")

            with mock.patch.dict(openai_register.config, {"record_enabled": True, "record_dir": str(root)}, clear=False):
                dirs = _all_recording_dirs(email)
                self.assertEqual(len(dirs), 2)
                self.assertEqual(find_recording_dir(email).resolve(), second.resolve())

    def test_delete_recordings_for_emails_removes_all_matching_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "a-b.com-111"
            other = root / "c-d.com-999"
            target.mkdir()
            other.mkdir()
            payload = "x" * 1024
            (target / "trace.zip").write_text(payload, encoding="utf-8")
            (other / "trace.zip").write_text(payload, encoding="utf-8")

            with mock.patch.dict(openai_register.config, {"record_enabled": True, "record_dir": str(root)}, clear=False):
                result = delete_recordings_for_emails(["a@b.com"])

            self.assertEqual(result["dirs_removed"], 1)
            self.assertGreaterEqual(result["bytes_freed"], 1024)
            self.assertFalse(target.exists())
            self.assertTrue(other.exists())

    def test_delete_recordings_ignores_hint_outside_record_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            record_root = root / "recordings"
            outside = root / "outside"
            record_root.mkdir()
            outside.mkdir()
            (outside / "manifest.jsonl").write_text("{}", encoding="utf-8")

            with mock.patch.dict(openai_register.config, {"record_enabled": True, "record_dir": str(record_root)}, clear=False):
                result = delete_recordings_for_emails(
                    ["a@b.com"],
                    hints={"a@b.com": str(outside)},
                )

            self.assertEqual(result["dirs_removed"], 0)
            self.assertTrue(outside.exists())


if __name__ == "__main__":
    unittest.main()
