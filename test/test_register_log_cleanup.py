from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from services.register_service import (  # noqa: E402
    RegisterService,
    _log_entry_matches_emails,
    _task_indices_from_text,
)


class RegisterLogCleanupTest(unittest.TestCase):
    def test_task_indices_from_text(self):
        self.assertEqual(_task_indices_from_text("[任务1] 启动浏览器"), {1})
        self.assertEqual(_task_indices_from_text("任务 2 注册失败"), {2})
        self.assertEqual(_task_indices_from_text("任务3 取邮箱失败"), {3})

    def test_log_entry_matches_emails_by_task_index(self):
        needles = {"a@b.com"}
        indices = _task_indices_from_text("[任务1] 已分配邮箱：a@b.com")
        self.assertTrue(
            _log_entry_matches_emails(
                {"text": "任务 1 注册失败，耗时 10.0 秒"},
                needles,
                indices,
            )
        )
        self.assertFalse(
            _log_entry_matches_emails(
                {"text": "[任务2] 已分配邮箱：c@d.com"},
                needles,
                indices,
            )
        )

    def test_clear_logs_for_emails_removes_related_task_logs(self):
        svc = RegisterService.__new__(RegisterService)
        svc._lock = threading.RLock()
        svc._logs = [
            {"time": "t1", "text": "[任务1] 已分配邮箱：a@b.com", "level": "info"},
            {"time": "t2", "text": "[任务1] 启动浏览器", "level": "info"},
            {"time": "t3", "text": "a@b.com 注册失败，已记入异常清单：boom", "level": "yellow"},
            {"time": "t4", "text": "任务 1 注册失败，耗时 10.0 秒，原因：boom", "level": "red"},
            {"time": "t5", "text": "[任务2] 已分配邮箱：c@d.com", "level": "info"},
        ]
        svc._save = lambda: None

        removed = svc.clear_logs_for_emails(["a@b.com"])

        self.assertEqual(removed, 4)
        self.assertEqual(len(svc._logs), 1)
        self.assertIn("c@d.com", svc._logs[0]["text"])


if __name__ == "__main__":
    unittest.main()
