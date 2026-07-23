from __future__ import annotations

import os
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("ACCOUNT_HUB_AUTH_KEY", "test-auth-key")

from services.account_lifecycle import STAGE_REGISTERED, apply_stage, email_storage_key
from services.account_service import AccountService
from test.test_account_export import MemoryStorage, make_jwt


class RefreshAccountTokenSkipLogsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = AccountService(MemoryStorage())

    def _put(self, email: str, **fields) -> str:
        token = str(fields.get("access_token") or make_jwt({"exp": int(time.time()) - 10, "email": email}))
        payload = {
            "email": email,
            "access_token": token,
            "password": fields.get("password", ""),
            "type": "free",
            "plan": "free",
        }
        if "browser_session" in fields:
            payload["browser_session"] = fields["browser_session"]
        if "fetch_url" in fields:
            payload["fetch_url"] = fields["fetch_url"]
        self.service._accounts[email_storage_key(email)] = self.service._normalize_account(
            apply_stage(payload, STAGE_REGISTERED)
        )
        return token

    def test_skip_without_password_and_mailbox_writes_operation_log(self) -> None:
        token = self._put("skip-pwd@example.com", password="")
        with (
            patch("services.account_service.log_service.add") as add_log,
            patch("services.mailbox_service.mailbox_service.get_fetch_url", return_value=None),
        ):
            result = self.service.refresh_account_tokens([token], progress_id="rotate-skip-1")

        self.assertEqual(result["rotated"], 0)
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["errors"][0]["error"], "无密码且无法收码")
        summaries = [call.args[1] for call in add_log.call_args_list]
        self.assertIn("刷新 Token 跳过", summaries)
        skip_calls = [call for call in add_log.call_args_list if call.args[1] == "刷新 Token 跳过"]
        self.assertEqual(skip_calls[0].args[2]["reason"], "无密码且无法收码")

    def test_skip_without_email_writes_operation_log(self) -> None:
        token = make_jwt({"exp": int(time.time()) - 10})
        self.service._accounts[token] = self.service._normalize_account(
            apply_stage(
                {"access_token": token, "password": "x", "type": "free", "plan": "free"},
                STAGE_REGISTERED,
            )
        )
        # normalize may keep email None
        with patch("services.account_service.log_service.add") as add_log:
            result = self.service.refresh_account_tokens([token], progress_id="rotate-skip-email")

        self.assertEqual(result["errors"][0]["error"], "无邮箱")
        skip_calls = [call for call in add_log.call_args_list if call.args[1] == "刷新 Token 跳过"]
        self.assertEqual(skip_calls[0].args[2]["reason"], "无邮箱")

    def test_skip_missing_account_writes_operation_log(self) -> None:
        with patch("services.account_service.log_service.add") as add_log:
            result = self.service.refresh_account_tokens(["missing-token"], progress_id="rotate-skip-2")

        self.assertEqual(result["rotated"], 0)
        self.assertEqual(result["errors"][0]["error"], "账号不存在")
        summaries = [call.args[1] for call in add_log.call_args_list]
        self.assertIn("刷新 Token 跳过", summaries)

    def test_no_password_with_mailbox_does_not_skip(self) -> None:
        token = self._put("otp@example.com", password="")
        with (
            patch("services.mailbox_service.mailbox_service.get_fetch_url", return_value="https://mail.example/feed"),
            patch.object(
                self.service,
                "rotate_access_token",
                return_value=("new-token", True, True),
            ) as rotate,
        ):
            result = self.service.refresh_account_tokens([token], progress_id="rotate-otp-1")

        self.assertEqual(result["rotated"], 1)
        self.assertEqual(result["errors"], [])
        rotate.assert_called_once()

    def test_fresh_token_with_session_does_not_skip_without_password(self) -> None:
        token = make_jwt({"exp": int(time.time()) + 3600, "email": "sess@example.com"})
        self._put(
            "sess@example.com",
            access_token=token,
            password="",
            browser_session={"cookies": [{"name": "a", "value": "b"}]},
        )
        with (
            patch("services.mailbox_service.mailbox_service.get_fetch_url", return_value=None),
            patch.object(
                self.service,
                "rotate_access_token",
                return_value=(token, True, False),
            ) as rotate,
        ):
            result = self.service.refresh_account_tokens([token], progress_id="rotate-sess-1")

        self.assertEqual(result["rotated"], 1)
        rotate.assert_called_once()


    def test_refresh_access_token_allows_otp_without_password(self) -> None:
        token = make_jwt({"exp": int(time.time()) - 10, "email": "auto-otp@example.com"})
        self._put("auto-otp@example.com", access_token=token, password="")
        with (
            patch("services.mailbox_service.mailbox_service.get_fetch_url", return_value="https://mail.example/feed"),
            patch(
                "services.register.openai_account_ops.run_browser_login",
                return_value={"ok": True, "access_token": "rotated.jwt", "reset_password": "", "browser_session": None},
            ) as login,
            patch.object(self.service, "_apply_refreshed_tokens", return_value="rotated.jwt"),
            patch.object(self.service, "update_account"),
        ):
            out = self.service.refresh_access_token(token, force=True, event="test_auto")

        self.assertEqual(out, "rotated.jwt")
        login.assert_called_once()
        self.assertEqual(login.call_args.args[0], "auto-otp@example.com")
        self.assertEqual(login.call_args.args[1], "")

    def test_refresh_access_token_skips_without_mailbox_or_password(self) -> None:
        token = make_jwt({"exp": int(time.time()) - 10, "email": "stuck@example.com"})
        self._put("stuck@example.com", access_token=token, password="")
        with patch("services.mailbox_service.mailbox_service.get_fetch_url", return_value=None):
            out = self.service.refresh_access_token(token, force=True, event="test_skip")
        self.assertEqual(out, token)


if __name__ == "__main__":
    unittest.main()
