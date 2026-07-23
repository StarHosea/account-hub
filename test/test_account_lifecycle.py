import unittest

from services.account_lifecycle import (
    STAGE_ACTIVATING,
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

    def test_free_view_hides_registering(self):
        registering = enrich_account(
            {"email": "c@b.com", "stage": "registering", "_registering": True},
        )
        self.assertFalse(account_in_view(registering, "free"))

    def test_free_view_hides_activating(self):
        activating = enrich_account(
            {
                "email": "d@b.com",
                "access_token": "eyJ3",
                "stage": "activating",
                "plan": "free",
                "plus_status": "激活中",
            },
        )
        self.assertFalse(account_in_view(activating, "free"))

    def test_enrich_preserves_in_progress_plus_status_over_registered_stage(self):
        """激活中写入 plus_status 后，即使 stage 仍为 registered，也应升格为 activating。

        否则运行监控 activation=activating / plus_status 过滤会看不到进行中账号。
        """
        queued = enrich_account(
            {
                "email": "q@b.com",
                "access_token": "eyJq",
                "stage": STAGE_REGISTERED,
                "plan": "free",
                "plus_status": "排队中",
                "plus_last_message": "提交 UPI CDK 兑换",
            },
        )
        self.assertEqual(queued["stage"], STAGE_ACTIVATING)
        self.assertEqual(queued["plus_status"], "排队中")
        self.assertEqual(queued["plus_last_message"], "提交 UPI CDK 兑换")

        activating = enrich_account(
            {
                "email": "a@b.com",
                "access_token": "eyJa",
                "stage": STAGE_REGISTERED,
                "plan": "free",
                "plus_status": "激活中",
                "plus_last_message": "等待充值",
            },
        )
        self.assertEqual(activating["stage"], STAGE_ACTIVATING)
        self.assertEqual(activating["plus_status"], "激活中")

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

    def test_enrich_separates_subscription_tier_and_activation(self):
        """subscription_tier 表示远端套餐；is_activated / plan 表示 CDK 激活生命周期。"""
        synced = enrich_account(
            {
                "email": "pro@b.com",
                "access_token": "eyJpro",
                "subscription_tier": "pro",
                "plan": "free",
                "stage": STAGE_REGISTERED,
            }
        )
        self.assertEqual(synced["subscription_tier"], "pro")
        self.assertEqual(synced["plan"], "free")
        self.assertEqual(synced["type"], "free")
        self.assertFalse(synced["is_activated"])

        activated = enrich_account(
            {
                "email": "legacy@b.com",
                "access_token": "eyJlegacy",
                "subscription_tier": "free",
                "plan": "plus",
                "stage": STAGE_PLUS_ACTIVATED,
                "plus_status": "已激活",
            }
        )
        self.assertEqual(activated["subscription_tier"], "free")
        self.assertEqual(activated["plan"], "plus")
        self.assertEqual(activated["type"], "plus")
        self.assertTrue(activated["is_activated"])
        self.assertEqual(activated["plus_status"], "已激活")

    def test_enrich_migrates_legacy_type_to_subscription_tier(self):
        """旧版写入 type=pro 且与 lifecycle plan 不一致时，展示层回填 subscription_tier。"""
        legacy = enrich_account(
            {
                "email": "old@b.com",
                "access_token": "eyJold",
                "type": "pro",
                "plan": "free",
                "stage": STAGE_REGISTERED,
            }
        )
        self.assertEqual(legacy["subscription_tier"], "pro")
        self.assertEqual(legacy["type"], "free")

    def test_remote_subscription_tier_prefers_stored_field(self):
        from services.account_lifecycle import remote_subscription_tier

        self.assertEqual(
            remote_subscription_tier({"subscription_tier": "Plus", "type": "free", "plan": "free"}),
            "plus",
        )
        self.assertEqual(
            remote_subscription_tier({"type": "pro", "plan": "free"}),
            "pro",
        )
        self.assertEqual(
            remote_subscription_tier({"type": "free", "plan": "free"}),
            "",
        )


if __name__ == "__main__":
    unittest.main()
