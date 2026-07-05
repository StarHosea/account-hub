import unittest
from unittest.mock import patch

from services.account_lifecycle import PLAN_FREE, STAGE_PLUS_REVIEW, STAGE_REGISTERED, enrich_account
from services.account_service import AccountService
from services.cdk_service import STATUS_AVAILABLE, STATUS_USED
from test.utils import InMemoryStorage


class RevokeActivationTest(unittest.TestCase):
    def setUp(self):
        self.storage = InMemoryStorage()
        self.svc = AccountService(self.storage)

    def _review_account(self, token: str = "eyJreview", cdk: str = "CDK-TEST-1") -> dict:
        return {
            "email": "review@x.com",
            "access_token": token,
            "stage": STAGE_PLUS_REVIEW,
            "plan": "free",
            "type": "free",
            "plus_status": "已激活",
            "plus_activated_at": "2026-01-01T00:00:00+00:00",
            "plus_last_message": "套餐核实失败",
            "activation": {"cdk": cdk, "cdk_type": "UPI", "attempts": {"UPI": 1, "IDEL": 0}},
        }

    def test_revoke_activation_without_revoke_cdk(self):
        self.svc._accounts["eyJreview"] = self._review_account()
        with patch("services.cdk_service.cdk_service.revoke_use") as mock_revoke, patch(
            "services.activation_audit_service.activation_audit_service.delete_by_access_tokens",
            return_value=1,
        ) as mock_audit_del:
            result = self.svc.revoke_activation(["eyJreview"], revoke_cdk=False)
        mock_revoke.assert_not_called()
        mock_audit_del.assert_called_once_with(["eyJreview"])
        self.assertEqual(result["updated"], 1)
        item = enrich_account(self.svc._accounts["eyJreview"])
        self.assertEqual(item["stage"], STAGE_REGISTERED)
        self.assertEqual(item["plan"], PLAN_FREE)
        self.assertFalse(item.get("plus_unavailable"))
        self.assertIsNone(item.get("plus_cdk"))
        self.assertIsNone(item.get("plus_last_message"))
        self.assertIsNone(item.get("last_activation_audit_id"))

    def test_revoke_activation_revokes_cdk(self):
        self.svc._accounts["eyJreview"] = self._review_account(cdk="CDK-ABC")
        with patch("services.cdk_service.cdk_service.revoke_use", return_value=1) as mock_revoke, patch(
            "services.activation_audit_service.activation_audit_service.delete_by_access_tokens",
            return_value=1,
        ):
            result = self.svc.revoke_activation(["eyJreview"], revoke_cdk=True)
        mock_revoke.assert_called_once_with(["CDK-ABC"])
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["cdk_revoked"], 1)

    def test_revoke_activation_skips_non_review(self):
        self.svc._accounts["eyJok"] = {
            "email": "ok@x.com",
            "access_token": "eyJok",
            "stage": STAGE_REGISTERED,
            "plan": "free",
        }
        result = self.svc.revoke_activation(["eyJok"])
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["skipped"], 1)


class RevokeActivationCdkIntegrationTest(unittest.TestCase):
    def test_revoke_use_restores_available(self):
        from pathlib import Path
        import tempfile

        from services.cdk_service import CdkService

        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "cdks.json"
            svc = CdkService(store_file=store)
            svc._cdks = {
                "CDK-1": {
                    "cdk": "CDK-1",
                    "type": "UPI",
                    "status": STATUS_USED,
                    "bound_token": "eyJx",
                    "used_at": "2026-01-01T00:00:00+00:00",
                    "imported_at": "2026-01-01T00:00:00+00:00",
                    "note": "",
                }
            }
            revoked = svc.revoke_use(["CDK-1"])
            self.assertEqual(revoked, 1)
            self.assertEqual(svc._cdks["CDK-1"]["status"], STATUS_AVAILABLE)
            self.assertIsNone(svc._cdks["CDK-1"]["bound_token"])


if __name__ == "__main__":
    unittest.main()
