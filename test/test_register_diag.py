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
    _extract_goto_retries,
    _extract_manifest_capture,
    _extract_manifest_code_capture,
    _extract_visible_ui,
    _load_manifest,
    _proxy_from_abnormal,
    build_brief,
    find_recording_dir,
)
from services.register_service import _normalize  # noqa: E402


class RegisterRecordConfigTest(unittest.TestCase):
    def test_record_enabled_by_default(self):
        cfg = _normalize({})
        self.assertTrue(cfg["record_enabled"])
        self.assertEqual(cfg["record_keep"], "fail")

    def test_spawn_worker_sets_record_on_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(openai_register.config, {
                "record_enabled": True,
                "record_dir": tmp,
                "record_keep": "fail",
            }, clear=False):
                with mock.patch("services.register.openai_register.subprocess.Popen") as popen:
                    popen.return_value = mock.Mock()
                    openai_register._spawn_worker({"email": "a@b.com", "recordDir": tmp, "recordKeep": "fail"})
        cmd = popen.call_args.args[0]
        job = json.loads(cmd[2])
        self.assertEqual(job["recordDir"], tmp)
        self.assertEqual(job["recordKeep"], "fail")

    def test_record_job_options_default_keep_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(openai_register.config, {
                "record_enabled": True,
                "record_dir": tmp,
            }, clear=False):
                opts = openai_register.record_job_options()
        self.assertEqual(opts["recordDir"], tmp)
        self.assertEqual(opts["recordKeep"], "fail")


