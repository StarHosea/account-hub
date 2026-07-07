"""插件池收码：按取码 URL 直连拉取并提取验证码（不走代理）。"""
from __future__ import annotations

import time
import urllib.error
import urllib.request

from services.pool_mail_extract import extract_verification_code, is_no_mail_response

DEFAULT_TIMEOUT_S = 15.0
DEFAULT_ATTEMPTS = 8
DEFAULT_INTERVAL_S = 3.0


def _fetch_once(code_url: str, *, timeout_s: float) -> str:
    separator = "&" if "?" in code_url else "?"
    url = f"{code_url}{separator}_t={int(time.time() * 1000)}"
    request = urllib.request.Request(
        url,
        headers={
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Accept": "application/json, text/plain, */*",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_verification_code(
    code_url: str,
    *,
    exclude: list[str] | None = None,
    attempts: int = DEFAULT_ATTEMPTS,
    interval_s: float = DEFAULT_INTERVAL_S,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> tuple[str, str]:
    """返回 (code, error)。code 非空即成功。"""
    code_url = str(code_url or "").strip()
    if not code_url.lower().startswith("http"):
        return "", "无效的取码 URL"

    last_error = "未获取到验证码"
    for _ in range(max(1, attempts)):
        try:
            text = _fetch_once(code_url, timeout_s=timeout_s)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = f"取码请求失败：{exc}"
            time.sleep(interval_s)
            continue
        if is_no_mail_response(text):
            time.sleep(interval_s)
            continue
        code = extract_verification_code(text, exclude=exclude)
        if code:
            return code, ""
        time.sleep(interval_s)
    return "", last_error
