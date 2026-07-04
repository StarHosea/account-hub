from __future__ import annotations

"""注册成功后的「试用资格」（资格号）检测。

接口对齐参考项目 upi-redeem-only-extension（background/steps/upi-redeem.js 的
`/api/v1/check` 优惠资格验证）：

- 端点：POST {base_url}/api/v1/check
- 请求头：Content-Type: application/json（该端点无需鉴权；若配置了 api_key，
  作为 X-External-Api-Key 一并带上，后端可忽略）
- 请求体：{"token": "<accessToken>"}
- 响应：结果条目可能在顶层、data、items[] 或 data.items[]；关键字段：
    token_ok / tokenOk / ok  —— access_token 是否有效
    eligible                 —— 账号是否有（试用/优惠）资格 ← 资格号判定
    upi_eligible / upiEligible（可选）—— 是否满足 UPI 兑换资格
    message / reason         —— 原因文案

判定映射到 {"eligible": bool|None, "reason": str}：
- token_ok=false          → eligible=None（token 未被后端认可，未知，fail-open 保号，记录原因）
- token_ok=true & eligible=false（或 upi_eligible 明确为 false）→ eligible=False（无资格，入异常清单）
- 其它                    → eligible=True（合格，入号池）
- 未启用 / base_url 为空   → eligible=True（不校验，全部入池）
- 网络/解析异常/非200且无法解析结果 → eligible=None（fail-open，记录 reason）
"""

import re
from typing import Any

from services.config import config

DEFAULT_CHECK_PATH = "/api/v1/check"
# 已知会被 base_url 误带上的后缀，归一化时剥掉，避免出现 .../api/v1/check/api/v1/check
_STRIP_SUFFIXES = (
    "/api/v1/check",
    "/api/v1/subscription",
    "/api/v1/totp/enable",
    "/api/v1/totp/lookup",
    "/api",
)


def _normalize_base_url(raw: str) -> str:
    url = str(raw or "").strip()
    url = re.sub(r"#.*$", "", url).rstrip("/")
    for suffix in _STRIP_SUFFIXES:
        if url.lower().endswith(suffix):
            url = url[: -len(suffix)]
            break
    return url.rstrip("/")


def _as_bool(value: Any, default: bool | None = None) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("1", "true", "yes", "y", "ok"):
            return True
        if low in ("0", "false", "no", "n"):
            return False
    return default


def _payload_items(payload: Any) -> list:
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            return data["items"]
        if isinstance(payload.get("items"), list):
            return payload["items"]
        if isinstance(data, list):
            return data
    return []


def _looks_like_eligibility_item(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    for key in ("token_ok", "tokenOk", "ok", "eligible", "upi_eligible", "upiEligible"):
        if key in value:
            return True
    return bool(str(value.get("reason") or "").strip())


def _pick_item(payload: Any) -> dict | None:
    items = _payload_items(payload)
    if items and isinstance(items[0], dict):
        return items[0]
    if _looks_like_eligibility_item(payload):
        return payload
    if isinstance(payload, dict) and _looks_like_eligibility_item(payload.get("data")):
        return payload["data"]
    return None


def _reason_of(item: dict, default: str) -> str:
    for key in ("message", "reason", "error", "detail"):
        val = item.get(key)
        if val:
            return str(val)[:200]
    return default


def _judge(item: dict) -> dict:
    token_ok = _as_bool(item.get("token_ok", item.get("tokenOk", item.get("ok"))), default=None)
    if token_ok is False:
        return {"eligible": None, "reason": f"trial_check_token_invalid:{_reason_of(item, 'access_token 无效或已过期')}"}

    eligible = _as_bool(item.get("eligible"), default=None)
    if eligible is False:
        return {"eligible": False, "reason": _reason_of(item, "账号无试用资格")}

    upi_raw = item.get("upi_eligible", item.get("upiEligible"))
    if upi_raw is not None and _as_bool(upi_raw) is False:
        return {"eligible": False, "reason": _reason_of(item, "账号不满足 UPI 兑换资格")}

    # token_ok 为真/未知，且未命中不合格 → 视为合格
    return {"eligible": True, "reason": _reason_of(item, "eligible")}


def check_eligibility(access_token: str, email: str = "") -> dict:
    """检测试用资格（资格号）。返回 {"eligible": bool|None, "reason": str}。"""
    cfg = config.trial_check
    if not cfg.get("enabled") or not cfg.get("base_url"):
        return {"eligible": True, "reason": "trial_check_disabled"}

    token = str(access_token or "").strip()
    if not token:
        return {"eligible": None, "reason": "trial_check_error:missing_access_token"}

    base_url = _normalize_base_url(cfg.get("base_url"))
    if not base_url:
        return {"eligible": True, "reason": "trial_check_disabled"}
    check_url = f"{base_url}{DEFAULT_CHECK_PATH}"

    headers = {"content-type": "application/json", "accept": "application/json"}
    api_key = str(cfg.get("api_key") or "").strip()
    if api_key:
        # /api/v1/check 本身无需鉴权；有则带上（后端可忽略），兼容需要网关鉴权的部署。
        headers["X-External-Api-Key"] = api_key

    try:
        from curl_cffi import requests

        resp = requests.post(check_url, headers=headers, json={"token": token}, timeout=30, verify=False)
        status = getattr(resp, "status_code", 0)
        try:
            payload = resp.json()
        except Exception:
            payload = None
        # 非 200：若响应体仍是可解析的资格结果就用它，否则按未知处理
        if status != 200:
            item = _pick_item(payload)
            if item is not None:
                return _judge(item)
            body = str(getattr(resp, "text", "") or "")[:200]
            return {"eligible": None, "reason": f"trial_check_error:http_{status}:{body}"}
    except Exception as exc:  # noqa: BLE001
        return {"eligible": None, "reason": f"trial_check_error:{exc}"}

    item = _pick_item(payload)
    if item is None:
        return {"eligible": None, "reason": "trial_check_error:unparsable_response"}
    return _judge(item)
