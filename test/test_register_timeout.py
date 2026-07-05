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

    def test_default_register_timeout_is_15_minutes(self):
        with mock.patch.dict(openai_register.config, {"register_timeout": 900}, clear=False):
            self.assertEqual(openai_register._register_timeout_s(), 900)

    def test_worker_fails_when_deadline_elapsed_before_browser(self):
        mailbox = {"provider": mail_provider.API_MAILBOX_TYPE, "address": "a@b.com", "fetch_url": "http://x"}
        # worker 启动时记 deadline；邮箱/代理步骤很快走完，到启动浏览器前时钟已越过 deadline。
        time_seq = iter([1000.0, 1000.0, 1000.0, 1002.0, 1002.0, 1002.0])
        with mock.patch.dict(openai_register.config, {"register_timeout": 1}, clear=False):
            with mock.patch("services.register.openai_register.time.time", side_effect=lambda: next(time_seq)):
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
            data, err, partial = openai_register._run_browser_job(
                1, "a@b.com", mailbox, "", identity, deadline_at=deadline_at,
            )
        spawn.assert_not_called()
        self.assertIsNone(data)
        self.assertIn("注册超时", str(err or ""))
        self.assertEqual(partial, {})


if __name__ == "__main__":
    unittest.main()
