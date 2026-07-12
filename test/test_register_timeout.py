from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from services.register import mail_provider, openai_register  # noqa: E402


class RegisterTimeoutTest(unittest.TestCase):
    def setUp(self):
        openai_register.reset_stop_requested()
        openai_register.reset_progress()

    def test_default_register_timeout_is_10_minutes(self):
        from services.register_service import _normalize

        cfg = _normalize({})
        self.assertEqual(cfg["register_timeout"], 600)
        self.assertEqual(cfg["ip_duration"], 10)
        self.assertTrue(cfg["auto_set_password"])

        with mock.patch.dict(openai_register.config, {"register_timeout": 600}, clear=False):
            self.assertEqual(openai_register._register_timeout_s(), 600)

    def test_auto_set_password_normalize(self):
        from services.register_service import _normalize

        self.assertFalse(_normalize({"auto_set_password": False})["auto_set_password"])

    def test_ip_duration_follows_register_timeout(self):
        from services.register_service import _normalize

        cfg = _normalize({"register_timeout": 600})
        self.assertEqual(cfg["register_timeout"], 600)
        self.assertEqual(cfg["ip_duration"], 10)

        cfg2 = _normalize({"register_timeout": 120})
        self.assertEqual(cfg2["ip_duration"], 2)

    def test_worker_fails_when_deadline_elapsed_before_browser(self):
        mailbox = {"provider": mail_provider.API_MAILBOX_TYPE, "address": "a@b.com", "fetch_url": "http://x"}
        checks = iter([60.0, 60.0, 0.0, 0.0])
        with mock.patch.object(openai_register, "_remaining_task_seconds", side_effect=lambda _d: next(checks)):
            with mock.patch.object(mail_provider, "create_mailbox", return_value=mailbox):
                with mock.patch.object(openai_register, "_acquire_working_proxy", return_value=("", "")):
                    with mock.patch.object(openai_register, "_run_browser_job") as browser_job:
                        result = openai_register.worker(1)
        browser_job.assert_not_called()
        self.assertFalse(result.get("ok"))
        self.assertIn("注册超时", str(result.get("error") or ""))

    def test_run_browser_job_terminates_on_deadline(self):
        mailbox = {"provider": mail_provider.API_MAILBOX_TYPE, "address": "a@b.com", "fetch_url": "http://x"}
        identity = openai_register.build_identity(enabled_regions=["US"])
        deadline_at = time.time() - 1
        with mock.patch.object(openai_register, "_spawn_worker") as spawn:
            data, err, partial, recording_dir = openai_register._run_browser_job(
                1, "a@b.com", mailbox, "", identity, deadline_at=deadline_at,
            )
        spawn.assert_not_called()
        self.assertIsNone(data)
        self.assertIn("注册超时", str(err or ""))
        self.assertEqual(partial, {})
        self.assertEqual(recording_dir, "")


if __name__ == "__main__":
    unittest.main()
