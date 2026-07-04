from __future__ import annotations

import json
import os
import random
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote

from curl_cffi import requests as curl_requests

from services.account_service import account_service
from services.register import mail_provider
from services.register import fingerprint
from services.register import trial_check
from services.register.fingerprint import (
    build_identity,
    normalize_proxy,
    parse_proxy,
    rotate_ipweb_proxy,
)
from services.register_abnormal_service import register_abnormal_service

base_dir = Path(__file__).resolve().parent
# 仓库根 / node_engine：CloakBrowser 浏览器引擎（单账号 CLI worker）
NODE_ENGINE_DIR = base_dir.parents[1] / "node_engine"
NODE_WORKER = NODE_ENGINE_DIR / "worker.js"

config = {
    "mail": {
        "request_timeout": 30,
        "wait_timeout": 30,
        "wait_interval": 2,
        "providers": [],
    },
    "proxy": "",
    "total": 10,
    "threads": 3,
    "enable_2fa": True,
    "regions": ["US"],
    "ipweb_rotate": False,
    "ip_duration": 120,
    # 出口 IP 探活重试次数：换 SID 后经代理探活，最多试这么多次直到拿到活 IP（0=关闭探活）
    "ip_probe_retries": 6,
    # 浏览器引擎相关（由 register_service._push_to_worker 下发）
    "engine": "browser",
    "headless": False,
    "register_timeout": 300,
    "node_bin": "node",
    "cloakbrowser_license": "",
}
register_config_file = base_dir.parents[1] / "data" / "register.json"
try:
    saved_config = json.loads(register_config_file.read_text(encoding="utf-8"))
    config.update({
        key: saved_config[key]
        for key in ("mail", "proxy", "total", "threads", "regions", "ipweb_rotate", "ip_duration",
                    "enable_2fa", "headless", "register_timeout", "node_bin", "ip_probe_retries")
        if key in saved_config
    })
except Exception:
    pass

chatgpt_url = "https://chatgpt.com/"

# 出口 IP 探活端点：经账号代理 GET 它，返回出口公网 IP 即认为该线路可用。
_EXIT_IP_PROBE_URL = "https://api.ipify.org?format=json"

print_lock = threading.Lock()
stats_lock = threading.Lock()
stats = {"done": 0, "success": 0, "fail": 0, "start_time": 0.0}
register_log_sink = None

# 正在运行的 Node 子进程集合：用于停止任务时优雅终止在途浏览器。
_active_lock = threading.Lock()
_active_procs: set[subprocess.Popen] = set()

# 正在注册的每个任务的实时进度（按任务号）：供工作台「正在注册账号」表展示。
progress_lock = threading.Lock()
progress: dict[int, dict] = {}


def _progress_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def reset_progress() -> None:
    """新一轮注册开始时清空上一轮的进度表。"""
    with progress_lock:
        progress.clear()


def progress_snapshot() -> list[dict]:
    """按任务号升序返回当前进度表副本（注册服务组装 SSE payload 时调用）。"""
    with progress_lock:
        return [dict(v) for _, v in sorted(progress.items())]


def _progress_update(index: int, **fields) -> None:
    with progress_lock:
        entry = progress.get(index) or {"index": index, "email": "", "step": "", "level": "info", "status": "running"}
        entry.update(fields)
        entry["updated_at"] = _progress_now()
        progress[index] = entry


def set_progress_email(index: int, email: str) -> None:
    """邮箱一旦分配即登记，让表格能显示是哪个邮箱在注册。"""
    _progress_update(index, email=str(email or ""))


def _remove_progress(index: int) -> None:
    with progress_lock:
        progress.pop(index, None)


def log(text: str, color: str = "") -> None:
    colors = {"red": "\033[31m", "green": "\033[32m", "yellow": "\033[33m"}
    if register_log_sink:
        try:
            register_log_sink(text, color)
        except Exception:
            pass
    with print_lock:
        prefix = colors.get(color, "")
        suffix = "\033[0m" if prefix else ""
        print(f"{prefix}{datetime.now().strftime('%H:%M:%S')} {text}{suffix}")


