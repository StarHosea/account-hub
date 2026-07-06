from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from services.register import mail_provider, openai_register  # noqa: E402
from services.register_abnormal_service import register_abnormal_service  # noqa: E402
from services.register_service import RegisterService  # noqa: E402


class RegisterMailboxStopTest(unittest.TestCase):
    def setUp(self):
        openai_register.reset_stop_requested()
        openai_register.reset_progress()

    def test_worker_skips_browser_when_stop_requested(self):
        mailbox = {"provider": mail_provider.API_MAILBOX_TYPE, "address": "a@b.com", "fetch_url": "http://x"}
        with mock.patch.object(mail_provider, "create_mailbox", return_value=mailbox):
            with mock.patch.object(mail_provider, "mark_mailbox_result") as mark_result:
                with mock.patch.object(register_abnormal_service, "add") as add_abnormal:
                    with mock.patch.object(openai_register, "_acquire_working_proxy", return_value=("", "")):
                        with mock.patch.object(openai_register, "_run_browser_job") as browser_job:
                            openai_register.request_stop()
                            result = openai_register.worker(1)
        browser_job.assert_not_called()
        self.assertFalse(result.get("ok"))
        self.assertNotIn("stop_run", result)
        add_abnormal.assert_called_once()
        mark_result.assert_called_once()

    def test_mailbox_shortage_does_not_kill_in_flight_browsers(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = RegisterService()
            svc.update({"total": 3, "threads": 2, "enabled": True})

            with mock.patch.object(openai_register, "worker", return_value={"ok": True, "index": 1}):
                with mock.patch.object(openai_register, "signal_stop_new_tasks") as signal_stop:
                    with mock.patch.object(openai_register, "request_stop") as request_stop:
                        with mock.patch.object(mail_provider, "is_api_pool_exhausted", return_value=True):
                            svc._run()

            signal_stop.assert_not_called()
            request_stop.assert_not_called()

    def test_run_does_not_signal_stop_when_worker_reports_pool_exhausted(self):
        """后启动 worker 取不到邮箱时，只停 submit，不 signal 误伤已领到邮箱的在途 worker。"""
        with tempfile.TemporaryDirectory() as tmp:
            svc = RegisterService()
            svc.update({"total": 10, "threads": 3, "enabled": True})

            def fake_worker(index: int) -> dict:
                if index == 1:
                    return {"ok": True, "index": index}
                return {
                    "ok": False,
                    "index": index,
                    "error": mail_provider.MAILBOX_POOL_EXHAUSTED_MSG,
                    "stop_run": True,
                }

            with mock.patch.object(openai_register, "worker", side_effect=fake_worker):
                with mock.patch.object(openai_register, "signal_stop_new_tasks") as signal_stop:
                    with mock.patch.object(mail_provider, "is_api_pool_exhausted", return_value=False):
                        svc._run()

            signal_stop.assert_not_called()
            self.assertFalse(svc.get()["enabled"])

    def test_run_stops_after_mailbox_exhausted_without_launching_more(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = RegisterService()
            svc.update({"total": 5, "threads": 1, "enabled": True})

            calls = {"n": 0}

            def fake_worker(index: int) -> dict:
                calls["n"] += 1
                if calls["n"] == 1:
                    return {"ok": False, "index": index, "error": "boom"}
                return {
                    "ok": False,
                    "index": index,
                    "error": mail_provider.MAILBOX_POOL_EXHAUSTED_MSG,
                    "stop_run": True,
                }

            with mock.patch.object(openai_register, "worker", side_effect=fake_worker):
                with mock.patch.object(openai_register, "signal_stop_new_tasks") as signal_stop:
                    with mock.patch.object(openai_register, "request_stop") as request_stop:
                        with mock.patch.object(mail_provider, "is_api_pool_exhausted", return_value=False):
                            svc._run()

            self.assertEqual(calls["n"], 2)
            signal_stop.assert_not_called()
            request_stop.assert_not_called()
            self.assertFalse(svc.get()["enabled"])

    def test_resume_skips_when_pool_exhausted(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = RegisterService()
            svc.update({"enabled": True, "total": 5})
            with mock.patch.object(mail_provider, "is_api_pool_exhausted", return_value=True):
                with mock.patch.object(svc, "start") as start:
                    svc.resume_if_enabled()
            start.assert_not_called()
            self.assertFalse(svc.get()["enabled"])

    def test_start_refuses_when_pool_exhausted(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = RegisterService()
            svc.update({"enabled": False, "total": 3})
            with mock.patch.object(mail_provider, "is_api_pool_exhausted", return_value=True):
                out = svc.start()
            self.assertFalse(out["enabled"])
            self.assertTrue(any("无可用地址" in str(x.get("text") or "") for x in out.get("logs") or []))


if __name__ == "__main__":
    unittest.main()
