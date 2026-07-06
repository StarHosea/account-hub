from __future__ import annotations

import json
import random
import re
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path

from services.account_service import account_service
from services.config import DATA_DIR, config
from services.register import mail_provider, openai_register, fingerprint
from services.register_diag_service import delete_all_recordings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


_TASK_INDEX_RE = re.compile(r"(?:\[任务(\d+)\]|任务\s*(\d+))")


def _task_indices_from_text(text: str) -> set[int]:
    out: set[int] = set()
    for match in _TASK_INDEX_RE.finditer(str(text or "")):
        raw = match.group(1) or match.group(2)
        if raw:
            out.add(int(raw))
    return out


def _log_entry_matches_emails(entry: dict, needles: set[str], task_indices: set[int]) -> bool:
    text = str(entry.get("text") or "")
    lower = text.lower()
    if any(needle in lower for needle in needles):
        return True
    if not task_indices:
        return False
    for index in task_indices:
        if re.search(rf"\[任务{index}\]|任务\s*{index}\b", text):
            return True
    return False


def _default_mail() -> dict:
    return {
        "request_timeout": 30,
        "wait_timeout": 300,
        "wait_interval": 3,
        "providers": [{"type": mail_provider.API_MAILBOX_TYPE, "enable": True, "label": "API邮箱"}],
    }


def _default_config() -> dict:
    return {
        "mail": _default_mail(),
        "proxy": "",
        "proxy_mode": "ipweb",
        "http_proxy": "http://127.0.0.1:7890",
        "total": 10,
        "threads": 3,
        "enabled": False,
        "enable_2fa": True,
        "regions": ["US"],
        "ipweb_rotate": False,
        "ip_duration": 120,
        # 出口 IP 探活重试次数（换 SID 后经代理探活，最多试这么多次；0=关闭探活）
        "ip_probe_retries": 6,
        # 浏览器引擎（CloakBrowser）相关：注册内核已完全替换为浏览器引擎
        "engine": "browser",
        "headless": False,
        "register_timeout": 600,
        "node_bin": "node",
        # 浏览器静态资源 route 缓存（JS/CSS/字体等，不共享 Cookie）
        "static_cache_enabled": True,
        "static_cache_max_age_days": 7,
        "static_cache_dir": "",
        # 注册失败 DOM/Trace 存证（默认开启，目录 data/recordings）
        "record_enabled": True,
        "record_dir": "",
        "record_keep": "fail",
        "diag_public_url": "",
        "stats": {
            "success": 0,
            "fail": 0,
            "done": 0,
            "running": 0,
            "threads": 3,
            "elapsed_seconds": 0,
            "avg_seconds": 0,
            "success_rate": 0,
            "current_available": 0,
        },
    }


def _normalize_providers(mail: dict) -> list[dict]:
    """保留用户配置的邮箱 provider（api_mailbox / cloudmail_gen）；缺省回退 API 邮箱池。"""
    providers = mail.get("providers") if isinstance(mail.get("providers"), list) else []
    cleaned: list[dict] = []
    for item in providers:
        if not isinstance(item, dict):
            continue
        t = str(item.get("type") or mail_provider.API_MAILBOX_TYPE)
        if t not in (mail_provider.API_MAILBOX_TYPE, mail_provider.CLOUDMAIL_TYPE):
            continue
        entry = {"type": t, "enable": bool(item.get("enable", True))}
        if t == mail_provider.CLOUDMAIL_TYPE:
            entry.update({
                "api_base": str(item.get("api_base") or "").strip(),
                "admin_email": str(item.get("admin_email") or "").strip(),
                "admin_password": str(item.get("admin_password") or "").strip(),
                "domain": item.get("domain") or [],
                "subdomain": item.get("subdomain") or [],
                "email_prefix": str(item.get("email_prefix") or "").strip(),
                "label": "CloudMail",
            })
        else:
            entry["label"] = "API邮箱"
        cleaned.append(entry)
    if not cleaned:
        cleaned = [{"type": mail_provider.API_MAILBOX_TYPE, "enable": True, "label": "API邮箱"}]
    return cleaned


def _infer_proxy_mode(proxy: str) -> str:
    p = str(proxy or "").strip()
    if not p:
        return "ipweb"
    parsed = fingerprint.parse_proxy(p)
    if parsed and parsed.host.endswith("ipweb.cc") and parsed.user.startswith("B_"):
        return "ipweb"
    return "http"


