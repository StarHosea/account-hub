from __future__ import annotations

import json
import os
import queue
import random
import re
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from curl_cffi import requests as curl_requests

from services.account_lifecycle import email_storage_key
from services.account_service import account_service
from services.register import mail_provider
from services.register import mail_code
from services.register import fingerprint
from services.register.fingerprint import (
    ParsedProxy,
    build_identity,
    normalize_proxy,
    parse_proxy,
    rotate_ipweb_proxy,
)
from services.config import DATA_DIR
from services.register_abnormal_service import register_abnormal_service

base_dir = Path(__file__).resolve().parent
# 仓库根 / node_engine：CloakBrowser 浏览器引擎（单账号 CLI worker）
NODE_ENGINE_DIR = base_dir.parents[1] / "node_engine"
NODE_WORKER = NODE_ENGINE_DIR / "worker.js"

config = {
    "mail": {
        "request_timeout": 30,
        "wait_timeout": 300,
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
    "register_timeout": 600,
    "node_bin": "node",
    "cloakbrowser_license": "",
    "static_cache_enabled": True,
    "static_cache_max_age_days": 7,
    "static_cache_dir": "",
    "record_enabled": True,
    "record_dir": "",
    "record_keep": "fail",
    "diag_public_url": "",
}
_CONFIG_KEYS = (
    "mail", "proxy", "total", "threads", "regions", "ipweb_rotate", "ip_duration",
    "enable_2fa", "headless", "register_timeout", "node_bin", "ip_probe_retries",
    "static_cache_enabled", "static_cache_max_age_days", "static_cache_dir",
    "record_enabled", "record_dir", "record_keep", "diag_public_url",
)


def refresh_config_from_storage() -> None:
    """从 register_service / 存储后端同步配置；独立脚本 import 时作兜底。"""
    try:
        from services.register_service import register_service

        register_service._push_to_worker()
        return
    except Exception:
        pass
    try:
        from services.config import config as app_config

        data = app_config.get_storage_backend().load_state("register")
        if isinstance(data, dict):
            config.update({key: data[key] for key in _CONFIG_KEYS if key in data})
    except Exception:
        pass


def ensure_config_loaded() -> None:
    if getattr(ensure_config_loaded, "_done", False):
        return
    refresh_config_from_storage()
    ensure_config_loaded._done = True  # type: ignore[attr-defined]


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
_stop_requested = threading.Event()

# 正在注册的每个任务的实时进度（按任务号）：供工作台「正在注册账号」表展示。
progress_lock = threading.Lock()
progress: dict[int, dict] = {}

# 号一号一 IP：本轮注册已占用的出口公网 IP 集合。探到活 IP 后先在此去重，
# 已占用则视为「撞号」换 SID 重试，仅探到全新 IP 才登记放行。每轮 start 时清空。
_used_ips_lock = threading.Lock()
_used_exit_ips: set[str] = set()

_TIMEOUT_SENTINEL = object()


def _progress_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def reset_progress() -> None:
    """新一轮注册开始时清空上一轮的进度表与出口 IP 去重集合。"""
    with progress_lock:
        progress.clear()
    reset_used_exit_ips()
    reset_stop_requested()


def reset_stop_requested() -> None:
    """新一轮注册开始前清除停止标记。"""
    _stop_requested.clear()


def is_stop_requested() -> bool:
    return _stop_requested.is_set()


def active_browser_count() -> int:
    """当前在途指纹浏览器（Node worker）子进程数。"""
    with _active_lock:
        return len(_active_procs)


def reset_used_exit_ips() -> None:
    """清空「号一号一 IP」去重集合（新一轮注册重新计数）。"""
    with _used_ips_lock:
        _used_exit_ips.clear()


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
    return mail_code.fulfill_need_code(_mail_config(), mailbox)


def _probe_exit_ip_once(proxy: str, timeout: float = 12.0) -> str | None:
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


def _probe_exit_ip(account_proxy: str, timeout: float = 12.0) -> str | None:
    """经账号专属代理 GET ipify，拿到出口公网 IP 即认为该线路可用；失败返回 None。

    走 curl_cffi（与 mail_provider 一致，支持带认证 socks5h），不复用收件会话——
    收件永不走代理，这里必须走代理才能验证「这条出口线路是否真的活着」。
    socks5h 探活失败时会再试 http（与浏览器侧 _browser_proxy_url 一致）。
    """
    proxy = (account_proxy or "").strip()
    if not proxy:
        return None
    candidates = [proxy]
    parsed = parse_proxy(proxy)
    if parsed and (parsed.scheme or "").lower().startswith("socks"):
        candidates.append(
            ParsedProxy("http", parsed.host, parsed.port, parsed.user, parsed.password).to_url()
        )
    for candidate in candidates:
        ip = _probe_exit_ip_once(candidate, timeout)
        if ip:
            return ip
    return None


def _proxy_sid(acct_proxy: str) -> str:
    parsed = parse_proxy(acct_proxy)
    if not parsed or not parsed.user:
        return "?"
    parts = parsed.user.split("_")
    return parts[-1] if parts else "?"


def _proxy_diag_fields(acct_proxy: str, identity, exit_ip: str = "") -> dict:
    """脱敏代理摘要，写入异常清单与诊断 brief。"""
    region = str(getattr(getattr(identity, "region", None), "code", "") or "").strip()
    if not acct_proxy:
        fields = {
            "proxy_region": region or None,
            "proxy_host": None,
            "proxy_scheme": None,
            "proxy_sid": None,
            "exit_ip": str(exit_ip or "").strip() or None,
            "proxy_mode": "direct",
        }
        return {k: v for k, v in fields.items() if v is not None}

    parsed = parse_proxy(acct_proxy)
    host = str(parsed.host if parsed else "").strip()
    scheme = str(parsed.scheme if parsed else "").strip()
    sid = _proxy_sid(acct_proxy)
    sid_masked = f"…{sid[-4:]}" if sid not in ("", "?") and len(sid) > 4 else sid
    mode = "ipweb" if host.endswith("ipweb.cc") else "proxy"
    fields = {
        "proxy_region": region or None,
        "proxy_host": host or None,
        "proxy_scheme": scheme or None,
        "proxy_sid": sid_masked,
        "exit_ip": str(exit_ip or "").strip() or None,
        "proxy_mode": mode,
    }
    return {k: v for k, v in fields.items() if v is not None}


def _code_purpose_label(purpose: str) -> str:
    return mail_code.purpose_label(purpose)


def _log_proxy_assignment(index: int, identity, acct_proxy: str, exit_ip: str) -> None:
    """每个任务固定打一行代理/出口 IP 摘要，避免旧逻辑「首次探活成功不打日志」导致前端看不到。"""
    region = identity.region.code
    if not acct_proxy:
        step(index, "未配置代理，使用本机网络", "yellow")
        return
    parsed = parse_proxy(acct_proxy)
    is_ipweb = bool(parsed and parsed.host.endswith("ipweb.cc"))
    label = "IPWeb 代理" if is_ipweb else "代理"
    sid = _proxy_sid(acct_proxy)
    retries = int(config.get("ip_probe_retries") or 0)
    if exit_ip:
        step(index, f"{label}已就绪，地区 {region}，出口 IP {exit_ip}", "green")
    elif retries <= 0:
        step(index, f"{label}已就绪，地区 {region}，未检测出口 IP", "yellow")
    else:
        step(index, f"{label}已就绪，地区 {region}，未能检测出口 IP，继续使用代理", "yellow")


def _ip_duration_minutes() -> int:
    """ipweb 一号一 IP 粘性时长（分钟），与 register_timeout 对齐。"""
    return max(1, (_register_timeout_s() + 59) // 60)


def _resolve_account_proxy(identity) -> str:
    """按账号解析专属出口代理（不探活，仅归一化 / 换段换 SID）。

    ipweb 开启则换国家段 + 全新 SID（号一号一 IP），否则归一化沿用。
    duration 取与 register_timeout 对齐的分钟数，覆盖注册全程及后续单次操作。
    """
    base = config.get("proxy") or ""
    if not base:
        return ""
    if config.get("ipweb_rotate"):
        dur = _ip_duration_minutes()
        rotated, sid = rotate_ipweb_proxy(base, identity.region.ipweb_country, duration=dur)
        if sid is not None:
            return rotated
        return normalize_proxy(base)
    return normalize_proxy(base)


def _acquire_working_proxy(identity, index: int) -> tuple[str, str]:
    """拿到一条「探活通过且出口 IP 未被本轮占用」的账号专属出口代理，返回 (account_proxy, exit_ip)。

    - 未配代理 → 直连 ("","")。
    - 关闭探活（ip_probe_retries<=0）→ 只解析一次、不探活、不去重，行为同旧逻辑（exit_ip 空）。
    - ipweb 轮换开启 → 最多试 ip_probe_retries 次，每次换全新 SID 后探活；探到的 IP 若已被
      本轮其它账号占用则视为撞号、换 SID 重试，探到全新 IP 才登记占用并返回（号一号一 IP）；
      全失败 → 记 warning 并回退「最后一次解析到的代理」（不比旧逻辑差，仍带出口代理）。
    - 非 ipweb（固定代理）→ 探活一次；撞号/不活也照用（用户固定代理，换 SID 无意义）。
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
            # 号一号一 IP：探到活 IP 后做全局去重。已被本轮占用 → 撞号，换 SID 重试。
            with _used_ips_lock:
                duplicated = exit_ip in _used_exit_ips
                if not duplicated:
                    _used_exit_ips.add(exit_ip)
            if not duplicated:
                return acct_proxy, exit_ip
            if rotate:
                step(index, f"出口 IP {exit_ip} 已被其他任务占用，正在更换代理重试 {attempt}/{attempts}", "yellow")
                continue
            # 非 ipweb 固定代理：换 SID 无意义，撞号也只能沿用（固定代理本就共享同一 IP）
            return acct_proxy, exit_ip
        if rotate:
            step(index, f"代理连接检测失败，正在更换代理重试 {attempt}/{attempts}", "yellow")
        elif attempt == 1:
            step(index, "代理连接检测失败，继续使用当前代理", "yellow")

    if rotate:
        step(index, "多次更换代理后仍未获得独立 IP，继续使用当前代理", "yellow")
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
        step(index, f"代理地址无法解析，使用本机网络：{raw}", "yellow")
        return ""
    scheme = (parsed.scheme or "http").lower()
    if scheme.startswith("socks"):
        if parsed.user:
            step(index, "检测到 SOCKS5 代理，已自动切换为 HTTP 方式连接", "yellow")
        scheme = "http"
    elif scheme not in ("http", "https"):
        scheme = "http"
    # 先 unquote 再 quote，避免对已编码的凭据二次编码（p%40ss → p@ss → p%40ss）
    user = quote(unquote(parsed.user), safe="") if parsed.user else ""
    pwd = quote(unquote(parsed.password), safe="") if parsed.password else ""
    auth = f"{user}:{pwd}@" if user else ""
    return f"{scheme}://{auth}{parsed.host}:{parsed.port}"


def static_cache_job_options() -> dict:
    """静态资源 route 缓存配置，随 job JSON 下发给 Node worker。"""
    raw_dir = str(config.get("static_cache_dir") or "").strip()
    cache_dir = ""
    if raw_dir:
        p = Path(raw_dir)
        cache_dir = str(p if p.is_absolute() else base_dir.parents[1] / raw_dir)
    return {
        "enabled": bool(config.get("static_cache_enabled", True)),
        "maxAgeDays": min(90, max(1, int(config.get("static_cache_max_age_days") or 7))),
        "dir": cache_dir,
    }


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


def signal_stop_new_tasks() -> None:
    """仅阻止尚未启动浏览器的任务继续；已在跑的注册流程不受影响。"""
    _stop_requested.set()


def request_stop() -> None:
    """用户主动停止：标记停止并向所有在途 Node 子进程发 stop 并终止，释放浏览器内存。"""
    signal_stop_new_tasks()
    with _active_lock:
        procs = list(_active_procs)
    if procs:
        log(f"正在终止 {len(procs)} 个在途指纹浏览器进程…", "yellow")
    for proc in procs:
        _terminate(proc)
    if procs:
        log(f"已终止 {len(procs)} 个指纹浏览器进程", "yellow")


def _totp_secret_from_data(data: dict) -> str:
    secret = str(data.get("twoFactorSecret") or "").strip()
    if secret:
        return secret
    uri = str(data.get("twoFactorUri") or "").strip()
    if not uri:
        return ""
    try:
        parsed = parse_qs(urlparse(uri).query)
        from_uri = str((parsed.get("secret") or [""])[0]).strip()
        if from_uri:
            return from_uri
    except Exception:  # noqa: BLE001
        pass
    match = re.search(r"secret=([A-Z2-7]+)", uri, flags=re.IGNORECASE)
    return match.group(1) if match else ""


def _cleanup_stale_accounts_for_email(email: str, keep_token: str) -> int:
    """删除同邮箱旧记录（含 email:: 占位行），保留本次注册产出的 token 行。"""
    target = email.strip().lower()
    keep = str(keep_token or "").strip()
    to_delete: list[str] = []
    for acct in account_service.list_accounts():
        if str(acct.get("email") or "").strip().lower() != target:
            continue
        tok = str(acct.get("access_token") or "").strip()
        if tok and tok != keep:
            to_delete.append(tok)
    email_key = email_storage_key(email)
    if email_key and email_key != keep:
        to_delete.append(email_key)
    keys = list(dict.fromkeys(k for k in to_delete if k and k != keep))
    if keys:
        account_service.delete_accounts(keys)
    return len(keys)


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
        "totp_secret": _totp_secret_from_data(data),
        "otpauth_url": str(data.get("twoFactorUri") or ""),
        "fingerprint_seed": data.get("fingerprintSeed"),
    }


def _resolve_record_dir() -> str:
    if not bool(config.get("record_enabled", True)):
        return ""
    raw = str(config.get("record_dir") or "").strip()
    if raw:
        path = Path(raw)
        resolved = path if path.is_absolute() else DATA_DIR.parent / path
    else:
        resolved = DATA_DIR / "recordings"
    return str(resolved)


def record_job_options() -> dict:
    """注册存证选项：经 job JSON 传给 worker（不依赖环境变量）。"""
    record_dir = _resolve_record_dir()
    if not record_dir:
        return {}
    keep = str(config.get("record_keep") or "fail").strip().lower()
    return {
        "recordDir": record_dir,
        "recordKeep": keep if keep in {"fail", "all", "none"} else "fail",
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


def _lookup_stored_credentials(email: str) -> tuple[str, str]:
    """按 email 查本地账号库，返回 (password, totp_secret)；查不到返回 ('', '')。
    注册时若邮箱已注册（落到登录页），worker 会用这里注入的密码先尝试登录，
    密码错再走忘记密码重设——满足"有存储密码优先密码登录"的要求。"""
    target = str(email or "").strip().lower()
    if not target:
        return "", ""
    try:
        for acc in account_service.list_accounts():
            if str(acc.get("email") or "").strip().lower() == target:
                return (
                    str(acc.get("password") or "").strip(),
                    str(acc.get("totp_secret") or "").strip(),
                )
    except Exception:  # noqa: BLE001
        pass
    return "", ""


def _register_timeout_s() -> int:
    return int(config.get("register_timeout") or 600)


def _remaining_task_seconds(deadline_at: float) -> float:
    return max(0.0, deadline_at - time.time())


def _timeout_error_message() -> str:
    return f"注册超时（{_register_timeout_s()} 秒）"


def _start_stdout_reader(proc: subprocess.Popen, out_q: queue.Queue) -> None:
    def _reader() -> None:
        try:
            if proc.stdout:
                for raw_line in proc.stdout:
                    out_q.put(raw_line)
        except Exception:
            pass
        finally:
            out_q.put(None)

    threading.Thread(target=_reader, daemon=True).start()


def _next_worker_line(proc: subprocess.Popen, out_q: queue.Queue, deadline_at: float):
    """读取下一行 NDJSON；None=EOF；_TIMEOUT_SENTINEL=任务时限已到。"""
    while True:
        remaining = _remaining_task_seconds(deadline_at)
        if remaining <= 0:
            return _TIMEOUT_SENTINEL
        try:
            item = out_q.get(timeout=min(1.0, remaining))
        except queue.Empty:
            if proc.poll() is not None and out_q.empty():
                return None
            continue
        return item


def _drain_worker_events(out_q: queue.Queue) -> list[dict]:
    """进程已退出时排空 stdout 队列，避免 Node 已 emit error 但未读。"""
    events: list[dict] = []
    while True:
        try:
            item = out_q.get_nowait()
        except queue.Empty:
            break
        if item is None:
            continue
        line = str(item).strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            continue
    return events


def _run_browser_job(
    index: int,
    email: str,
    mailbox: dict,
    browser_proxy: str,
    identity,
    *,
    deadline_at: float,
) -> tuple[dict | None, str | None, dict, str]:
    """启动 Node 子进程跑浏览器流程，泵 NDJSON，返回 (result_data, error_msg, partial, recording_dir)。"""
    remaining = _remaining_task_seconds(deadline_at)
    if remaining <= 0:
        return None, _timeout_error_message(), {}, ""

    timeout_s = max(1, int(remaining))
    job = {
        "email": email,
        "proxyUrl": browser_proxy,
        "fingerprintSeed": None,
        "enable2fa": bool(config.get("enable_2fa")),
        "headless": bool(config.get("headless")),
        "chatgptUrl": chatgpt_url,
        "timeoutMs": timeout_s * 1000,
        "locale": identity.browser_locale,
        "timezone": identity.browser_timezone,
        "acceptLanguage": identity.accept_language,
        "staticCache": static_cache_job_options(),
    }
    job.update(record_job_options())
    # 若该邮箱本地已存过凭据（此前注册过），注入登录密码/2FA 密钥：
    # 注册中一旦发现邮箱已注册（登录页），先用存储密码登录，错了再忘记密码重设。
    stored_pwd, stored_totp = _lookup_stored_credentials(email)
    if stored_pwd:
        job["loginPassword"] = stored_pwd
    if stored_totp:
        job["existingTotpSecret"] = stored_totp
    if stored_pwd or stored_totp:
        parts = []
        if stored_pwd:
            parts.append("密码")
        if stored_totp:
            parts.append("双重验证密钥")
        step(index, f"已从本地读取历史{'和'.join(parts)}")
    mode_label = "无头" if job.get("headless") else "有界面"
    step(index, f"正在启动浏览器，{mode_label}模式，本任务剩余时限约 {timeout_s} 秒")
    proc = _spawn_worker(job)
    step(index, "浏览器已启动")
    with _active_lock:
        _active_procs.add(proc)

    # 硬超时看门狗：Node 侧自身有 Promise.race，这里再兜一层，防止无输出挂死。
    watchdog = threading.Timer(remaining + 15, lambda: _terminate(proc))
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

    out_q: queue.Queue = queue.Queue()
    _start_stdout_reader(proc, out_q)

    data: dict | None = None
    err_msg: str | None = None
    partial: dict = {}
    recording_dir = ""
    try:
        while True:
            raw_line = _next_worker_line(proc, out_q, deadline_at)
            if raw_line is _TIMEOUT_SENTINEL:
                err_msg = err_msg or _timeout_error_message()
                break
            if raw_line is None:
                for evt in _drain_worker_events(out_q):
                    etype = evt.get("type")
                    if etype == "log":
                        step(index, str(evt.get("message") or ""), _level_color(evt.get("level")))
                    elif etype == "result":
                        data = evt.get("data") or {}
                        recording_dir = str(evt.get("recordingDir") or recording_dir or "")
                    elif etype == "error":
                        err_msg = str(evt.get("message") or "注册失败")
                        partial = evt.get("partial") or {}
                        recording_dir = str(evt.get("recordingDir") or recording_dir or "")
                break
            line = str(raw_line).strip()
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
                if _remaining_task_seconds(deadline_at) <= 0:
                    err_msg = _timeout_error_message()
                    break
                purpose = str(evt.get("purpose") or "register")
                label = _code_purpose_label(purpose)
                step(index, f"正在等待{label}验证码…")
                round_timeout = min(
                    mail_code.ROUND_WAIT_TIMEOUT,
                    _remaining_task_seconds(deadline_at),
                )
                code = mail_code.fulfill_need_code(
                    _mail_config(), mailbox, ts=evt.get("ts"), purpose=purpose,
                    round_timeout=round_timeout,
                )
                _send_line(proc, {"type": "code", "code": code})
                if code:
                    step(index, f"收到{label}验证码：{code}")
                else:
                    step(index, "等待验证码超时，邮箱中未收到新邮件", "yellow")
            elif etype == "result":
                data = evt.get("data") or {}
                recording_dir = str(evt.get("recordingDir") or recording_dir or "")
                break
            elif etype == "error":
                err_msg = str(evt.get("message") or "注册失败")
                partial = evt.get("partial") or {}
                recording_dir = str(evt.get("recordingDir") or recording_dir or "")
                break
    except Exception as exc:  # noqa: BLE001
        err_msg = err_msg or f"读取引擎输出异常：{exc}"
    finally:
        watchdog.cancel()
        _terminate(proc)
        with _active_lock:
            _active_procs.discard(proc)
        step(index, "浏览器已关闭")

    if data is None and err_msg is None:
        err_msg = "浏览器引擎未返回结果（进程可能被终止或超时）"
        if stderr_tail:
            # 引擎 stderr 可能含浏览器组件内部字样/文件路径，仅记入服务端日志，不透出前端
            with print_lock:
                print(f"{datetime.now().strftime('%H:%M:%S')} 任务{index} 引擎 stderr 末尾：{''.join(stderr_tail[-5:]).strip()}")
    return data, err_msg, partial, recording_dir


def worker(index: int) -> dict:
    ensure_config_loaded()
    start = time.time()
    deadline_at = start + _register_timeout_s()
    _progress_update(index, status="running", step="任务启动", email="")
    mailbox: dict | None = None
    mailbox_settled = False
    acct_proxy = ""
    exit_ip = ""
    identity = None

    def _fail_timeout() -> dict:
        nonlocal mailbox_settled
        err = _timeout_error_message()
        if mailbox is not None and not mailbox_settled:
            try:
                mail_provider.mark_mailbox_result(mailbox, success=False, error=err)
                mailbox_settled = True
            except Exception:
                pass
        email = str((mailbox or {}).get("address") or "").strip()
        fetch_url = str((mailbox or {}).get("fetch_url") or "")
        if email:
            register_abnormal_service.add(
                email,
                fetch_url=fetch_url,
                reason=err,
                **_proxy_diag_fields(acct_proxy, identity, exit_ip),
            )
            log(f"{email} 注册超时，已记入异常清单", "yellow")
        cost = time.time() - start
        with stats_lock:
            stats["done"] += 1
            stats["fail"] += 1
        log(f"任务 {index} {err}，耗时 {cost:.1f} 秒", "red")
        return {"ok": False, "index": index, "error": err}

    def _abort_stopped() -> dict:
        """手动停止：已领邮箱的任务记入异常清单，避免「失败数」与清单条数不一致。"""
        nonlocal mailbox_settled
        err = "注册任务已停止（手动终止）"
        email = str((mailbox or {}).get("address") or "").strip()
        fetch_url = str((mailbox or {}).get("fetch_url") or "")
        if mailbox is not None and email and not mailbox_settled:
            try:
                register_abnormal_service.add(
                    email,
                    fetch_url=fetch_url,
                    reason=err,
                    **_proxy_diag_fields(acct_proxy, identity, exit_ip),
                )
                mail_provider.mark_mailbox_result(mailbox, success=False, error=err)
                mailbox_settled = True
                log(f"{email} 注册已停止，已记入异常清单", "yellow")
            except Exception:
                pass
        cost = time.time() - start
        with stats_lock:
            stats["done"] += 1
            stats["fail"] += 1
        log(f"任务{index} 注册任务已停止，跳过启动浏览器", "yellow")
        return {"ok": False, "index": index, "error": err}

    verb = _mailbox_verb()
    try:
        if _remaining_task_seconds(deadline_at) <= 0:
            return _fail_timeout()
        step(index, f"任务启动，开始{verb}邮箱")
        try:
            mailbox = mail_provider.create_mailbox(_mail_config())
        except mail_provider.MailboxPoolExhaustedError as exc:
            with stats_lock:
                stats["done"] += 1
                stats["fail"] += 1
            log(f"任务{index} 取邮箱失败：{exc}", "red")
            return {"ok": False, "index": index, "error": str(exc), "stop_run": True}
        except Exception as exc:  # noqa: BLE001
            with stats_lock:
                stats["done"] += 1
                stats["fail"] += 1
            log(f"任务{index} 取邮箱失败：{exc}", "red")
            return {"ok": False, "index": index, "error": str(exc)}

        if is_stop_requested():
            return _abort_stopped()

        if _remaining_task_seconds(deadline_at) <= 0:
            return _fail_timeout()

        identity = build_identity(enabled_regions=config.get("regions") or ["US"])
        acct_proxy, exit_ip = _acquire_working_proxy(identity, index)
        if is_stop_requested():
            return _abort_stopped()
        _log_proxy_assignment(index, identity, acct_proxy, exit_ip)
        browser_proxy = _browser_proxy_url(acct_proxy, index)

        email = str(mailbox.get("address") or "").strip()
        if not email:
            mail_provider.release_mailbox(mailbox)
            mailbox_settled = True
            with stats_lock:
                stats["done"] += 1
                stats["fail"] += 1
            return {"ok": False, "index": index, "error": "邮箱服务未返回 address"}

        label = str(mailbox.get("label") or "")
        fetch_url = str(mailbox.get("fetch_url") or "")
        set_progress_email(index, email)
        step(index, f"已分配邮箱：{email}")

        if is_stop_requested():
            return _abort_stopped()

        if _remaining_task_seconds(deadline_at) <= 0:
            return _fail_timeout()

        data, err_msg, partial, recording_dir = _run_browser_job(
            index, email, mailbox, browser_proxy, identity, deadline_at=deadline_at,
        )

        # —— 成功：拿到 token —— #
        if data and str(data.get("accessToken") or "").strip():
            mailbox_settled = True
            token = str(data.get("accessToken")).strip()
            acct = _build_account(data, email, acct_proxy, identity, exit_ip)
            # 未改动的凭据用本地已存值回填（改了才存新的、没改保留旧的），避免用空值覆盖已有密码/2FA。
            stored_pwd, stored_totp = _lookup_stored_credentials(email)
            if not str(acct.get("password") or "").strip() and stored_pwd:
                acct["password"] = stored_pwd
            if not str(acct.get("totp_secret") or "").strip() and stored_totp:
                acct["totp_secret"] = stored_totp
            # 同邮箱的旧账号条目（旧 access_token / email:: 占位）先删，避免重复与陈旧凭据。
            # 必须在 _lookup_stored_credentials 之后删（旧凭据就存在旧条目里）。
            removed = _cleanup_stale_accounts_for_email(email, token)
            if removed:
                step(index, f"已清理同邮箱 {removed} 条旧记录")
            mailbox["access_token"] = token
            for field in ("password", "totp_secret", "otpauth_url"):
                val = str(acct.get(field) or "").strip()
                if val:
                    mailbox[field] = val
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
            log(f'{email} {"注册" if mode == "register" else "账号加固"}成功，耗时 {cost:.1f} 秒，平均每个 {avg:.1f} 秒', "green")
            cred_parts = []
            if str(acct.get("password") or "").strip():
                cred_parts.append(f"密码 {acct['password']}")
            if str(acct.get("totp_secret") or "").strip():
                cred_parts.append(f"双重验证密钥 {acct['totp_secret']}")
            if cred_parts:
                step(index, "账号凭据 · " + " · ".join(cred_parts), "green")
            return {"ok": True, "index": index, "result": acct}

        # —— 失败：可能带 partial token（step8 失败但已拿 token）—— #
        mailbox_settled = True
        token = str((partial or {}).get("accessToken") or "").strip()
        abnormal_extra = {
            **_proxy_diag_fields(acct_proxy, identity, exit_ip),
            **({"recording_path": recording_dir} if recording_dir else {}),
        }
        if token:
            register_abnormal_service.add(
                email, fetch_url=fetch_url, reason=str(err_msg or "register_error"),
                access_token=token, password=(partial or {}).get("password"),
                **abnormal_extra,
            )
            mailbox["access_token"] = token
            mail_provider.mark_mailbox_result(mailbox, success=False, error=err_msg)
            log(f"{email} 注册部分完成，登录凭证已保存到异常清单：{err_msg}", "yellow")
        else:
            register_abnormal_service.add(
                email, fetch_url=fetch_url, reason=str(err_msg or "register_error"),
                **abnormal_extra,
            )
            mail_provider.mark_mailbox_result(mailbox, success=False, error=err_msg)
            log(f"{email} 注册失败，已记入异常清单：{err_msg}", "yellow")

        cost = time.time() - start
        with stats_lock:
            stats["done"] += 1
            stats["fail"] += 1
        log(f"任务 {index} 注册失败，耗时 {cost:.1f} 秒，原因：{err_msg}", "red")
        return {"ok": False, "index": index, "error": err_msg or "注册失败"}
    except Exception as e:  # noqa: BLE001
        if mailbox is not None:
            try:
                mail_provider.mark_mailbox_result(mailbox, success=False, error=e)
                mailbox_settled = True
            except Exception:
                pass
        email = str((mailbox or {}).get("address") or "").strip()
        fetch_url = str((mailbox or {}).get("fetch_url") or "")
        if email:
            register_abnormal_service.add(
                email,
                fetch_url=fetch_url,
                reason=str(e),
                **_proxy_diag_fields(acct_proxy, identity, exit_ip),
            )
            log(f"{email} 注册异常，已记入异常清单：{e}", "yellow")
        cost = time.time() - start
        with stats_lock:
            stats["done"] += 1
            stats["fail"] += 1
        log(f"任务 {index} 注册异常，耗时 {cost:.1f} 秒，原因：{e}", "red")
        return {"ok": False, "index": index, "error": str(e)}
    finally:
        if mailbox is not None and not mailbox_settled:
            try:
                mail_provider.release_mailbox(mailbox)
            except Exception:
                pass
        _remove_progress(index)
