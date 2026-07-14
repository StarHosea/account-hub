"""老账号维护的浏览器 UI 操作（无协议）。

注册之后「刷新 / 重登」拿新 access_token 不再走 HTTP OAuth（authorize / password-verify /
oauth-token），而是复用注册用的 node_engine 浏览器引擎：spawn worker.js →
在真实浏览器里恢复 session 或登录取新 token。

- session_refresh：注入 browser_session（cookies/localStorage）快路径，失败 fallback 密码登录
- login：完整密码登录（刷新 / 重登兜底）
- 验证码从账号「自己绑定的邮箱」取（mailbox_service.get_fetch_url），不是注册用的邮箱池。
- 代理复用账号专属出口（号一号一 IP），转成 CloakBrowser 可用的 socks5/http URL。
"""
from __future__ import annotations

import json
import threading
from typing import Any

from services.register import mail_provider
from services.register import mail_code
from services.register import openai_register as reg
from services.register.fingerprint import browser_proxy_url, browser_locale_for_region

# 浏览器登录很重（每次起一个浏览器几秒），批量刷新时限全局并发，避免同时起几十个浏览器打爆机器。
_LOGIN_CONCURRENCY = 2
_login_sem = threading.Semaphore(_LOGIN_CONCURRENCY)


def _to_browser_proxy(raw: str) -> str:
    """把账号专属代理转成 CloakBrowser 可用 URL（与 openai_register._browser_proxy_url 同源）。"""
    return browser_proxy_url(raw) or ""


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


def _parse_fingerprint_seed(account: dict[str, Any]) -> int | None:
    raw = account.get("fingerprint_seed")
    try:
        seed = int(raw)
    except (TypeError, ValueError):
        return None
    return seed if seed > 0 else None


def _browser_session_from_account(account: dict[str, Any]) -> dict | None:
    session = account.get("browser_session")
    return session if isinstance(session, dict) and session.get("cookies") is not None else None


def _build_browser_job(
    account: dict[str, Any],
    *,
    mode: str,
    email: str = "",
    password: str = "",
    totp_secret: str = "",
    locale: str = "",
    country: str = "",
) -> dict:
    browser_proxy = _to_browser_proxy(str(account.get("proxy") or ""))
    timeout_s = int(reg.config.get("register_timeout") or 600)
    resolved_email = email or str(account.get("email") or "").strip()
    resolved_country = country or str(account.get("country") or "")
    job: dict[str, Any] = {
        "email": resolved_email,
        "proxyUrl": browser_proxy,
        "mode": mode,
        "loginPassword": password or str(account.get("password") or ""),
        "existingTotpSecret": totp_secret or str(account.get("totp_secret") or ""),
        "enable2fa": False,
        "headless": bool(reg.config.get("headless")),
        "chatgptUrl": reg.chatgpt_url,
        "timeoutMs": timeout_s * 1000,
        "locale": (locale or browser_locale_for_region(resolved_country) or "en-US"),
        "staticCache": reg.static_cache_job_options(),
    }
    seed = _parse_fingerprint_seed(account)
    if seed is not None:
        job["fingerprintSeed"] = seed
    job.update(reg.record_job_options())
    return job


def run_token_refresh(
    account: dict[str, Any],
    *,
    log=lambda *_: None,
) -> dict:
    """强制刷新 access_token：优先 session 恢复，失败 fallback 密码登录。

    返回 {ok, access_token, browser_session, fingerprint_seed, via_session, reset_password, error}。
    """
    email = str(account.get("email") or "").strip()
    password = str(account.get("password") or "").strip()
    if not email or not password:
        return {"ok": False, "error": "无邮箱或密码，无法刷新 token"}

    # 统一走 session_refresh：确认登录态后会 reload 再读 AccessToken；
    # 无 browser_session 时由 fallbackLogin 走密码登录。
    session = _browser_session_from_account(account)
    job = _build_browser_job(account, mode="session_refresh")
    job["fallbackLogin"] = True
    if session:
        job["storageState"] = session
    mail_config, mailbox = _account_mail_ctx(email)

    with _login_sem:
        result = _drive_worker(job, mail_config, mailbox, log)

    if not result.get("ok"):
        return result

    storage = result.get("browser_session")
    if not isinstance(storage, dict):
        storage = None
    seed = result.get("fingerprint_seed")
    return {
        "ok": True,
        "access_token": str(result.get("access_token") or ""),
        "browser_session": storage,
        "fingerprint_seed": int(seed) if seed else None,
        "via_session": bool(result.get("via_session")),
        "reset_password": str(result.get("reset_password") or ""),
        "user": result.get("user"),
        "expires": result.get("expires"),
    }


def run_browser_login(
    email: str,
    password: str,
    *,
    totp_secret: str = "",
    account_proxy: str = "",
    locale: str = "",
    country: str = "",
    fingerprint_seed: int | None = None,
    log=lambda *_: None,
) -> dict:
    """用浏览器 UI 登录老账号取新 token（刷新 / 重登主流程）。"""
    account: dict[str, Any] = {
        "email": email,
        "password": password,
        "totp_secret": totp_secret,
        "proxy": account_proxy,
        "country": country,
    }
    if fingerprint_seed is not None and fingerprint_seed > 0:
        account["fingerprint_seed"] = fingerprint_seed
    job = _build_browser_job(
        account,
        mode="login",
        email=email,
        password=password,
        totp_secret=totp_secret,
        locale=locale,
        country=country,
    )
    mail_config, mailbox = _account_mail_ctx(email)

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
        storage = data.get("storageState")
        browser_session = storage if isinstance(storage, dict) else None
        seed_raw = data.get("fingerprintSeed")
        try:
            fingerprint_seed = int(seed_raw) if seed_raw is not None else None
        except (TypeError, ValueError):
            fingerprint_seed = None
        return {
            "ok": True,
            "access_token": str(data.get("accessToken")).strip(),
            "reset_password": str(data.get("resetPassword") or ""),
            "browser_session": browser_session,
            "fingerprint_seed": fingerprint_seed if fingerprint_seed and fingerprint_seed > 0 else None,
            "via_session": bool(data.get("viaSession")),
            "user": data.get("user"),
            "expires": data.get("expires"),
        }
    return {"ok": False, "error": err_msg or "浏览器登录未返回 token"}
