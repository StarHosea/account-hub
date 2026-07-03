from __future__ import annotations

import json
import random
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path

from services.account_service import account_service
from services.config import DATA_DIR, config
from services.register import mail_provider, openai_register


REGISTER_FILE = DATA_DIR / "register.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_mail() -> dict:
    return {
        "request_timeout": 30,
        "wait_timeout": 60,
        "wait_interval": 3,
        "providers": [{"type": mail_provider.API_MAILBOX_TYPE, "enable": True, "label": "API邮箱"}],
    }


def _default_config() -> dict:
    return {
        "mail": _default_mail(),
        "proxy": "",
        "total": 10,
        "threads": 3,
        "enabled": False,
        "enable_2fa": True,
        "regions": ["US"],
        "ipweb_rotate": False,
        "ip_duration": 120,
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


def _normalize(raw: dict) -> dict:
    cfg = _default_config()
    cfg["total"] = max(1, int(raw.get("total") or cfg["total"]))
    cfg["threads"] = max(1, int(raw.get("threads") or cfg["threads"]))
    cfg["proxy"] = str(raw.get("proxy") or "").strip()
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
    cfg["ipweb_rotate"] = bool(raw.get("ipweb_rotate"))
    cfg["ip_duration"] = min(2880, max(1, int(raw.get("ip_duration") or 120)))
    base_stats = _default_config()["stats"]
    raw_stats = raw.get("stats") if isinstance(raw.get("stats"), dict) else {}
    cfg["stats"] = {**base_stats, **{k: raw_stats[k] for k in base_stats if k in raw_stats}, "threads": cfg["threads"]}
    return cfg


class RegisterService:
    def __init__(self, store_file: Path):
        self._store_file = store_file
        self._storage = config.get_storage_backend()
        self._lock = threading.RLock()
        self._runner: threading.Thread | None = None
        self._logs: list[dict] = []
        openai_register.register_log_sink = self._append_log
        self._config = self._load()
        # 注意：不在构造时 auto-start。续跑统一由 api/app.py lifespan 调 resume_if_enabled()，
        # 确保「对账清中间态」先于「续跑」执行，且避免被 import 副作用意外拉起注册任务。

    def resume_if_enabled(self) -> None:
        """进程启动时由 lifespan 调用：若上次退出时任务处于运行态（enabled=True），自动续跑。

        续跑语义 = 重新跑满 total（非精确断点续跑）；邮箱 used 标志保证不会重复注册同一邮箱。
        """
        with self._lock:
            enabled = bool(self._config.get("enabled"))
        if enabled:
            self._append_log("检测到上次注册任务未结束，自动续跑（重新跑满目标数）", "yellow")
            self.start()

    def _load(self) -> dict:
        data = self._storage.load_state("register")
        if data is None:
            # 后端首次启动：从旧 data/register.json 迁移种子配置。
            data = self._read_legacy_config()
            normalized = _normalize(data)
            self._storage.save_state("register", normalized)
            return normalized
        return _normalize(data)

    def _read_legacy_config(self) -> dict:
        try:
            return json.loads(self._store_file.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save(self) -> None:
        self._storage.save_state("register", self._config)

    def get(self) -> dict:
        with self._lock:
            base = json.loads(json.dumps({**self._config, "logs": self._logs[-300:]}, ensure_ascii=False))
        # 正在注册的实时进度（按任务号），与 stats/logs 一起随 SSE 推给前端。
        base["progress"] = openai_register.progress_snapshot()
        return base

    def _push_to_worker(self) -> None:
        openai_register.config.update({k: self._config[k] for k in ("mail", "proxy", "total", "threads", "enable_2fa", "regions", "ipweb_rotate", "ip_duration")})

    def update(self, updates: dict) -> dict:
        with self._lock:
            self._config = _normalize({**self._config, **updates})
            self._push_to_worker()
            self._save()
            return self.get()

    def start(self) -> dict:
        with self._lock:
            if self._runner and self._runner.is_alive():
                self._config["enabled"] = True
                self._save()
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
            self._append_log(f"注册任务启动，目标数量={self._config['total']}，线程数={self._config['threads']}", "yellow")
            return self.get()

    def stop(self) -> dict:
        with self._lock:
            self._config["enabled"] = False
            self._config["stats"]["updated_at"] = _now()
            self._save()
            self._append_log("已请求停止注册任务，正在等待当前运行任务结束", "yellow")
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

    def _run(self) -> None:
        threads = int(self.get()["threads"])
        total = int(self.get()["total"])
        submitted, done, success, fail = 0, 0, 0, 0
        with ThreadPoolExecutor(max_workers=threads) as executor:
            futures = set()
            while True:
                while self.get()["enabled"] and submitted < total and len(futures) < threads:
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
                    except Exception:
                        fail += 1
        self._bump(running=0, done=done, success=success, fail=fail, finished_at=_now(), **self._pool_metrics())
        with self._lock:
            self._config["enabled"] = False
            self._save()
        self._append_log(f"注册任务结束，成功{success}，失败{fail}", "yellow")


register_service = RegisterService(REGISTER_FILE)
