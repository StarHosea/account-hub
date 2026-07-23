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
    "failed", "fail", "error", "rejected", "invalid",
    "token-invalidated", "token_invalidated", "token-invalid", "invalidated",
    "access-token-invalid", "access_token_invalid",
}
# timeout：服务端「兑换超时/仍在处理」的独立终态。不当失败——对同一张 CDK 走
# /cdkey-jobs/retry 重入列继续等（不计失败次数）。详见 activation_service 单卡重试循环。
STATUS_TIMEOUT = {"timeout"}
# cancelled：任务已取消。retry 接口不可复用（文档要求改用提交接口重新 submit 同卡）。
STATUS_CANCELLED = {"cancelled", "canceled"}
STATUS_CDK_INVALID = {"not_found", "notfound"}
STATUS_PENDING = {"pending_dispatch", "dispatched", "running", "queued", "processing", "pending", "waiting"}

SUBMIT_PATH = "/api/external/cdkey-redeems"
STATUS_PATH = "/api/external/cdkey-redeems/status"
# 任务接口：取消/重试走 /cdkey-jobs（与提交/查询的 /cdkey-redeems 路径不同，同一把 API Key）。
JOBS_RETRY_PATH = "/api/external/cdkey-jobs/retry"
JOBS_CANCEL_PATH = "/api/external/cdkey-jobs/cancel"

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
    """状态字符串 → success / timeout / cancelled / fail / cdk_invalid / pending / unknown。"""
    st = (status or "").strip().lower()
    if st in STATUS_SUCCESS:
        return "success"
    if st in STATUS_TIMEOUT:
        return "timeout"
    if st in STATUS_CANCELLED:
        return "cancelled"
    if st in STATUS_FAIL:
        return "fail"
    if st in STATUS_CDK_INVALID:
        return "cdk_invalid"
    if st in STATUS_PENDING:
        return "pending"
    return "unknown"


# 「CDK 已被使用/已提供」类失败文案：该卡已被服务端核销给某账号，重试同卡永远失败，
# 应立即标记 CDK 异常并换下一张（不计入账号失败次数——是卡的问题，不是账号的问题）。
_CDK_USED_HINTS = (
    "已提供",
    "已被使用",
    "已使用",
    "已兑换",
    "已被兑换",
    "already provided",
    "already used",
    "already redeemed",
    "already exchanged",
)


def is_cdk_used_error(message: str, status: str = "") -> bool:
    text = f"{message or ''} {status or ''}".strip().lower()
    if not text:
        return False
    return any(hint in text for hint in _CDK_USED_HINTS)


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


def _item_cdk_value(it: dict) -> str | None:
    for key in ("cdkey", "cdk", "cdkey_code", "code"):
        if it.get(key):
            return str(it.get(key))
    return None


def item_for_cdk(js: object, cdk: str) -> dict | None:
    items = items_of(js)
    for it in items:
        if isinstance(it, dict) and _item_cdk_value(it) == cdk:
            return it
    # 单条兜底：仅当该条**未回显 cdkey**（服务端省略字段）时才视为本卡结果。
    # 若明确带了别的 cdkey（如服务端返回该账号已存在的另一张卡的任务），绝不能当成
    # 本卡状态——否则会把别的卡的 success 记到当前卡上，consume 错卡、账号与 CDK 错配。
    if len(items) == 1 and isinstance(items[0], dict) and _item_cdk_value(items[0]) is None:
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


def item_retried(it: object) -> bool:
    """/cdkey-jobs/retry 逐条结果：本次是否成功重新入列。"""
    return bool(isinstance(it, dict) and it.get("retried"))


def item_found(it: object) -> bool:
    """/cdkey-jobs/* 逐条结果：是否找到该任务。"""
    return bool(isinstance(it, dict) and it.get("found"))


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


