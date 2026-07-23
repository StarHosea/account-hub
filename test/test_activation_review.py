import unittest
from unittest.mock import MagicMock, patch

from services.account_lifecycle import STAGE_ACTIVATING, STAGE_PLUS_ACTIVATED, STAGE_PLUS_REVIEW, STAGE_REGISTERED, enrich_account
from services.activation_service import ActivationService, can_run_activation, is_activation_eligible
from services.account_service import AccountService
from test.test_account_export import MemoryStorage


class ActivationReviewTest(unittest.TestCase):
    def test_summary_pending_matches_resolve_targets(self):
        svc = ActivationService()
        accounts = [
            {
                "email": "ok@x.com",
                "access_token": "eyJok",
                "stage": STAGE_REGISTERED,
                "plan": "free",
                "type": "free",
            },
            {
                "email": "unavail@x.com",
                "access_token": "eyJunavail",
                "stage": STAGE_REGISTERED,
                "plan": "free",
                "type": "free",
                "plus_unavailable": True,
            },
            {
                "email": "review@x.com",
                "access_token": "eyJreview",
                "stage": STAGE_PLUS_REVIEW,
                "plus_activated_at": "2026-01-01T00:00:00+00:00",
                "plus_status": "已激活",
                "type": "free",
            },
        ]
        with patch("services.activation_service.account_service.list_accounts", return_value=accounts):
            summary = svc.summary()
            targets = svc._resolve_targets(None)
        self.assertEqual(summary["pending"], 1)
        self.assertEqual(summary["not_plus_by_type"], 3)
        self.assertEqual(targets, ["eyJok"])

    def test_enrich_retires_plus_review(self):
        item = enrich_account({
            "email": "review@x.com",
            "access_token": "eyJreview",
            "stage": STAGE_PLUS_REVIEW,
            "plan": "free",
            "type": "free",
            "plus_status": "已激活",
        })
        self.assertEqual(item["stage"], STAGE_PLUS_ACTIVATED)
        self.assertEqual(item["plan"], "plus")

    def test_migrate_plus_review_accounts_persists(self):
        storage = MemoryStorage([
            {
                "email": "review@x.com",
                "access_token": "eyJreview",
                "stage": STAGE_PLUS_REVIEW,
                "plan": "free",
                "plus_status": "已激活",
                "plus_activated_at": "2026-01-01T00:00:00+00:00",
            },
        ])
        svc = AccountService(storage)
        changed = svc.migrate_plus_review_accounts()
        self.assertEqual(changed, 1)
        item = svc.get_account("eyJreview")
        assert item is not None
        self.assertEqual(item.get("stage"), STAGE_PLUS_ACTIVATED)
        self.assertEqual(item.get("plan"), "plus")

    def test_is_activation_eligible_skips_unavailable_and_activated(self):
        pending = {
            "email": "free@x.com",
            "access_token": "eyJfree",
            "stage": STAGE_REGISTERED,
            "plan": "free",
            "type": "free",
        }
        unavailable = {**pending, "access_token": "eyJbad", "plus_unavailable": True}
        review = {
            "email": "review@x.com",
            "access_token": "eyJreview",
            "stage": STAGE_PLUS_REVIEW,
            "plus_activated_at": "2026-01-01T00:00:00+00:00",
            "plus_status": "已激活",
        }
        self.assertTrue(is_activation_eligible(pending))
        self.assertFalse(is_activation_eligible(unavailable))
        self.assertFalse(is_activation_eligible(review))

    def test_can_run_activation_allows_already_marked_activating(self):
        """入选后 stage=activating 仍应允许 worker 继续跑，不能被 is_activation_eligible 挡掉。"""
        activating = {
            "email": "run@x.com",
            "access_token": "eyJrun",
            "stage": STAGE_ACTIVATING,
            "plan": "free",
            "type": "free",
            "plus_status": "排队中",
        }
        self.assertFalse(is_activation_eligible(activating))
        self.assertTrue(can_run_activation(activating))
        self.assertFalse(can_run_activation({**activating, "plus_unavailable": True}))

    def test_resolve_targets_skips_activated_accounts(self):
        svc = ActivationService()
        review = {
            "email": "review@x.com",
            "access_token": "eyJreview",
            "stage": STAGE_PLUS_REVIEW,
            "plus_activated_at": "2026-01-01T00:00:00+00:00",
            "plus_status": "已激活",
            "plus_last_message": "套餐核实失败：token invalidated (/backend-api/me)",
        }
        pending = {
            "email": "free@x.com",
            "access_token": "eyJfree",
            "stage": STAGE_REGISTERED,
            "plan": "free",
            "type": "free",
        }
        with patch("services.activation_service.account_service.list_accounts", return_value=[review, pending]):
            with patch("services.activation_service.account_service.apply_stage_update"):
                targets = svc._resolve_targets(None)
        self.assertEqual(targets, ["eyJfree"])

    def test_resolve_targets_default_marks_stage_activating(self):
        """批量激活默认路径（无 tokens）须把选中账号标为 activating，运行监控才能查到。"""
        svc = ActivationService()
        pending = {
            "email": "free@x.com",
            "access_token": "eyJfree",
            "stage": STAGE_REGISTERED,
            "plan": "free",
            "type": "free",
        }
        updates: list[tuple[str, str]] = []

        def _capture_stage(token, stage, **extra):
            updates.append((token, stage))
            return {**pending, "stage": stage, **extra}

        with patch("services.activation_service.account_service.list_accounts", return_value=[pending]):
            with patch("services.activation_service.account_service.apply_stage_update", side_effect=_capture_stage):
                targets = svc._resolve_targets(None, limit=1)
        self.assertEqual(targets, ["eyJfree"])
        self.assertTrue(updates, "默认路径应 apply_stage_update 标记激活中")
        token, stage = updates[0]
        self.assertEqual(token, "eyJfree")
        self.assertEqual(stage, STAGE_ACTIVATING)

    def test_resolve_targets_limit_only_marks_selected(self):
        """limit 截取后只标记实际入选账号，避免多余账号卡在 activating。"""
        svc = ActivationService()
        accounts = [
            {
                "email": f"a{i}@x.com",
                "access_token": f"eyJ{i}",
                "stage": STAGE_REGISTERED,
                "plan": "free",
                "type": "free",
            }
            for i in range(3)
        ]
        marked: list[str] = []

        def _capture_stage(token, stage, **extra):
            if stage == STAGE_ACTIVATING:
                marked.append(token)
            return {**next(a for a in accounts if a["access_token"] == token), "stage": stage, **extra}

        with patch("services.activation_service.account_service.list_accounts", return_value=accounts):
            with patch("services.activation_service.account_service.apply_stage_update", side_effect=_capture_stage):
                targets = svc._resolve_targets(None, limit=1)
        self.assertEqual(targets, ["eyJ0"])
        self.assertEqual(marked, ["eyJ0"])

    def test_reconcile_stuck_activations_resets_stage(self):
        storage = MemoryStorage([
            {
                "email": "stuck@x.com",
                "access_token": "eyJstuck",
                "stage": STAGE_ACTIVATING,
                "plan": "free",
                "plus_status": "激活中",
            },
            {
                "email": "failed@x.com",
                "access_token": "eyJfail",
                "stage": STAGE_REGISTERED,
                "plan": "free",
                "plus_status": "激活失败",
                "plus_unavailable": True,
            },
        ])
        svc = AccountService(storage)
        reset = svc.reconcile_stuck_activations()
        self.assertEqual(reset, 1)
        stuck = svc.get_account("eyJstuck")
        self.assertIsNotNone(stuck)
        assert stuck is not None
        self.assertEqual(stuck.get("stage"), STAGE_REGISTERED)
        self.assertEqual(stuck.get("plus_status"), "未激活")
        failed = svc.get_account("eyJfail")
        self.assertIsNotNone(failed)
        assert failed is not None
        self.assertEqual(failed.get("plus_status"), "激活失败")

    def test_reconcile_locked_stuck_account_not_marked_activated(self):
        """曾提交 CDK（redeem 锁）且卡在进行中的账号：重启对账不得乐观标已激活。

        旧行为直接标 plus_activated 造成假成功（明确失败的卡也打过锁）；新行为复位为
        未激活并保留锁，交由下轮激活预检核实真实档位。
        """
        storage = MemoryStorage([
            {
                "email": "locked@x.com",
                "access_token": "eyJlocked",
                "stage": STAGE_ACTIVATING,
                "plan": "free",
                "plus_status": "激活中",
                "plus_redeem_locked": True,
            },
        ])
        svc = AccountService(storage)
        reset = svc.reconcile_stuck_activations()
        self.assertEqual(reset, 1)
        item = svc.get_account("eyJlocked")
        self.assertIsNotNone(item)
        assert item is not None
        self.assertEqual(item.get("stage"), STAGE_REGISTERED)
        self.assertEqual(item.get("plan"), "free")
        self.assertEqual(item.get("plus_status"), "未激活")
        self.assertTrue(item.get("plus_redeem_locked"))
        self.assertIsNone(item.get("plus_activated_at"))

    def test_account_claim_rejects_duplicate(self):
        svc = ActivationService()
        email_key = "claim@x.com"
        self.assertTrue(svc._try_claim_account(email_key))
        self.assertFalse(svc._try_claim_account(email_key))
        svc._release_account(email_key)
        self.assertTrue(svc._try_claim_account(email_key))
        svc._release_account(email_key)

    def test_activate_account_skips_when_account_already_claimed(self):
        svc = ActivationService()
        token = "eyJskip"
        acct = {
            "email": "skip@x.com",
            "access_token": token,
            "stage": STAGE_REGISTERED,
            "plan": "free",
            "type": "free",
        }
        cfg = {"max_attempts_per_type": 1, "poll_interval": 0.01, "poll_timeout": 0.05}
        svc._activating_emails.add("skip@x.com")
        client = MagicMock()
        with patch("services.activation_service.account_service.get_account", return_value=acct):
            with patch("services.activation_service.cdk_service.acquire_available") as acquire:
                ok = svc._activate_account(client, token, cfg)
        self.assertIsNone(ok)
        acquire.assert_not_called()
        svc._release_account("skip@x.com")

    def test_verify_plan_after_timeout_refreshes_invalid_token(self):
        from services.openai_backend_api import InvalidAccessTokenError

        svc = ActivationService()
        old_token = "eyJold"
        new_token = "eyJnew"
        refreshed_acct = {
            "email": "t@x.com",
            "access_token": new_token,
            "subscription_tier": "plus",
            "plan": "free",
            "stage": STAGE_REGISTERED,
        }

        def _fetch(token: str, event: str = "fetch_remote_plan"):
            if token == old_token:
                raise InvalidAccessTokenError("token invalidated")
            return refreshed_acct

        with patch("services.activation_service.account_service.fetch_remote_plan", side_effect=_fetch):
            with patch(
                "services.activation_service.account_service.refresh_access_token",
                return_value=new_token,
            ) as refresh:
                verdict, latest = svc._verify_plan_after_timeout(old_token, audit=None)
        self.assertEqual(verdict, "plus")
        self.assertEqual(latest, new_token)
        refresh.assert_called_once()


if __name__ == "__main__":
    unittest.main()
