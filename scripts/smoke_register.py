#!/usr/bin/env python3
"""注册机端到端冒烟：驱动真实生产路径跑 1 个账号（register_service → openai_register.worker → node_engine）。

用途：本地/服务器上用你的 ipweb 代理 + 1 个池内邮箱，实跑一轮注册（新号或老号自动分流），
看实时日志 + 进度，诊断截图落 REG_DIAG_DIR，最后打印结果（入号池 / 异常清单）。

会创建真实 OpenAI 账号，请仅用于验证。

用法：
  # 邮箱与代理走环境变量（推荐，避免命令行泄漏）
  export SMOKE_MAILBOX='someone@box.com----https://mail.example/api/getcode?...'
  export SMOKE_PROXY='gate2.ipweb.cc:7778:B_88059_US_x_y_10_SID0:pass'   # ipweb 原生/URL 均可
  export REG_DIAG_DIR="$PWD/data/diag"                                   # 可选，开诊断截图
  export SMOKE_IPWEB_ROTATE=1        # 可选，开一号一 IP 换段换 SID（默认 1）
  export SMOKE_HEADLESS=0            # 可选，Linux 无显示器时配 Xvfb 跑有头（默认 0=有头）
  .venv/bin/python scripts/smoke_register.py

  # 或命令行传参：
  .venv/bin/python scripts/smoke_register.py "mail----fetch_url" "proxy_str"
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def main() -> int:
    mailbox_line = (sys.argv[1] if len(sys.argv) > 1 else os.getenv("SMOKE_MAILBOX", "")).strip()
    proxy = (sys.argv[2] if len(sys.argv) > 2 else os.getenv("SMOKE_PROXY", "")).strip()
    if not mailbox_line:
        print("缺少邮箱：设 SMOKE_MAILBOX='邮箱----取件地址' 或作为第 1 个参数传入", file=sys.stderr)
        return 2
    if "----" not in mailbox_line and "@" not in mailbox_line:
        print("邮箱格式应为 '邮箱----取件地址'", file=sys.stderr)
        return 2

    diag = os.getenv("REG_DIAG_DIR", "")
    if diag:
        Path(diag).mkdir(parents=True, exist_ok=True)
        print(f"[smoke] 诊断截图目录：{diag}")

    from services.mailbox_service import mailbox_service
    from services.register_service import register_service

    # 1) 导入 1 个邮箱到池
    stats = mailbox_service.import_text(mailbox_line)
    print(f"[smoke] 邮箱导入：{stats}，当前池：{mailbox_service.stats()}")

    # 1b) 可选：指定目标邮箱，把池里其它「可用」邮箱临时标记为 used，
    #     确保 acquire_unused 一定领到目标（避免历史遗留的测试邮箱如 a@x.com 抢先被领）。
    target = os.getenv("SMOKE_TARGET", "").strip().lower()
    if target:
        mailbox_service.reconcile_in_use()
        # 可选：目标邮箱之前已 used（跑过一轮），置回可用以便重测（走老账号加固路径）。
        if _env_bool("SMOKE_RELEASE_TARGET", False):
            mailbox_service.mark_used([target], False)
        others = []
        for m in mailbox_service.list_mailboxes():
            email = str(m.get("email") or "").lower()
            avail = (not m.get("used")) and (not m.get("in_use"))
            if avail and email != target:
                others.append(m.get("email"))
        if others:
            mailbox_service.mark_used(others, True)
        # 目标本身释放为可用（清 cooldown / in_use）
        mailbox_service.release(target)
        print(f"[smoke] 目标邮箱={target}；其它可用邮箱临时置 used {len(others)} 个，当前池：{mailbox_service.stats()}")

    # 2) 配置注册机：只跑 1 号、单线程、用你的代理
    regions = [r.strip() for r in os.getenv("SMOKE_REGIONS", "US").split(",") if r.strip()] or ["US"]
    updates = {
        "proxy": proxy,
        "total": 1,
        "threads": 1,
        "regions": regions,
        "enable_2fa": _env_bool("SMOKE_ENABLE_2FA", True),
        "ipweb_rotate": _env_bool("SMOKE_IPWEB_ROTATE", True),
        "headless": _env_bool("SMOKE_HEADLESS", False),
        "register_timeout": int(os.getenv("SMOKE_TIMEOUT", "360")),
    }
    register_service.update(updates)
    print(f"[smoke] 注册机配置：total=1 threads=1 regions={regions} ipweb_rotate={updates['ipweb_rotate']} "
          f"headless={updates['headless']} enable_2fa={updates['enable_2fa']} 代理={'有' if proxy else '无'}")

    # 3) 启动并跟日志/进度直到结束
    register_service.start()
    print("[smoke] 已启动，跟随日志……\n" + "-" * 60)
    seen = 0
    deadline = time.time() + int(os.getenv("SMOKE_TIMEOUT", "360")) + 120
    while time.time() < deadline:
        state = register_service.get()
        logs = state.get("logs") or []
        for entry in logs[seen:]:
            print(f"  [{entry.get('level','info')}] {entry.get('text','')}")
        seen = len(logs)
        for p in state.get("progress") or []:
            print(f"    · 任务{p.get('index')} [{p.get('email','')}] {p.get('step','')}")
        if not state.get("enabled") and state.get("stats", {}).get("done"):
            break
        time.sleep(1.5)

    # 4) 结果
    print("-" * 60)
    from services.account_service import account_service
    from services.register_abnormal_service import register_abnormal_service
    accounts = account_service.list_accounts()
    abnormal = register_abnormal_service.list_items()
    print(f"[smoke] 结束。号池账号数={len(accounts)}，异常清单={len(abnormal)}")
    if accounts:
        a = accounts[-1]
        print(f"[smoke] 最新账号：{a.get('email')} status={a.get('status')} "
              f"token={'有' if a.get('access_token') else '无'} 2fa={'有' if a.get('totp_secret') else '无'} "
              f"exit_ip={a.get('exit_ip','')} country={a.get('country','')}")
    if abnormal:
        b = abnormal[-1]
        print(f"[smoke] 最新异常：{b.get('email')} reason={b.get('reason')} eligible={b.get('eligible')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
