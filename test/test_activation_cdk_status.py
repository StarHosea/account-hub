"""CDK 兑换服务端各响应状态回归：只有真成功或 not_found 才终态消耗 CDK，其余归还 available。"""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from services.account_lifecycle import STAGE_REGISTERED
from services.activation_service import ActivationService
from services.cdk_service import STATUS_AVAILABLE, STATUS_INVALID, STATUS_USED, CdkService
from test.utils import InMemoryStorage
from services.cdk_redeem_client import (
    STATUS_CDK_INVALID,
    STATUS_FAIL,
    STATUS_PENDING,
    STATUS_SUCCESS,
    AuthError,
    RedeemError,
    classify,
)


def _free_account(token: str = "eyJstatus", email: str = "status@x.com") -> dict:
    return {
        "email": email,
        "access_token": token,
        "stage": STAGE_REGISTERED,
        "plan": "free",
        "type": "free",
    }


def _fast_cfg(*, poll_timeout: float = 0.05, poll_interval: float = 0.01, max_attempts: int = 1,
              timeout_retry_max: int = 0, failed_retry_max: int = 0) -> dict:
    return {
        "max_attempts_per_type": max_attempts,
        "poll_interval": poll_interval,
        "poll_timeout": poll_timeout,
        "timeout_retry_max": timeout_retry_max,
        "failed_retry_max": failed_retry_max,
        "concurrency": 2,
        "base_url": "http://test",
        "api_key": "k",
    }


def _item_response(cdk: str, status: str, *, code: int = 0, envelope_message: str = "ok", message: str = "", **fields) -> dict:
    item = {"cdkey": cdk, "status": status, **fields}
    if message:
        item["message"] = message
    return {"code": code, "message": envelope_message, "data": {"items": [item]}}


def _envelope_only(code: int, message: str = "error") -> dict:
    return {"code": code, "message": message, "data": {}}


class MockRedeemClient:
    """可控 submit / status 响应序列，模拟激活服务器。"""

    def __init__(self, submit_response: dict | None, poll_responses: list[dict | None] | None = None):
        self.submit_response = submit_response
        self.poll_responses = list(poll_responses or [])
        self.submit_calls = 0
        self.poll_calls = 0
        self.retry_calls = 0
        self.retry_response = None

    def submit(self, cdk: str, access_token: str, exchange_cb=None) -> dict | None:
        self.submit_calls += 1
        if isinstance(self.submit_response, Exception):
            raise self.submit_response
        return self.submit_response

    def query_status(self, cdks: list[str], exchange_cb=None) -> dict | None:
        self.poll_calls += 1
        if not self.poll_responses:
            return None
        nxt = self.poll_responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    def retry(self, cdks: list[str], exchange_cb=None) -> dict | None:
        self.retry_calls += 1
        if self.retry_response is not None:
            if isinstance(self.retry_response, Exception):
                raise self.retry_response
            return self.retry_response
        c = cdks[0] if cdks else ""
        return {"code": 0, "data": {"items": [{"cdkey": c, "found": True, "retried": True}]}}

    def close(self) -> None:
        pass


class ClassifyStatusTest(unittest.TestCase):
    def test_success_status_words(self) -> None:
        for st in STATUS_SUCCESS:
            with self.subTest(status=st):
                self.assertEqual(classify(st), "success")

    def test_fail_status_words(self) -> None:
        for st in STATUS_FAIL:
            with self.subTest(status=st):
                self.assertEqual(classify(st), "fail")

    def test_cdk_invalid_status_words(self) -> None:
        for st in STATUS_CDK_INVALID:
            with self.subTest(status=st):
                self.assertEqual(classify(st), "cdk_invalid")

    def test_pending_status_words(self) -> None:
        for st in STATUS_PENDING:
            with self.subTest(status=st):
                self.assertEqual(classify(st), "pending")

    def test_unknown_status(self) -> None:
        self.assertEqual(classify("weird_server_state"), "unknown")


class AttemptResponseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.svc = ActivationService()
        self.token = "eyJstatus"
        self.cdk = "CDK-STATUS-1"
        self.cfg = _fast_cfg()

    def _attempt(self, client: MockRedeemClient) -> tuple[str, str, str, str]:
        return self.svc._attempt(client, self.token, self.cdk, self.cfg)

    def test_submit_immediate_success(self) -> None:
        for status in ("success", "succeeded", "completed", "ok"):
            with self.subTest(status=status):
                client = MockRedeemClient(_item_response(self.cdk, status))
                cls, st, _, _ = self._attempt(client)
                self.assertEqual(cls, "success")
                self.assertEqual(st, status)
                self.assertEqual(client.poll_calls, 0)

    def test_submit_immediate_fail_does_not_poll(self) -> None:
        for status in ("failed", "error", "rejected", "token-invalidated"):
            with self.subTest(status=status):
                client = MockRedeemClient(_item_response(self.cdk, status, message="boom"))
                cls, st, msg, _ = self._attempt(client)
                self.assertEqual(cls, "fail")
                self.assertEqual(st, status)
                self.assertIn("boom", msg)
                self.assertEqual(client.poll_calls, 0)

    def test_submit_immediate_not_found(self) -> None:
        for status in ("not_found", "notfound"):
            with self.subTest(status=status):
                client = MockRedeemClient(_item_response(self.cdk, status))
                cls, st, _, _ = self._attempt(client)
                self.assertEqual(cls, "cdk_invalid")
                self.assertEqual(st, status)

    def test_submit_pending_then_poll_success(self) -> None:
        client = MockRedeemClient(
            _item_response(self.cdk, "queued", queue_ahead=2),
            [_item_response(self.cdk, "running"), _item_response(self.cdk, "success", message="done")],
        )
        cls, st, msg, _ = self._attempt(client)
        self.assertEqual(cls, "success")
        self.assertEqual(st, "success")
        self.assertEqual(msg, "done")
        self.assertGreaterEqual(client.poll_calls, 1)

    def test_submit_pending_then_poll_fail(self) -> None:
        client = MockRedeemClient(
            _item_response(self.cdk, "pending_dispatch"),
            [_item_response(self.cdk, "failed", message="server rejected")],
        )
        cls, st, msg, _ = self._attempt(client)
        self.assertEqual(cls, "fail")
        self.assertEqual(st, "failed")
        self.assertEqual(msg, "server rejected")

    def test_submit_pending_then_poll_not_found(self) -> None:
        client = MockRedeemClient(
            _item_response(self.cdk, "processing"),
            [_item_response(self.cdk, "not_found")],
        )
        cls, _, _, _ = self._attempt(client)
        self.assertEqual(cls, "cdk_invalid")

    def test_submit_pending_poll_timeout(self) -> None:
        client = MockRedeemClient(
            _item_response(self.cdk, "running"),
            [_item_response(self.cdk, "running")] * 20,
        )
        cls, st, msg, _ = self._attempt(client)
        self.assertEqual(cls, "poll_exhausted")
        self.assertEqual(st, "running")
        self.assertIn("大兜底", msg)

    def test_submit_unknown_then_poll_timeout(self) -> None:
        client = MockRedeemClient(
            _item_response(self.cdk, "weird_state"),
            [_item_response(self.cdk, "weird_state")] * 20,
        )
        cls, _, msg, _ = self._attempt(client)
        self.assertEqual(cls, "poll_exhausted")
        self.assertIn("大兜底", msg)

    def test_envelope_error_without_item_is_fail(self) -> None:
        client = MockRedeemClient(_envelope_only(500, "internal error"))
        cls, st, msg, _ = self._attempt(client)
        self.assertEqual(cls, "rejected")
        self.assertEqual(st, "code=500")
        self.assertEqual(msg, "internal error")
        self.assertEqual(client.poll_calls, 0)

    def test_envelope_nonzero_ignored_when_item_present(self) -> None:
        """复现历史 bug：信封 code!=0 但 item 已受理，应继续轮询而非直接失败。"""
        client = MockRedeemClient(
            _item_response(self.cdk, "queued", code=200, envelope_message="accepted"),
            [_item_response(self.cdk, "success")],
        )
        cls, _, _, _ = self._attempt(client)
        self.assertEqual(cls, "success")
        self.assertGreaterEqual(client.poll_calls, 1)

    def test_submit_missing_item_disappears_until_timeout(self) -> None:
        client = MockRedeemClient(
            _item_response(self.cdk, "queued"),
            [None, {"code": 0, "data": {"items": []}}] * 10,
        )
        cls, _, msg, _ = self._attempt(client)
        self.assertEqual(cls, "poll_exhausted")
        self.assertIn("大兜底", msg)

    def test_redeem_error_on_submit(self) -> None:
        client = MockRedeemClient(RedeemError("network down"))
        with self.assertRaises(RedeemError):
            self._attempt(client)


