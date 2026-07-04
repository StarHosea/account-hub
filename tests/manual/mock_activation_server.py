#!/usr/bin/env python3
"""激活兑换 mock 服务：顶替真实 OpenAI CDK 兑换端点，供本地测试激活链路与 CDK 回收。

顶替对象：services/cdk_redeem_client.py 里的两个端点
- POST /api/external/cdkey-redeems         (submit)  body: {"items":[{"cdkey","access_token"}]}
- POST /api/external/cdkey-redeems/status  (status)  body: {"cdkeys":[...]}
鉴权：请求头 X-External-Api-Key，须与 --api-key 一致（默认 mock-key），否则 401（触发 AuthError）。
响应信封：{"code":0,"data":{"items":[{"cdkey","status","task_id","queue_ahead","message"}]}}

按 CDK 前缀切换结果（覆盖激活各分支）：
- TEST-OK-*    → success（一次成功）
- TEST-PEND-*  → 前 N 次 pending，之后 success（测排队轮询）
- TEST-BAD-*   → not_found（CDK 无效，激活换下一个，cdk_service.mark_invalid）
- TEST-FAIL-*  → failed（计一次失败尝试，CDK 仍可用）
- TEST-STUCK-* → 永远 pending（僵尸占用：测轮询超时 / CDK reaper 回收）
- 其它         → 由 --default 决定（默认 success）

用法：
  .venv/bin/python tests/manual/mock_activation_server.py            # 默认 127.0.0.1:8899 mock-key
  .venv/bin/python tests/manual/mock_activation_server.py --pending 3 --default success
"""
from __future__ import annotations

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SUBMIT_PATH = "/api/external/cdkey-redeems"
STATUS_PATH = "/api/external/cdkey-redeems/status"

# 每个 CDK 已被轮询/提交的次数（用于 TEST-PEND 的 pending→success 过渡）
_seen: dict[str, int] = {}
_seen_lock = threading.Lock()

_ARGS: argparse.Namespace  # 运行参数，main 里赋值


def _bump(cdk: str) -> int:
    with _seen_lock:
        _seen[cdk] = _seen.get(cdk, 0) + 1
        return _seen[cdk]


def _status_for(cdk: str) -> tuple[str, str]:
    """返回 (status, message)。status 用 cdk_redeem_client.classify 认得的词。"""
    u = cdk.upper()
    if u.startswith("TEST-OK"):
        return "success", "mock success"
    if u.startswith("TEST-PEND"):
        n = _bump(cdk)
        if n > int(_ARGS.pending):
            return "success", f"mock success after {n} polls"
        return "pending", f"queued (poll {n}/{_ARGS.pending})"
    if u.startswith("TEST-BAD"):
        return "not_found", "mock cdk not found"
    if u.startswith("TEST-FAIL"):
        return "failed", "mock redeem failed"
    if u.startswith("TEST-STUCK"):
        return "pending", "mock stuck forever (zombie)"
    return str(_ARGS.default), f"mock default={_ARGS.default}"


def _item(cdk: str) -> dict:
    status, message = _status_for(cdk)
    return {
        "cdkey": cdk,
        "status": status,
        "task_id": f"mock-task-{abs(hash(cdk)) % 100000}",
        "queue_ahead": 0 if status != "pending" else 1,
        "message": message,
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return {}

    def _auth_ok(self) -> bool:
        return (self.headers.get("X-External-Api-Key") or "") == _ARGS.api_key

    def do_POST(self) -> None:  # noqa: N802
        if not self._auth_ok():
            self._send(401, {"code": 401, "message": "invalid X-External-Api-Key"})
            return
        body = self._read_json()
        if self.path.rstrip("/") == SUBMIT_PATH:
            items = body.get("items") or []
            cdks = [str(it.get("cdkey") or "").strip() for it in items if isinstance(it, dict)]
        elif self.path.rstrip("/") == STATUS_PATH:
            cdks = [str(c).strip() for c in (body.get("cdkeys") or [])]
        else:
            self._send(404, {"code": 404, "message": "unknown path"})
            return
        result_items = [_item(c) for c in cdks if c]
        self._send(200, {"code": 0, "message": "ok", "data": {"items": result_items}})

    def log_message(self, fmt, *args) -> None:  # 精简日志：打一行便于观察
        try:
            print(f"[mock] {self.command} {self.path} -> {fmt % args}")
        except Exception:
            pass


def main() -> None:
    global _ARGS
    ap = argparse.ArgumentParser(description="激活兑换 mock 服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--api-key", default="mock-key", help="须与 settings.json cdk_activation.api_key 一致")
    ap.add_argument("--pending", type=int, default=3, help="TEST-PEND 前多少次返回 pending")
    ap.add_argument("--default", default="success", choices=["success", "failed", "not_found", "pending"],
                    help="非 TEST-* 前缀 CDK 的默认结果")
    _ARGS = ap.parse_args()
    srv = ThreadingHTTPServer((_ARGS.host, _ARGS.port), Handler)
    print(f"[mock] listening on http://{_ARGS.host}:{_ARGS.port}  api-key={_ARGS.api_key}  "
          f"default={_ARGS.default}  pending={_ARGS.pending}")
    print(f"[mock] endpoints: POST {SUBMIT_PATH} | POST {STATUS_PATH}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[mock] shutting down")
        srv.shutdown()


if __name__ == "__main__":
    main()
