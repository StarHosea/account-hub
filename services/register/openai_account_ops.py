"""老账号维护的浏览器 UI 操作（无协议）。

注册之后「刷新 / 重登」拿新 access_token 不再走 HTTP OAuth（authorize / password-verify /
oauth-token），而是复用注册用的 node_engine 浏览器引擎：spawn worker.js（mode='login'）→
loginChatGPT 用账号存的 password + totp 在真实浏览器里登录取新 token。

- 验证码从账号「自己绑定的邮箱」取（mailbox_service.get_fetch_url），不是注册用的邮箱池。
- 代理复用账号专属出口（号一号一 IP），转成 Chromium 可用的 http(s):// 形式。
- 复用 openai_register 的 config / _spawn_worker / NDJSON 泵原语，保持与注册同一套引擎与生命周期管理。
"""
from __future__ import annotations

import json
import threading

from urllib.parse import quote, unquote

from services.register import mail_provider
from services.register import mail_code
from services.register import openai_register as reg
from services.register.fingerprint import parse_proxy, browser_locale_for_region

# 浏览器登录很重（每次起一个浏览器几秒），批量刷新时限全局并发，避免同时起几十个浏览器打爆机器。
# 与注册线程池相互独立；如需调整改这里即可。
_LOGIN_CONCURRENCY = 2
_login_sem = threading.Semaphore(_LOGIN_CONCURRENCY)


def _to_browser_proxy(raw: str) -> str:
    """把账号专属代理转成 Chromium 可用的 http(s):// URL（带认证 SOCKS5 → 强制 http）。

    与 openai_register._browser_proxy_url 同源逻辑，但不写注册进度表（无任务号）。
    """
    if not raw:
        return ""
    parsed = parse_proxy(raw, default_scheme="http")
    if parsed is None:
        return ""
    scheme = (parsed.scheme or "http").lower()
    if scheme.startswith("socks") or scheme not in ("http", "https"):
        scheme = "http"
    user = quote(unquote(parsed.user), safe="") if parsed.user else ""
    pwd = quote(unquote(parsed.password), safe="") if parsed.password else ""
    auth = f"{user}:{pwd}@" if user else ""
    return f"{scheme}://{auth}{parsed.host}:{parsed.port}"


def _account_mail_ctx(email: str):
    """账号自己绑定邮箱的取码上下文；无绑定邮箱返回 (None, None)。"""
    try:
        from services.mailbox_service import mailbox_service
    except Exception:
        return None, None
    fetch_url = mailbox_service.get_fetch_url(email)
    if not fetch_url:
        return None, None
    mail_config = {
        "request_timeout": 30,
        "wait_timeout": 300,
        "wait_interval": 3,
        "providers": [{"type": mail_provider.API_MAILBOX_TYPE, "enable": True}],
        "proxy": "",
    }
    mailbox = {"provider": mail_provider.API_MAILBOX_TYPE, "address": email, "fetch_url": fetch_url}
    return mail_config, mailbox


def run_browser_login(
    email: str,
    password: str,
    *,
    totp_secret: str = "",
    account_proxy: str = "",
    locale: str = "",
    country: str = "",
    log=lambda *_: None,
) -> dict:
    """用浏览器 UI 登录老账号取新 token（刷新 / 重登主流程）。

    loginChatGPT 内部：有密码走密码登录；密码错 / 无密码走邮箱 OTP / 忘记密码重设兜底；
    账号已开 2FA 时用 totp_secret 自动过验证器页。走了忘记密码时返回新密码（reset_password）。

    返回 {ok:True, access_token, reset_password, user, expires} 或 {ok:False, error}。
    """
    browser_proxy = _to_browser_proxy(account_proxy)
    timeout_s = int(reg.config.get("register_timeout") or 600)
    job = {
        "email": email,
        "proxyUrl": browser_proxy,
        "mode": "login",
        "loginPassword": password or "",
        "existingTotpSecret": totp_secret or "",
        "enable2fa": False,
        "headless": bool(reg.config.get("headless")),
        "chatgptUrl": reg.chatgpt_url,
        "timeoutMs": timeout_s * 1000,
        "locale": (locale or browser_locale_for_region(country) or "en-US"),
        "staticCache": reg.static_cache_job_options(),
    }
    job.update(reg.record_job_options())

    with _login_sem:
        return _drive_worker(job, mail_config, mailbox, log)


def _drive_worker(job: dict, mail_config, mailbox, log) -> dict:
    timeout_s = int(reg.config.get("register_timeout") or 600)
    proc = reg._spawn_worker(job)
    with reg._active_lock:
        reg._active_procs.add(proc)

    watchdog = threading.Timer(timeout_s + 60, lambda: reg._terminate(proc))
    watchdog.daemon = True
    watchdog.start()

    data: dict | None = None
    err_msg: str | None = None
    try:
        for raw_line in proc.stdout:  # type: ignore[union-attr]
            line = raw_line.strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except Exception:
                continue
            etype = evt.get("type")
            if etype == "log":
                log(str(evt.get("message") or ""))
            elif etype == "need_code":
                purpose = str(evt.get("purpose") or "login")
                label = reg._code_purpose_label(purpose)
                log(f"正在等待{label}验证码…")
                code_result = None
                if mailbox:
                    code_result = mail_code.fulfill_need_code(
                        mail_config, mailbox, ts=evt.get("ts"), purpose=purpose,
                        use_mailbox_baseline=bool(evt.get("use_mailbox_baseline")),
                    )
                code = (code_result or {}).get("code") if code_result else None
                received_at = (code_result or {}).get("received_at") if code_result else None
                reg._send_line(proc, {"type": "code", "code": code or "", "received_at": received_at})
                if code:
                    log(f"收到{label}验证码：{code}")
                else:
                    log("等待验证码超时，邮箱中未收到新邮件")
            elif etype == "result":
                data = evt.get("data") or {}
                break
            elif etype == "error":
                err_msg = str(evt.get("message") or "登录失败")
                break
    except Exception as exc:  # noqa: BLE001
        err_msg = err_msg or f"读取引擎输出异常：{exc}"
    finally:
        watchdog.cancel()
        reg._terminate(proc)
        with reg._active_lock:
            reg._active_procs.discard(proc)

    if data and str(data.get("accessToken") or "").strip():
        return {
            "ok": True,
            "access_token": str(data.get("accessToken")).strip(),
            "reset_password": str(data.get("resetPassword") or ""),
            "user": data.get("user"),
            "expires": data.get("expires"),
        }
    return {"ok": False, "error": err_msg or "浏览器登录未返回 token"}