class NetworkError(RedeemError):
    """网络类失败：连接异常 / 超时 / HTTP 5xx / 429 / 4xx(非401,403) / 响应非预期。

    语义 = 「没能从接口拿到可信的业务结果，可重试」。重试策略由激活层统一负责
    （固定间隔 + 有限次数 + 不计入激活尝试次数），本层只做一次请求并分类，不自行重试。
    """


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
            "User-Agent": "account-hub-cdk/1.0",
        }

    def _emit_exchange(self, exchange_cb, meta: dict) -> None:
        if not exchange_cb:
            return
        try:
            exchange_cb(meta)
        except Exception:
            pass

    @staticmethod
    def _parse_response(text: str) -> dict | list | str | None:
        if not text:
            return None
        try:
            return json.loads(text)
        except Exception:
            return {"_raw": text}

    def _request(self, method: str, path: str, body: dict | None = None, exchange_cb=None) -> dict | None:
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
                will_retry = attempt < NET_RETRIES
                self._emit_exchange(exchange_cb, {
                    "method": method,
                    "path": path,
                    "url": url,
                    "request": body,
                    "http_status": None,
                    "response": None,
                    "error": scrub(exc),
                    "attempt": attempt + 1,
                    "retrying": will_retry,
                })
                if will_retry:
                    time.sleep((BACKOFF_BASE ** attempt) + random.random())
                    continue
                raise RedeemError(scrub(exc))
            if status in (401, 403):
                self._emit_exchange(exchange_cb, {
                    "method": method,
                    "path": path,
                    "url": url,
                    "request": body,
                    "http_status": status,
                    "response": self._parse_response(text),
                    "error": f"鉴权失败 HTTP {status}",
                    "attempt": attempt + 1,
                })
                raise AuthError(f"鉴权失败 HTTP {status}（X-External-Api-Key 可能无效）")
            if status == 429 or 500 <= status < 600:
                last_err = f"HTTP {status}"
                will_retry = attempt < NET_RETRIES
                self._emit_exchange(exchange_cb, {
                    "method": method,
                    "path": path,
                    "url": url,
                    "request": body,
                    "http_status": status,
                    "response": self._parse_response(text),
                    "error": str(last_err),
                    "attempt": attempt + 1,
                    "retrying": will_retry,
                })
                if will_retry:
                    retry_after = headers.get("Retry-After") or headers.get("retry-after")
                    try:
                        sleep_s = float(retry_after) if retry_after else (BACKOFF_BASE ** attempt) + random.random()
                    except Exception:
                        sleep_s = (BACKOFF_BASE ** attempt) + random.random()
                    time.sleep(sleep_s)
                    continue
            parsed = self._parse_response(text)
            self._emit_exchange(exchange_cb, {
                "method": method,
                "path": path,
                "url": url,
                "request": body,
                "http_status": status,
                "response": parsed,
                "attempt": attempt + 1,
            })
            if isinstance(parsed, dict) or parsed is None:
                return parsed if isinstance(parsed, dict) else None
            return None
        self._emit_exchange(exchange_cb, {
            "method": method,
            "path": path,
            "url": url,
            "request": body,
            "http_status": None,
            "response": None,
            "error": scrub(last_err),
            "attempt": NET_RETRIES + 1,
        })
        raise RedeemError(scrub(last_err))

    # ----------------------------- 接口封装 ----------------------------- #

    def submit(self, cdk: str, access_token: str, exchange_cb=None) -> dict | None:
        body = {"items": [{"cdkey": cdk.strip(), "access_token": access_token.strip()}]}
        return self._request("POST", SUBMIT_PATH, body, exchange_cb=exchange_cb)

    def query_status(self, cdks: list[str], exchange_cb=None) -> dict | None:
        body = {"cdkeys": [c.strip() for c in cdks]}
        return self._request("POST", STATUS_PATH, body, exchange_cb=exchange_cb)

    def retry(self, cdks: list[str], exchange_cb=None) -> dict | None:
        """重试任务：一键复用已绑定的 access_token 重新入列（POST /cdkey-jobs/retry）。

        用于 timeout / failed 时对**同一张 CDK** 原地重试，不换新卡、不重占 access_token。
        逐条结果在 data.items（found / retried / reason）；retried=false（如任务已取消/不可操作）
        时调用方应回退为重新 submit 同卡。
        """
        body = {"cdkeys": [c.strip() for c in cdks]}
        return self._request("POST", JOBS_RETRY_PATH, body, exchange_cb=exchange_cb)

    def cancel(self, cdks: list[str], exchange_cb=None) -> dict | None:
        """取消任务（POST /cdkey-jobs/cancel）。逐条结果在 data.items（found / cancelled / reason）。"""
        body = {"cdkeys": [c.strip() for c in cdks]}
        return self._request("POST", JOBS_CANCEL_PATH, body, exchange_cb=exchange_cb)

    def close(self) -> None:
        try:
            self._session.close()
        except Exception:
            pass