class RegisterDiagServiceTest(unittest.TestCase):
    def test_extract_visible_ui_finds_buttons_and_hints(self):
        html = """
        <html><head><title>ChatGPT</title></head><body>
        <button>继续</button>
        <button><span>続行</span></button>
        <div role="button">免费注册</div>
        <p>验证码无效，请重试</p>
        </body></html>
        """
        ui = _extract_visible_ui(html)
        self.assertIn("继续", ui["buttons"])
        self.assertIn("続行", ui["buttons"])
        self.assertTrue(any("验证码无效" in hint for hint in ui["hints"]))

    def test_extract_manifest_capture_reads_auth_ui(self):
        manifest = [
            {
                "stepId": "register-02-pre-continue",
                "note": "authSurface=dialog",
                "authSurface": "dialog",
                "authUi": {"authSurface": "dialog", "buttons": [{"text": "続行", "scope": "dialog"}]},
            },
            {
                "stepId": "register-02-after-continue",
                "note": "continue=dialog-submit",
                "continueHit": "dialog-submit",
                "authSurface": "dialog",
                "authUi": {"authSurface": "dialog", "buttons": [{"text": "続行", "scope": "dialog"}]},
            },
            {
                "stepId": "register-02-post-email",
                "note": "landing=unknown continue=dialog-submit",
                "landing": "unknown",
                "continueHit": "dialog-submit",
            },
        ]
        capture = _extract_manifest_capture(manifest)
        self.assertEqual(capture["after_continue"]["continueHit"], "dialog-submit")
        self.assertEqual(capture["post_email"]["landing"], "unknown")
        self.assertEqual(capture["pre_continue"]["authUi"]["buttons"][0]["text"], "続行")

    def test_extract_manifest_code_capture_prefers_invalid_step(self):
        manifest = [
            {
                "stepId": "register-04-code-filled",
                "note": "注册验证码已填 code=111111",
                "code": "111111",
                "codeReceivedAt": "2026-07-01 22:45:38",
                "codeInputMode": "single",
                "codeReadbackMatches": True,
            },
            {
                "stepId": "register-04-code-invalid",
                "note": "验证码无效 hint=不正確なコード",
                "code": "111111",
                "codeReceivedAt": "2026-07-01 22:45:38",
                "invalidHintText": "不正確なコード",
            },
            {"stepId": "final-error-scene", "note": "验证码无效"},
        ]
        capture = _extract_manifest_code_capture(manifest)
        self.assertEqual(capture["stepId"], "register-04-code-invalid")
        self.assertEqual(capture["code"], "111111")
        self.assertEqual(capture["codeReceivedAt"], "2026-07-01 22:45:38")
        self.assertEqual(capture["invalidHintText"], "不正確なコード")

    def test_extract_goto_retries(self):
        manifest = [
            {"stepId": "register-00-goto-fail-1", "note": "timeout", "url": "chrome-error://", "attempt": 1, "attempts": 3},
            {"stepId": "register-00-goto-fail-2", "note": "timeout", "url": "chrome-error://", "attempt": 2, "attempts": 3},
            {"stepId": "final-error-scene", "note": "多次打开失败"},
        ]
        rows = _extract_goto_retries(manifest)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["stepId"], "register-00-goto-fail-1")

    def test_proxy_from_abnormal(self):
        proxy = _proxy_from_abnormal({
            "proxy_region": "US",
            "proxy_host": "gate.ipweb.cc",
            "proxy_sid": "…abcd",
            "exit_ip": "1.2.3.4",
            "proxy_mode": "ipweb",
            "proxy_scheme": "",
        })
        self.assertEqual(proxy["proxy_region"], "US")
        self.assertNotIn("proxy_scheme", proxy)

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
                "proxy_region": "US",
                "proxy_host": "gate.ipweb.cc",
                "proxy_sid": "…abcd",
                "exit_ip": "1.2.3.4",
                "proxy_mode": "ipweb",
            }]
            with mock.patch("services.register_diag_service.register_abnormal_service", abnormal):
                brief = build_brief("a@b.com")

            self.assertTrue(brief["ok"])
            self.assertEqual(brief["failed_step"], "register-start")
            self.assertEqual(brief["pageState"], "login")
            self.assertEqual(brief["proxy"]["proxy_region"], "US")
            self.assertIn("继续", brief["visible_ui"]["buttons"])
            self.assertIn("brief", brief["urls"])

    def test_build_brief_prefers_engine_error_over_generic_abnormal(self):
        with tempfile.TemporaryDirectory() as tmp:
            record_dir = Path(tmp)
            manifest = [
                {
                    "seq": 7,
                    "stepId": "register-05-profile-submitted",
                    "ts": 7,
                    "note": "资料已提交",
                    "url": "https://auth.openai.com/about-you",
                    "pageState": "new_needs_profile",
                    "confidence": "high",
                    "html": "007-register-05-profile-submitted.html",
                    "png": "007-register-05-profile-submitted.png",
                },
                {
                    "seq": 8,
                    "stepId": "final-error-scene",
                    "ts": 8,
                    "note": "二次验证码无效",
                    "url": "https://auth.openai.com/about-you",
                    "pageState": "new_needs_profile",
                    "confidence": "high",
                    "html": "008-final-error-scene.html",
                    "png": "008-final-error-scene.png",
                },
            ]
            (record_dir / "manifest.jsonl").write_text(
                "\n".join(json.dumps(row, ensure_ascii=False) for row in manifest),
                encoding="utf-8",
            )
            (record_dir / "008-final-error-scene.html").write_text(
                "<html><body><p>続けるには有効な年齢を入力してください</p></body></html>",
                encoding="utf-8",
            )
            (record_dir / "008-final-error-scene.png").write_bytes(b"png")

            abnormal = mock.Mock()
            abnormal.list_items.return_value = [{
                "email": "b@b.com",
                "reason": "浏览器引擎未返回结果（进程可能被终止或超时）",
                "fetch_url": "http://mail",
                "recording_path": str(record_dir),
                "created_at": "2026-01-01T00:00:00+00:00",
            }]
            with mock.patch("services.register_diag_service.register_abnormal_service", abnormal):
                brief = build_brief("b@b.com")

            self.assertEqual(brief["reason"], "二次验证码无效")
            self.assertEqual(brief["engine_error"], "二次验证码无效")
            self.assertIn("浏览器引擎未返回结果", brief["abnormal_reason"])
            self.assertEqual(brief["failed_step"], "register-05-profile-submitted")

    def test_extract_visible_ui_japanese_age_hint(self):
        html = """
        <html><body>
        <p>続けるには有効な年齢を入力してください</p>
        <button>アカウントの作成を完了する</button>
        </body></html>
        """
        ui = _extract_visible_ui(html)
        self.assertTrue(any("有効な年齢" in hint for hint in ui["hints"]))
        self.assertIn("アカウントの作成を完了する", ui["buttons"])

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