def step(index: int, text: str, color: str = "") -> None:
    _progress_update(index, step=str(text), level=str(color or "info"))
    log(f"[任务{index}] {text}", color)


def _mail_config() -> dict:
    return {**config["mail"], "proxy": config["proxy"]}


def _mailbox_verb() -> str:
    """邮箱来源动词：API 邮箱池是从池中「获取」，CloudMail 是按需「生成」。"""
    providers = (config.get("mail") or {}).get("providers") or []
    for provider in providers:
        if isinstance(provider, dict) and provider.get("enable") is not False:
            return "生成" if str(provider.get("type")) == mail_provider.CLOUDMAIL_TYPE else "获取"
    return "获取"


def create_mailbox(username: str | None = None) -> dict:
    return mail_provider.create_mailbox(_mail_config(), username)


def wait_for_code(mailbox: dict) -> str | None:
    return mail_provider.wait_for_code(_mail_config(), mailbox)


def _probe_exit_ip(account_proxy: str, timeout: float = 12.0) -> str | None:
    """经账号专属代理 GET ipify，拿到出口公网 IP 即认为该线路可用；失败返回 None。

    走 curl_cffi（与 mail_provider 一致，支持带认证 socks5h），不复用收件会话——
    收件永不走代理，这里必须走代理才能验证「这条出口线路是否真的活着」。
    """
    proxy = (account_proxy or "").strip()
    if not proxy:
        return None
    try:
        resp = curl_requests.get(
            _EXIT_IP_PROBE_URL,
            proxies={"http": proxy, "https": proxy},
            timeout=timeout,
            impersonate="chrome",
            verify=False,
        )
        if resp.status_code != 200:
            return None
        ip = str((resp.json() or {}).get("ip") or "").strip()
        return ip or None
    except Exception:
        return None


def _resolve_account_proxy(identity) -> str:
    """按账号解析专属出口代理（不探活，仅归一化 / 换段换 SID）。

    ipweb 开启则换国家段 + 全新 SID（号一号一 IP），否则归一化沿用。
    duration 取 config["ip_duration"]（分钟），延长同 IP 粘性，覆盖注册全程及后续单次操作。
    """
    base = config.get("proxy") or ""
    if not base:
        return ""
    if config.get("ipweb_rotate"):
        dur = int(config.get("ip_duration") or 120)
        rotated, sid = rotate_ipweb_proxy(base, identity.region.ipweb_country, duration=dur)
        if sid is not None:
            return rotated
        return normalize_proxy(base)
    return normalize_proxy(base)


def _acquire_working_proxy(identity, index: int) -> tuple[str, str]:
    """拿到一条「探活通过」的账号专属出口代理，返回 (account_proxy, exit_ip)。

    - 未配代理 → 直连 ("","")。
    - 关闭探活（ip_probe_retries<=0）→ 只解析一次、不探活，行为同旧逻辑（exit_ip 空）。
    - ipweb 轮换开启 → 最多试 ip_probe_retries 次，每次换全新 SID 后探活，命中即返回；
      全失败 → 记 warning 并回退「最后一次解析到的代理」（不比旧逻辑差，仍带出口代理）。
    - 非 ipweb（固定代理）→ 探活一次；不活也照用（用户固定代理，换 SID 无意义）。
    """
    base = config.get("proxy") or ""
    if not base:
        return "", ""

    retries = int(config.get("ip_probe_retries") or 0)
    rotate = bool(config.get("ipweb_rotate"))

    # 关闭探活：保持旧行为（解析一次直接用）
    if retries <= 0:
        return _resolve_account_proxy(identity), ""

    last_proxy = ""
    attempts = max(1, retries) if rotate else 1
    for attempt in range(1, attempts + 1):
        acct_proxy = _resolve_account_proxy(identity)  # ipweb 时每轮换新 SID
        last_proxy = acct_proxy
        exit_ip = _probe_exit_ip(acct_proxy)
        if exit_ip:
            if attempt > 1:
                step(index, f"出口 IP 探活通过（第 {attempt} 次换线）：{exit_ip}")
            return acct_proxy, exit_ip
        if rotate:
            step(index, f"出口 IP 探活失败（第 {attempt}/{attempts} 次），换 SID 重试", "yellow")

    if rotate:
        step(index, "多次换 SID 仍未探到活 IP，回退沿用最后一条代理继续", "yellow")
    # 非 ipweb 固定代理：探活失败也照用（换 SID 无意义）
    return last_proxy, ""



