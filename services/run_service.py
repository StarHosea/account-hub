from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from services.account_lifecycle import enrich_account
from services.account_service import account_service
from services.activation_service import activation_service, is_activation_eligible
from services.cdk_redeem_client import AuthError, CdkRedeemClient, scrub
from services.cdk_service import cdk_service
from services.config import config
from services.register import openai_register
from services.register_service import register_service


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RunService:
    """一键运行编排：串起「注册 → 激活」。

    目标 = 期望激活成功数（≈消耗 CDK 数）。循环：未激活账号不足且开启自动补注册时，
    先注册补充（受邮箱与 CDK 余量约束），再激活未激活账号消耗 CDK；直到达成目标或资源耗尽。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._runner: threading.Thread | None = None
        self._stop = threading.Event()
        self._logs: list[dict] = []
        self._storage = config.get_storage_backend()
        try:
            _btype = self._storage.get_backend_info().get("type")
        except Exception:
            _btype = None
        self._persist_interval = 1e9 if _btype == "git" else 4.0
        self._last_persist_ts = 0.0
        self._stats: dict = self._load_persisted_stats()

    @staticmethod
    def _empty_stats() -> dict:
        return {
            "target": 0,
            "registered": 0,
            "activated": 0,
            "failed": 0,
            "running": 0,
            "phase": "空闲",
            "job_running": False,
            "job_target": 0,
            "job_replenish": True,
            "job_id": None,
            "started_at": None,
            "finished_at": None,
            "updated_at": None,
        }

    def _load_persisted_stats(self) -> dict:
        try:
            st = self._storage.load_state("run")
        except Exception:
            st = None
        base = self._empty_stats()
        if isinstance(st, dict) and st:
            base.update(st)
        return base

    def _persist_stats(self, force: bool = False) -> None:
        now = time.time()
        if not force and (now - self._last_persist_ts) < self._persist_interval:
            return
        self._last_persist_ts = now
        with self._lock:
            snapshot = dict(self._stats)
        try:
            self._storage.save_state("run", snapshot)
        except Exception:
            pass

    # ----------------------------- 只读 ----------------------------- #
    def _mailbox_available(self) -> int:
        try:
            from services.mailbox_service import mailbox_service
            return sum(1 for m in mailbox_service.list_mailboxes() if mailbox_service._is_available(m))
        except Exception:
            return 0

    def get(self) -> dict:
        with self._lock:
            running = bool(self._runner and self._runner.is_alive())
            return {
                "running": running,
                "stats": dict(self._stats),
                "summary": activation_service.summary(),
                "cdk": cdk_service.counts(),
                "mailbox_available": self._mailbox_available(),
                "logs": self._logs[-300:],
            }

    def _append_log(self, text: str, level: str = "info") -> None:
        with self._lock:
            self._logs.append({"time": _now(), "text": scrub(str(text)), "level": level})
            self._logs = self._logs[-300:]

    def _bump(self, **updates) -> None:
        with self._lock:
            self._stats.update(updates)
            self._stats["updated_at"] = _now()
        self._persist_stats()

    # ----------------------------- 启停 ----------------------------- #
    def start(self, target: int | None = None, auto_replenish: bool | None = None) -> dict:
        with self._lock:
            if self._runner and self._runner.is_alive():
                return self.get()
            cfg = config.cdk_activation
            target = int(target if target is not None else cfg.get("target") or 0)
            replenish = bool(cfg.get("auto_replenish", True) if auto_replenish is None else auto_replenish)
            if target <= 0:
                self._append_log("请先设置目标激活数量（>0）", "red")
                return self.get()
            if not cfg["api_key"]:
                self._append_log("未配置 CDK API Key，无法激活（请在设置中填写）", "red")
                return self.get()
            # 持久化本次运行参数 & 同步注册配置到 worker
            config.update_cdk_activation({"target": target, "auto_replenish": replenish})
            reg = register_service.get()
            openai_register.config.update({k: reg[k] for k in ("mail", "proxy", "total", "threads") if k in reg})
            self._stop.clear()
            self._logs = []
            self._stats = {**self._empty_stats(), "target": target, "phase": "启动", "job_running": True,
                           "job_target": target, "job_replenish": replenish, "job_id": uuid.uuid4().hex,
                           "started_at": _now(), "updated_at": _now()}
            self._runner = threading.Thread(target=self._run, args=(target, replenish, cfg), daemon=True, name="one-click-run")
            self._runner.start()
            self._append_log(f"一键运行启动：目标 {target} 个，自动补注册={'开' if replenish else '关'}", "yellow")
        self._persist_stats(force=True)
        return self.get()

    def resume_if_running(self) -> None:
        """进程启动时由 lifespan 调用：若上次退出时一键运行处于运行态，自动续跑。"""
        try:
            st = self._storage.load_state("run")
        except Exception:
            st = None
        if st and st.get("job_running"):
            self._append_log("检测到上次一键运行未结束，自动续跑", "yellow")
            self.start(target=st.get("job_target"), auto_replenish=st.get("job_replenish"))

    def stop(self) -> dict:
        self._stop.set()
        with self._lock:
            self._stats["job_running"] = False
        self._persist_stats(force=True)
        self._append_log("已请求停止，正在等待当前任务结束", "yellow")
        return self.get()

    # ----------------------------- 运行 ----------------------------- #
    def _unactivated_tokens(self) -> list[str]:
        return [
            str(enrich_account(a).get("access_token") or "")
            for a in account_service.list_accounts()
            if is_activation_eligible(a) and a.get("access_token")
        ]

    def _run(self, target: int, replenish: bool, cfg: dict) -> None:
        client = CdkRedeemClient(cfg["base_url"], cfg["api_key"])
        registered = activated = failed = 0
        try:
            while not self._stop.is_set() and activated < target:
                remaining = target - activated
                cdk_avail = int(cdk_service.counts().get("available", 0))
                if cdk_avail <= 0:
                    self._append_log("无可用 CDK，结束", "yellow")
                    break

                unactivated = self._unactivated_tokens()
                progressed = False

                # 1) 账号不足 → 自动补注册（受目标剩余、CDK 余量约束）
                if len(unactivated) < remaining and replenish:
                    deficit = max(0, min(remaining, cdk_avail) - len(unactivated))
                    if deficit > 0:
                        self._bump(phase="注册补充", running=int(cfg["concurrency"]))
                        ok = self._register_batch(deficit)
                        registered += ok
                        self._bump(registered=registered)
                        if ok > 0:
                            progressed = True
                        else:
                            self._append_log("补注册未产出新账号（邮箱可能耗尽），停止", "red")
                            break
                        unactivated = self._unactivated_tokens()

                if not unactivated:
                    if not replenish:
                        self._append_log("无未激活账号，且未开启自动补注册，结束", "yellow")
                    else:
                        self._append_log("无法补充账号，结束", "yellow")
                    break

                # 2) 激活一批未激活账号
                self._bump(phase="激活中", running=int(cfg["concurrency"]))
                batch = unactivated[:remaining]
                got, completed = self._activate_batch(client, batch, cfg)
                activated += got
                failed += max(0, completed - got)
                self._bump(activated=activated, failed=failed)
                if got > 0:
                    progressed = True

                if not progressed:
                    self._append_log("本轮无新增进展，结束", "yellow")
                    break
        except AuthError as exc:
            self._append_log(f"{exc}，已停止", "red")
        except Exception as exc:  # noqa: BLE001
            self._append_log(f"运行异常：{exc}", "red")
        finally:
            client.close()
            cdk_service.clear_reservations()
        self._bump(running=0, job_running=False, phase="完成", finished_at=_now())
        self._persist_stats(force=True)
        self._append_log(f"运行结束：注册 {registered}，激活成功 {activated}", "green" if activated >= target else "yellow")

    def _register_batch(self, count: int) -> int:
        """并发注册 count 个账号，返回成功数。失败（含邮箱耗尽）只计 0。"""
        threads = max(1, int(openai_register.config.get("threads") or 3))
        ok = 0
        with ThreadPoolExecutor(max_workers=threads) as ex:
            futures = [ex.submit(openai_register.worker, i + 1) for i in range(count)]
            for fut in as_completed(futures):
                if self._stop.is_set():
                    pass
                try:
                    res = fut.result()
                    if res.get("ok"):
                        ok += 1
                    elif res.get("error"):
                        self._append_log(f"注册失败：{res.get('error')}", "red")
                except Exception as exc:  # noqa: BLE001
                    self._append_log(f"注册异常：{exc}", "red")
        return ok

    def _activate_batch(self, client: CdkRedeemClient, tokens: list[str], cfg: dict) -> tuple[int, int]:
        """并发激活，返回 (成功数, 完成数)。"""
        success = completed = 0
        # 把每账号的激活细节（尝试第几次 / 用哪张 CDK / 原始响应）转发到一键运行日志面板。
        def _sink(text: str, level: str = "info") -> None:
            self._append_log(text, level or "info")
        with ThreadPoolExecutor(max_workers=int(cfg["concurrency"])) as ex:
            futures = [ex.submit(activation_service._activate_account, client, t, cfg, _sink) for t in tokens]
            for fut in as_completed(futures):
                try:
                    if fut.result() is True:
                        success += 1
                except Exception as exc:  # noqa: BLE001
                    self._append_log(f"激活异常：{exc}", "red")
                completed += 1
        return success, completed


run_service = RunService()
