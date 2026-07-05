import unittest
from datetime import datetime

from services.register import mail_provider as mp

T0 = datetime(2026, 7, 1, 22, 0, 0)
T1 = datetime(2026, 7, 1, 22, 5, 0)  # 更晚（发码后新到达）


class _FakeProvider(mp.BaseMailProvider):
    """按序返回 (code, received_at)，模拟信箱里最新邮件随时间变化。"""

    def __init__(self, seq) -> None:
        super().__init__({"wait_timeout": 3, "wait_interval": 0.2, "user_agent": "x"}, "fake")
        self._seq = list(seq)
        self._i = -1

    def fetch_latest_message(self, mailbox):  # type: ignore[override]
        self._i += 1
        item = self._seq[min(self._i, len(self._seq) - 1)]
        if not item:
            return None
        code, received_at = item
        return {
            "provider": "fake",
            "mailbox": "m",
            "subject": "",
            "text_content": f"Your code is {code}",
            "html_content": "",
            "received_at": received_at,
        }


class ReceivedAtParseTests(unittest.TestCase):
    def test_parses_labeled_time(self) -> None:
        html = '<span>发件人：OpenAI</span><span>时间：2026-07-01 22:45:38</span>'
        self.assertEqual(mp._extract_received_at(html), datetime(2026, 7, 1, 22, 45, 38))

    def test_parses_icloud_api_rfc822_dt(self) -> None:
        html = (
            '<div class="card"><div class="fr">ChatGPT</div>'
            '<div class="su">你的 ChatGPT 验证码</div>'
            '<div class="dt">Sun, 05 Jul 2026 16:49:58 +0000</div></div>'
        )
        parsed = mp._extract_received_at(html)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.year, 2026)
        self.assertEqual(parsed.month, 7)
        self.assertEqual(parsed.day, 5)
        self.assertEqual((parsed.hour, parsed.minute, parsed.second), (16, 49, 58))

    def test_returns_none_when_absent(self) -> None:
        self.assertIsNone(mp._extract_received_at("no timestamp here"))


class WaitForFreshCodeTests(unittest.TestCase):
    """开关 2FA 邮箱 OTP：按到达时间判断新邮件，只接受发码后新到达的码。"""

    def test_peek_returns_latest_received_at(self) -> None:
        self.assertEqual(_FakeProvider([("111111", T0)]).peek_received_at({}), T0)

    def test_skips_stale_email_and_times_out(self) -> None:
        # 信箱里只有发码前那封（T0），after=T0 -> 不接受，等到超时 None。
        self.assertIsNone(_FakeProvider([("111111", T0)]).wait_for_code({}, after_received_at=T0))

    def test_skips_when_received_at_unparseable_with_baseline(self) -> None:
        provider = _FakeProvider([("111111", None)])
        self.assertIsNone(provider.wait_for_code({}, after_received_at=T0))

    def test_accepts_newer_email_even_with_same_code(self) -> None:
        # 关键：OpenAI 重发相同的码，但到达时间更晚 -> 应接受（按时间而非码值判断）。
        provider = _FakeProvider([("111111", T0), ("111111", T0), ("111111", T1)])
        self.assertEqual(provider.wait_for_code({}, after_received_at=T0), "111111")

    def test_accepts_newer_email_with_new_code(self) -> None:
        provider = _FakeProvider([("111111", T0), ("222222", T1)])
        self.assertEqual(provider.wait_for_code({}, after_received_at=T0), "222222")

    def test_accepts_icloud_html_when_after_cutoff(self) -> None:
        html = (
            '<div class="card"><div class="fr">ChatGPT</div>'
            '<div class="su">Your code</div>'
            '<div class="dt">Sun, 05 Jul 2026 16:49:58 +0000</div>'
            '<div class="bd">Your verification code is 855006</div></div>'
        )
        received = mp._extract_received_at(html)
        self.assertIsNotNone(received)
        after = datetime(2026, 7, 5, 16, 49, 0)  # local naive, before mail arrived (UTC 16:49:58)
        self.assertTrue(mp._received_is_fresh(received, after))

    def test_no_baseline_keeps_old_behavior(self) -> None:
        self.assertEqual(_FakeProvider([("111111", T0)]).wait_for_code({}), "111111")


if __name__ == "__main__":
    unittest.main()
