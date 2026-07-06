"""激活并发与账号占用锁：防止同一免费号被多个 CDK 同时 submit。"""
from __future__ import annotations

import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from services.account_lifecycle import STAGE_REGISTERED, _norm_email
from services.activation_service import ActivationService
from services.config import config


def _free_account(token: str, email: str) -> dict:
    return {
        "email": email,
        "access_token": token,
        "stage": STAGE_REGISTERED,
        "plan": "free",
        "type": "free",
    }


def _fast_cfg() -> dict:
    return {
        "max_attempts_per_type": 1,
        "poll_interval": 0.01,
        "poll_timeout": 0.05,
        "timeout_retry_max": 0,
        "failed_retry_max": 0,
        "base_url": "http://test",
        "api_key": "k",
    }


class ActivationConcurrencyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.svc = ActivationService()
        self.svc._stats = self.svc._empty_stats()
        self.token = "eyJconcurrent"
        self.acct = _free_account(self.token, "concurrent@x.com")
        self.cfg = _fast_cfg()
        self.client = MagicMock()

    def _patch_account_flow(self):
        return patch.multiple(
            "services.activation_service.account_service",
            get_account=MagicMock(return_value=self.acct),
            update_account=MagicMock(return_value=self.acct),
        )

    def _patch_preverify(self, token: str | None = None):
        tok = token or self.token
        return patch.object(self.svc, "_preverify_already_plus", return_value=(False, tok))

    def test_duplicate_claim_rejects_second_caller(self) -> None:
        email_key = _norm_email("concurrent@x.com")
        self.assertTrue(self.svc._try_claim_account(email_key))
        self.assertFalse(self.svc._try_claim_account(email_key))
        self.svc._release_account(email_key)

    def test_activation_claim_key_uses_email(self) -> None:
        acct = _free_account("eyJold", "same@x.com")
        self.assertEqual(ActivationService._activation_claim_key("eyJold", acct), "same@x.com")
        self.assertEqual(
            ActivationService._activation_claim_key("eyJnew", {**acct, "access_token": "eyJnew"}),
            "same@x.com",
        )

    def test_skip_when_account_already_claimed(self) -> None:
        self.svc._activating_emails.add(_norm_email(self.acct["email"]))
        with self._patch_account_flow():
            with patch("services.activation_service.cdk_service.acquire_available") as acquire:
                result = self.svc._activate_account(self.client, self.token, self.cfg)
        self.assertIsNone(result)
        acquire.assert_not_called()
        self.assertEqual(self.svc.get()["stats"]["skipped"], 1)
        logs = self.svc.get()["logs"]
        self.assertTrue(any("跳过重复派发" in item["text"] for item in logs))
        self.svc._release_account(_norm_email(self.acct["email"]))

    def test_concurrent_dispatch_only_one_submit(self) -> None:
        gate = threading.Event()
        release = threading.Event()
        submit_calls: list[str] = []

        def _blocking_attempt(_client, _token, cdk, _cfg, log_sink=None, audit=None, **kwargs):
            submit_calls.append(cdk)
            gate.set()
            release.wait(timeout=5)
            return "fail", "error", "fail", ""

        results: list[bool | None] = []

        def _run() -> None:
            results.append(self.svc._activate_account(self.client, self.token, self.cfg))

        with self._patch_account_flow():
            with self._patch_preverify():
                with patch("services.activation_service.cdk_service.acquire_available", side_effect=["CDK-A", None, None]):
                    with patch("services.activation_service.cdk_service.release"):
                        with patch.object(self.svc, "_attempt", side_effect=_blocking_attempt):
                            t1 = threading.Thread(target=_run, name="worker-1")
                            t1.start()
                            self.assertTrue(gate.wait(timeout=5), "first worker did not reach submit")
                            t2 = threading.Thread(target=_run, name="worker-2")
                            t3 = threading.Thread(target=_run, name="worker-3")
                            t2.start()
                            t3.start()
                            time.sleep(0.05)
                            release.set()
                            t1.join(timeout=5)
                            t2.join(timeout=5)
                            t3.join(timeout=5)

        self.assertEqual(len(results), 3)
        self.assertEqual(submit_calls, ["CDK-A"])
        self.assertEqual(sum(1 for r in results if r is None), 2)
        self.assertGreaterEqual(self.svc.get()["stats"]["skipped"], 2)

    def test_sequential_activation_after_release(self) -> None:
        submit_calls: list[str] = []

        def _quick_fail(_client, _token, cdk, _cfg, log_sink=None, audit=None, **kwargs):
            submit_calls.append(cdk)
            return "fail", "error", "fail", ""

        with self._patch_account_flow():
            with self._patch_preverify():
                with patch("services.activation_service.cdk_service.acquire_available", side_effect=["CDK-1", "CDK-2", "CDK-3", "CDK-4"]):
                    with patch("services.activation_service.cdk_service.release"):
                        with patch.object(self.svc, "_attempt", side_effect=_quick_fail):
                            first = self.svc._activate_account(self.client, self.token, self.cfg)
                            second = self.svc._activate_account(self.client, self.token, self.cfg)

        self.assertFalse(first)
        self.assertFalse(second)
        self.assertEqual(submit_calls, ["CDK-1", "CDK-2", "CDK-3", "CDK-4"])

    def test_single_thread_retries_cdk_types_sequentially(self) -> None:
        submit_calls: list[str] = []

        def _quick_fail(_client, _token, cdk, _cfg, log_sink=None, audit=None, **kwargs):
            submit_calls.append(cdk)
            return "fail", "error", "fail", ""

        cfg = {**self.cfg, "max_attempts_per_type": 2}
        with self._patch_account_flow():
            with self._patch_preverify():
                with patch(
                    "services.activation_service.cdk_service.acquire_available",
                    side_effect=["UPI-1", "UPI-2", "IDEL-1", "IDEL-2"],
                ):
                    with patch("services.activation_service.cdk_service.release"):
                        with patch.object(self.svc, "_attempt", side_effect=_quick_fail):
                            result = self.svc._activate_account(self.client, self.token, cfg)

        self.assertFalse(result)
        self.assertEqual(submit_calls, ["UPI-1", "UPI-2", "IDEL-1", "IDEL-2"])

    def test_activate_token_async_skips_when_account_busy(self) -> None:
        cfg_backup = dict(config.cdk_activation)
        try:
            config.update_cdk_activation({**cfg_backup, "auto_activate_after_register": True, "api_key": "k"})
            self.svc._activating_emails.add(_norm_email(self.acct["email"]))
            sink_logs: list[str] = []

            def _sink(text: str, _level: str = "info") -> None:
                sink_logs.append(text)

            with self._patch_account_flow():
                with patch("services.activation_service.cdk_service.counts", return_value={"available": 1}):
                    with patch("services.activation_service.threading.Thread") as Thread:
                        def _run_inline(target=None, args=(), **kwargs):
                            if target:
                                target(*args)
                            return MagicMock()

                        Thread.side_effect = _run_inline
                        dispatched = self.svc.activate_token_async(self.token, log_sink=_sink)
            self.assertTrue(dispatched)
            self.assertTrue(any("跳过重复派发" in text for text in sink_logs))
        finally:
            config.update_cdk_activation(cfg_backup)
            self.svc._release_account(_norm_email(self.acct["email"]))

    def test_batch_run_counts_skipped_not_as_fail(self) -> None:
        gate = threading.Event()
        release = threading.Event()
        targets = ["eyJ-a", "eyJ-a"]

        def _blocking_attempt(_client, token, cdk, _cfg, log_sink=None, audit=None, **kwargs):
            gate.set()
            release.wait(timeout=5)
            return "success", "ok", "ok", "task-1"

        acct = _free_account("eyJ-a", "dup@x.com")
        cfg = {**self.cfg, "concurrency": 2}

        with patch("services.activation_service.CdkRedeemClient", return_value=self.client):
            with patch("services.activation_service.account_service.get_account", return_value=acct):
                with patch("services.activation_service.account_service.update_account", return_value=acct):
                    with self._patch_preverify("eyJ-a"):
                        with patch("services.activation_service.cdk_service.acquire_available", return_value="CDK-1"):
                            with patch("services.activation_service.cdk_service.consume"):
                                with patch("services.activation_service.cdk_service.release"):
                                    with patch.object(self.svc, "_attempt", side_effect=_blocking_attempt):
                                        with patch.object(self.svc, "_verify_plan"):
                                            t = threading.Thread(target=self.svc._run, args=(targets, cfg))
                                            t.start()
                                            self.assertTrue(gate.wait(timeout=5))
                                            release.set()
                                            t.join(timeout=5)

        stats = self.svc.get()["stats"]
        self.assertEqual(stats["success"], 1)
        self.assertEqual(stats["skipped"], 1)
        self.assertEqual(stats["fail"], 0)

    def test_same_email_different_tokens_only_one_submit(self) -> None:
        token_old = "eyJold"
        token_new = "eyJnew"
        acct_old = _free_account(token_old, "rotate@x.com")
        acct_new = {**acct_old, "access_token": token_new}
        gate = threading.Event()
        release = threading.Event()
        submit_calls: list[str] = []

        def _get_account(token: str):
            return acct_new if token == token_new else acct_old

        def _blocking_attempt(_client, _token, cdk, _cfg, log_sink=None, audit=None, **kwargs):
            submit_calls.append(cdk)
            gate.set()
            release.wait(timeout=5)
            return "fail", "error", "fail", ""

        results: list[bool | None] = []

        def _run(tok: str) -> None:
            results.append(self.svc._activate_account(self.client, tok, self.cfg))

        with patch("services.activation_service.account_service.get_account", side_effect=_get_account):
            with patch("services.activation_service.account_service.update_account", side_effect=lambda t, u, quiet=False: _get_account(t)):
                with self._patch_preverify(token_old):
                    with patch("services.activation_service.cdk_service.acquire_available", side_effect=["CDK-A", None]):
                        with patch("services.activation_service.cdk_service.release"):
                            with patch.object(self.svc, "_attempt", side_effect=_blocking_attempt):
                                t1 = threading.Thread(target=_run, args=(token_old,))
                                t1.start()
                                self.assertTrue(gate.wait(timeout=5))
                                t2 = threading.Thread(target=_run, args=(token_new,))
                                t2.start()
                                time.sleep(0.05)
                                release.set()
                                t1.join(timeout=5)
                                t2.join(timeout=5)

        self.assertEqual(submit_calls, ["CDK-A"])
        self.assertEqual(sum(1 for r in results if r is None), 1)

    def test_claiming_count_exposed_in_stats(self) -> None:
        self.svc._activating_emails.add(_norm_email(self.acct["email"]))
        self.assertEqual(self.svc.get()["stats"]["claiming"], 1)
        self.svc._release_account(_norm_email(self.acct["email"]))
        self.assertEqual(self.svc.get()["stats"]["claiming"], 0)


if __name__ == "__main__":
    unittest.main()