class ActivateAccountCdkDispositionTest(unittest.TestCase):
    """端到端：_activate_account 对各服务端状态的 CDK 处置（consume / release / mark_invalid）。"""

    def setUp(self) -> None:
        self.svc = ActivationService()
        self.svc._stats = self.svc._empty_stats()
        self.token = "eyJstatus"
        self.acct = _free_account(self.token)
        self.cdk = "CDK-DISP-1"
        self.cfg = _fast_cfg()

    def _run_activate(self, client: MockRedeemClient) -> bool | None:
        def _acquire(_cdk_type: str, exclude: set[str] | None = None) -> str | None:
            if self.cdk in (exclude or set()):
                return None
            return self.cdk

        with patch("services.activation_service.account_service.get_account", return_value=self.acct):
            with patch("services.activation_service.account_service.update_account", return_value=self.acct):
                with patch("services.activation_service.cdk_service.acquire_available", side_effect=_acquire):
                    with patch("services.activation_service.cdk_service.consume") as consume:
                        with patch("services.activation_service.cdk_service.release") as release:
                            with patch("services.activation_service.cdk_service.mark_invalid") as mark_invalid:
                                with patch.object(self.svc, "_verify_plan"):
                                    result = self.svc._activate_account(client, self.token, self.cfg)
        self.consume = consume
        self.release = release
        self.mark_invalid = mark_invalid
        return result

    def test_success_consumes_cdk_once(self) -> None:
        client = MockRedeemClient(_item_response(self.cdk, "success"))
        self.assertTrue(self._run_activate(client))
        self.consume.assert_called_once_with(self.cdk, self.token)
        self.release.assert_not_called()
        self.mark_invalid.assert_not_called()

    def test_fail_releases_cdk_not_consume(self) -> None:
        for status in ("failed", "error", "rejected", "token_invalidated"):
            with self.subTest(status=status):
                client = MockRedeemClient(_item_response(self.cdk, status))
                self.assertFalse(self._run_activate(client))
                self.consume.assert_not_called()
                self.mark_invalid.assert_not_called()
                self.assertGreaterEqual(self.release.call_count, 1)
                self.assertIn(self.cdk, [c.args[0] for c in self.release.call_args_list])

    def test_not_found_marks_invalid_not_release(self) -> None:
        for status in ("not_found", "notfound"):
            with self.subTest(status=status):
                client = MockRedeemClient(_item_response(self.cdk, status))
                self.assertFalse(self._run_activate(client))
                self.consume.assert_not_called()
                self.assertGreaterEqual(self.mark_invalid.call_count, 1)
                self.assertIn(self.cdk, [c.args[0] for c in self.mark_invalid.call_args_list])
                self.release.assert_not_called()

    def test_pending_success_on_poll_consumes(self) -> None:
        client = MockRedeemClient(
            _item_response(self.cdk, "queued"),
            [_item_response(self.cdk, "success")],
        )
        self.assertTrue(self._run_activate(client))
        self.consume.assert_called_once_with(self.cdk, self.token)
        self.release.assert_not_called()

    def test_pending_fail_on_poll_releases(self) -> None:
        client = MockRedeemClient(
            _item_response(self.cdk, "dispatched"),
            [_item_response(self.cdk, "failed")],
        )
        self.assertFalse(self._run_activate(client))
        self.consume.assert_not_called()
        self.mark_invalid.assert_not_called()
        self.assertGreaterEqual(self.release.call_count, 1)

    def test_poll_timeout_releases(self) -> None:
        client = MockRedeemClient(
            _item_response(self.cdk, "running"),
            [_item_response(self.cdk, "running")] * 20,
        )
        self.assertFalse(self._run_activate(client))
        self.consume.assert_not_called()
        self.mark_invalid.assert_not_called()
        self.assertGreaterEqual(self.release.call_count, 1)

    def test_envelope_error_releases(self) -> None:
        client = MockRedeemClient(_envelope_only(403, "forbidden"))
        self.assertFalse(self._run_activate(client))
        self.consume.assert_not_called()
        self.mark_invalid.assert_not_called()
        self.assertGreaterEqual(self.release.call_count, 1)

    def test_redeem_error_on_submit_releases(self) -> None:
        client = MockRedeemClient(RedeemError("connection reset"))

        def _acquire(_cdk_type: str, exclude: set[str] | None = None) -> str | None:
            if self.cdk in (exclude or set()):
                return None
            return self.cdk

        with patch("services.activation_service.account_service.get_account", return_value=self.acct):
            with patch("services.activation_service.account_service.update_account", return_value=self.acct):
                with patch("services.activation_service.cdk_service.acquire_available", side_effect=_acquire):
                    with patch("services.activation_service.cdk_service.consume") as consume:
                        with patch("services.activation_service.cdk_service.release") as release:
                            with patch("services.activation_service.cdk_service.mark_invalid") as mark_invalid:
                                result = self.svc._activate_account(client, self.token, self.cfg)
        self.assertFalse(result)
        consume.assert_not_called()
        mark_invalid.assert_not_called()
        self.assertGreaterEqual(release.call_count, 1)

    def test_fail_then_success_on_next_cdk_only_one_consume(self) -> None:
        """第一张 CDK 失败应 release，第二张成功才 consume。"""
        cfg = _fast_cfg(max_attempts=2)
        cdk_fail = "CDK-FAIL"
        cdk_ok = "CDK-OK"

        def _attempt_side_effect(_client, _token, cdk, _cfg, log_sink=None, audit=None, **kwargs):
            if cdk == cdk_fail:
                return "fail", "failed", "nope", ""
            return "success", "success", "ok", "task-1"

        with patch("services.activation_service.account_service.get_account", return_value=self.acct):
            with patch("services.activation_service.account_service.update_account", return_value=self.acct):
                with patch(
                    "services.activation_service.cdk_service.acquire_available",
                    side_effect=[cdk_fail, cdk_ok, None],
                ):
                    with patch("services.activation_service.cdk_service.consume") as consume:
                        with patch("services.activation_service.cdk_service.release") as release:
                            with patch("services.activation_service.cdk_service.mark_invalid"):
                                with patch.object(self.svc, "_verify_plan"):
                                    with patch.object(self.svc, "_attempt", side_effect=_attempt_side_effect):
                                        result = self.svc._activate_account(MagicMock(), self.token, cfg)
        self.assertTrue(result)
        release.assert_called_once_with(cdk_fail)
        consume.assert_called_once_with(cdk_ok, self.token)


