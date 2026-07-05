#!/usr/bin/env python3
"""从 account-hub 服务器拉注册失败诊断，复制给本地 AI 分析。

默认读 scripts/diag.local.env（已配置 hao.shuangdeng.space）。

用法:
  ./scripts/fetch-register-diag.py              # 最近一条失败 → Markdown 打印并复制到剪贴板
  ./scripts/fetch-register-diag.py a@b.com      # 指定邮箱
  ./scripts/fetch-register-diag.py list         # 异常列表 + 各条诊断链接
  ./scripts/fetch-register-diag.py url            # 只打印「给 AI 用的链接」
  ./scripts/fetch-register-diag.py --no-copy      # 不写入剪贴板
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = Path(__file__).with_name("diag.local.env")
DEFAULT_SERVER = "https://hao.shuangdeng.space"


def load_server_url(override: str = "") -> str:
    if override.strip():
        return override.strip().rstrip("/")
    if os.getenv("ACCOUNT_HUB_URL", "").strip():
        return os.getenv("ACCOUNT_HUB_URL", "").strip().rstrip("/")
    if ENV_FILE.is_file():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("ACCOUNT_HUB_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'").rstrip("/")
    return DEFAULT_SERVER


def http_get(url: str) -> tuple[int, str, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": "account-hub-diag-fetch/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, str(resp.headers.get_content_type() or ""), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, str(exc.headers.get_content_type() or ""), exc.read()


def copy_mac(text: str) -> bool:
    if sys.platform != "darwin":
        return False
    try:
        proc = subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)
        return proc.returncode == 0
    except Exception:
        return False


def diag_urls(server: str, email: str = "") -> dict[str, str]:
    q = urllib.parse.quote(email, safe="") if email else ""
    base = server.rstrip("/")
    if email:
        return {
            "ai": f"{base}/api/register/diag/brief.md?email={q}",
            "json": f"{base}/api/register/diag/brief?email={q}",
            "zip": f"{base}/api/register/diag/artifacts?email={q}",
        }
    return {
        "ai": f"{base}/api/register/diag/brief.md",
        "json": f"{base}/api/register/diag/brief",
        "list": f"{base}/api/register/diag/list",
    }


def cmd_url(server: str, email: str) -> int:
    urls = diag_urls(server, email)
    print(urls["ai"])
    return 0


def cmd_list(server: str) -> int:
    status, _, body = http_get(f"{server}/api/register/diag/list")
    if status != 200:
        print(body.decode("utf-8", errors="replace"), file=sys.stderr)
        return 1
    data = json.loads(body.decode("utf-8"))
    print(f"服务器: {server}")
    print(f"异常数: {data.get('total', 0)}\n")
    for item in data.get("items") or []:
        email = item.get("email") or ""
        urls = item.get("urls") if isinstance(item.get("urls"), dict) else diag_urls(server, email)
        rec = "有存证" if item.get("has_recording") else "无存证"
        print(f"- {email} [{rec}]")
        print(f"  原因: {item.get('reason') or '—'}")
        print(f"  AI链接: {urls.get('brief_md') or urls.get('brief') or diag_urls(server, email)['ai']}")
        print()
    latest = (data.get("urls") or {}).get("brief_latest") or diag_urls(server)["ai"]
    print(f"最近失败简报: {latest}")
    return 0


def cmd_fetch(server: str, email: str, *, do_copy: bool) -> int:
    urls = diag_urls(server, email)
    status, ctype, body = http_get(urls["ai"])
    text = body.decode("utf-8", errors="replace")
    if status != 200:
        print(f"HTTP {status}\n{text}", file=sys.stderr)
        return 1
    print(text)
    print("---")
    print(f"AI 链接: {urls['ai']}")
    print(f"JSON:    {urls['json']}")
    print(f"ZIP:     {urls['zip']}")
    if do_copy and copy_mac(text):
        print("（已复制 Markdown 简报到剪贴板，可直接贴给 Cursor）")
    elif do_copy:
        print("（非 macOS 或未安装 pbcopy，请手动复制上方内容）")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="拉取 account-hub 注册诊断简报")
    parser.add_argument("target", nargs="?", default="", help="邮箱 / list / url；留空=最近一条失败")
    parser.add_argument("--server", default="", help=f"服务器地址（默认 {DEFAULT_SERVER}）")
    parser.add_argument("--no-copy", action="store_true", help="不写入剪贴板")
    args = parser.parse_args()

    server = load_server_url(args.server)
    target = str(args.target or "").strip()

    if target.lower() == "list":
        return cmd_list(server)
    if target.lower() == "url":
        return cmd_url(server, "")

    email = "" if target.lower() in {"", "latest", "last"} else target
    if email and "@" not in email and target.lower() != "url":
        print(f"未知命令: {target}（可用 list / url / 邮箱）", file=sys.stderr)
        return 2
    if target.lower() == "url" and email:
        return cmd_url(server, email)

    return cmd_fetch(server, email, do_copy=not args.no_copy)


if __name__ == "__main__":
    raise SystemExit(main())
