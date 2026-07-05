from __future__ import annotations

import json
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
    _extract_visible_ui,
    _load_manifest,
    build_brief,
    find_recording_dir,
)
from services.register_service import _normalize  # noqa: E402


class RegisterRecordConfigTest(unittest.TestCase):
    def test_record_enabled_by_default(self):
        cfg = _normalize({})
        self.assertTrue(cfg["record_enabled"])
        self.assertEqual(cfg["record_keep"], "fail")

    def test_spawn_worker_sets_record_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(openai_register.config, {
                "record_enabled": True,
                "record_dir": tmp,
                "record_keep": "fail",
            }, clear=False):
                with mock.patch("services.register.openai_register.subprocess.Popen") as popen:
                    popen.return_value = mock.Mock()
                    openai_register._spawn_worker({"email": "a@b.com"})
        env = popen.call_args.kwargs["env"]
        self.assertEqual(env["REG_RECORD_DIR"], tmp)
        self.assertEqual(env["REG_RECORD_KEEP"], "fail")

    def test_spawn_worker_clears_record_env_when_disabled(self):
        with mock.patch.dict(openai_register.config, {"record_enabled": False}, clear=False):
            with mock.patch("services.register.openai_register.subprocess.Popen") as popen:
                with mock.patch.dict("os.environ", {"REG_RECORD_DIR": "/tmp/old"}, clear=False):
                    popen.return_value = mock.Mock()
                    openai_register._spawn_worker({"email": "a@b.com"})
        env = popen.call_args.kwargs["env"]
        self.assertNotIn("REG_RECORD_DIR", env)


class RegisterDiagServiceTest(unittest.TestCase):
    def test_extract_visible_ui_finds_buttons_and_hints(self):
        html = """
        <html><head><title>ChatGPT</title></head><body>
        <button>继续</button>
        <div role="button">免费注册</div>
        <p>验证码无效，请重试</p>
        </body></html>
        """
        ui = _extract_visible_ui(html)
        self.assertIn("继续", ui["buttons"])
        self.assertTrue(any("验证码无效" in hint for hint in ui["hints"]))

    def test_build_brief_from_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            record_dir = Path(tmp)
            manifest = [
                {
                    "seq": 1,
                    "stepId": "register-start",
                    "ts": 1,
                    "note": "开始",
                    "url": "https://chatgpt.com/",
                    "pageState": "landing",
                    "confidence": "high",
                    "html": "001-register-start.html",
                    "png": "001-register-start.png",
                },
                {
                    "seq": 2,
                    "stepId": "final-error-scene",
                    "ts": 2,
                    "note": "按钮未命中",
                    "url": "https://chatgpt.com/auth",
                    "pageState": "login",
                    "confidence": "low",
                    "reason": "仍在登录页",
                    "html": "002-final-error-scene.html",
                    "png": "002-final-error-scene.png",
                },
            ]
            (record_dir / "manifest.jsonl").write_text(
                "\n".join(json.dumps(row, ensure_ascii=False) for row in manifest),
                encoding="utf-8",
            )
            (record_dir / "002-final-error-scene.html").write_text(
                "<html><body><button>继续</button><p>验证码无效</p></body></html>",
                encoding="utf-8",
            )
            (record_dir / "002-final-error-scene.png").write_bytes(b"png")

            abnormal = mock.Mock()
            abnormal.list_items.return_value = [{
                "email": "a@b.com",
                "reason": "按钮未命中",
                "fetch_url": "http://mail",
                "recording_path": str(record_dir),
                "created_at": "2026-01-01T00:00:00+00:00",
            }]
            with mock.patch("services.register_diag_service.register_abnormal_service", abnormal):
                brief = build_brief("a@b.com")

            self.assertTrue(brief["ok"])
            self.assertEqual(brief["failed_step"], "register-start")
            self.assertEqual(brief["pageState"], "login")
            self.assertIn("继续", brief["visible_ui"]["buttons"])
            self.assertIn("brief", brief["urls"])

    def test_find_recording_dir_by_email_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            older = root / "a-b.com-900"
            older.mkdir()
            target = root / "a-b.com-1000"
            target.mkdir()
            target.touch()
            import os
            os.utime(target, None)
            with mock.patch("services.register_diag_service.resolve_record_root", return_value=root):
                found = find_recording_dir("a@b.com")
            self.assertEqual(found, target)

    def test_load_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            record_dir = Path(tmp)
            (record_dir / "manifest.jsonl").write_text(
                '{"stepId":"s1"}\n\n{"stepId":"s2"}\n',
                encoding="utf-8",
            )
            rows = _load_manifest(record_dir)
            self.assertEqual([row["stepId"] for row in rows], ["s1", "s2"])


if __name__ == "__main__":
    unittest.main()
