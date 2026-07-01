import base64
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

import services.mailbox_service as mailbox_module
from services.account_service import AccountService
from services.mailbox_service import MailboxService


class MemoryStorage:
    def __init__(self, accounts: list[dict[str, Any]] | None = None) -> None:
        self.accounts = list(accounts or [])

    def load_accounts(self) -> list[dict[str, Any]]:
        return list(self.accounts)

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        self.accounts = list(accounts)

    def load_auth_keys(self) -> list[dict[str, Any]]:
        return []

    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        pass

    def health_check(self) -> dict[str, Any]:
        return {"ok": True}

    def get_backend_info(self) -> dict[str, Any]:
        return {"type": "memory"}


def make_jwt(payload: dict[str, Any]) -> str:
    def encode(value: dict[str, Any]) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    return f'{encode({"alg": "none", "typ": "JWT"})}.{encode(payload)}.sig'


class AccountExportTests(unittest.TestCase):
    def test_build_export_items_uses_codex_shape_and_jwt_claims(self) -> None:
        access_token = make_jwt(
            {
                "exp": 0,
                "iat": 3600,
                "https://api.openai.com/auth": {"chatgpt_account_id": "acct_123"},
                "https://api.openai.com/profile": {"email": "test@example.com"},
            }
        )
        id_token = make_jwt({"email": "fallback@example.com"})
        service = AccountService(
            MemoryStorage(
                [
                    {
                        "access_token": access_token,
                        "id_token": id_token,
                        "refresh_token": "rt_test",
                    }
                ]
            )
        )

        [item] = service.build_export_items([access_token])

        # 导出真实套餐类型（账号无 type 时回退 free），而非旧版硬编码 codex。
        self.assertEqual(item["type"], "free")
        self.assertEqual(item["email"], "test@example.com")
        self.assertEqual(item["expired"], "1970-01-01T08:00:00+08:00")
        self.assertEqual(item["account_id"], "acct_123")
        self.assertEqual(item["access_token"], access_token)
        self.assertEqual(item["last_refresh"], "1970-01-01T09:00:00+08:00")
        self.assertEqual(item["id_token"], id_token)
        self.assertEqual(item["refresh_token"], "rt_test")

    def test_build_export_items_skips_accounts_missing_complete_tokens(self) -> None:
        complete_access_token = make_jwt({"exp": 0})
        complete_id_token = make_jwt({"email": "complete@example.com"})
        service = AccountService(
            MemoryStorage(
                [
                    {"access_token": "only_access"},
                    {"access_token": "missing_id", "refresh_token": "rt_missing_id"},
                    {"access_token": complete_access_token, "id_token": complete_id_token, "refresh_token": "rt_complete"},
                ]
            )
        )

        items = service.build_export_items()

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["access_token"], complete_access_token)
        self.assertEqual(items[0]["id_token"], complete_id_token)
        self.assertEqual(items[0]["refresh_token"], "rt_complete")

    def test_add_account_items_preserves_export_fields_without_overwriting_plan_type(self) -> None:
        service = AccountService(MemoryStorage())

        result = service.add_account_items(
            [
                {
                    "type": "codex",
                    "access_token": "access_token_test",
                    "refresh_token": "rt_test",
                    "account_id": "acct_123",
                }
            ]
        )

        account = service.get_account("access_token_test")
        self.assertEqual(result["added"], 1)
        self.assertIsNotNone(account)
        self.assertEqual(account["type"], "free")
        self.assertEqual(account["export_type"], "codex")
        self.assertEqual(account["refresh_token"], "rt_test")
        self.assertEqual(account["account_id"], "acct_123")


class MailboxCarryTests(unittest.TestCase):
    """迁移导出/导入携带邮箱接码地址（mail_link/fetch_url），修复导入后取不到邮箱 OTP。"""

    EMAIL = "carry@example.com"
    URL = "https://mail.example.com/fetch?token=abc"

    def setUp(self) -> None:
        # 用临时文件构造隔离的邮箱管理实例，并替换模块级单例（导出/导入内部惰性引用它）。
        self._tmp = tempfile.mkdtemp()
        self._orig_mailbox = mailbox_module.mailbox_service

    def tearDown(self) -> None:
        mailbox_module.mailbox_service = self._orig_mailbox

    def _swap_mailbox(self, name: str) -> MailboxService:
        mb = MailboxService(store_file=Path(self._tmp) / name)
        mailbox_module.mailbox_service = mb
        return mb

    def _account(self) -> dict[str, Any]:
        access_token = make_jwt({"https://api.openai.com/profile": {"email": self.EMAIL}})
        return {
            "access_token": access_token,
            "id_token": make_jwt({"email": self.EMAIL}),
            "refresh_token": "rt_carry",
            "email": self.EMAIL,
        }

    def test_export_includes_mail_link_from_mailbox(self) -> None:
        mb = self._swap_mailbox("src.json")
        mb.import_text(f"{self.EMAIL}----{self.URL}")
        acct = self._account()
        service = AccountService(MemoryStorage([acct]))

        [item] = service.build_export_items([acct["access_token"]])

        self.assertEqual(item["mail_link"], self.URL)

    def test_import_registers_mailbox_and_strips_transient_field(self) -> None:
        mb = self._swap_mailbox("dst.json")  # fresh target system: no mailboxes yet
        service = AccountService(MemoryStorage())

        acct = self._account()
        service.add_account_items([{**acct, "mail_link": self.URL}])

        stored = service.get_account(acct["access_token"])
        self.assertNotIn("mail_link", stored)  # 接码地址不落在账号对象上
        self.assertNotIn("fetch_url", stored)
        self.assertEqual(mb.get_fetch_url(self.EMAIL), self.URL)  # 已登记进邮箱管理
        row = next(m for m in mb.list_mailboxes() if m["email"] == self.EMAIL)
        self.assertTrue(row["used"])
        self.assertEqual(row["account_token"], acct["access_token"])

    def test_import_reads_legacy_fetch_url_key(self) -> None:
        mb = self._swap_mailbox("legacy.json")
        service = AccountService(MemoryStorage())

        acct = self._account()
        service.add_account_items([{**acct, "fetch_url": self.URL}])  # 旧字段名

        self.assertEqual(mb.get_fetch_url(self.EMAIL), self.URL)

    def test_import_without_mailbox_does_not_register(self) -> None:
        mb = self._swap_mailbox("none.json")
        service = AccountService(MemoryStorage())

        acct = self._account()
        service.add_account_items([acct])  # 无接码地址

        self.assertIsNone(mb.get_fetch_url(self.EMAIL))


if __name__ == "__main__":
    unittest.main()
