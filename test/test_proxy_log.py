from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.register import openai_register as oai  # noqa: E402
from services.register.fingerprint import build_identity  # noqa: E402


class LogProxyAssignmentTest(unittest.TestCase):
  def test_logs_exit_ip_on_first_success(self):
    identity = build_identity(region="US")
    sink: list[tuple[str, str]] = []
    oai.register_log_sink = lambda text, color="": sink.append((text, color))
    try:
      oai._log_proxy_assignment(
        1,
        identity,
        "socks5h://B_88059_US___120_Ab000001:pw@gate2.ipweb.cc:7778",
        "1.2.3.4",
      )
    finally:
      oai.register_log_sink = None
    self.assertTrue(sink)
    text, color = sink[-1]
    self.assertIn("出口 IP 1.2.3.4", text)
    self.assertIn("IPWeb 代理就绪", text)
    self.assertEqual(color, "green")

  def test_logs_when_probe_disabled(self):
    identity = build_identity(region="JP")
    sink: list[str] = []
    oai.register_log_sink = lambda text, color="": sink.append(text)
    try:
      with mock.patch.dict(oai.config, {"ip_probe_retries": 0}, clear=False):
        oai._log_proxy_assignment(
          2,
          identity,
          "socks5h://B_88059_JP___120_Xy000002:pw@gate2.ipweb.cc:7778",
          "",
        )
    finally:
      oai.register_log_sink = None
    self.assertTrue(any("探活已关闭" in t for t in sink))


if __name__ == "__main__":
  unittest.main()
