#!/usr/bin/env python3
"""本地 Mock CDK 兑换服务：实现「外部兑换接口」用于本地联调，不触达真实服务端。

实现的接口（统一信封 {code,message,data:{items:[...]}}，鉴权头 X-External-Api-Key）：
  POST /api/external/cdkey-redeems           提交兑换
  POST /api/external/cdkey-redeems/status    查询兑换状态
  POST /api/external/cdkey-jobs/cancel       取消任务
  POST /api/external/cdkey-jobs/retry        重试任务

状态机（按提交后经过的秒数推进，便于观察轮询）：
  pending_dispatch(排队) → dispatched(已派发) → running(兑换中) → 终态

按 cdkey 关键字（大小写不敏感）指定测试结果，方便覆盖各分支：
  含 "INVALID"/"BAD"/"NOTFOUND" → 提交即返回 not_found（客户端应标记该 CDK 无效并换下一张）
  含 "FAIL"                     → 最终 failed
  含 "TIMEOUT"                  → 卡在 running 永不终态（客户端会一直轮询直到终态或任务停止）
  含 "SLOW"                     → 排队更久后 success
  其它                          → success

可调环境变量：
  MOCK_API_KEY         期望的 X-External-Api-Key（默认 "mock-key"，与平台配置 cdk_activation.api_key 对齐）
  MOCK_ENVELOPE_CODE   成功信封的顶层 code（默认 0；设为 200 可复现「旧逻辑按 code!=0 直接判失败」的历史 bug）
  MOCK_SUCCESS_SECS    默认成功所需秒数（默认 6）

用法：
  python3 scripts/mock_cdk_server.py --port 8899
  然后把平台配置 cdk_activation.base_url 设为 http://127.0.0.1:8899 ，api_key 设为 MOCK_API_KEY。
"""
from __future__ import annotations

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ----------------------------- 配置 ----------------------------- #
API_KEY = os.getenv("MOCK_API_KEY", "mock-key")
ENVELOPE_CODE = int(os.getenv("MOCK_ENVELOPE_CODE", "0"))
SUCCESS_SECS = float(os.getenv("MOCK_SUCCESS_SECS", "6"))
MAX_ITEMS = 100

# 各阶段时间线（秒）：[0,PENDING) 排队 / [PENDING,DISPATCH) 已派发 / [DISPATCH,RUNNING) 兑换中 / >=SUCCESS 终态
PENDING_SECS = 2.0
DISPATCH_SECS = 3.0
RUNNING_SECS = 4.0

DISPLAY = {
    "pending_dispatch": "等待兑换",
    "dispatched": "已派发",
    "running": "兑换中",
    "success": "兑换成功",
    "failed": "兑换失败",
    "timeout": "兑换超时",
    "cancelled": "已取消",
    "not_found": "未找到",
}
TERMINAL = {"success", "failed", "cancelled"}


def _now() -> float:
    return time.time()


def _mask(tok: str) -> str:
    tok = str(tok or "")
    return f"…{tok[-6:]}" if len(tok) > 6 else "…"


def _outcome_for(cdkey: str) -> str:
    """由 cdkey 关键字决定该任务的最终归宿。"""
    k = cdkey.upper()
    if any(s in k for s in ("INVALID", "BAD", "NOTFOUND")):
        return "invalid"          # 提交即 not_found
    if "FAIL" in k:
        return "failed"
    if "TIMEOUT" in k:
        return "timeout"          # 永远停在 running
    return "success"


