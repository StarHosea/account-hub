import unittest

from services.activation_audit_service import (
    OUTCOME_FAILED,
    OUTCOME_REVIEW,
    ActivationAuditRecorder,
    activation_audit_service,
)


class ActivationAuditServiceTest(unittest.TestCase):
    def test_recorder_persists_http_and_log_events(self):
        recorder = ActivationAuditRecorder(email="a@x.com", access_token="eyJ1", job_id="job1")
        recorder.log("尝试 UPI CDK", "info")
        recorder.record_http(
            "cdk_submit",
            {
                "method": "POST",
                "path": "/api/external/cdkey-redeems",
                "url": "http://example/api/external/cdkey-redeems",
                "http_status": 200,
                "request": {"items": [{"cdkey": "CDK-1", "access_token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"}]},
                "response": {"code": 0, "data": {"items": [{"status": "success"}]}},
            },
        )
        recorder.record_plan_verify("error", error="token invalidated (/backend-api/me)")
        saved = recorder.finish(OUTCOME_REVIEW, "套餐核实失败：token invalidated (/backend-api/me)", cdk="CDK-1", cdk_type="UPI", cdk_consumed=True)

        self.assertEqual(saved["outcome"], OUTCOME_REVIEW)
        self.assertIn("token invalidated", saved["summary"])
        self.assertEqual(saved["event_count"], 3)
        self.assertEqual(saved["events"][1]["kind"], "http")
        self.assertEqual(saved["events"][2]["kind"], "plan_verify")

        listed = activation_audit_service.list_items(abnormal_only=True, page_size=10)
        self.assertGreaterEqual(listed["total"], 1)
        detail = activation_audit_service.get(saved["id"])
        self.assertIsNotNone(detail)
        self.assertEqual(len(detail["events"]), 3)

    def test_list_filters_abnormal_only(self):
        ok = ActivationAuditRecorder(email="ok@x.com", access_token="eyJ2")
        ok.finish("success", "ok")
        bad = ActivationAuditRecorder(email="bad@x.com", access_token="eyJ3")
        bad.finish(OUTCOME_FAILED, "failed")

        items = activation_audit_service.list_items(abnormal_only=True, page_size=50)["items"]
        outcomes = {i["email"]: i["outcome"] for i in items}
        self.assertEqual(outcomes.get("bad@x.com"), OUTCOME_FAILED)
        self.assertNotEqual(outcomes.get("ok@x.com"), "success")

    def test_list_groups_by_email_latest_outcome(self):
        first = ActivationAuditRecorder(email="dup@x.com", access_token="eyJ4")
        first.finish(OUTCOME_FAILED, "first fail")
        second = ActivationAuditRecorder(email="dup@x.com", access_token="eyJ4")
        second.finish(OUTCOME_REVIEW, "later review")

        items = activation_audit_service.list_items(page_size=50)["items"]
        dup_rows = [i for i in items if i["email"] == "dup@x.com"]
        self.assertEqual(len(dup_rows), 1)
        self.assertEqual(dup_rows[0]["outcome"], OUTCOME_REVIEW)
        self.assertEqual(dup_rows[0]["attempt_count"], 2)

        stats = activation_audit_service.stats()
        self.assertGreaterEqual(stats["total"], 2)
        self.assertGreaterEqual(stats["review"], 1)


    def test_delete_by_access_token_removes_audit(self):
        recorder = ActivationAuditRecorder(email="del@x.com", access_token="eyJdel")
        saved = recorder.finish(OUTCOME_FAILED, "fail")
        self.assertIsNotNone(activation_audit_service.get(saved["id"]))

        removed = activation_audit_service.delete_by_access_tokens(["eyJdel"])
        self.assertGreaterEqual(removed, 1)
        self.assertIsNone(activation_audit_service.get(saved["id"]))
        listed = activation_audit_service.list_items(page_size=50)["items"]
        self.assertFalse(any(i["email"] == "del@x.com" for i in listed))

    def test_delete_by_email_removes_all_attempts(self):
        first = ActivationAuditRecorder(email="wipe@x.com", access_token="eyJw1")
        first.finish(OUTCOME_FAILED, "first")
        second = ActivationAuditRecorder(email="wipe@x.com", access_token="eyJw1")
        second.finish(OUTCOME_REVIEW, "second")

        removed = activation_audit_service.delete_by_emails(["wipe@x.com"])
        self.assertGreaterEqual(removed, 2)
        listed = activation_audit_service.list_items(page_size=50)["items"]
        self.assertFalse(any(i["email"] == "wipe@x.com" for i in listed))


if __name__ == "__main__":
    unittest.main()
