from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from services.account_lifecycle import STAGE_REGISTERING, email_storage_key  # noqa: E402
from services.account_service import AccountService  # noqa: E402
from test.test_account_export import MemoryStorage  # noqa: E402


class RegisterCredentialsPersistenceTest(unittest.TestCase):
    EMAIL = "regcred@example.com"
    TOKEN = "eyJhbGciOiJIUzI1NiJ9.regcred.token"

    def setUp(self) -> None:
        self.storage = MemoryStorage()
        self.service = AccountService(self.storage)

    def test_complete_registration_preserves_password_and_totp(self) -> None:
        email_key = email_storage_key(self.EMAIL)
        self.service._accounts[email_key] = self.service._normalize_account(
            {"email": self.EMAIL, "stage": STAGE_REGISTERING, "_registering": True}
        )
        self.service.add_account_items(
            [
                {
                    "email": self.EMAIL,
                    "access_token": self.TOKEN,
                    "password": "PwReg123!",
                    "totp_secret": "JBSWY3DPEHPK3PXP",
                }
            ]
        )

        self.service.complete_registration(self.EMAIL, {"access_token": self.TOKEN})

        account = self.service.get_account(self.TOKEN)
        self.assertIsNotNone(account)
        assert account is not None
        self.assertEqual(account.get("password"), "PwReg123!")
        self.assertEqual(account.get("totp_secret"), "JBSWY3DPEHPK3PXP")
        self.assertNotIn(email_key, self.service._accounts)

    def test_complete_registration_accepts_credentials_in_payload(self) -> None:
        email_key = email_storage_key(self.EMAIL)
        self.service._accounts[email_key] = self.service._normalize_account(
            {"email": self.EMAIL, "stage": STAGE_REGISTERING, "_registering": True}
        )

        self.service.complete_registration(
            self.EMAIL,
            {
                "access_token": self.TOKEN,
                "password": "FromMailbox1!",
                "totp_secret": "ABCDEFGH23456789",
            },
        )

        account = self.service.get_account(self.TOKEN)
        self.assertIsNotNone(account)
        assert account is not None
        self.assertEqual(account.get("password"), "FromMailbox1!")
        self.assertEqual(account.get("totp_secret"), "ABCDEFGH23456789")


if __name__ == "__main__":
    unittest.main()