class Store:
    """内存任务表：cdkey → job。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict] = {}
        self._seq = 0

    def submit(self, cdkey: str, access_token: str) -> dict:
        with self._lock:
            outcome = _outcome_for(cdkey)
            self._seq += 1
            job = {
                "cdkey": cdkey,
                "access_token": access_token,
                "task_id": f"job_{self._seq:06d}",
                "outcome": outcome,
                "submitted_at": _now(),
                "cancelled": False,
                "queue0": (self._seq % 4) + 1,  # 初始排队人数 1..4，随时间递减
            }
            self._jobs[cdkey] = job
            return self._view(job)

    def status(self, cdkey: str) -> dict:
        with self._lock:
            job = self._jobs.get(cdkey)
            if job is None:
                return self._not_found(cdkey)
            return self._view(job)

    def cancel(self, cdkey: str) -> dict:
        with self._lock:
            job = self._jobs.get(cdkey)
            if job is None:
                return {"cdkey": cdkey, "found": False, "cancelled": False, "reason": "not_found"}
            st = self._compute(job)
            if st in TERMINAL or st == "timeout":
                return {"cdkey": cdkey, "found": True, "cancelled": False, "reason": f"不可取消（当前 {st}）"}
            job["cancelled"] = True
            return {"cdkey": cdkey, "found": True, "cancelled": True, "reason": ""}

    def retry(self, cdkey: str) -> dict:
        with self._lock:
            job = self._jobs.get(cdkey)
            if job is None:
                return {"cdkey": cdkey, "found": False, "retried": False, "reason": "not_found"}
            st = self._compute(job)
            if st not in ("failed", "cancelled", "timeout"):
                return {"cdkey": cdkey, "found": True, "retried": False, "reason": f"当前 {st} 不可重试"}
            if not job.get("access_token"):
                return {"cdkey": cdkey, "found": True, "retried": False, "reason": "无绑定 access_token，请重新提交"}
            job["cancelled"] = False
            job["submitted_at"] = _now()
            if job["outcome"] in ("failed", "invalid"):
                job["outcome"] = "success"  # 重试给一次成功机会，便于验证流程闭环
            return {"cdkey": cdkey, "found": True, "retried": True, "reason": ""}

    # ---- 内部 ---- #
    def _compute(self, job: dict) -> str:
        if job["cancelled"]:
            return "cancelled"
        outcome = job["outcome"]
        if outcome == "invalid":
            return "not_found"
        e = _now() - job["submitted_at"]
        terminal_at = SUCCESS_SECS if "SLOW" not in job["cdkey"].upper() else SUCCESS_SECS + 6
        if e < PENDING_SECS:
            return "pending_dispatch"
        if e < DISPATCH_SECS:
            return "dispatched"
        if e < RUNNING_SECS:
            return "running"
        if outcome == "timeout":
            return "running"  # 永不终态
        if e < terminal_at:
            return "running"
        return outcome  # success / failed

    def _view(self, job: dict) -> dict:
        st = self._compute(job)
        e = _now() - job["submitted_at"]
        queue_ahead = max(0, job["queue0"] - int(e)) if st == "pending_dispatch" else 0
        has_tok = bool(job.get("access_token"))
        can_cancel = st in ("pending_dispatch", "dispatched", "running")
        can_retry = st in ("failed", "cancelled", "timeout")
        return {
            "cdkey": job["cdkey"],
            "found": True,
            "status": st,
            "display_status": DISPLAY.get(st, st),
            "task_id": job["task_id"],
            "queue_ahead": queue_ahead,
            "has_access_token": has_tok,
            "can_cancel": can_cancel,
            "can_retry": can_retry,
            "can_reuse_token": has_tok,
        }

    @staticmethod
    def _not_found(cdkey: str) -> dict:
        return {
            "cdkey": cdkey,
            "found": False,
            "status": "not_found",
            "display_status": DISPLAY["not_found"],
            "task_id": "",
            "queue_ahead": 0,
            "has_access_token": False,
            "can_cancel": False,
            "can_retry": False,
            "can_reuse_token": False,
        }


STORE = Store()


class Handler(BaseHTTPRequestHandler):
    server_version = "mock-cdk/1.0"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # 精简访问日志（不打印任何 access_token / api key 明文）。
        print(f"[mock-cdk] {self.address_string()} {fmt % args}", flush=True)

    # ---- 工具 ---- #
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)  # 业务错误也用 HTTP 200 + 信封 code，贴近真实网关风格
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _envelope(self, items: list[dict], code: int | None = None, message: str = "ok") -> None:
        self._send(200, {"code": ENVELOPE_CODE if code is None else code, "message": message, "data": {"items": items}})

    def _error_envelope(self, code: int, message: str) -> None:
        self._send(200, {"code": code, "message": message, "data": {"items": []}})

    def _read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return None

    def _auth_ok(self) -> bool:
        return (self.headers.get("X-External-Api-Key") or "") == API_KEY

    # ---- 路由 ---- #
    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/")
        if not self._auth_ok():
            self.send_response(401)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"code": 401, "message": "invalid X-External-Api-Key", "data": {"items": []}}, ensure_ascii=False).encode())
            return
        body = self._read_json()
        if body is None:
            self._error_envelope(400, "invalid json body")
            return

        if path == "/api/external/cdkey-redeems":
            self._handle_submit(body)
        elif path == "/api/external/cdkey-redeems/status":
            self._handle_status(body)
        elif path == "/api/external/cdkey-jobs/cancel":
            self._handle_job(body, "cancel")
        elif path == "/api/external/cdkey-jobs/retry":
            self._handle_job(body, "retry")
        else:
            self._error_envelope(404, f"unknown path {path}")

    def _handle_submit(self, body: dict) -> None:
        items = body.get("items")
        if not isinstance(items, list) or not items:
            self._error_envelope(400, "items is required")
            return
        if len(items) > MAX_ITEMS:
            self._error_envelope(400, f"最多 {MAX_ITEMS} 条")
            return
        seen: set[str] = set()
        out: list[dict] = []
        for it in items:
            cdkey = str((it or {}).get("cdkey") or "").strip()
            token = str((it or {}).get("access_token") or "").strip()
            if not cdkey or not token:
                out.append({"cdkey": cdkey, "found": False, "status": "failed", "display_status": "cdkey / access_token 不能为空", "task_id": "", "queue_ahead": 0})
                continue
            if cdkey in seen:
                out.append({"cdkey": cdkey, "found": False, "status": "failed", "display_status": "同一请求内 cdkey 重复", "task_id": "", "queue_ahead": 0})
                continue
            seen.add(cdkey)
            view = STORE.submit(cdkey, token)
            out.append(view)
            print(f"[mock-cdk] submit cdkey={cdkey} token={_mask(token)} → outcome={_outcome_for(cdkey)} status={view['status']}", flush=True)
        self._envelope(out)

    def _handle_status(self, body: dict) -> None:
        cdkeys = body.get("cdkeys")
        if not isinstance(cdkeys, list) or not cdkeys:
            self._error_envelope(400, "cdkeys is required")
            return
        if len(cdkeys) > MAX_ITEMS:
            self._error_envelope(400, f"最多 {MAX_ITEMS} 条")
            return
        out = [STORE.status(str(c or "").strip()) for c in cdkeys]
        for v in out:
            print(f"[mock-cdk] status cdkey={v['cdkey']} → {v['status']}", flush=True)
        self._envelope(out)

    def _handle_job(self, body: dict, action: str) -> None:
        cdkeys = body.get("cdkeys")
        if not isinstance(cdkeys, list) or not cdkeys:
            self._error_envelope(400, "cdkeys is required")
            return
        fn = STORE.cancel if action == "cancel" else STORE.retry
        out = [fn(str(c or "").strip()) for c in cdkeys]
        for v in out:
            print(f"[mock-cdk] {action} cdkey={v['cdkey']} → {v}", flush=True)
        self._envelope(out)


def main() -> None:
    ap = argparse.ArgumentParser(description="本地 Mock CDK 兑换服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8899)
    args = ap.parse_args()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        f"[mock-cdk] listening on http://{args.host}:{args.port}\n"
        f"[mock-cdk] X-External-Api-Key = {API_KEY!r} | envelope code = {ENVELOPE_CODE} | success in ~{SUCCESS_SECS}s\n"
        f"[mock-cdk] 把平台配置 cdk_activation.base_url 设为 http://{args.host}:{args.port} ，api_key 设为 {API_KEY!r}\n"
        f"[mock-cdk] cdkey 关键字：INVALID/BAD→not_found，FAIL→失败，TIMEOUT→卡住，SLOW→慢成功，其它→成功",
        flush=True,
    )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("[mock-cdk] shutting down", flush=True)
        srv.shutdown()


if __name__ == "__main__":
    main()
