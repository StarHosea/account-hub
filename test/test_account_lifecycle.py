import unittest

from services.account_lifecycle import (
    STAGE_PLUS_ACTIVATED,
    STAGE_REGISTERED,
    STAGE_UNREGISTERED,
    account_in_view,
    enrich_account,
    filter_accounts,
    summary_for_view,
)


class AccountLifecycleTest(unittest.TestCase):
    def test_enrich_unregistered_mailbox(self):
        item = enrich_account({"email": "a@b.com", "fetch_url": "http://x"})
        self.assertEqual(item["stage"], STAGE_UNREGISTERED)
        self.assertEqual(item["plan"], "free")
        self.assertEqual(item["access_token"], "")

    def test_free_view_hides_unregistered(self):
        mailbox = enrich_account({"email": "a@b.com", "fetch_url": "http://x"})
        registered = enrich_account({"email": "b@b.com", "access_token": "eyJ2", "stage": STAGE_REGISTERED, "plan": "free"})
        self.assertFalse(account_in_view(mailbox, "free"))
        self.assertTrue(account_in_view(registered, "free"))

    def test_plus_view_filter(self):
        accounts = [
            enrich_account({"email": "p@b.com", "access_token": "eyJ1", "stage": STAGE_PLUS_ACTIVATED, "plan": "plus", "type": "plus"}),
            enrich_account({"email": "f@b.com", "access_token": "eyJ2", "stage": STAGE_REGISTERED, "plan": "free", "type": "free"}),
        ]
        plus_items = filter_accounts(accounts, view="plus")
        self.assertEqual(len(plus_items), 1)
        self.assertTrue(account_in_view(accounts[0], "plus"))
        self.assertFalse(account_in_view(accounts[1], "plus"))

    def test_summary_for_free_view(self):
        accounts = [
            enrich_account({"email": "a@b.com", "stage": STAGE_UNREGISTERED}),
            enrich_account({"email": "b@b.com", "access_token": "eyJ2", "stage": STAGE_REGISTERED, "plan": "free"}),
        ]
        summary = summary_for_view(accounts, "free")
        self.assertEqual(summary["total"], 1)
        self.assertEqual(summary.get("unregistered", 0), 0)
        self.assertEqual(summary["registered"], 1)

    def test_enrich_preserves_activation_failed_status(self):
        item = enrich_account(
            {
                "email": "f@b.com",
                "access_token": "eyJ3",
                "plus_status": "激活失败",
                "plus_last_message": "两种类型 CDK 均激活失败，已标记账号不可用",
                "stage": STAGE_REGISTERED,
            }
        )
        self.assertEqual(item["plus_status"], "激活失败")
        self.assertEqual(item["plus_last_message"], "两种类型 CDK 均激活失败，已标记账号不可用")
        self.assertIsNone(item["last_error"])

    def test_enrich_activation_failed_keeps_refresh_errors_only(self):
        item = enrich_account(
            {
                "email": "f@b.com",
                "access_token": "eyJ5",
                "plus_status": "激活失败",
                "plus_last_message": "CDK 兑换超时",
                "last_refresh_error": "invalid access token",
                "stage": STAGE_REGISTERED,
            }
        )
        self.assertEqual(item["last_error"], "invalid access token")
        self.assertEqual(item["plus_last_message"], "CDK 兑换超时")

    def test_enrich_migrates_legacy_activation_last_error_to_plus_last_message(self):
        item = enrich_account(
            {
                "email": "f@b.com",
                "access_token": "eyJ6",
                "plus_status": "激活失败",
                "last_error": "两种类型 CDK 均激活失败，已标记账号不可用",
                "stage": STAGE_REGISTERED,
            }
        )
        self.assertEqual(item["plus_last_message"], "两种类型 CDK 均激活失败，已标记账号不可用")
        self.assertIsNone(item["last_error"])

    def test_enrich_prefers_plus_last_message_over_stale_activation(self):
        item = enrich_account(
            {
                "email": "f@b.com",
                "access_token": "eyJ4",
                "plus_status": "激活失败",
                "plus_last_message": "套餐核实失败：token invalidated (/backend-api/me)",
                "activation": {"last_message": "提交 UPI CDK 兑换", "attempts": {"UPI": 1, "IDEL": 0}},
            }
        )
        self.assertEqual(item["plus_last_message"], "套餐核实失败：token invalidated (/backend-api/me)")
        self.assertEqual(item["activation"]["last_message"], "套餐核实失败：token invalidated (/backend-api/me)")


if __name__ == "__main__":
    unittest.main()
