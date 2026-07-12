import unittest
from unittest.mock import MagicMock, patch

from services.account_lifecycle import STAGE_ACTIVATING, STAGE_PLUS_REVIEW, STAGE_REGISTERED
from services.activation_service import ActivationService, is_activation_eligible
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

    def test_is_activation_eligible_skips_unavailable_and_review(self):
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

    def test_resolve_targets_skips_plus_review_and_activated_at(self):
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
            with patch("services.activation_service.account_service.update_account"):
                targets = svc._resolve_targets(None)
        self.assertEqual(targets, ["eyJfree"])

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


if __name__ == "__main__":
    unittest.main()
