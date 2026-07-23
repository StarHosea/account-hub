from __future__ import annotations

import os
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("ACCOUNT_HUB_AUTH_KEY", "test-auth-key")

from services.register import openai_account_ops as ops
from test.test_account_export import make_jwt


def _ok_result(**extra):
    base = {
        "ok": True,
        "access_token": "new.jwt.token",
        "browser_session": {"cookies": []},
        "fingerprint_seed": 1,
        "via_session": True,
        "reset_password": "",
    }
    base.update(extra)
    return base


class TokenRefreshRoutingTests(unittest.TestCase):
    def test_fresh_token_with_cookies_uses_session_only(self) -> None:
        token = make_jwt({"exp": int(time.time()) + 3600})
        account = {
            "email": "fresh@example.com",
            "password": "",
            "access_token": token,
            "browser_session": {"cookies": [{"name": "session", "value": "1"}]},
        }
        jobs: list[dict] = []

        def fake_drive(job, mail_config, mailbox, log):
            jobs.append(dict(job))
            return _ok_result(via_session=True)

        with (
            patch.object(ops, "_drive_worker", side_effect=fake_drive),
            patch.object(ops, "_account_mail_ctx", return_value=(None, None)),
        ):
            result = ops.run_token_refresh(account)

        self.assertTrue(result["ok"])
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["mode"], "session_refresh")
        self.assertIs(jobs[0].get("fallbackLogin"), False)
        self.assertIn("storageState", jobs[0])

    def test_session_only_failure_falls_back_to_login(self) -> None:
        token = make_jwt({"exp": int(time.time()) + 3600})
        account = {
            "email": "fallback@example.com",
            "password": "",
            "access_token": token,
            "browser_session": {"cookies": [{"name": "session", "value": "1"}]},
        }
        jobs: list[dict] = []

        def fake_drive(job, mail_config, mailbox, log):
            jobs.append(dict(job))
            if job.get("mode") == "session_refresh":
                return {"ok": False, "error": "session dead"}
            return _ok_result(via_session=False, reset_password="")

        with (
            patch.object(ops, "_drive_worker", side_effect=fake_drive),
            patch.object(ops, "_account_mail_ctx", return_value=({"x": 1}, {"address": "fallback@example.com"})),
        ):
            result = ops.run_token_refresh(account)

        self.assertTrue(result["ok"])
        self.assertEqual([j["mode"] for j in jobs], ["session_refresh", "login"])
        self.assertEqual(jobs[1].get("loginPassword"), "")

    def test_no_session_goes_direct_login_without_password(self) -> None:
        token = make_jwt({"exp": int(time.time()) - 10})
        account = {
            "email": "otp@example.com",
            "password": "",
            "access_token": token,
            "browser_session": None,
        }
        jobs: list[dict] = []

        def fake_drive(job, mail_config, mailbox, log):
            jobs.append(dict(job))
            return _ok_result(via_session=False)

        with (
            patch.object(ops, "_drive_worker", side_effect=fake_drive),
            patch.object(ops, "_account_mail_ctx", return_value=({"x": 1}, {"address": "otp@example.com"})),
        ):
            result = ops.run_token_refresh(account)

        self.assertTrue(result["ok"])
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["mode"], "login")
        self.assertEqual(jobs[0].get("loginPassword"), "")

    def test_expired_with_session_tries_session_then_can_fallback_login(self) -> None:
        token = make_jwt({"exp": int(time.time()) - 10})
        account = {
            "email": "expired@example.com",
            "password": "secret",
            "access_token": token,
            "browser_session": {"cookies": [{"name": "session", "value": "1"}]},
        }
        jobs: list[dict] = []

        def fake_drive(job, mail_config, mailbox, log):
            jobs.append(dict(job))
            return _ok_result(via_session=True)

        with (
            patch.object(ops, "_drive_worker", side_effect=fake_drive),
            patch.object(ops, "_account_mail_ctx", return_value=(None, None)),
        ):
            result = ops.run_token_refresh(account)

        self.assertTrue(result["ok"])
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["mode"], "session_refresh")
        self.assertIs(jobs[0].get("fallbackLogin"), True)

    def test_missing_email_fails(self) -> None:
        result = ops.run_token_refresh({"email": "", "password": "x"})
        self.assertFalse(result["ok"])
        self.assertIn("邮箱", result.get("error") or "")


if __name__ == "__main__":
    unittest.main()
