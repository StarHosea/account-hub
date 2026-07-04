#!/usr/bin/env python3
"""测试数据 seed：注入/清理带 TEST- 标记的邮箱、CDK、账号，用于本地测试注册/激活与资源回收。

所有测试数据都带明显标记，clean 只删这些，不动你的真实数据：
- 邮箱：email 以 "test-" 开头
- CDK ：cdk 以 "TEST-" 开头
- 账号：access_token 以 "test-token-" 开头（激活僵尸号）

直接读写 data/*.json（{"items":[...]} 结构），与服务层格式一致；服务重启后即加载。
⚠️ 修改前请确保后端未在写这些文件（停后端再 seed，或 seed 后再启动后端）。

用法：
  .venv/bin/python tests/manual/seed_test_data.py inject   # 注入测试数据
  .venv/bin/python tests/manual/seed_test_data.py status   # 查看当前测试数据
  .venv/bin/python tests/manual/seed_test_data.py clean     # 清除所有 TEST- 数据
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data"
MAILBOXES = DATA / "mailboxes.json"
CDKS = DATA / "cdks.json"
ACCOUNTS = DATA / "accounts.json"

MAIL_PREFIX = "test-"
CDK_PREFIX = "TEST-"
TOKEN_PREFIX = "test-token-"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _old_iso(seconds_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).isoformat()


def _load(path: Path) -> dict:
    if not path.exists():
        return {"items": [], "_shape": "dict"}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"items": [], "_shape": "dict"}
    if isinstance(d, list):
        # 顶层数组形态（如 accounts.json）：记录形态，写回时保持数组，不强加 items 包裹。
        return {"items": d, "_shape": "list"}
    if not isinstance(d.get("items"), list):
        d["items"] = []
    d["_shape"] = "dict"
    return d


def _save(path: Path, data: dict) -> None:
    shape = data.get("_shape", "dict")
    if shape == "list":
        payload: object = data["items"]
    else:
        payload = {k: v for k, v in data.items() if k != "_shape"}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ----------------------------- 测试数据定义 ----------------------------- #

def _mailbox_items() -> list[dict]:
    """5 个测试邮箱，覆盖：可用 / 陈旧占用（reaper 该回收）/ 新占用（reaper 不该动）。"""
    def mk(email: str, *, used=False, in_use=False, in_use_at=None, note="") -> dict:
        return {
            "email": email,
            "fetch_url": f"http://127.0.0.1:8899/mock-mail?u={email}",  # 假取件地址，注册不真跑就够用
            "used": used, "in_use": in_use, "account_token": None,
            "registered_at": None, "imported_at": _now_iso(),
            "in_use_at": in_use_at, "cooldown_until": None, "note": note or "TEST seed",
        }
    return [
        mk(f"{MAIL_PREFIX}fresh-01@example.com"),
        mk(f"{MAIL_PREFIX}fresh-02@example.com"),
        mk(f"{MAIL_PREFIX}fresh-03@example.com"),
        # 陈旧占用：in_use_at 很久以前 → reaper(阈值内) 与启动对账都应释放
        mk(f"{MAIL_PREFIX}stale-inuse@example.com", in_use=True, in_use_at=_old_iso(3600),
           note="TEST 陈旧占用，应被 reaper/启动对账释放"),
        # 新占用：in_use_at 就在刚才 → reaper 不该误伤（模拟正在注册中的邮箱）
        mk(f"{MAIL_PREFIX}fresh-inuse@example.com", in_use=True, in_use_at=_now_iso(),
           note="TEST 新占用，reaper 不应回收"),
    ]


def _cdk_items() -> list[dict]:
    """各前缀 CDK（available），配合 mock 服务切换激活结果。UPI/IDEL 两类都给。"""
    def mk(cdk: str, cdk_type: str) -> dict:
        return {"cdk": cdk, "type": cdk_type, "status": "available", "bound_token": None,
                "used_at": None, "imported_at": _now_iso(), "note": "TEST seed"}
    return [
        mk(f"{CDK_PREFIX}OK-UPI-0001", "UPI"),
        mk(f"{CDK_PREFIX}OK-IDEL-0001", "IDEL"),
        mk(f"{CDK_PREFIX}PEND-UPI-0001", "UPI"),
        mk(f"{CDK_PREFIX}BAD-UPI-0001", "UPI"),
        mk(f"{CDK_PREFIX}FAIL-UPI-0001", "UPI"),
        mk(f"{CDK_PREFIX}STUCK-UPI-0001", "UPI"),
        mk(f"{CDK_PREFIX}STUCK-IDEL-0001", "IDEL"),
    ]


def _account_items() -> list[dict]:
    """2 个激活僵尸号：plus_status=激活中，plus_updated_at 一老一新。

    老的应被 reaper(按龄) 与启动对账复位为「未激活」；新的 reaper 不该动（模拟正在激活）。
    带 access_token 便于激活链路直接对这些号发起兑换（配合 mock）。
    """
    def mk(suffix: str, *, plus_updated_at: str, email: str) -> dict:
        return {
            "email": email,
            "access_token": f"{TOKEN_PREFIX}{suffix}",
            "password": "test-pass", "status": "正常", "type": "未知",
            "created_at": _now_iso(), "source_type": "web", "proxy": "",
            "plus_status": "激活中", "plus_attempts": {"UPI": 0, "IDEL": 0},
            "plus_cdk": None, "plus_cdk_type": None, "plus_task_id": None,
            "plus_last_message": "TEST 卡在激活中", "plus_updated_at": plus_updated_at,
            "plus_activated_at": None, "plus_unavailable": False, "note": "TEST seed",
        }
    return [
        mk("stuck-old", plus_updated_at=_old_iso(3600),
           email=f"{MAIL_PREFIX}acct-stuck-old@example.com"),
        mk("stuck-fresh", plus_updated_at=_now_iso(),
           email=f"{MAIL_PREFIX}acct-stuck-fresh@example.com"),
    ]


# ----------------------------- 操作 ----------------------------- #

def _is_test_mail(m: dict) -> bool:
    return str(m.get("email") or "").startswith(MAIL_PREFIX)


def _is_test_cdk(c: dict) -> bool:
    return str(c.get("cdk") or "").startswith(CDK_PREFIX)


def _is_test_acct(a: dict) -> bool:
    return str(a.get("access_token") or "").startswith(TOKEN_PREFIX)


def inject() -> None:
    for path, new_items, is_test in (
        (MAILBOXES, _mailbox_items(), _is_test_mail),
        (CDKS, _cdk_items(), _is_test_cdk),
        (ACCOUNTS, _account_items(), _is_test_acct),
    ):
        data = _load(path)
        kept = [it for it in data["items"] if not is_test(it)]  # 先去旧测试数据，幂等
        data["items"] = kept + new_items
        _save(path, data)
        print(f"[seed] {path.name}: 注入 {len(new_items)} 条测试数据（保留真实 {len(kept)} 条）")
    print("[seed] 注入完成。启动/重启后端后生效。")


def clean() -> None:
    for path, is_test in ((MAILBOXES, _is_test_mail), (CDKS, _is_test_cdk), (ACCOUNTS, _is_test_acct)):
        data = _load(path)
        before = len(data["items"])
        data["items"] = [it for it in data["items"] if not is_test(it)]
        removed = before - len(data["items"])
        _save(path, data)
        print(f"[seed] {path.name}: 清除 {removed} 条测试数据（保留 {len(data['items'])} 条）")
    print("[seed] 清理完成。")


def status() -> None:
    for path, is_test, key in ((MAILBOXES, _is_test_mail, "email"),
                               (CDKS, _is_test_cdk, "cdk"),
                               (ACCOUNTS, _is_test_acct, "access_token")):
        data = _load(path)
        tests = [it for it in data["items"] if is_test(it)]
        print(f"\n=== {path.name}: {len(tests)} 条测试数据 ===")
        for it in tests:
            if path is MAILBOXES:
                print(f"  {it.get('email')}  used={it.get('used')} in_use={it.get('in_use')} "
                      f"in_use_at={it.get('in_use_at')}")
            elif path is CDKS:
                print(f"  {it.get('cdk')}  type={it.get('type')} status={it.get('status')}")
            else:
                print(f"  {it.get('access_token')}  plus_status={it.get('plus_status')} "
                      f"plus_updated_at={it.get('plus_updated_at')}")


def main() -> None:
    ap = argparse.ArgumentParser(description="测试数据 seed")
    ap.add_argument("action", choices=["inject", "clean", "status"])
    args = ap.parse_args()
    if not DATA.exists():
        print(f"[seed] 数据目录不存在: {DATA}", file=sys.stderr)
        sys.exit(1)
    {"inject": inject, "clean": clean, "status": status}[args.action]()


if __name__ == "__main__":
    main()
