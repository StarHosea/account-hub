"""账号详情：应返回 browser_session，而列表接口不得带出。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from services.account_service import AccountService  # noqa: E402
from test.test_account_export import MemoryStorage  # noqa: E402


class AccountDetailTests(unittest.TestCase):
    def test_get_account_detail_keeps_browser_session(self) -> None:
        session = {"cookies": [{"name": "session", "value": "abc"}], "origins": []}
        token = "eyJhbGciOiJub25lIn0.e30.sig"
        svc = AccountService(
            MemoryStorage(
                [
                    {
                        "access_token": token,
                        "email": "detail@example.com",
                        "password": "pw",
                        "browser_session": session,
                        "browser_session_at": "2026-07-14T00:00:00+00:00",
                    }
                ]
            )
        )

        listed = svc.list_accounts()
        self.assertEqual(len(listed), 1)
        self.assertNotIn("browser_session", listed[0])

        detail = svc.get_account_detail(access_token=token)
        assert detail is not None
        self.assertEqual(detail["email"], "detail@example.com")
        self.assertEqual(detail["browser_session"], session)

        by_email = svc.get_account_detail(email="detail@example.com")
        assert by_email is not None
        self.assertEqual(by_email["browser_session"]["cookies"][0]["value"], "abc")


if __name__ == "__main__":
    unittest.main()
