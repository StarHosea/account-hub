from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import services.mailbox_service as mailbox_module  # noqa: E402
from services.account_lifecycle import STAGE_REGISTERED, apply_stage, email_storage_key  # noqa: E402
from services.account_service import AccountService  # noqa: E402
from services.mailbox_service import MailboxService  # noqa: E402
from test.test_account_export import MemoryStorage  # noqa: E402
from test.utils import InMemoryStorage  # noqa: E402


class AccountDeleteByEmailTest(unittest.TestCase):
    EMAIL = "user@icloud.com"
    TOKEN = "eyJhbGciOiJIUzI1NiJ9.registered.token"

    def setUp(self) -> None:
        self.storage = MemoryStorage()
        self.service = AccountService(self.storage)
        self._orig_mailbox = mailbox_module.mailbox_service

    def tearDown(self) -> None:
        mailbox_module.mailbox_service = self._orig_mailbox

    def test_delete_registered_account_by_email_when_stored_under_email_key(self) -> None:
        email_key = email_storage_key(self.EMAIL)
        self.service._accounts[email_key] = self.service._normalize_account(
            apply_stage(
                {
                    "email": self.EMAIL,
                    "access_token": self.TOKEN,
                    "password": "secret",
                },
                STAGE_REGISTERED,
            )
        )

        result = self.service.delete_accounts([self.EMAIL])

        self.assertEqual(result["removed"], 1)
        self.assertIsNone(self.service.find_by_email(self.EMAIL))

    def test_load_accounts_rekeys_legacy_jwt_storage_to_email(self) -> None:
        self.storage.save_accounts(
            [
                {
                    "email": self.EMAIL,
                    "access_token": self.TOKEN,
                    "stage": STAGE_REGISTERED,
                    "type": "free",
                }
            ]
        )
        service = AccountService(self.storage)
        email_key = email_storage_key(self.EMAIL)

        self.assertIn(email_key, service._accounts)
        self.assertNotIn(self.TOKEN, service._accounts)
        result = service.delete_accounts([self.EMAIL])
        self.assertEqual(result["removed"], 1)

    def test_delete_account_resets_mailbox_used_status(self) -> None:
        mailbox = MailboxService(storage=InMemoryStorage())
        mailbox_module.mailbox_service = mailbox
        mailbox.import_text(f"{self.EMAIL}----https://example.com/inbox")
        mailbox.bind_account(self.EMAIL, self.TOKEN)
        self.assertTrue(mailbox.list_mailboxes()[0]["used"])

        self.service._accounts[email_storage_key(self.EMAIL)] = self.service._normalize_account(
            apply_stage(
                {
                    "email": self.EMAIL,
                    "access_token": self.TOKEN,
                    "password": "secret",
                },
                STAGE_REGISTERED,
            )
        )

        self.service.delete_accounts([self.TOKEN])

        mailbox_item = mailbox.list_mailboxes()[0]
        self.assertFalse(mailbox_item["used"])
        self.assertIsNone(mailbox_item["account_token"])
        self.assertIsNone(mailbox_item["registered_at"])


if __name__ == "__main__":
    unittest.main()
