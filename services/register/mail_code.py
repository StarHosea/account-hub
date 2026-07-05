"""注册/登录流程共用的邮箱验证码取码逻辑。

Node 引擎每次 requestCode 会通过 NDJSON 发出 need_code（含 ts）。本模块以该时刻
往前 FRESHNESS_BUFFER_SECONDS 秒作为时间截止线，只接受「邮件到达时间晚于截止线」的验证码，
避免抓到发码前残留在信箱里的旧码。取不到新码时持续轮询，直至 wait_timeout（默认 5 分钟）。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from services.register import mail_provider

# 请求取码时刻往前这么久的邮件一律视为旧码（发码动作与 requestCode 之间可能有数秒延迟）。
FRESHNESS_BUFFER_SECONDS = 10
DEFAULT_WAIT_TIMEOUT = 300.0
# 单次 need_code 轮询最长等待；超时后由页面点「重新发送」再发起下一轮 need_code。
ROUND_WAIT_TIMEOUT = 90.0

_CODE_PURPOSE_LABELS = {
    "register": "注册",
    "login": "登录",
    "password": "设密码",
    "2fa": "双重验证",
}


def purpose_label(purpose: str) -> str:
    return _CODE_PURPOSE_LABELS.get(str(purpose or "").strip().lower(), "验证")


def parse_request_ts(ts: str | None) -> datetime | None:
    """解析 need_code.ts（ISO-8601，通常为 UTC）。"""
    text = str(ts or "").strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def cutoff_from_request(ts: str | None, *, buffer_seconds: int = FRESHNESS_BUFFER_SECONDS) -> datetime | None:
    """由 need_code 请求时刻推算「可接受邮件」的最早到达时间。

    API 收件页解析出的时间为服务器本地朴素 datetime；将请求时刻转成本地朴素再减 buffer，
    以便与 provider 返回的 received_at 直接比较。
    """
    requested = parse_request_ts(ts)
    if requested is None:
        return None
    local = requested.astimezone().replace(tzinfo=None)
    return local - timedelta(seconds=buffer_seconds)


def mail_config_with_defaults(mail_config: dict | None) -> dict:
    conf = dict(mail_config or {})
    if not conf.get("wait_timeout"):
        conf["wait_timeout"] = DEFAULT_WAIT_TIMEOUT
    return conf


def fulfill_need_code(
    mail_config: dict | None,
    mailbox: dict | None,
    *,
    ts: str | None = None,
    purpose: str = "register",
    round_timeout: float | None = None,
) -> str | None:
    """响应一次 need_code：按请求时间过滤旧码并轮询取新验证码。

    每轮最长等待 round_timeout（默认 ROUND_WAIT_TIMEOUT 秒）。超时返回 None，
    由 Node 侧在页面上点「重新发送」后再发下一轮 need_code。
    """
    _ = purpose
    if not mailbox:
        return None
    conf = mail_config_with_defaults(mail_config)
    conf["wait_timeout"] = float(round_timeout if round_timeout is not None else ROUND_WAIT_TIMEOUT)
    after = cutoff_from_request(ts)
    return mail_provider.wait_for_code(conf, mailbox, after_received_at=after)
