"""本次重构新增/修改的纯解析函数回归测试（不依赖存储后端，隔离干净）。

覆盖：
- CDK 行内 `CDK-类型` 解析（parse_cdk_type_lines）
- 账号池 `邮箱---密码---2FA--Accesstoken` 导入解析（parse_import_blob），
  且不误伤旧「邮箱----接码URL----密码----2FA」凭据格式
- 邮箱 `邮箱---收件地址` 解析（兼容旧 `----`）
"""

import unittest

from services.cdk_service import parse_cdk_type_lines
from services.mailbox_service import parse_mailbox_lines
from services.account_service import AccountService


class CdkTypeLineTests(unittest.TestCase):
    def test_inline_type_parsed(self) -> None:
        rows = parse_cdk_type_lines("ABCD1234-UPI\nEFGH-5678-IDEL\nPLAIN")
        self.assertEqual(rows, [("ABCD1234", "UPI"), ("EFGH-5678", "IDEL"), ("PLAIN", None)])

    def test_dedup_and_comments(self) -> None:
        rows = parse_cdk_type_lines("# note\nX-UPI\nX-UPI\n\nY")
        self.assertEqual(rows, [("X", "UPI"), ("Y", None)])

    def test_invalid_suffix_kept_as_cdk(self) -> None:
        # 非法类型后缀不当作类型，整行作 CDK。
        self.assertEqual(parse_cdk_type_lines("CODE-FOO"), [("CODE-FOO", None)])


class AccountPoolImportTests(unittest.TestCase):
    def test_dashed_with_token(self) -> None:
        items, _ = AccountService.parse_import_blob("a@b.com---pw123---SECRET--eyJa.bc.de")
        self.assertEqual(len(items), 1)
        it = items[0]
        self.assertEqual(it["email"], "a@b.com")
        self.assertEqual(it["password"], "pw123")
        self.assertEqual(it["totp_secret"], "SECRET")
        self.assertEqual(it["access_token"], "eyJa.bc.de")

    def test_dashed_without_token_gets_manual_key(self) -> None:
        items, _ = AccountService.parse_import_blob("plain@x.com---pw---TOTP--")
        self.assertEqual(len(items), 1)
        it = items[0]
        self.assertEqual(it["email"], "plain@x.com")
        self.assertEqual(it["password"], "pw")
        self.assertEqual(it["totp_secret"], "TOTP")
        self.assertTrue(it["access_token"].startswith("manual::"))

    def test_old_credentials_format_not_misparsed_as_pool(self) -> None:
        # 旧凭据导出「邮箱----接码URL----密码----2FA」次段是 URL，不应被当作账号池格式解析成密码。
        items, _ = AccountService.parse_import_blob("a@b.com----https://mail/x----pw----TOTP")
        # 不进入 dashed 分支：整行没有拆出 password=https://...
        self.assertTrue(all(i.get("password") != "https://mail/x" for i in items))

    def test_labeled_format_still_works(self) -> None:
        items, _ = AccountService.parse_import_blob("邮箱：a@b.com----密码：xyz----2FA密钥：ABC")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["email"], "a@b.com")
        self.assertEqual(items[0]["password"], "xyz")
        self.assertEqual(items[0]["totp_secret"], "ABC")


class MailboxLineTests(unittest.TestCase):
    def test_three_dash(self) -> None:
        rows = parse_mailbox_lines("a@x.com---https://recv/a")
        self.assertEqual(rows, [{"email": "a@x.com", "fetch_url": "https://recv/a"}])

    def test_four_dash_compat(self) -> None:
        rows = parse_mailbox_lines("b@x.com----https://recv/b")
        self.assertEqual(rows, [{"email": "b@x.com", "fetch_url": "https://recv/b"}])

    def test_dedup_by_email(self) -> None:
        rows = parse_mailbox_lines("c@x.com---u1\nc@x.com---u2")
        self.assertEqual(rows, [{"email": "c@x.com", "fetch_url": "u2"}])


if __name__ == "__main__":
    unittest.main()
