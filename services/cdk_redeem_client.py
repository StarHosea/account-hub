from __future__ import annotations

import json
import random
import re
import threading
import time

from curl_cffi import requests

# ----------------------------- 状态分类（移植自参考脚本 redeem.py，大小写不敏感） ----------------------------- #
STATUS_SUCCESS = {"success", "succeeded", "completed", "complete", "ok"}
STATUS_FAIL = {
    "failed", "fail", "timeout", "error", "rejected", "invalid",
    "token-invalidated", "token_invalidated", "token-invalid", "invalidated",
    "access-token-invalid", "access_token_invalid", "cancelled", "canceled",
}
STATUS_CDK_INVALID = {"not_found", "notfound"}
STATUS_PENDING = {"pending_dispatch", "dispatched", "running", "queued", "processing", "pending", "waiting"}

SUBMIT_PATH = "/api/external/cdkey-redeems"
STATUS_PATH = "/api/external/cdkey-redeems/status"

NET_RETRIES = 3
BACKOFF_BASE = 1.5
REQUEST_GAP = 0.4
REQUEST_JITTER = 0.6

# JWT 形态串一律打码，防止 access_token 通过日志/异常意外泄露。
_SCRUB_JWT = re.compile(r"eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}")


def scrub(text: object) -> str:
    if not text:
        return ""
    return _SCRUB_JWT.sub("eyJ***REDACTED***", str(text))


def classify(status: str) -> str:
    """状态字符串 → success / fail / cdk_invalid / pending / unknown。"""
    st = (status or "").strip().lower()
    if st in STATUS_SUCCESS:
        return "success"
    if st in STATUS_FAIL:
        return "fail"
    if st in STATUS_CDK_INVALID:
        return "cdk_invalid"
    if st in STATUS_PENDING:
        return "pending"
    return "unknown"


def _as_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    return None


def items_of(js: object) -> list:
    if isinstance(js, dict):
        data = js.get("data")
        if isinstance(data, dict):
            for key in ("items", "results", "list"):
                if isinstance(data.get(key), list):
                    return data[key]
        for key in ("items", "results", "list"):
            if isinstance(js.get(key), list):
                return js[key]
        if any(k in js for k in ("cdkey", "status")):
            return [js]
    return []


def item_for_cdk(js: object, cdk: str) -> dict | None:
    items = items_of(js)
    for it in items:
        if isinstance(it, dict):
            c = it.get("cdkey") or it.get("cdk") or it.get("cdkey_code") or it.get("code")
            if c == cdk:
                return it
    if len(items) == 1 and isinstance(items[0], dict):
        return items[0]
    return None


def item_status(it: object) -> str:
    if not isinstance(it, dict):
        return ""
    return str(it.get("status") or it.get("state") or "").strip().lower()


def item_message(it: object) -> str:
    if not isinstance(it, dict):
        return ""
    for key in ("display_status", "message", "msg", "reason", "error", "detail"):
        if it.get(key):
            return str(it.get(key))
    return ""


def item_task_id(it: object) -> str:
    if not isinstance(it, dict):
        return ""
    for key in ("task_id", "taskId", "task", "id"):
        if it.get(key):
            return str(it.get(key))
    return ""


def queue_ahead(it: object) -> int | None:
    """排队进度：前方还有多少人。真实字段为 queue_ahead，并对常见别名兜底。"""
    if not isinstance(it, dict):
        return None
    n = _as_int(it.get("queue_ahead"))
    if n is not None:
        return n
    for key in ("queue_ahead_count", "ahead_count", "ahead", "people_ahead", "queue_position", "position", "rank", "queue_index", "queue_no"):
        n = _as_int(it.get(key))
        if n is not None:
            return n
    return None


def env_code(js: object):
    if isinstance(js, dict) and "code" in js:
        return _as_int(js.get("code"))
    return None


def env_msg(js: object) -> str:
    if isinstance(js, dict):
        return str(js.get("message") or js.get("msg") or "")
    return ""


class RedeemError(Exception):
    pass


class AuthError(RedeemError):
    """鉴权失败(401/403)：API Key 无效，应立即停止整轮，避免无意义消耗。"""


class CdkRedeemClient:
    """CDK 兑换 HTTP 客户端（移植 redeem.py 的 HttpClient + RedeemApi 语义）。

    - 注入 X-External-Api-Key（绝不记录）。
    - 网络层指数退避重试（异常 / 5xx / 429）。
    - 全局限速（间隔 + 抖动）。
    - 401/403 抛 AuthError。
    """

    def __init__(self, base_url: str, api_key: str, *, request_timeout: float = 30.0):
        self.base_url = str(base_url or "").rstrip("/")
        self._api_key = str(api_key or "")
        self._request_timeout = request_timeout
        self._session = requests.Session(impersonate="chrome", verify=False)
        self._rate_lock = threading.Lock()
        self._last_req_ts = 0.0

    def _rate_limit(self) -> None:
        with self._rate_lock:
            elapsed = time.time() - self._last_req_ts
            wait = REQUEST_GAP + random.random() * REQUEST_JITTER - elapsed
            if wait > 0:
                time.sleep(wait)
            self._last_req_ts = time.time()

    def _headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-External-Api-Key": self._api_key,
            "User-Agent": "chatgpt2api-cdk/1.0",
        }

    def _request(self, method: str, path: str, body: dict | None = None) -> dict | None:
        url = self.base_url + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        last_err: object = None
        for attempt in range(NET_RETRIES + 1):
            self._rate_limit()
            try:
                resp = self._session.request(method, url, data=data, headers=self._headers(), timeout=self._request_timeout)
                status = resp.status_code
                text = resp.text or ""
                headers = dict(resp.headers or {})
            except Exception as exc:  # 网络异常 → 退避重试
                last_err = exc
                if attempt < NET_RETRIES:
                    time.sleep((BACKOFF_BASE ** attempt) + random.random())
                    continue
                raise RedeemError(scrub(exc))
            if status in (401, 403):
                raise AuthError(f"鉴权失败 HTTP {status}（X-External-Api-Key 可能无效）")
            if status == 429 or 500 <= status < 600:
                last_err = f"HTTP {status}"
                if attempt < NET_RETRIES:
                    retry_after = headers.get("Retry-After") or headers.get("retry-after")
                    try:
                        sleep_s = float(retry_after) if retry_after else (BACKOFF_BASE ** attempt) + random.random()
                    except Exception:
                        sleep_s = (BACKOFF_BASE ** attempt) + random.random()
                    time.sleep(sleep_s)
                    continue
            try:
                return json.loads(text) if text else None
            except Exception:
                return None
        raise RedeemError(scrub(last_err))

    # ----------------------------- 接口封装 ----------------------------- #

    def submit(self, cdk: str, access_token: str) -> dict | None:
        body = {"items": [{"cdkey": cdk.strip(), "access_token": access_token.strip()}]}
        return self._request("POST", SUBMIT_PATH, body)

    def query_status(self, cdks: list[str]) -> dict | None:
        body = {"cdkeys": [c.strip() for c in cdks]}
        return self._request("POST", STATUS_PATH, body)

    def close(self) -> None:
        try:
            self._session.close()
        except Exception:
            pass
