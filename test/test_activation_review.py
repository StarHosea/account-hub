import unittest
from unittest.mock import patch

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

    def test_verify_plan_failure_marks_plus_review(self):
        svc = ActivationService()
        token = "eyJbad"
        acct = {
            "email": "bad@x.com",
            "access_token": token,
            "plus_status": "已激活",
            "plus_activated_at": "2026-01-01T00:00:00+00:00",
            "stage": STAGE_PLUS_REVIEW,
        }
        updates: list[dict] = []

        def _capture_update(access_token, fields, quiet=False):
            updates.append(dict(fields))
            return {**acct, **fields, "access_token": access_token}

        with patch("services.activation_service.account_service.fetch_remote_info", side_effect=RuntimeError("token invalidated (/backend-api/me)")):
            with patch("services.activation_service.account_service.get_account", return_value=acct):
                with patch("services.activation_service.account_service.update_account", side_effect=_capture_update):
                    svc._verify_plan(token, "bad@x.com")

        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["stage"], STAGE_PLUS_REVIEW)
        self.assertEqual(updates[0]["plus_last_message"], "套餐核实失败：token invalidated (/backend-api/me)")
        self.assertIsNone(updates[0].get("last_error"))
        self.assertEqual(updates[0]["plus_status"], "已激活")

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


if __name__ == "__main__":
    unittest.main()
