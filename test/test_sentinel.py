from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from utils.sentinel import SentinelTokenGenerator  # noqa: E402


class SentinelConfigTest(unittest.TestCase):
    def test_defaults_match_legacy(self):
        g = SentinelTokenGenerator("dev", "UA/1.0")
        cfg = g._get_config()
        self.assertEqual(cfg[0], "1920x1080")          # screen
        self.assertIn("GMT+0000", cfg[1])               # 时区偏移
        self.assertIn("Coordinated Universal Time", cfg[1])
        self.assertEqual(cfg[8], "en-US")               # language
        self.assertEqual(cfg[16], 8)                    # hardware_concurrency 默认

    def test_params_applied(self):
        g = SentinelTokenGenerator(
            "dev", "UA/1.0",
            screen="2560x1440", hardware_concurrency=12,
            language="ja-JP", gmt_offset="GMT+0900", tz_label="Japan Standard Time",
        )
        cfg = g._get_config()
        self.assertEqual(cfg[0], "2560x1440")
        self.assertIn("GMT+0900", cfg[1])
        self.assertIn("Japan Standard Time", cfg[1])
        self.assertEqual(cfg[8], "ja-JP")
        self.assertEqual(cfg[16], 12)

    def test_offset_seconds(self):
        self.assertEqual(SentinelTokenGenerator._offset_seconds("GMT+0900"), 9 * 3600)
        self.assertEqual(SentinelTokenGenerator._offset_seconds("GMT-0500"), -5 * 3600)
        self.assertEqual(SentinelTokenGenerator._offset_seconds("GMT+0530"), 5 * 3600 + 30 * 60)
        self.assertEqual(SentinelTokenGenerator._offset_seconds("GMT+0000"), 0)


if __name__ == "__main__":
    unittest.main()
