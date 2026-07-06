import unittest
from datetime import datetime, timedelta, timezone

from services.register import mail_code as mc


class MailCodeCutoffTests(unittest.TestCase):
    def test_cutoff_subtracts_buffer_from_local_time(self) -> None:
        ts = "2026-07-01T14:30:00+00:00"
        cutoff = mc.cutoff_from_request(ts, buffer_seconds=10)
        self.assertIsNotNone(cutoff)
        requested_local = datetime.fromisoformat(ts).astimezone().replace(tzinfo=None)
        self.assertEqual(cutoff, requested_local - timedelta(seconds=10))

    def test_cutoff_none_without_ts(self) -> None:
        self.assertIsNone(mc.cutoff_from_request(None))

    def test_purpose_label(self) -> None:
        self.assertEqual(mc.purpose_label("login"), "登录")
        self.assertEqual(mc.purpose_label("unknown"), "验证")


class MailCodeRoundTimeoutTests(unittest.TestCase):
    def test_round_timeout_default(self) -> None:
        self.assertEqual(mc.ROUND_WAIT_TIMEOUT, 90.0)

    def test_merge_after_received_at_uses_later_baseline(self) -> None:
        cutoff = datetime(2026, 7, 6, 21, 6, 0)
        baseline = datetime(2026, 7, 6, 21, 5, 52)
        merged = mc._merge_after_received_at(
            cutoff,
            use_mailbox_baseline=True,
            mail_config={},
            mailbox={"address": "a@b.com"},
        )
        self.assertEqual(merged, cutoff)

        import services.register.mail_provider as mp

        original = mp.peek_received_at

        def _fake_peek(_conf, _mailbox):
            return baseline

        try:
            mp.peek_received_at = _fake_peek
            merged = mc._merge_after_received_at(
                cutoff,
                use_mailbox_baseline=True,
                mail_config={},
                mailbox={"address": "a@b.com"},
            )
        finally:
            mp.peek_received_at = original

        self.assertEqual(merged, cutoff)

        try:
            mp.peek_received_at = lambda _conf, _mailbox: datetime(2026, 7, 6, 21, 6, 5)
            merged = mc._merge_after_received_at(
                cutoff,
                use_mailbox_baseline=True,
                mail_config={},
                mailbox={"address": "a@b.com"},
            )
        finally:
            mp.peek_received_at = original

        self.assertEqual(merged, datetime(2026, 7, 6, 21, 6, 5))

    def test_fulfill_uses_round_timeout(self) -> None:
        captured: dict = {}

        class _FakeProvider:
            conf = {}

            def wait_for_code_detail(self, mailbox, after_received_at=None):
                captured["wait_timeout"] = self.conf["wait_timeout"]
                return {"code": "654321", "received_at": datetime(2026, 7, 1, 22, 45, 38)}

            def wait_for_code(self, mailbox, after_received_at=None):
                detail = self.wait_for_code_detail(mailbox, after_received_at=after_received_at)
                return detail.get("code") if detail else None

            def close(self):
                pass

            def __init__(self, conf, _ref=""):
                self.conf = conf

        import services.register.mail_provider as mp

        original = mp._create_provider

        def _fake_create(mail_config, provider="", provider_ref=""):
            conf = mp._config(mail_config)
            return _FakeProvider(conf)

        try:
            mp._create_provider = _fake_create
            code_result = mc.fulfill_need_code({"wait_timeout": 300}, {"address": "a@b.com"}, ts="2026-07-01T14:30:00Z")
        finally:
            mp._create_provider = original

        self.assertEqual(code_result, {"code": "654321", "received_at": "2026-07-01 22:45:38"})
        self.assertEqual(captured.get("wait_timeout"), 90.0)


if __name__ == "__main__":
    unittest.main()
