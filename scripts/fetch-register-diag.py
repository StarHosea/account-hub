#!/usr/bin/env python3
"""从 account-hub 拉注册失败诊断，复制给本地 AI。

自动探测顺序：显式 --server → 本地 127.0.0.1:8000 → 远程 meta 里的 public_url。

用法:
  python3 scripts/fetch-register-diag.py              # 自动选可用服务器，拉最近失败
  python3 scripts/fetch-register-diag.py --local        # 强制本地
  python3 scripts/fetch-register-diag.py --remote       # 强制远程（读设置里的诊断对外地址）
  python3 scripts/fetch-register-diag.py a@b.com
  python3 scripts/fetch-register-diag.py list
  python3 scripts/fetch-register-diag.py url
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

LOCAL_CANDIDATES = (
    "http://127.0.0.1:8000",
    "http://localhost:8000",
)
REMOTE_FALLBACK = "https://hao.shuangdeng.space"


def http_get(url: str) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": "account-hub-diag-fetch/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def fetch_meta(base: str) -> dict | None:
    status, body = http_get(f"{base.rstrip('/')}/api/register/diag/meta")
    if status != 200:
        return None
    try:
        data = json.loads(body.decode("utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def pick_server(explicit: str = "", *, prefer_local: bool = False, prefer_remote: bool = False) -> str:
    if explicit.strip():
        return explicit.strip().rstrip("/")

    order: list[str] = []
    if prefer_local:
        order.extend(LOCAL_CANDIDATES)
    elif prefer_remote:
        order.append(REMOTE_FALLBACK)
    else:
        order.extend(LOCAL_CANDIDATES)
        order.append(REMOTE_FALLBACK)

    seen: set[str] = set()
    for base in order:
        if base in seen:
            continue
        seen.add(base)
        meta = fetch_meta(base)
        if meta and meta.get("ok"):
            return str(meta.get("public_url") or base).rstrip("/") or base

    return order[0]


def copy_mac(text: str) -> bool:
    if sys.platform != "darwin":
        return False
    try:
        subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)
        return True
    except Exception:
        return False


def diag_urls(server: str, email: str = "") -> dict[str, str]:
    base = server.rstrip("/")
    if email:
        q = urllib.parse.quote(email, safe="")
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
    print(diag_urls(server, email)["ai"])
    return 0


def cmd_list(server: str) -> int:
    status, body = http_get(f"{server}/api/register/diag/list")
    if status != 200:
        print(body.decode("utf-8", errors="replace"), file=sys.stderr)
        return 1
    data = json.loads(body.decode("utf-8"))
    print(f"服务器: {server}")
    print(f"异常数: {data.get('total', 0)}\n")
    for item in data.get("items") or []:
        email = item.get("email") or ""
        urls = item.get("urls") if isinstance(item.get("urls"), dict) else {}
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
    status, body = http_get(urls["ai"])
    text = body.decode("utf-8", errors="replace")
    if status != 200:
        print(f"HTTP {status}\n{text}", file=sys.stderr)
        return 1
    print(text)
    print("---")
    print(f"服务器:  {server}")
    print(f"AI 链接: {urls['ai']}")
    print(f"JSON:    {urls['json']}")
    if email:
        print(f"ZIP:     {urls['zip']}")
    if do_copy and copy_mac(text):
        print("（已复制 Markdown 简报到剪贴板，可直接贴给 Cursor）")
    elif do_copy:
        print("（非 macOS 或未安装 pbcopy，请手动复制上方内容）")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="拉取 account-hub 注册诊断简报")
    parser.add_argument("target", nargs="?", default="", help="邮箱 / list / url；留空=最近一条失败")
    parser.add_argument("--server", default="", help="指定服务器根地址")
    parser.add_argument("--local", action="store_true", help="优先本地 http://127.0.0.1:8000")
    parser.add_argument("--remote", action="store_true", help="优先远程生产服务器")
    parser.add_argument("--no-copy", action="store_true", help="不写入剪贴板")
    args = parser.parse_args()

    server = pick_server(args.server, prefer_local=args.local, prefer_remote=args.remote)
    target = str(args.target or "").strip()

    if target.lower() == "list":
        return cmd_list(server)
    if target.lower() == "url":
        email = "" if target.lower() == "url" and not args.target else target
        return cmd_url(server, email if "@" in email else "")

    email = "" if target.lower() in {"", "latest", "last"} else target
    if email and "@" not in email:
        print(f"未知命令: {target}（可用 list / url / 邮箱）", file=sys.stderr)
        return 2
    if target.lower() == "url" and email:
        return cmd_url(server, email)

    return cmd_fetch(server, email, do_copy=not args.no_copy)


if __name__ == "__main__":
    raise SystemExit(main())
