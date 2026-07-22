import unittest
from unittest.mock import patch

from services.account_lifecycle import STAGE_PLUS_ACTIVATED, STAGE_PLUS_REVIEW, STAGE_REGISTERED, enrich_account
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

    def test_revoke_activation_resets_activated_account(self):
        """撤销激活对已激活账号生效：复位 registered/free、清 redeem 锁与激活字段。

        历史 plus_review 账号读盘时被 enrich 升格为 plus_activated，此前 revoke 只认
        plus_review 导致永远 skipped——错标「已激活」的账号无任何人工纠正入口。
        """
        account = self._review_account()
        account["plus_redeem_locked"] = True
        account["plus_unavailable"] = True
        self.svc._accounts["eyJreview"] = account
        with patch("services.activation_audit_service.activation_audit_service.delete_by_access_tokens", return_value=0):
            result = self.svc.revoke_activation(["eyJreview"], revoke_cdk=False)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["skipped"], 0)
        item = enrich_account(self.svc._accounts["eyJreview"])
        self.assertEqual(item["stage"], STAGE_REGISTERED)
        self.assertEqual(item["plan"], "free")
        self.assertEqual(item["plus_status"], "未激活")
        self.assertFalse(item.get("plus_redeem_locked"))
        self.assertFalse(item.get("plus_unavailable"))
        self.assertIsNone(item.get("plus_activated_at"))

    def test_revoke_activation_clears_registered_residue(self):
        """registered 但带激活残留（redeem 锁/不可用）的账号也可撤销复位——
        锁定后核实非 Plus 被标不可用的账号，这是唯一的人工恢复入口。"""
        self.svc._accounts["eyJlocked"] = {
            "email": "locked@x.com",
            "access_token": "eyJlocked",
            "stage": STAGE_REGISTERED,
            "plan": "free",
            "type": "free",
            "plus_status": "激活失败",
            "plus_redeem_locked": True,
            "plus_unavailable": True,
        }
        with patch("services.activation_audit_service.activation_audit_service.delete_by_access_tokens", return_value=0):
            result = self.svc.revoke_activation(["eyJlocked"], revoke_cdk=False)
        self.assertEqual(result["updated"], 1)
        item = enrich_account(self.svc._accounts["eyJlocked"])
        self.assertEqual(item["stage"], STAGE_REGISTERED)
        self.assertEqual(item["plus_status"], "未激活")
        self.assertFalse(item.get("plus_redeem_locked"))
        self.assertFalse(item.get("plus_unavailable"))

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
        import tempfile

        from services.cdk_service import CdkService

        with tempfile.TemporaryDirectory() as tmp:
            svc = CdkService()
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

    def test_revoke_use_releases_stale_reservation(self):
        from services.cdk_service import CdkService

        svc = CdkService()
        svc._cdks = {
            "CDK-2": {
                "cdk": "CDK-2",
                "type": "IDEL",
                "status": STATUS_AVAILABLE,
                "bound_token": None,
                "used_at": None,
                "imported_at": "2026-01-01T00:00:00+00:00",
                "note": "",
            }
        }
        svc._reserved.add("CDK-2")
        revoked = svc.revoke_use(["CDK-2"])
        self.assertEqual(revoked, 1)
        self.assertNotIn("CDK-2", svc._reserved)


if __name__ == "__main__":
    unittest.main()
