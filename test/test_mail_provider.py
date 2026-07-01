import unittest

from services.register import mail_provider as mp


class _FakeProvider(mp.BaseMailProvider):
    """按序返回验证码，模拟「信箱残留旧码 + 新码稍后到达」。"""

    def __init__(self, seq: list[str]) -> None:
        super().__init__({"wait_timeout": 3, "wait_interval": 0.2, "user_agent": "x"}, "fake")
        self._seq = list(seq)
        self._i = -1

    def fetch_latest_message(self, mailbox):  # type: ignore[override]
        self._i += 1
        code = self._seq[min(self._i, len(self._seq) - 1)]
        if not code:
            return None
        return {
            "provider": "fake",
            "mailbox": "m",
            "subject": "",
            "text_content": f"Your code is {code}",
            "html_content": "",
            "received_at": None,
        }


class WaitForCodeExcludeTests(unittest.TestCase):
    """开关 2FA 登录邮箱 OTP：发码前记录旧码，只接受之后新到达的码（覆盖邮件迟到）。"""

    def test_peek_returns_current_code(self) -> None:
        self.assertEqual(_FakeProvider(["111111"]).peek_code({}), "111111")

    def test_exclude_skips_stale_and_times_out(self) -> None:
        # 信箱里只有旧码 111111：排除它 -> 不会返回旧码，等到超时返回 None。
        self.assertIsNone(_FakeProvider(["111111"]).wait_for_code({}, exclude_code="111111"))

    def test_exclude_returns_new_code_when_it_arrives(self) -> None:
        # 前几轮仍是旧码，之后新码 222222 到达 -> 返回新码。
        provider = _FakeProvider(["111111", "111111", "222222"])
        self.assertEqual(provider.wait_for_code({}, exclude_code="111111"), "222222")

    def test_no_exclude_keeps_old_behavior(self) -> None:
        self.assertEqual(_FakeProvider(["111111"]).wait_for_code({}), "111111")


if __name__ == "__main__":
    unittest.main()
