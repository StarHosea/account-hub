from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

NODE_ENGINE_DIR = ROOT_DIR / "node_engine"
NODE_WORKER = NODE_ENGINE_DIR / "worker.js"


def _node_ready() -> bool:
    """Node 可用且 node_engine 依赖（otpauth）已安装时才跑浏览器引擎相关用例。"""
    if shutil.which("node") is None:
        return False
    return (NODE_ENGINE_DIR / "node_modules" / "otpauth").exists()


@unittest.skipUnless(_node_ready(), "node 或 node_engine 依赖未就绪，跳过 Node 引擎协议测试")
class NodeDryRunProtocolTest(unittest.TestCase):
    """不启浏览器，验证 NDJSON 协议：log → need_code → result，且 code 走 stdin 往返。"""

    def test_dry_run_sequence(self):
        job = json.dumps({"dryRun": True, "email": "tester@example.com", "fingerprintSeed": 42})
        proc = subprocess.Popen(
            ["node", str(NODE_WORKER), job],
            cwd=str(NODE_ENGINE_DIR),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        events = []
        assert proc.stdout is not None and proc.stdin is not None
        try:
            for raw in proc.stdout:
                line = raw.strip()
                if not line:
                    continue
                evt = json.loads(line)
                events.append(evt)
                if evt.get("type") == "need_code":
                    proc.stdin.write(json.dumps({"type": "code", "code": "123456"}) + "\n")
                    proc.stdin.flush()
                if evt.get("type") in ("result", "error"):
                    break
        finally:
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()

        types = [e.get("type") for e in events]
        self.assertIn("log", types)
        self.assertIn("need_code", types)
        self.assertIn("result", types)
        # need_code 必须早于 result（顺序正确）
        self.assertLess(types.index("need_code"), types.index("result"))
        result = next(e for e in events if e["type"] == "result")
        self.assertEqual(result["data"]["accessToken"], "dry-access-token")
        self.assertEqual(result["data"]["email"], "tester@example.com")
        self.assertTrue(result["data"]["twoFactorSet"])

    def test_bad_job_emits_error(self):
        """无法解析的 job 也要发一条终态 error（避免 Python 悬挂）。"""
        proc = subprocess.Popen(
            ["node", str(NODE_WORKER), "{not json"],
            cwd=str(NODE_ENGINE_DIR),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        out, _ = proc.communicate(timeout=10)
        lines = [json.loads(l) for l in out.splitlines() if l.strip()]
        self.assertTrue(lines, "应至少输出一条事件")
        self.assertEqual(lines[-1]["type"], "error")


class BrowserProxyUrlTest(unittest.TestCase):
    def setUp(self):
        from services.register import openai_register
        self.o = openai_register

    def test_socks5_with_auth_becomes_http(self):
        url = self.o._browser_proxy_url("socks5h://user:pass@gate2.ipweb.cc:7778", 1)
        self.assertEqual(url, "http://user:pass@gate2.ipweb.cc:7778")

    def test_no_double_encoding(self):
        # 已编码的 %40 不应被二次编码成 %2540
        url = self.o._browser_proxy_url("socks5h://user:p%40ss@h.ipweb.cc:7778", 1)
        self.assertEqual(url, "http://user:p%40ss@h.ipweb.cc:7778")

    def test_raw_special_char_encoded_once(self):
        url = self.o._browser_proxy_url("http://user:p@ss@h:7778", 1)
        # urlsplit 以最后一个 @ 分隔 host，密码含 @ 会被编码
        self.assertTrue(url.startswith("http://user:"))
        self.assertIn("@h:7778", url)

    def test_empty_proxy_direct(self):
        self.assertEqual(self.o._browser_proxy_url("", 1), "")

    def test_ipweb_native_colon_form(self):
        url = self.o._browser_proxy_url("gate2.ipweb.cc:7778:B_1_US_x:pw", 1)
        self.assertEqual(url, "http://B_1_US_x:pw@gate2.ipweb.cc:7778")


class AcquireWorkingProxyTest(unittest.TestCase):
    """出口 IP 探活 + 换 SID 重试：模拟 curl_cffi.get，验证换线/回退/关闭探活三条路径。"""

    def setUp(self):
        from services.register import openai_register, fingerprint
        self.o = openai_register
        self.fp = fingerprint
        # 一个 ipweb 动态住宅代理模板（username 形如 B_<id>_<country>_<state>_<city>_<dur>_<SID>）
        self._ipweb = "gate2.ipweb.cc:7778:B_88059_US_x_y_10_SID0abc:pw"
        self._identity = self.fp.build_identity(region="US")

    def _cfg(self, **over):
        base = {"proxy": self._ipweb, "ipweb_rotate": True, "ip_duration": 120, "ip_probe_retries": 6}
        base.update(over)
        return mock.patch.dict(self.o.config, base, clear=False)

    def test_first_dead_second_alive_rotates_sid(self):
        seen_users = []

        def fake_get(url, proxies=None, **kwargs):
            # 记录每次探活用的 username（换 SID → username 不同）
            proxy = (proxies or {}).get("https", "")
            seen_users.append(proxy)
            # 第一次死、第二次活
            alive = len(seen_users) >= 2
            return SimpleNamespace(status_code=200 if alive else 502,
                                   json=lambda: {"ip": "1.2.3.4"} if alive else {})

        with self._cfg():
            with mock.patch("curl_cffi.requests.get", side_effect=fake_get):
                proxy, exit_ip = self.o._acquire_working_proxy(self._identity, 1)
        self.assertEqual(exit_ip, "1.2.3.4")
        self.assertTrue(proxy)
        self.assertGreaterEqual(len(seen_users), 2)
        self.assertNotEqual(seen_users[0], seen_users[1])  # SID 换过 → 探活地址不同

    def test_all_dead_falls_back_to_last_proxy(self):
        def fake_get(url, proxies=None, **kwargs):
            return SimpleNamespace(status_code=504, json=lambda: {})

        with self._cfg(ip_probe_retries=3):
            with mock.patch("curl_cffi.requests.get", side_effect=fake_get):
                proxy, exit_ip = self.o._acquire_working_proxy(self._identity, 1)
        self.assertEqual(exit_ip, "")          # 没探到活 IP
        self.assertTrue(proxy)                  # 但仍回退带出一条代理（不比旧逻辑差）
        self.assertIn("ipweb.cc", proxy)

    def test_probe_disabled_keeps_old_behavior(self):
        called = {"n": 0}

        def fake_get(*a, **k):
            called["n"] += 1
            return SimpleNamespace(status_code=200, json=lambda: {"ip": "9.9.9.9"})

        with self._cfg(ip_probe_retries=0):
            with mock.patch("curl_cffi.requests.get", side_effect=fake_get):
                proxy, exit_ip = self.o._acquire_working_proxy(self._identity, 1)
        self.assertEqual(called["n"], 0)        # 关闭探活 → 完全不探
        self.assertEqual(exit_ip, "")
        self.assertTrue(proxy)                  # 仍解析出账号代理

    def test_no_proxy_is_direct(self):
        with self._cfg(proxy=""):
            proxy, exit_ip = self.o._acquire_working_proxy(self._identity, 1)
        self.assertEqual((proxy, exit_ip), ("", ""))


if __name__ == "__main__":
    unittest.main()
