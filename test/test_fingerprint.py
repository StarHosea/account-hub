from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from services.register import fingerprint as fp  # noqa: E402

IPWEB_RAW = "gate2.ipweb.cc:7778:B_88059_IN_1106_10126_10_x2HnZNuU:220807"


class ParseProxyTest(unittest.TestCase):
    def test_url_form(self):
        p = fp.parse_proxy("socks5://user:pass@gate1.ipweb.cc:7778")
        self.assertEqual((p.scheme, p.host, p.port, p.user, p.password),
                         ("socks5", "gate1.ipweb.cc", "7778", "user", "pass"))

    def test_ipweb_native_host_first(self):
        p = fp.parse_proxy(IPWEB_RAW)
        self.assertEqual(p.host, "gate2.ipweb.cc")
        self.assertEqual(p.port, "7778")
        self.assertEqual(p.user, "B_88059_IN_1106_10126_10_x2HnZNuU")
        self.assertEqual(p.password, "220807")
        self.assertEqual(p.scheme, "socks5h")

    def test_ipweb_user_first(self):
        p = fp.parse_proxy("B_88059_IN_1106_10126_10_x2HnZNuU:220807:gate2.ipweb.cc:7778")
        self.assertEqual(p.host, "gate2.ipweb.cc")
        self.assertEqual(p.user, "B_88059_IN_1106_10126_10_x2HnZNuU")

    def test_invalid(self):
        self.assertIsNone(fp.parse_proxy(""))
        self.assertIsNone(fp.parse_proxy("not-a-proxy"))
        self.assertIsNone(fp.parse_proxy("a:b:c"))

    def test_normalize_roundtrip(self):
        self.assertEqual(
            fp.normalize_proxy(IPWEB_RAW),
            "socks5h://B_88059_IN_1106_10126_10_x2HnZNuU:220807@gate2.ipweb.cc:7778")
        self.assertEqual(fp.normalize_proxy(""), "")


class BrowserProxyUrlTest(unittest.TestCase):
    def test_socks5h_to_socks5(self):
        self.assertEqual(
            fp.browser_proxy_url("socks5h://user:pass@gate2.ipweb.cc:7778"),
            "socks5://user:pass@gate2.ipweb.cc:7778",
        )

    def test_http_unchanged(self):
        self.assertEqual(
            fp.browser_proxy_url("http://user:pass@proxy.example:8080"),
            "http://user:pass@proxy.example:8080",
        )


class RotateIpwebTest(unittest.TestCase):
    def test_changes_country_and_sid(self):
        url, sid = fp.rotate_ipweb_proxy(IPWEB_RAW, "US")
        self.assertIsNotNone(sid)
        self.assertRegex(sid, r"^[A-Za-z0-9]{8}$")
        segs = fp.parse_proxy(url).user.split("_")
        self.assertEqual(segs[0], "B")
        self.assertEqual(segs[1], "88059")
        self.assertEqual(segs[2], "US")
        self.assertEqual(segs[3], "")
        self.assertEqual(segs[4], "")
        self.assertEqual(segs[5], "10")
        self.assertEqual(segs[6], sid)
        p = fp.parse_proxy(url)
        self.assertEqual((p.host, p.port, p.password), ("gate2.ipweb.cc", "7778", "220807"))

    def test_two_calls_differ(self):
        _, sid1 = fp.rotate_ipweb_proxy(IPWEB_RAW, "JP")
        _, sid2 = fp.rotate_ipweb_proxy(IPWEB_RAW, "JP")
        self.assertNotEqual(sid1, sid2)

    def test_explicit_sid(self):
        url, sid = fp.rotate_ipweb_proxy(IPWEB_RAW, "IN", new_sid="Ab000001")
        self.assertEqual(sid, "Ab000001")
        self.assertIn("Ab000001", url)

    def test_duration_override(self):
        url, _ = fp.rotate_ipweb_proxy(IPWEB_RAW, "US", duration=120)
        segs = fp.parse_proxy(url).user.split("_")
        self.assertEqual(segs[5], "120")  # 时长段被覆盖
        # 不传 duration 时保留模板原值 10
        url2, _ = fp.rotate_ipweb_proxy(IPWEB_RAW, "US")
        self.assertEqual(fp.parse_proxy(url2).user.split("_")[5], "10")

    def test_non_ipweb_unchanged(self):
        url, sid = fp.rotate_ipweb_proxy("socks5://user:pass@1.2.3.4:1080", "US")
        self.assertIsNone(sid)
        self.assertEqual(fp.parse_proxy(url).host, "1.2.3.4")

    def test_malformed_username_unchanged(self):
        url, sid = fp.rotate_ipweb_proxy("gate2.ipweb.cc:7778:plainuser:pass", "US")
        self.assertIsNone(sid)


class BuildIdentityTest(unittest.TestCase):
    def test_region_jp(self):
        idn = fp.build_identity(region="JP")
        self.assertEqual(idn.region.code, "JP")
        self.assertEqual(idn.region.ipweb_country, "JP")
        self.assertTrue(idn.accept_language.startswith("ja-JP"))
        self.assertEqual(idn.browser_locale, "ja-JP")
        self.assertEqual(idn.browser_timezone, "Asia/Tokyo")
        self.assertEqual(idn.sentinel_language, "ja-JP")
        self.assertEqual(idn.gmt_offset, "GMT+0900")
        self.assertEqual(idn.tz_label, "Japan Standard Time")

    def test_enabled_pool(self):
        seen = {fp.build_identity(enabled_regions=["US", "IN"]).region.code for _ in range(50)}
        self.assertTrue(seen and seen <= {"US", "IN"})

    def test_invalid_fallback_us(self):
        self.assertEqual(fp.build_identity(region="ZZ").region.code, "US")
        self.assertEqual(fp.build_identity(enabled_regions=[]).region.code, "US")

    def test_profiles_impersonate_supported(self):
        for p in fp.PROFILES:
            self.assertIn(p.impersonate, fp.SUPPORTED_IMPERSONATE)
            ua_major = re.search(r"Chrome/(\d+)", p.user_agent).group(1)
            imp_major = re.search(r"(\d+)", p.impersonate).group(1)
            self.assertEqual(ua_major, imp_major)

    def test_headers_consistent(self):
        idn = fp.build_identity(region="US", profile_key="mac_chrome142")
        ch = fp.common_headers_for(idn)
        nh = fp.navigate_headers_for(idn)
        self.assertEqual(ch["user-agent"], idn.user_agent)
        self.assertEqual(nh["user-agent"], idn.user_agent)
        self.assertEqual(ch["accept-language"], idn.accept_language)
        self.assertEqual(ch["sec-ch-ua-platform"], '"macOS"')

    def test_random_name_region(self):
        idn = fp.build_identity(region="JP")
        first, last = fp.random_name(idn)
        self.assertIn(first, fp.REGIONS["JP"].first_names)
        self.assertIn(last, fp.REGIONS["JP"].last_names)
        f2, _ = fp.random_name()
        self.assertIn(f2, fp.REGIONS["US"].first_names)


if __name__ == "__main__":
    unittest.main()