def _normalize(raw: dict) -> dict:
    cfg = _default_config()
    cfg["total"] = max(1, int(raw.get("total") or cfg["total"]))
    cfg["threads"] = max(1, int(raw.get("threads") or cfg["threads"]))
    cfg["proxy"] = str(raw.get("proxy") or "").strip()
    mode = str(raw.get("proxy_mode") or "").strip().lower()
    cfg["proxy_mode"] = mode if mode in ("none", "ipweb", "http") else _infer_proxy_mode(cfg["proxy"])
    cfg["http_proxy"] = str(raw.get("http_proxy") or "").strip() or "http://127.0.0.1:7890"
    if cfg["proxy_mode"] == "none":
        cfg["proxy"] = ""
    mail = raw.get("mail") if isinstance(raw.get("mail"), dict) else {}
    cfg["mail"] = {
        "request_timeout": float(mail.get("request_timeout") or 30),
        "wait_timeout": float(mail.get("wait_timeout") or 60),
        "wait_interval": float(mail.get("wait_interval") or 3),
        "providers": _normalize_providers(mail),
    }
    cfg["enabled"] = bool(raw.get("enabled"))
    # 缺失时回退到默认（现默认开），避免旧配置文件没有该键就被强制关掉。
    cfg["enable_2fa"] = bool(raw.get("enable_2fa", cfg["enable_2fa"]))
    valid_regions = set(openai_register.fingerprint.REGIONS.keys())
    raw_regions = raw.get("regions") if isinstance(raw.get("regions"), list) else []
    cfg["regions"] = [r for r in raw_regions if r in valid_regions] or ["US"]
    # 未显式配置时：ipweb 动态住宅代理（B_<id>_..._<SID>）默认开启号一号一 IP。
    if "ipweb_rotate" in raw:
        cfg["ipweb_rotate"] = bool(raw.get("ipweb_rotate"))
    elif cfg["proxy_mode"] == "http":
        cfg["ipweb_rotate"] = False
    elif cfg["proxy_mode"] == "none":
        cfg["ipweb_rotate"] = False
    else:
        parsed = fingerprint.parse_proxy(cfg["proxy"])
        cfg["ipweb_rotate"] = bool(
            parsed
            and parsed.host.endswith("ipweb.cc")
            and parsed.user.startswith("B_")
        )
    cfg["register_timeout"] = min(1800, max(60, int(raw.get("register_timeout") or 600)))
    # ipweb 一号一 IP 粘性时长与单次注册时限对齐（分钟）
    cfg["ip_duration"] = min(2880, max(1, (cfg["register_timeout"] + 59) // 60))
    # 出口 IP 探活重试：0 关闭探活（旧行为），上限 20 次避免死循环空转
    cfg["ip_probe_retries"] = min(20, max(0, int(raw.get("ip_probe_retries", cfg["ip_probe_retries"]))))
    # 浏览器引擎配置：engine 固定 browser；headless 默认有头（Linux 上配 Xvfb）；
    # register_timeout 每账号整轮超时（秒）；node_bin 为 node 可执行文件。
    cfg["engine"] = "browser"
    cfg["headless"] = bool(raw.get("headless"))
    cfg["node_bin"] = str(raw.get("node_bin") or "node").strip() or "node"
    cfg["static_cache_enabled"] = bool(raw.get("static_cache_enabled", cfg["static_cache_enabled"]))
    cfg["static_cache_max_age_days"] = min(90, max(1, int(raw.get("static_cache_max_age_days") or cfg["static_cache_max_age_days"])))
    cfg["static_cache_dir"] = str(raw.get("static_cache_dir") or "").strip()
    cfg["record_enabled"] = bool(raw.get("record_enabled", cfg["record_enabled"]))
    cfg["record_dir"] = str(raw.get("record_dir") or "").strip()
    keep = str(raw.get("record_keep") or cfg["record_keep"]).strip().lower()
    cfg["record_keep"] = keep if keep in {"fail", "all", "none"} else "fail"
    cfg["diag_public_url"] = str(raw.get("diag_public_url") or cfg.get("diag_public_url") or "").strip().rstrip("/")
    base_stats = _default_config()["stats"]
    raw_stats = raw.get("stats") if isinstance(raw.get("stats"), dict) else {}
    cfg["stats"] = {**base_stats, **{k: raw_stats[k] for k in base_stats if k in raw_stats}, "threads": cfg["threads"]}
    return cfg


def _resolve_static_cache_dir(cfg: dict) -> Path:
  raw = str(cfg.get("static_cache_dir") or "").strip()
  if raw:
    p = Path(raw)
    return p if p.is_absolute() else DATA_DIR.parent / p
  return DATA_DIR / "http-cache"


def _resolve_record_dir(cfg: dict) -> Path:
    if not bool(cfg.get("record_enabled", True)):
        return Path()
    raw = str(cfg.get("record_dir") or "").strip()
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else DATA_DIR.parent / p
    return DATA_DIR / "recordings"


def _record_stats(cfg: dict) -> dict:
    path = _resolve_record_dir(cfg)
    dir_count = 0
    size_bytes = 0
    if path.is_dir():
        try:
            for entry in path.iterdir():
                if not entry.is_dir():
                    continue
                dir_count += 1
                for file_path in entry.rglob("*"):
                    if not file_path.is_file():
                        continue
                    try:
                        size_bytes += file_path.stat().st_size
                    except OSError:
                        pass
        except OSError:
            pass
    return {
        "record_dir_count": dir_count,
        "record_size_bytes": size_bytes,
        "record_resolved_dir": str(path),
    }


def _static_cache_stats(cfg: dict) -> dict:
  path = _resolve_static_cache_dir(cfg)
  size_bytes = 0
  file_count = 0
  if path.is_dir():
    try:
      for entry in path.rglob("*"):
        if not entry.is_file():
          continue
        try:
          size_bytes += entry.stat().st_size
          file_count += 1
        except OSError:
          pass
    except OSError:
      pass
  return {
    "static_cache_size_bytes": size_bytes,
    "static_cache_file_count": file_count,
    "static_cache_resolved_dir": str(path),
  }


class RegisterService:
    def __init__(self):
        self._storage = config.get_storage_backend()
        self._lock = threading.RLock()
        self._runner: threading.Thread | None = None
        self._logs: list[dict] = []
        self._reserved_mailboxes: list[dict[str, str]] = []
        openai_register.register_log_sink = self._append_log
        self._config = self._load()
        self._push_to_worker()
        # 注意：不在构造时 auto-start。续跑统一由 api/app.py lifespan 调 resume_if_enabled()，
        # 确保「对账清中间态」先于「续跑」执行，且避免被 import 副作用意外拉起注册任务。

    def resume_if_enabled(self) -> None:
        """进程启动时由 lifespan 调用：若上次退出时任务处于运行态（enabled=True），自动续跑。

        续跑语义 = 重新跑满 total（非精确断点续跑）；邮箱 used 标志保证不会重复注册同一邮箱。
        """
        with self._lock:
            enabled = bool(self._config.get("enabled"))
        if not enabled:
            return
        if mail_provider.is_api_pool_exhausted(self.get().get("mail") or {}):
            with self._lock:
                self._config["enabled"] = False
                self._save()
            self._append_log("检测到上次注册任务未结束，但邮箱池已无可用地址，已自动停止续跑", "yellow")
            return
        self._append_log("检测到上次注册任务未结束，自动续跑并将重新完成目标数量", "yellow")
        self.start()

    def _load(self) -> dict:
        data = self._storage.load_state("register")
        if data is None:
            normalized = _normalize({})
            self._storage.save_state("register", normalized)
            return normalized
        return _normalize(data)

    def _save(self) -> None:
        self._storage.save_state("register", self._config)

    def get(self) -> dict:
        with self._lock:
            base = json.loads(json.dumps({**self._config, "logs": self._logs[-300:]}, ensure_ascii=False))
        # 正在注册的实时进度（按任务号），与 stats/logs 一起随 SSE 推给前端。
        base["progress"] = openai_register.progress_snapshot()
        stats = base.get("stats") if isinstance(base.get("stats"), dict) else {}
        stats["active_browsers"] = openai_register.active_browser_count()
        base["stats"] = stats
        base.update(_static_cache_stats(self._config))
        base.update(_record_stats(self._config))
        return base

    def _push_to_worker(self) -> None:
        openai_register.config.update({
            k: self._config[k]
            for k in (
                "mail", "proxy", "total", "threads", "enable_2fa", "regions", "ipweb_rotate",
                "ip_duration", "ip_probe_retries", "engine", "headless", "register_timeout", "node_bin",
                "static_cache_enabled", "static_cache_max_age_days", "static_cache_dir",
                "record_enabled", "record_dir", "record_keep", "diag_public_url",
            )
        })

    def update(self, updates: dict) -> dict:
        with self._lock:
            self._config = _normalize({**self._config, **updates})
            self._push_to_worker()
            self._save()
            return self.get()

    def pop_reserved_mailbox(self) -> dict | None:
        with self._lock:
            if not self._reserved_mailboxes:
                return None
            item = self._reserved_mailboxes.pop(0)
            return {
                "provider": mail_provider.API_MAILBOX_TYPE,
                "provider_ref": f"{mail_provider.API_MAILBOX_TYPE}#1",
                "label": "API邮箱",
                "address": item["email"],
                "fetch_url": item.get("fetch_url") or "",
            }

    def start(self, emails: list[str] | None = None) -> dict:
        with self._lock:
            if self._runner and self._runner.is_alive():
                self._config["enabled"] = True
                self._save()
                return self.get()
            selected = [str(e or "").strip() for e in (emails or []) if str(e or "").strip()]
            if selected:
                reserved = account_service.reserve_emails_for_register(selected)
                self._reserved_mailboxes = []
                for email in reserved:
                    rec = account_service.find_by_email(email) or {}
                    self._reserved_mailboxes.append({
                        "email": email,
                        "fetch_url": str(rec.get("fetch_url") or ""),
                    })
                if not self._reserved_mailboxes:
                    self._append_log("未选中可注册邮箱，注册任务未启动", "yellow")
                    return self.get()
                self._config["total"] = min(int(self._config.get("total") or 1), len(self._reserved_mailboxes))
            elif mail_provider.is_api_pool_exhausted(self._config.get("mail") or {}):
                self._config["enabled"] = False
                self._save()
                self._append_log("邮箱池无可用地址，注册任务未启动", "yellow")
                return self.get()
            self._config["enabled"] = True
            self._logs = []
            openai_register.reset_progress()
            metrics = self._pool_metrics()
            self._config["stats"] = {"job_id": uuid.uuid4().hex, "success": 0, "fail": 0, "done": 0, "running": 0, "threads": self._config["threads"], **metrics, "started_at": _now(), "updated_at": _now()}
            self._push_to_worker()
            with openai_register.stats_lock:
                openai_register.stats.update({"done": 0, "success": 0, "fail": 0, "start_time": time.time()})
            self._save()
            self._runner = threading.Thread(target=self._run, daemon=True, name="openai-register")
            self._runner.start()
            self._append_log(f"注册任务启动，目标 {self._config['total']} 个，并发 {self._config['threads']} 路", "yellow")
            if selected:
                self._append_log(f"已预选邮箱：{', '.join(item['email'] for item in self._reserved_mailboxes)}", "yellow")
            return self.get()

    def stop(self) -> dict:
        with self._lock:
            self._config["enabled"] = False
            self._config["stats"]["updated_at"] = _now()
            self._save()
            self._append_log("已请求停止注册，正在关闭浏览器并等待当前任务结束", "yellow")
        # 终止所有在途 Node/CloakBrowser 子进程（在锁外调用，避免阻塞其它请求）
        try:
            openai_register.request_stop()
        except Exception as exc:  # noqa: BLE001
            self._append_log(f"终止在途浏览器进程时出错：{exc}", "red")
        return self.get()

    def reset(self) -> dict:
        with self._lock:
            self._logs = []
            self._config["stats"] = {"success": 0, "fail": 0, "done": 0, "running": 0, "threads": self._config["threads"], "elapsed_seconds": 0, "avg_seconds": 0, "success_rate": 0, **self._pool_metrics(), "updated_at": _now()}
            with openai_register.stats_lock:
                openai_register.stats.update({"done": 0, "success": 0, "fail": 0, "start_time": 0.0})
            self._save()
            return self.get()

    def clear_logs(self) -> dict:
        """只清空日志，保留统计（供工作台「清空日志」使用）。"""
        with self._lock:
            self._logs = []
            self._save()
            return self.get()

    def clear_recordings(self) -> dict[str, int]:
        """删除全部诊断存证目录（供设置页「清空存证」使用）。"""
        with self._lock:
            return delete_all_recordings()

    def clear_logs_for_emails(self, emails: list[str]) -> int:
        """删除与指定邮箱相关的注册日志（含同任务号的 [任务N] 步骤日志）。"""
        needles = {str(email or "").strip().lower() for email in emails if str(email or "").strip()}
        if not needles:
            return 0
        with self._lock:
            task_indices: set[int] = set()
            for entry in self._logs:
                text = str(entry.get("text") or "")
                if any(needle in text.lower() for needle in needles):
                    task_indices |= _task_indices_from_text(text)
            before = len(self._logs)
            self._logs = [
                entry
                for entry in self._logs
                if not _log_entry_matches_emails(entry, needles, task_indices)
            ]
            removed = before - len(self._logs)
            if removed:
                self._save()
            return removed

    def _append_log(self, text: str, color: str = "") -> None:
        with self._lock:
            self._logs.append({"time": _now(), "text": str(text), "level": str(color or "info")})
            self._logs = self._logs[-300:]

    # 自动激活错峰参数：避免「注册成功秒充 Plus」这种非自然行为聚类
    _ACT_MIN_DELAY = 30.0
    _ACT_MAX_DELAY = 180.0
    _ACT_GAP_MIN = 20.0
    _ACT_GAP_MAX = 60.0

    def _maybe_auto_activate(self, result: dict) -> None:
        """注册成功后，若开启「注册后自动激活」，延迟 + 跨账号错峰派发 Plus 激活。"""
        token = str((result.get("result") or {}).get("access_token") or "").strip()
        if not token:
            return
        delay = random.uniform(self._ACT_MIN_DELAY, self._ACT_MAX_DELAY)
        with self._lock:
            base = max(time.time(), float(getattr(self, "_act_next_floor", 0.0)))
            fire_at = base + delay
            self._act_next_floor = fire_at + random.uniform(self._ACT_GAP_MIN, self._ACT_GAP_MAX)
        timer = threading.Timer(max(0.0, fire_at - time.time()), self._dispatch_activation, args=(token,))
        timer.daemon = True
        timer.start()

    def _dispatch_activation(self, token: str) -> None:
        try:
            from services.activation_service import activation_service
            # 传入注册机日志回调：自动激活全过程（派发 → UPI/IDEL 逐次尝试 → 成功/失败）
            # 同步显示到注册机日志面板，用户在同一处追踪注册→激活全链路。
            activation_service.activate_token_async(token, log_sink=self._append_log)
        except Exception as exc:  # noqa: BLE001
            self._append_log(f"自动激活派发失败：{exc}", "red")

    def _pool_metrics(self) -> dict:
        items = account_service.list_accounts()
        normal = [item for item in items if item.get("status") == "正常"]
        return {"current_available": len(normal)}

    def _bump(self, **updates) -> None:
        with self._lock:
            self._config["stats"].update(updates)
            stats = self._config["stats"]
            started_at = str(stats.get("started_at") or "")
            if started_at:
                try:
                    elapsed = max(0.0, (datetime.now(timezone.utc) - datetime.fromisoformat(started_at)).total_seconds())
                except Exception:
                    elapsed = 0.0
                success = int(stats.get("success") or 0)
                fail = int(stats.get("fail") or 0)
                stats["elapsed_seconds"] = round(elapsed, 1)
                stats["avg_seconds"] = round(elapsed / success, 1) if success else 0
                stats["success_rate"] = round(success * 100 / max(1, success + fail), 1)
            self._config["stats"]["updated_at"] = _now()
            self._save()

    def _stop_for_mailbox_shortage(self, *, pool_stop_logged: list[bool]) -> None:
        with self._lock:
            self._config["enabled"] = False
        # 仅停止 _run 循环继续 submit 新 worker；不 signal_stop_new_tasks。
        # 否则并发下后启动的任务取不到邮箱时会误拦已领到邮箱、尚未开浏览器的在途任务。
        if not pool_stop_logged[0]:
            pool_stop_logged[0] = True
            self._append_log("邮箱不足，已停止提交新任务；在途注册将继续完成", "yellow")

    def _run(self) -> None:
        threads = int(self.get()["threads"])
        total = int(self.get()["total"])
        submitted, done, success, fail = 0, 0, 0, 0
        pool_stop_logged = [False]
        with ThreadPoolExecutor(max_workers=threads) as executor:
            futures = set()
            while True:
                while self.get()["enabled"] and submitted < total and len(futures) < threads:
                    if mail_provider.is_api_pool_exhausted(self.get().get("mail") or {}):
                        self._stop_for_mailbox_shortage(pool_stop_logged=pool_stop_logged)
                        break
                    submitted += 1
                    futures.add(executor.submit(openai_register.worker, submitted))
                self._bump(running=len(futures), done=done, success=success, fail=fail, **self._pool_metrics())
                if not futures:
                    break
                finished, futures = wait(futures, return_when=FIRST_COMPLETED)
                for future in finished:
                    done += 1
                    try:
                        result = future.result()
                        if result.get("ok"):
                            success += 1
                            self._maybe_auto_activate(result)
                        else:
                            fail += 1
                            if result.get("stop_run"):
                                self._stop_for_mailbox_shortage(pool_stop_logged=pool_stop_logged)
                    except Exception:
                        fail += 1
        self._bump(running=0, done=done, success=success, fail=fail, finished_at=_now(), **self._pool_metrics())
        with self._lock:
            self._config["enabled"] = False
            self._save()
        openai_register.reset_stop_requested()
        self._append_log(f"注册任务结束，成功{success}，失败{fail}", "yellow")


register_service = RegisterService()
