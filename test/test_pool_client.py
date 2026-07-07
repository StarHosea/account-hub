from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from services.account_service import AccountService  # noqa: E402
from services.mailbox_service import MailboxService  # noqa: E402
from services.pool_client_service import is_flowpilot_pool_upload, upload_flowpilot_account  # noqa: E402
from services.pool_mail_extract import extract_verification_code  # noqa: E402
from services.pool_mail_fetch import fetch_verification_code  # noqa: E402
from test.test_account_export import MemoryStorage  # noqa: E402
from test.utils import InMemoryStorage  # noqa: E402


class PoolClientServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mailbox_service = MailboxService(storage=InMemoryStorage())
        self.account_service = AccountService(MemoryStorage())
        self.mailbox_service.import_text("a@x.com----http://mail/a\nb@x.com----http://mail/b")
        self._patches = [
            patch("services.pool_client_service.mailbox_service", self.mailbox_service),
            patch("services.pool_client_service.account_service", self.account_service),
        ]
        for item in self._patches:
            item.start()

    def tearDown(self) -> None:
        for item in reversed(self._patches):
            item.stop()

    def test_is_flowpilot_pool_upload(self) -> None:
        self.assertTrue(
            is_flowpilot_pool_upload(
                {
                    "email": "u@icloud.com",
                    "register_status": "success",
                    "access_token": "eyJhbGciOiJIUzI1NiJ9.token",
                }
            )
        )
        self.assertFalse(is_flowpilot_pool_upload({"email": "u@icloud.com"}))
        self.assertFalse(
            is_flowpilot_pool_upload(
                {"email": "u@icloud.com", "tokens": ["eyJhbGciOiJIUzI1NiJ9.token"]}
            )
        )

    def test_claim_release_and_reclaim(self) -> None:
        first = self.mailbox_service.acquire_unused()
        second = self.mailbox_service.acquire_unused()
        self.assertEqual(first["email"], "a@x.com")
        self.assertEqual(second["email"], "b@x.com")
        self.mailbox_service.release("a@x.com")
        reclaimed = self.mailbox_service.acquire_unused()
        self.assertEqual(reclaimed["email"], "a@x.com")

    def test_upload_flowpilot_account_binds_mailbox(self) -> None:
        claimed = self.mailbox_service.acquire_unused()
        email = str(claimed["email"])
        result = upload_flowpilot_account(
            {
                "email": email,
                "password": "Pw!1",
                "access_token": "eyJhbGciOiJIUzI1NiJ9.uploaded.token",
                "totp_secret": "SECRET",
                "register_status": "success",
                "source_browser": "browser-1",
            }
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["added"], 1)
        account = self.account_service.find_by_email(email)
        self.assertIsNotNone(account)
        self.assertEqual(account.get("source_type"), "flowpilot")
        mailbox = next(item for item in self.mailbox_service.list_mailboxes() if item["email"] == email)
        self.assertTrue(mailbox["used"])
        self.assertFalse(mailbox["in_use"])


class PoolMailExtractTests(unittest.TestCase):
    def test_extract_verification_code_from_json(self) -> None:
        payload = json.dumps({"code": "123456"})
        self.assertEqual(extract_verification_code(payload), "123456")
        self.assertEqual(extract_verification_code(payload, exclude=["123456"]), "")

    @patch("services.pool_mail_fetch._fetch_once", return_value='{"code":"654321"}')
    @patch("services.pool_mail_fetch.time.sleep", return_value=None)
    def test_fetch_verification_code(self, _sleep, _fetch_once) -> None:
        code, error = fetch_verification_code("http://mail/a", attempts=1, interval_s=0)
        self.assertEqual(code, "654321")
        self.assertEqual(error, "")


if __name__ == "__main__":
    unittest.main()