def _browser_proxy_url(raw: str, index: int) -> str:
    """把账号代理转成 Chromium 可用的 http(s):// URL。

    Chromium/Playwright 无法做「带认证的 SOCKS5」，而 account-hub 代理默认归一化为 socks5h。
    这里统一强制成 http，凭据做 URL 编码；无法解析则直连（返回空串）。
    """
    if not raw:
        return ""
    parsed = parse_proxy(raw, default_scheme="http")
    if parsed is None:
        step(index, f"代理无法解析，浏览器将直连：{raw}", "yellow")
        return ""
    scheme = (parsed.scheme or "http").lower()
    if scheme.startswith("socks"):
        if parsed.user:
            step(index, "检测到带认证的 SOCKS5 代理，Chromium 不支持，已改用 http 方案（若网关不支持 http 可能失败）", "yellow")
        scheme = "http"
    elif scheme not in ("http", "https"):
        scheme = "http"
    # 先 unquote 再 quote，避免对已编码的凭据二次编码（p%40ss → p@ss → p%40ss）
    user = quote(unquote(parsed.user), safe="") if parsed.user else ""
    pwd = quote(unquote(parsed.password), safe="") if parsed.password else ""
    auth = f"{user}:{pwd}@" if user else ""
    return f"{scheme}://{auth}{parsed.host}:{parsed.port}"


def _level_color(level: object) -> str:
    text = str(level or "").lower()
    if text == "error":
        return "red"
    if text in ("warn", "warning", "yellow"):
        return "yellow"
    return ""


def _send_line(proc: subprocess.Popen, obj: dict) -> None:
    try:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
            proc.stdin.flush()
    except Exception:
        pass


def _terminate(proc: subprocess.Popen) -> None:
    try:
        if proc.poll() is None:
            _send_line(proc, {"type": "stop"})
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
    except Exception:
        pass


def request_stop() -> None:
    """停止注册任务时调用：向所有在途 Node 子进程发 stop 并终止，释放浏览器内存。"""
    with _active_lock:
        procs = list(_active_procs)
    for proc in procs:
        _terminate(proc)


def _build_account(data: dict, email: str, acct_proxy: str, identity, exit_ip: str = "") -> dict:
    prof = identity.profile
    token = str(data.get("accessToken") or "").strip()
    return {
        "email": str(data.get("email") or email).strip(),
        "password": str(data.get("password") or ""),
        "access_token": token,
        "source_type": "web",
        "created_at": datetime.now(timezone.utc).isoformat(),
        # 号一号一 IP：把专属代理与地区持久化到账号，后续官方接口复用同一出口
        "proxy": acct_proxy,
        "country": identity.region.code,
        # 注册时探到的出口公网 IP（探活通过才有值），便于排查与展示
        "exit_ip": str(exit_ip or ""),
        # 指纹持久化（与 openai_backend_api._build_fp 字段对齐）
        "impersonate": identity.impersonate,
        "user-agent": identity.user_agent,
        "sec-ch-ua": identity.sec_ch_ua,
        "sec-ch-ua-mobile": prof.sec_ch_ua_mobile,
        "sec-ch-ua-platform": prof.platform,
        # 浏览器会话拿到的 2FA / 指纹种子（token 过期后靠 password+totp 重登）
        "totp_secret": str(data.get("twoFactorSecret") or ""),
        "otpauth_url": str(data.get("twoFactorUri") or ""),
        "fingerprint_seed": data.get("fingerprintSeed"),
    }


