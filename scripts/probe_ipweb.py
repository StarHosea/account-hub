#!/usr/bin/env python3
"""验证 IPWeb 代理与「号一号一 IP」改写是否可用。

用法（在项目根目录）：
  .venv/bin/python scripts/probe_ipweb.py
  .venv/bin/python scripts/probe_ipweb.py --proxy 'gate2.ipweb.cc:7778:B_88059_IN_...:pass' --rounds 3
  .venv/bin/python scripts/probe_ipweb.py --regions US,JP,IN

从 PostgreSQL register 状态读取 proxy / ipweb_rotate / ip_duration / ip_probe_retries（可用 CLI 覆盖）。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.register import fingerprint as fp  # noqa: E402
from services.register.openai_register import (  # noqa: E402
    _acquire_working_proxy,
    _probe_exit_ip,
    _resolve_account_proxy,
    build_identity,
    config,
    reset_used_exit_ips,
)


def _load_register_defaults() -> dict:
    try:
        from services.config import config

        data = config.get_storage_backend().load_state("register")
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def main() -> int:
    saved = _load_register_defaults()
    parser = argparse.ArgumentParser(description="探活 IPWeb 代理并验证换 SID 后出口 IP 是否变化")
    parser.add_argument("--proxy", default=saved.get("proxy", ""), help="IPWeb 代理（host:port:user:pass 或 URL）")
    parser.add_argument("--regions", default=",".join(saved.get("regions") or ["US"]), help="逗号分隔地区码，如 US,JP")
    parser.add_argument("--rounds", type=int, default=3, help="连续探活轮数（每轮换新 SID）")
    parser.add_argument("--ip-duration", type=int, default=int(saved.get("ip_duration") or 120), help="IP 粘性分钟数")
    parser.add_argument("--ip-probe-retries", type=int, default=int(saved.get("ip_probe_retries") or 6))
    parser.add_argument("--no-rotate", action="store_true", help="关闭 SID 轮换（仅探活模板代理）")
    args = parser.parse_args()

    proxy_raw = (args.proxy or "").strip()
    if not proxy_raw:
        print("错误：请通过 --proxy 或 PostgreSQL register 配置提供 IPWeb 代理", file=sys.stderr)
        return 1

    parsed = fp.parse_proxy(proxy_raw)
    if not parsed or not parsed.host.endswith("ipweb.cc"):
        print(f"警告：代理 host 不是 ipweb.cc（{parsed.host if parsed else '无法解析'}）", file=sys.stderr)

    config["proxy"] = proxy_raw
    config["ipweb_rotate"] = not args.no_rotate
    config["ip_duration"] = max(1, args.ip_duration)
    config["ip_probe_retries"] = max(0, args.ip_probe_retries)

    regions = [r.strip().upper() for r in args.regions.split(",") if r.strip()]
    if not regions:
        regions = ["US"]

    print(f"代理模板: {proxy_raw}")
    print(f"号一号一 IP: {'开' if config['ipweb_rotate'] else '关'}  粘性: {config['ip_duration']} 分钟  探活重试: {config['ip_probe_retries']}")
    print(f"地区池: {regions}  轮数: {args.rounds}\n")

    reset_used_exit_ips()
    seen_ips: set[str] = set()

    for i in range(1, args.rounds + 1):
        region = regions[(i - 1) % len(regions)]
        identity = build_identity(region=region)
        rotated = _resolve_account_proxy(identity)
        exit_ip = _probe_exit_ip(rotated)
        sid = fp.parse_proxy(rotated).user.split("_")[-1] if fp.parse_proxy(rotated) else "?"
        dup = exit_ip in seen_ips if exit_ip else False
        if exit_ip:
            seen_ips.add(exit_ip)

        print(f"[{i}/{args.rounds}] 地区={region}  SID={sid}")
        print(f"         改写后: {rotated}")
        print(f"         出口 IP: {exit_ip or '(探活失败)'}  {'⚠ 与本轮重复' if dup else ''}")

        # 走一遍生产同款 acquire（含撞号去重）
        acct_proxy, acquired_ip = _acquire_working_proxy(identity, i)
        if acquired_ip and acquired_ip != exit_ip:
            print(f"         acquire 去重后: {acquired_ip}（可能与上一轮 SID 撞号后换线）")
        elif acct_proxy and not acquired_ip:
            print(f"         acquire: 探活未拿到 IP，回退代理 {acct_proxy[:72]}...")
        print()

    unique = len(seen_ips)
    print(f"汇总: {unique}/{args.rounds} 轮拿到不同出口 IP")
    if config["ipweb_rotate"] and unique < args.rounds and unique > 0:
        print("提示: 住宅代理偶发撞 IP 属正常；注册机内会自动换 SID 重试（ip_probe_retries）。")
    return 0 if unique > 0 or not config["ipweb_rotate"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