def _make_isolated_cdk_service(*cdks: tuple[str, str]) -> CdkService:
    """内存 CDK 池，可观测 _reserved 与 status。"""
    from threading import RLock

    from services.cdk_service import _now

    svc = CdkService.__new__(CdkService)
    svc._storage = InMemoryStorage()
    svc._lock = RLock()
    svc._reserved = set()
    items = cdks or [("CDK-1", "UPI")]
    svc._cdks = {
        cdk: {
            "cdk": cdk,
            "type": typ,
            "status": STATUS_AVAILABLE,
            "bound_token": None,
            "used_at": None,
            "imported_at": _now(),
            "note": "",
        }
        for cdk, typ in items
    }
    return svc


class ActivationOccupationLeakTest(unittest.TestCase):
    """各类激活失败后：邮箱占用锁与 CDK 内存占用必须释放，避免异常占用。"""

    def setUp(self) -> None:
        self.svc = ActivationService()
        self.svc._stats = self.svc._empty_stats()
        self.token = "eyJlease"
        self.acct = _free_account(self.token, "lease@x.com")
        self.cfg = _fast_cfg()
        self.cdk_svc = _make_isolated_cdk_service(("CDK-LEASE", "UPI"))

    def _activate(self, client: MockRedeemClient) -> bool | None:
        with patch("services.activation_service.cdk_service", self.cdk_svc):
            with patch("services.activation_service.account_service.get_account", return_value=self.acct):
                with patch("services.activation_service.account_service.update_account", return_value=self.acct):
                    with patch.object(self.svc, "_verify_plan"):
                        return self.svc._activate_account(client, self.token, self.cfg)

    def _assert_no_occupation(self) -> None:
        self.assertEqual(self.svc.get()["stats"]["claiming"], 0)
        self.assertEqual(len(self.cdk_svc._reserved), 0)

    def test_fail_releases_cdk_reservation(self) -> None:
        client = MockRedeemClient(_item_response("CDK-LEASE", "failed"))
        self.assertFalse(self._activate(client))
        self._assert_no_occupation()
        self.assertEqual(self.cdk_svc._cdks["CDK-LEASE"]["status"], STATUS_AVAILABLE)

    def test_poll_timeout_releases_cdk_reservation(self) -> None:
        client = MockRedeemClient(
            _item_response("CDK-LEASE", "running"),
            [_item_response("CDK-LEASE", "running")] * 20,
        )
        self.assertFalse(self._activate(client))
        self._assert_no_occupation()
        self.assertEqual(self.cdk_svc._cdks["CDK-LEASE"]["status"], STATUS_AVAILABLE)

    def test_not_found_clears_reservation_and_marks_invalid(self) -> None:
        client = MockRedeemClient(_item_response("CDK-LEASE", "not_found"))
        self.assertFalse(self._activate(client))
        self._assert_no_occupation()
        self.assertEqual(self.cdk_svc._cdks["CDK-LEASE"]["status"], STATUS_INVALID)

    def test_redeem_error_releases_cdk_reservation(self) -> None:
        client = MockRedeemClient(RedeemError("connection reset"))
        self.assertFalse(self._activate(client))
        self._assert_no_occupation()
        self.assertEqual(self.cdk_svc._cdks["CDK-LEASE"]["status"], STATUS_AVAILABLE)

    def test_auth_error_releases_cdk_reservation(self) -> None:
        client = MockRedeemClient(AuthError("401"))
        with patch("services.activation_service.cdk_service", self.cdk_svc):
            with patch("services.activation_service.account_service.get_account", return_value=self.acct):
                with patch("services.activation_service.account_service.update_account", return_value=self.acct):
                    with self.assertRaises(AuthError):
                        self.svc._activate_account(client, self.token, self.cfg)
        self._assert_no_occupation()
        self.assertEqual(self.cdk_svc._cdks["CDK-LEASE"]["status"], STATUS_AVAILABLE)

    def test_success_consumes_not_reserved(self) -> None:
        client = MockRedeemClient(_item_response("CDK-LEASE", "success"))
        self.assertTrue(self._activate(client))
        self._assert_no_occupation()
        self.assertEqual(self.cdk_svc._cdks["CDK-LEASE"]["status"], STATUS_USED)

    def test_batch_run_finally_clears_stale_cdk_reservations(self) -> None:
        """模拟线程异常未走 release：批次结束应 sweep _reserved。"""
        self.cdk_svc._reserved.add("CDK-LEASE")
        client = MagicMock()
        with patch("services.activation_service.cdk_service", self.cdk_svc):
            with patch("services.activation_service.CdkRedeemClient", return_value=client):
                with patch.object(self.svc, "_activate_account", return_value=False):
                    self.svc._run(["eyJx"], self.cfg)
        self.assertEqual(len(self.cdk_svc._reserved), 0)

    def test_all_fail_statuses_leave_cdk_available(self) -> None:
        for status in ("failed", "error", "rejected", "cancelled", "token-invalidated"):
            with self.subTest(status=status):
                cdk_svc = _make_isolated_cdk_service(("CDK-F", "UPI"))
                client = MockRedeemClient(_item_response("CDK-F", status))
                with patch("services.activation_service.cdk_service", cdk_svc):
                    with patch("services.activation_service.account_service.get_account", return_value=self.acct):
                        with patch("services.activation_service.account_service.update_account", return_value=self.acct):
                            with patch.object(self.svc, "_verify_plan"):
                                self.assertFalse(self.svc._activate_account(client, self.token, self.cfg))
                self.assertEqual(len(cdk_svc._reserved), 0)
                self.assertEqual(cdk_svc._cdks["CDK-F"]["status"], STATUS_AVAILABLE)
                self.assertEqual(self.svc.get()["stats"]["claiming"], 0)


if __name__ == "__main__":
    unittest.main()