def _spawn_worker(job: dict) -> subprocess.Popen:
    env = {**os.environ}
    license_key = str(config.get("cloakbrowser_license") or "").strip() or os.getenv("CLOAKBROWSER_LICENSE_KEY", "")
    if license_key:
        env["CLOAKBROWSER_LICENSE_KEY"] = license_key
    node_bin = str(config.get("node_bin") or "node")
    return subprocess.Popen(
        [node_bin, str(NODE_WORKER), json.dumps(job, ensure_ascii=False)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        cwd=str(NODE_ENGINE_DIR),
        env=env,
    )


def _run_browser_job(index: int, email: str, mailbox: dict, browser_proxy: str, identity) -> tuple[dict | None, str | None, dict]:
    """启动 Node 子进程跑浏览器流程，泵 NDJSON，返回 (result_data, error_msg, partial)。"""
    timeout_s = int(config.get("register_timeout") or 300)
    job = {
        "email": email,
        "proxyUrl": browser_proxy,
        "fingerprintSeed": None,
        "enable2fa": bool(config.get("enable_2fa")),
        "headless": bool(config.get("headless")),
        "chatgptUrl": chatgpt_url,
        "timeoutMs": timeout_s * 1000,
        "locale": (str(identity.accept_language).split(",")[0] or "en-US"),
    }
    baseline = mail_provider.peek_received_at(_mail_config(), mailbox)

    proc = _spawn_worker(job)
    with _active_lock:
        _active_procs.add(proc)

    # 硬超时看门狗：Node 侧自身有 Promise.race，这里再兜一层，防止无输出挂死。
    watchdog = threading.Timer(timeout_s + 60, lambda: _terminate(proc))
    watchdog.daemon = True
    watchdog.start()

    stderr_tail: list[str] = []

    def _drain_stderr() -> None:
        try:
            for line in proc.stderr:  # type: ignore[union-attr]
                stderr_tail.append(line)
                if len(stderr_tail) > 200:
                    del stderr_tail[0]
        except Exception:
            pass

    threading.Thread(target=_drain_stderr, daemon=True).start()

    data: dict | None = None
    err_msg: str | None = None
    partial: dict = {}
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
                step(index, str(evt.get("message") or ""), _level_color(evt.get("level")))
            elif etype == "need_code":
                code = mail_provider.wait_for_code(_mail_config(), mailbox, after_received_at=baseline)
                newb = mail_provider.peek_received_at(_mail_config(), mailbox)
                if isinstance(newb, datetime):
                    baseline = newb
                _send_line(proc, {"type": "code", "code": code})
                if code:
                    step(index, f"已向浏览器回传验证码 {code}")
                else:
                    step(index, "取码超时，已回传空验证码", "yellow")
            elif etype == "result":
                data = evt.get("data") or {}
                break
            elif etype == "error":
                err_msg = str(evt.get("message") or "注册失败")
                partial = evt.get("partial") or {}
                break
    except Exception as exc:  # noqa: BLE001
        err_msg = err_msg or f"读取引擎输出异常：{exc}"
    finally:
        watchdog.cancel()
        _terminate(proc)
        with _active_lock:
            _active_procs.discard(proc)

    if data is None and err_msg is None:
        err_msg = "浏览器引擎未返回结果（进程可能被终止或超时）"
        if stderr_tail:
            log(f"任务{index} 引擎 stderr 末尾：{''.join(stderr_tail[-5:]).strip()}", "yellow")
    return data, err_msg, partial


def worker(index: int) -> dict:
    start = time.time()
    _progress_update(index, status="running", step="任务启动", email="")
    identity = build_identity(enabled_regions=config.get("regions") or ["US"])
    acct_proxy, exit_ip = _acquire_working_proxy(identity, index)
    browser_proxy = _browser_proxy_url(acct_proxy, index)

    verb = _mailbox_verb()
    step(index, f"任务启动，开始{verb}邮箱")
    try:
        mailbox = mail_provider.create_mailbox(_mail_config())
    except Exception as exc:  # noqa: BLE001
        with stats_lock:
            stats["done"] += 1
            stats["fail"] += 1
        log(f"任务{index} 取邮箱失败：{exc}", "red")
        _remove_progress(index)
        return {"ok": False, "index": index, "error": str(exc)}

    email = str(mailbox.get("address") or "").strip()
    if not email:
        mail_provider.release_mailbox(mailbox)
        with stats_lock:
            stats["done"] += 1
            stats["fail"] += 1
        _remove_progress(index)
        return {"ok": False, "index": index, "error": "邮箱服务未返回 address"}

    label = str(mailbox.get("label") or "")
    fetch_url = str(mailbox.get("fetch_url") or "")
    set_progress_email(index, email)
    step(index, f"邮箱{verb}完成[{label}]: {email}")

    try:
        data, err_msg, partial = _run_browser_job(index, email, mailbox, browser_proxy, identity)

        # —— 成功：拿到 token —— #
        if data and str(data.get("accessToken") or "").strip():
            token = str(data.get("accessToken")).strip()
            elig = trial_check.check_eligibility(token, email)
            if elig.get("eligible") is False:
                # 注册成功但无试用资格：入异常清单，不进号池、不自动激活
                register_abnormal_service.add(
                    email, fetch_url=fetch_url, reason=str(elig.get("reason") or "no_trial"),
                    access_token=token, password=data.get("password"), eligible=False,
                )
                mailbox["access_token"] = token
                mail_provider.mark_mailbox_result(mailbox, success=True)
                cost = time.time() - start
                with stats_lock:
                    stats["done"] += 1
                    stats["fail"] += 1
                log(f"{email} 注册成功但无试用资格（{elig.get('reason')}），已入异常清单，不入号池，本次耗时{cost:.1f}s", "yellow")
                return {"ok": False, "index": index, "error": "no_trial"}

            # 合格（或未启用检测/检测异常按 fail-open 视为合格）→ 入号池
            acct = _build_account(data, email, acct_proxy, identity, exit_ip)
            mailbox["access_token"] = token
            account_service.add_account_items([acct])
            refresh_result = account_service.refresh_accounts([token])
            if refresh_result.get("errors"):
                step(index, f"账号已保存，刷新状态暂未成功，稍后可重试: {refresh_result['errors']}", "yellow")
            mail_provider.mark_mailbox_result(mailbox, success=True)
            cost = time.time() - start
            with stats_lock:
                stats["done"] += 1
                stats["success"] += 1
                avg = (time.time() - stats["start_time"]) / max(1, stats["success"])
            mode = str(data.get("mode") or "register")
            log(f'{email} {"注册" if mode == "register" else "老账号加固"}成功，本次耗时{cost:.1f}s，全局平均每个号耗时{avg:.1f}s', "green")
            return {"ok": True, "index": index, "result": acct}

        # —— 失败：可能带 partial token（step8 失败但已拿 token）—— #
        token = str((partial or {}).get("accessToken") or "").strip()
        if token:
            elig = trial_check.check_eligibility(token, email)
            register_abnormal_service.add(
                email, fetch_url=fetch_url, reason=str(err_msg or "register_error"),
                access_token=token, password=(partial or {}).get("password"),
                eligible=elig.get("eligible"),
            )
            mailbox["access_token"] = token
            mail_provider.mark_mailbox_result(mailbox, success=True)
            log(f"{email} 注册部分成功（{err_msg}），token 已存入异常清单", "yellow")
        else:
            mail_provider.mark_mailbox_result(mailbox, success=False, error=err_msg)

        cost = time.time() - start
        with stats_lock:
            stats["done"] += 1
            stats["fail"] += 1
        log(f"任务{index} 注册失败，本次耗时{cost:.1f}s，原因: {err_msg}", "red")
        return {"ok": False, "index": index, "error": err_msg or "注册失败"}
    except Exception as e:  # noqa: BLE001
        try:
            mail_provider.mark_mailbox_result(mailbox, success=False, error=e)
        except Exception:
            pass
        cost = time.time() - start
        with stats_lock:
            stats["done"] += 1
            stats["fail"] += 1
        log(f"任务{index} 注册异常，本次耗时{cost:.1f}s，原因: {e}", "red")
        return {"ok": False, "index": index, "error": str(e)}
    finally:
        _remove_progress(index)
