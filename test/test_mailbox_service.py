import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from services.mailbox_service import MailboxService
from services.register import mail_provider as mp
from test.utils import InMemoryStorage


def _make_service(tmp: Path) -> MailboxService:
    svc = MailboxService(store_file=tmp / "mailboxes.json", storage=InMemoryStorage())
    svc.import_text("a@x.com----http://a\nb@x.com----http://b\nc@x.com----http://c")
    return svc


class IsAvailableTests(unittest.TestCase):
    """_is_available：占用态无时间戳应视为不可用（此前 bug 会误判为可用导致重复领取）。"""

    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.svc = _make_service(Path(self._dir.name))

    def tearDown(self) -> None:
        self._dir.cleanup()

    def test_in_use_without_timestamp_is_unavailable(self) -> None:
        item = {"used": False, "in_use": True, "in_use_at": None}
        self.assertFalse(self.svc._is_available(item))

    def test_in_use_with_bad_timestamp_is_unavailable(self) -> None:
        item = {"used": False, "in_use": True, "in_use_at": "not-a-date"}
        self.assertFalse(self.svc._is_available(item))

    def test_fresh_in_use_is_unavailable(self) -> None:
        item = {"used": False, "in_use": True, "in_use_at": datetime.now(timezone.utc).isoformat()}
        self.assertFalse(self.svc._is_available(item))

    def test_free_mailbox_is_available(self) -> None:
        item = {"used": False, "in_use": False, "in_use_at": None}
        self.assertTrue(self.svc._is_available(item))

    def test_cooldown_future_is_unavailable(self) -> None:
        until = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()
        item = {"used": False, "in_use": False, "in_use_at": None, "cooldown_until": until}
        self.assertFalse(self.svc._is_available(item))

    def test_cooldown_past_is_available(self) -> None:
        until = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
        item = {"used": False, "in_use": False, "in_use_at": None, "cooldown_until": until}
        self.assertTrue(self.svc._is_available(item))


class AcquireUnusedTests(unittest.TestCase):
    """acquire_unused：连续领取不得重复返回同一邮箱（此前 bug 会把占用中的邮箱反复发出）。"""

    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.svc = _make_service(Path(self._dir.name))

    def tearDown(self) -> None:
        self._dir.cleanup()

    def test_acquire_does_not_repeat(self) -> None:
        first = self.svc.acquire_unused()
        second = self.svc.acquire_unused()
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertNotEqual(first["email"], second["email"])

    def test_acquire_exhausts_pool(self) -> None:
        got = {self.svc.acquire_unused()["email"] for _ in range(3)}
        self.assertEqual(len(got), 3)  # 三个都不同
        self.assertIsNone(self.svc.acquire_unused())  # 池已空

    def test_release_with_cooldown_blocks_immediate_reacquire(self) -> None:
        first = self.svc.acquire_unused()
        self.svc.release(first["email"], cooldown_seconds=60)
        # 冷却期内不应再被领到，除非领到的是池里其它邮箱。
        for _ in range(2):
            nxt = self.svc.acquire_unused()
            if nxt is not None:
                self.assertNotEqual(nxt["email"], first["email"])

    def test_mark_used_bad_permanently_removes(self) -> None:
        first = self.svc.acquire_unused()
        self.svc.mark_used_bad(first["email"], note="疑似已注册")
        # 标坏后无论如何都不应再领到它。
        for _ in range(5):
            nxt = self.svc.acquire_unused()
            if nxt is None:
                break
            self.assertNotEqual(nxt["email"], first["email"])


class MarkMailboxResultTests(unittest.TestCase):
    """mark_mailbox_result：按失败原因分类处置邮箱。"""

    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.svc = MailboxService(store_file=Path(self._dir.name) / "mailboxes.json", storage=InMemoryStorage())
        self.svc.import_text("bad@x.com----http://bad\nenv@x.com----http://env")
        self._orig = mp.mailbox_service
        mp.mailbox_service = self.svc

    def tearDown(self) -> None:
        mp.mailbox_service = self._orig
        self._dir.cleanup()

    def _mailbox(self, address: str) -> dict:
        return {"provider": mp.API_MAILBOX_TYPE, "address": address}

    def test_email_exists_marks_used_bad(self) -> None:
        self.svc.acquire_unused()  # 占用第一个（bad@x.com）
        err = RuntimeError("register failed: email_exists")
        mp.mark_mailbox_result(self._mailbox("bad@x.com"), success=False, error=err)
        item = self.svc._mailboxes["bad@x.com"]
        self.assertTrue(item["used"])  # 永久标坏

    def test_environment_failure_releases_with_cooldown(self) -> None:
        self.svc.acquire_unused()
        self.svc.acquire_unused()  # 占用两个，确保 env@x.com 处于 in_use
        mp.mark_mailbox_result(self._mailbox("env@x.com"), success=False, error=RuntimeError("被 Cloudflare 拦截"))
        item = self.svc._mailboxes["env@x.com"]
        self.assertFalse(item["used"])  # 未标坏
        self.assertFalse(item["in_use"])  # 已释放
        self.assertIsNotNone(item["cooldown_until"])  # 有冷却


if __name__ == "__main__":
    unittest.main()
