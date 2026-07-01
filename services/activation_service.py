from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from services.account_service import account_service
from services.cdk_service import cdk_service
from services import cdk_redeem_client
from services.cdk_redeem_client import (
    AuthError,
    CdkRedeemClient,
    RedeemError,
    classify,
    item_for_cdk,
    item_message,
    item_status,
    item_task_id,
    queue_ahead,
    scrub,
)
from services.config import config

CDK_TYPES = ("UPI", "IDEL")

STATUS_UNACTIVATED = "未激活"
STATUS_QUEUED = "排队中"
STATUS_ACTIVATING = "激活中"
STATUS_ACTIVATED = "已激活"
STATUS_FAILED = "激活失败"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ActivationService:
    """Plus 激活引擎：仿 register_service 的「后台线程 + 线程池 + stats + SSE」结构。

    每账号先用 UPI 类 CDK 尝试至多 N 次 → 再换 IDEL 类至多 N 次 → 两类都失败标记「激活失败」。
    CDK 成功消耗前一直有效（失败不消耗）；服务端 not_found 的 CDK 标记 invalid。
    """

    def __init__(self):
        self._lock = threading.RLock()
        self._runner: threading.Thread | None = None
        self._stop = threading.Event()
        self._logs: list[dict] = []
        self._stats: dict = self._empty_stats()

    @staticmethod
    def _empty_stats() -> dict:
        return {"total": 0, "done": 0, "success": 0, "fail": 0, "running": 0, "started_at": None, "finished_at": None, "updated_at": None}

    # ----------------------------- 对外只读 ----------------------------- #

    def summary(self) -> dict:
        accounts = account_service.list_accounts()
        free = sum(1 for a in accounts if a.get("plus_status", STATUS_UNACTIVATED) == STATUS_UNACTIVATED)
        activated = sum(1 for a in accounts if a.get("plus_status") == STATUS_ACTIVATED)
        activating = sum(1 for a in accounts if a.get("plus_status") in (STATUS_QUEUED, STATUS_ACTIVATING))
        return {"free": free, "activated": activated, "activating": activating, "total": len(accounts)}

    def get(self) -> dict:
        with self._lock:
            running = bool(self._runner and self._runner.is_alive())
            return {
                "running": running,
                "stats": dict(self._stats),
                "summary": self.summary(),
                "logs": self._logs[-300:],
            }

    def _append_log(self, text: str, level: str = "info", log_sink=None) -> None:
        with self._lock:
            self._logs.append({"time": _now(), "text": scrub(text), "level": level})
            self._logs = self._logs[-300:]
        # 自动激活链路：把同一条进度转发到注册机日志面板（前缀区分来源）。
        if log_sink is not None:
            try:
                log_sink(f"[自动激活] {scrub(text)}", level or "info")
            except Exception:
                pass

    def _bump(self, **updates) -> None:
        with self._lock:
            self._stats.update(updates)
            self._stats["updated_at"] = _now()

    # ----------------------------- 启动/停止 ----------------------------- #

    def start(self, tokens: list[str] | None = None) -> dict:
        with self._lock:
            if self._runner and self._runner.is_alive():
                return self.get()
            cfg = config.cdk_activation
            if not cfg["api_key"]:
                self._append_log("未配置 CDK API Key，无法激活（请在设置中填写）", "red")
                return self.get()
            targets = self._resolve_targets(tokens)
            if not targets:
                self._append_log("没有需要激活的账号", "yellow")
                return self.get()
            self._stop.clear()
            self._logs = []
            self._stats = {**self._empty_stats(), "job_id": uuid.uuid4().hex, "total": len(targets), "started_at": _now(), "updated_at": _now()}
            self._runner = threading.Thread(target=self._run, args=(targets, cfg), daemon=True, name="cdk-activation")
            self._runner.start()
            self._append_log(f"激活任务启动，目标账号 {len(targets)} 个，并发 {cfg['concurrency']}", "yellow")
            return self.get()

    def stop(self) -> dict:
        self._stop.set()
        self._append_log("已请求停止激活任务，正在等待当前任务结束", "yellow")
        return self.get()

    def activate_token_async(self, token: str, log_sink=None) -> bool:
        """注册成功后由注册机调用：若开启「注册后自动激活」且配置了 API Key，
        起一个后台线程对单个账号尝试激活（不影响批量激活任务）。返回是否已派发。

        log_sink：可选回调 (text, level)，用于把本次自动激活的进度**同时**转发到注册机
        日志面板（注册机与激活是同一条链路，用户在同一面板追踪全过程）。
        """
        cfg = config.cdk_activation
        if not cfg.get("auto_activate_after_register"):
            return False
        if not cfg["api_key"]:
            self._append_log("已开启注册后自动激活，但未配置 CDK API Key，跳过", "yellow", log_sink)
            return False
        if cdk_service.counts().get("available", 0) <= 0:
            self._append_log("已开启注册后自动激活，但当前无可用 CDK，跳过", "yellow", log_sink)
            return False

        def _worker():
            client = CdkRedeemClient(cfg["base_url"], cfg["api_key"])
            try:
                self._activate_account(client, token, cfg, log_sink=log_sink)
            except AuthError as exc:
                self._append_log(f"自动激活鉴权失败：{exc}", "red", log_sink)
            except Exception as exc:  # noqa: BLE001
                self._append_log(f"自动激活异常：{exc}", "red", log_sink)
            finally:
                client.close()

        threading.Thread(target=_worker, daemon=True, name=f"auto-activate-{token[:8]}").start()
        self._append_log(f"注册成功后已自动派发激活：{token[:8]}…", "", log_sink)
        return True

    def _resolve_targets(self, tokens: list[str] | None) -> list[str]:
        accounts = account_service.list_accounts()
        by_token = {a.get("access_token"): a for a in accounts}
        if tokens:
            # 显式选中：给予一次全新激活机会（重置已尝试次数与失败态）。
            result = []
            for token in tokens:
                acct = by_token.get(token) or by_token.get(account_service.resolve_access_token(token))
                if not acct:
                    continue
                real = acct.get("access_token")
                if acct.get("plus_status") == STATUS_ACTIVATED:
                    continue
                account_service.update_account(real, {
                    "plus_status": STATUS_UNACTIVATED,
                    "plus_attempts": {"UPI": 0, "IDEL": 0},
                    "plus_last_message": None,
                }, quiet=True)
                result.append(real)
            return result
        # 默认：所有未激活账号。
        return [a.get("access_token") for a in accounts if a.get("plus_status", STATUS_UNACTIVATED) == STATUS_UNACTIVATED]

    # ----------------------------- 运行 ----------------------------- #

    def _run(self, targets: list[str], cfg: dict) -> None:
        client = CdkRedeemClient(cfg["base_url"], cfg["api_key"])
        done = success = fail = 0
        lock = threading.Lock()
        try:
            with ThreadPoolExecutor(max_workers=cfg["concurrency"]) as executor:
                futures = [executor.submit(self._activate_account, client, token, cfg) for token in targets]
                self._bump(running=min(len(targets), cfg["concurrency"]))
                for future in futures:
                    if self._stop.is_set():
                        pass
                    try:
                        ok = future.result()
                    except Exception as exc:
                        ok = False
                        self._append_log(f"激活异常: {exc}", "red")
                    with lock:
                        done += 1
                        success += 1 if ok else 0
                        fail += 0 if ok else 1
                    self._bump(done=done, success=success, fail=fail, running=max(0, min(len(targets) - done, cfg["concurrency"])))
        except AuthError as exc:
            self._append_log(f"{exc}，已停止整轮激活", "red")
        finally:
            client.close()
        self._bump(running=0, finished_at=_now())
        self._append_log(f"激活任务结束，成功 {success}，失败 {fail}", "yellow")

    def _set_account(self, token: str, **fields) -> None:
        fields["plus_updated_at"] = _now()
        account_service.update_account(token, fields, quiet=True)

    def _activate_account(self, client: CdkRedeemClient, token: str, cfg: dict, log_sink=None) -> bool:
        if self._stop.is_set():
            return False
        acct = account_service.get_account(token)
        email = (acct or {}).get("email") or token[:8]
        attempts = dict((acct or {}).get("plus_attempts") or {"UPI": 0, "IDEL": 0})
        max_attempts = int(cfg["max_attempts_per_type"])
        any_attempt = False

        for cdk_type in CDK_TYPES:
            tried: set[str] = set()
            while attempts.get(cdk_type, 0) < max_attempts and not self._stop.is_set():
                cdk = cdk_service.acquire_available(cdk_type, exclude=tried)
                if not cdk:
                    self._append_log(f"[{email}] 无可用 {cdk_type} CDK，跳过该类型", "yellow", log_sink)
                    break
                tried.add(cdk)
                any_attempt = True
                self._set_account(token, plus_status=STATUS_QUEUED, plus_cdk=cdk, plus_last_message=f"提交 {cdk_type} CDK 兑换")
                self._append_log(f"[{email}] 尝试 {cdk_type} CDK（第 {attempts.get(cdk_type, 0) + 1}/{max_attempts} 次）", "", log_sink)
                try:
                    cls, status, message, task_id = self._attempt(client, token, cdk, cfg)
                except AuthError:
                    raise
                except RedeemError as exc:
                    cls, status, message, task_id = "fail", "error", str(exc), ""

                if cls == "success":
                    cdk_service.consume(cdk, token)
                    self._set_account(token, plus_status=STATUS_ACTIVATED, type="Plus", plus_task_id=task_id, plus_last_message=message or "兑换成功")
                    self._append_log(f"[{email}] 激活成功（{cdk_type}）", "green", log_sink)
                    return True
                if cls == "cdk_invalid":
                    cdk_service.mark_invalid(cdk)
                    self._append_log(f"[{email}] CDK {scrub(cdk)} 无效(not_found)，换下一个", "yellow", log_sink)
                    continue  # 不计入尝试次数
                # fail / pending(timeout) / unknown → 计一次失败尝试，CDK 保持可用
                attempts[cdk_type] = attempts.get(cdk_type, 0) + 1
                self._set_account(token, plus_attempts=attempts, plus_last_message=message or status)
                self._append_log(f"[{email}] {cdk_type} 第 {attempts[cdk_type]} 次失败：{scrub(message or status)}", "red", log_sink)

        self._set_account(token, plus_status=STATUS_FAILED,
                          plus_last_message=("两种类型 CDK 均激活失败" if any_attempt else "无可用 CDK"))
        if any_attempt:
            self._append_log(f"[{email}] 两种类型 CDK 均激活失败，标记激活失败", "red", log_sink)
        return False

    def _attempt(self, client: CdkRedeemClient, token: str, cdk: str, cfg: dict) -> tuple[str, str, str, str]:
        """一次提交 + 轮询到终态。返回 (cls, status, message, task_id)。"""
        js = client.submit(cdk, token)
        code = cdk_redeem_client.env_code(js)
        if code not in (None, 0):
            return "fail", f"code={code}", cdk_redeem_client.env_msg(js) or "envelope code!=0", ""
        it = item_for_cdk(js, cdk)
        task_id = item_task_id(it)
        status = item_status(it)
        cls = classify(status)
        self._reflect_progress(token, it)
        if cls in ("success", "fail", "cdk_invalid"):
            return cls, status, item_message(it), task_id

        deadline = time.time() + float(cfg["poll_timeout"])
        interval = float(cfg["poll_interval"])
        while time.time() < deadline and not self._stop.is_set():
            time.sleep(interval)
            sjs = client.query_status([cdk])
            sit = item_for_cdk(sjs, cdk)
            status = item_status(sit)
            self._reflect_progress(token, sit)
            cls = classify(status)
            if cls in ("success", "fail", "cdk_invalid"):
                return cls, status, item_message(sit), item_task_id(sit) or task_id
        return "fail", status or "timeout", "兑换超时（仍在排队/处理）", task_id

    def _reflect_progress(self, token: str, it: dict | None) -> None:
        if not isinstance(it, dict):
            return
        q = queue_ahead(it)
        message = item_message(it)
        if q is not None:
            note = f"排队中，前面还有 {q} 个" + (f"·{message}" if message else "")
            self._set_account(token, plus_status=STATUS_QUEUED, plus_last_message=note)
        else:
            self._set_account(token, plus_status=STATUS_ACTIVATING, plus_last_message=message or "兑换中")


activation_service = ActivationService()
