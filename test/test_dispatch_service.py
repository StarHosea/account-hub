import unittest
from unittest.mock import patch

from services.dispatch_service import DispatchService


class DispatchAccountCardTest(unittest.TestCase):
    @patch("services.dispatch_service.mailbox_service.get_fetch_url", return_value="https://mail.example/inbox")
    def test_account_card_includes_mail_fetch_url_password_and_2fa(self, _mock_fetch) -> None:
        card = DispatchService._account_card(
            {
                "email": "user@icloud.com",
                "access_token": "token-abc",
                "password": "secret123",
                "totp_secret": "TOTPKEY",
            }
        )
        labels = [f["label"] for f in card["fields"]]
        values = {f["label"]: f["value"] for f in card["fields"]}
        self.assertEqual(labels, ["邮箱", "邮箱接码地址", "密码", "2FA"])
        self.assertEqual(values["邮箱"], "user@icloud.com")
        self.assertEqual(values["邮箱接码地址"], "https://mail.example/inbox")
        self.assertEqual(values["密码"], "secret123")
        self.assertEqual(values["2FA"], "TOTPKEY")

    @patch("services.dispatch_service.mailbox_service.get_fetch_url", return_value=None)
    def test_account_card_keeps_email_and_fetch_row_when_optional_fields_missing(self, _mock_fetch) -> None:
        card = DispatchService._account_card({"email": "user@icloud.com", "access_token": "token-abc"})
        labels = [f["label"] for f in card["fields"]]
        self.assertEqual(labels, ["邮箱", "邮箱接码地址"])


if __name__ == "__main__":
    unittest.main()
