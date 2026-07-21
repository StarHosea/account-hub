from __future__ import annotations

import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from services.account_lifecycle import (
    PLAN_FREE,
    STAGE_ACTIVATING,
    STAGE_PLUS_ACTIVATED,
    STAGE_REGISTERED,
    apply_stage,
    enrich_account,
    _norm_email,
)
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
from services.activation_audit_service import (
    OUTCOME_FAILED,
    OUTCOME_SUCCESS,
    ActivationAuditRecorder,
    activation_audit_service,
)
from services.config import config

from services.activation_audit_context import clear_recorder, get_recorder, set_recorder

CDK_TYPES = ("UPI", "IDEL")

# 已完成 CDK 兑换的 stage，下轮激活不再选中。
_ACTIVATION_DONE_STAGES = frozenset({STAGE_PLUS_ACTIVATED})

# _attempt 结束轮询的服务端明确终态；其余（pending/unknown）在接口无服务异常时一直轮询。
_TERMINAL_CLS = frozenset({"success", "fail", "cdk_invalid", "timeout", "cancelled"})


def is_activation_eligible(account: dict) -> bool:
    """与 start() → _resolve_targets 默认分支相同的可选中口径（尚未入队的 registered 免费号）。"""
    item = enrich_account(account)
    if item.get("stage") in _ACTIVATION_DONE_STAGES:
        return False
    if item.get("plus_activated_at"):
        return False
    if item.get("plus_redeem_locked"):
        # 已对该账号提交并被服务端受理过一张 CDK：不再自动提交第二张卡，避免重复激活烧卡。
        return False
    if item.get("plus_unavailable"):
        return False
    return item.get("stage") == STAGE_REGISTERED and item.get("plan") == PLAN_FREE


def can_run_activation(account: dict) -> bool:
    """单账号激活 worker 放行口径：含本轮已标为 activating 的目标。

    _resolve_targets 入选后会把 stage 写成 activating；worker 再跑时不能再用
    is_activation_eligible（仅 registered），否则会全部被跳过。
    """
    item = enrich_account(account)
    if item.get("stage") in _ACTIVATION_DONE_STAGES:
        return False
    if item.get("plus_activated_at"):
        return False
    if item.get("plus_redeem_locked"):
        return False
    if item.get("plus_unavailable"):
        return False
    if item.get("plan") != PLAN_FREE:
        return False
    return item.get("stage") in (STAGE_REGISTERED, STAGE_ACTIVATING)


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
        self._storage = config.get_storage_backend()
        # stats 落库节流：Postgres 等 4s 一次；Git 后端仅在关键节点 force 落库（避免每次 commit）。
        try:
            _btype = self._storage.get_backend_info().get("type")
        except Exception:
            _btype = None
        self._persist_interval = 1e9 if _btype == "git" else 4.0
        self._last_persist_ts = 0.0
        self._stats: dict = self._load_persisted_stats()
        # 进行中（已派发尚未出终态）的账号：以邮箱为唯一 key（token 刷新后会变）。
        # 无邮箱时回退 access_token。仅内存态，进程重启后由 reconcile_stuck_activations 复位。
        self._activating_emails: set[str] = set()

    @staticmethod
    def _empty_stats() -> dict:
        # running：在跑并发数（int，UI 展示）；job_running：整个批次是否运行中（bool，决定重启续跑）。
        return {"total": 0, "done": 0, "success": 0, "fail": 0, "skipped": 0, "review": 0, "running": 0, "job_running": False,
                "job_limit": None, "started_at": None, "finished_at": None, "updated_at": None}

    def _load_persisted_stats(self) -> dict:
        try:
            st = self._storage.load_state("activation")
        except Exception:
            st = None
        base = self._empty_stats()
        if isinstance(st, dict) and st:
            base.update(st)
        return base

    def _persist_stats(self, force: bool = False) -> None:
        """把 stats 落库（节流）。force=True 用于 start/finish/stop 等关键节点，绕过节流立即写。

        job_running 标志的准确性直接决定重启后是否续跑，故关键节点必须 force。
        """
        now = time.time()
        if not force and (now - self._last_persist_ts) < self._persist_interval:
            return
        self._last_persist_ts = now
        with self._lock:
            snapshot = dict(self._stats)
        try:
            self._storage.save_state("activation", snapshot)
        except Exception:
            pass

    # ----------------------------- 对外只读 ----------------------------- #

    def summary(self) -> dict:
        accounts = account_service.list_accounts()
        free = sum(1 for a in accounts if a.get("plus_status", STATUS_UNACTIVATED) == STATUS_UNACTIVATED)
        activated = sum(1 for a in accounts if a.get("plus_status") == STATUS_ACTIVATED)
        activating = sum(1 for a in accounts if a.get("plus_status") in (STATUS_QUEUED, STATUS_ACTIVATING))
        # 按真实套餐 type 判定「是否已激活 Plus」：type==plus 视为已激活，其余（含 free/空）视为未激活。
        # 与上面基于 plus_status 的 free/activated 口径分开：这两个字段供工作台卡片展示用。
        plus_by_type = sum(1 for a in accounts if str(a.get("type") or "").strip().lower() == "plus")
        not_plus_by_type = len(accounts) - plus_by_type
        pending = sum(1 for a in accounts if is_activation_eligible(a))
        return {
            "free": free,
            "activated": activated,
            "activating": activating,
            "total": len(accounts),
            "plus_by_type": plus_by_type,
            "not_plus_by_type": not_plus_by_type,
            "pending": pending,
        }

    def get(self) -> dict:
        with self._lock:
            running = bool(self._runner and self._runner.is_alive())
            stats = dict(self._stats)
            stats["claiming"] = len(self._activating_emails)
            return {
                "running": running,
                "stats": stats,
                "summary": self.summary(),
                "logs": self._logs[-300:],
            }

    def _append_log(self, text: str, level: str = "info", log_sink=None) -> None:
        with self._lock:
            self._logs.append({"time": _now(), "text": scrub(text), "level": level})
            self._logs = self._logs[-300:]
        audit = get_recorder()
        if audit is not None:
            audit.log(text, level)
        # 自动激活链路：把同一条进度转发到注册机日志面板（前缀区分来源）。
        if log_sink is not None:
            try:
                log_sink(f"[自动激活] {scrub(text)}", level or "info")
            except Exception:
                pass

    def _current_job_id(self) -> str | None:
        with self._lock:
            job_id = self._stats.get("job_id")
            return str(job_id) if job_id else None

    @staticmethod
    def _end_audit(recorder: ActivationAuditRecorder, outcome: str, summary: str, token: str, **extra) -> dict:
        record = recorder.finish(outcome, summary, **extra)
        if token:
            account_service.update_account(token, {"last_activation_audit_id": record["id"]}, quiet=True)
        return record

    def _bump(self, **updates) -> None:
        with self._lock:
            self._stats.update(updates)
            self._stats["updated_at"] = _now()
        self._persist_stats()

    @staticmethod
    def _activation_claim_key(token: str, account: dict | None = None) -> str | None:
        """占用锁唯一键：优先规范化邮箱；无邮箱时回退 access_token。"""
        acct = account if account is not None else account_service.get_account(token)
        email = str((acct or {}).get("email") or "").strip()
        if email:
            return _norm_email(email)
        fallback = str((acct or {}).get("access_token") or token or "").strip()
        return fallback or None

    def _try_claim_account(self, claim_key: str) -> bool:
        """原子领取账号激活权：同一邮箱同时只允许一条激活链路（顺序试 CDK）。"""
        key = str(claim_key or "").strip()
        if not key:
            return False
        with self._lock:
            if key in self._activating_emails:
                return False
            self._activating_emails.add(key)
            return True

    def _release_account(self, claim_key: str) -> None:
        with self._lock:
            self._activating_emails.discard(str(claim_key or "").strip())

    def _record_skip(self, email: str, message: str, log_sink=None) -> None:
        self._append_log(f"[{email}] {message}", "yellow", log_sink)
        with self._lock:
            self._stats["skipped"] = int(self._stats.get("skipped") or 0) + 1
            self._stats["updated_at"] = _now()
        self._persist_stats()

    # ----------------------------- 启动/停止 ----------------------------- #

    def start(
        self,
        tokens: list[str] | None = None,
        limit: int | None = None,
        emails: list[str] | None = None,
        concurrency: int | None = None,
    ) -> dict:
        with self._lock:
            if self._runner and self._runner.is_alive():
                return self.get()
            cfg = dict(config.cdk_activation)
            if concurrency is not None:
                cfg["concurrency"] = max(1, min(10, int(concurrency)))
            if not cfg["api_key"]:
                self._append_log("未配置 CDK API Key，无法激活（请在设置中填写）", "red")
                return self.get()
            if limit is None:
                configured = int(cfg.get("target") or 0)
                limit = configured if configured > 0 else None
            targets = self._resolve_targets(tokens, limit, emails)
            if not targets:
                self._append_log("没有需要激活的账号", "yellow")
                return self.get()
            self._stop.clear()
            self._logs = []
            self._stats = {**self._empty_stats(), "job_id": uuid.uuid4().hex, "total": len(targets),
                           "job_running": True, "job_limit": limit, "started_at": _now(), "updated_at": _now()}
            self._runner = threading.Thread(target=self._run, args=(targets, cfg), daemon=True, name="cdk-activation")
            self._runner.start()
            self._append_log(f"激活任务启动，目标账号 {len(targets)} 个，并发 {cfg['concurrency']}", "yellow")
        # 关键节点：立即落库 job_running=True，确保重启能识别到需续跑（锁外，避免持锁 I/O）。
        self._persist_stats(force=True)
        return self.get()

    def resume_if_running(self) -> None:
        """进程启动时由 lifespan 调用：若上次退出时激活任务处于运行态，自动续跑。

        传 tokens=None 走默认「所有未激活」分支（避免显式选中分支清零 attempts）；
        对账已把卡在「排队中/激活中」的账号复位成「未激活」，故它们会被自然重新纳入。
        """
        try:
            st = self._storage.load_state("activation")
        except Exception:
            st = None
        if st and st.get("job_running"):
            self._append_log("检测到上次激活任务未结束，自动续跑（所有未激活账号）", "yellow")
            self.start(tokens=None, limit=st.get("job_limit"))

    def stop(self) -> dict:
        self._stop.set()
        with self._lock:
            self._stats["job_running"] = False
        self._persist_stats(force=True)
        self._append_log("已请求停止激活任务，正在等待当前任务结束", "yellow")
        return self.get()

    def clear_logs(self) -> dict:
        """只清空日志，保留统计（供工作台「清空日志」使用）。"""
        with self._lock:
            self._logs = []
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
        acct = account_service.get_account(token)
        if not acct or not is_activation_eligible(enrich_account(acct)):
            self._append_log(f"已跳过自动激活：{token[:8]}… 不满足激活条件", "yellow", log_sink)
            return False

        def _worker():
            client = CdkRedeemClient(cfg["base_url"], cfg["api_key"])
            try:
                self._activate_account(client, token, cfg, log_sink=log_sink, source="auto")
            except AuthError as exc:
                self._append_log(f"自动激活鉴权失败：{exc}", "red", log_sink)
            except Exception as exc:  # noqa: BLE001
                self._append_log(f"自动激活异常：{exc}", "red", log_sink)
            finally:
                client.close()

        threading.Thread(target=_worker, daemon=True, name=f"auto-activate-{token[:8]}").start()
        self._append_log(f"注册成功后已自动派发激活：{token[:8]}…", "", log_sink)
        return True

    def _resolve_targets(self, tokens: list[str] | None, limit: int | None = None, emails: list[str] | None = None) -> list[str]:
        accounts = account_service.list_accounts()
        by_token = {a.get("access_token"): a for a in accounts}
        by_email = {str(a.get("email") or "").strip().lower(): a for a in accounts if a.get("email")}
        if emails:
            tokens = []
            for email in emails:
                acct = by_email.get(str(email or "").strip().lower())
                if acct and acct.get("access_token"):
                    tokens.append(str(acct.get("access_token")))
        if tokens:
            result = []
            for token in tokens:
                acct = by_token.get(token) or by_token.get(account_service.resolve_access_token(token))
                if not acct:
                    continue
                item = enrich_account(acct)
                if not is_activation_eligible(item):
                    if item.get("plus_unavailable"):
                        self._append_log(f"账号 {str(item.get('access_token'))[:8]}… 已标记不可用，已跳过（请先标记可用）", "yellow")
                    continue
                real = str(item.get("access_token") or "")
                if real:
                    result.append(real)
            targets = self._cap(result, limit)
        else:
            default = [
                str(enrich_account(a).get("access_token") or "")
                for a in accounts
                if is_activation_eligible(a)
            ]
            targets = self._cap([t for t in default if t], limit)

        # 入选后立刻标 stage=activating，供运行监控 /api/accounts?activation=activating 展示。
        # 须在 cap 之后标记，避免 limit 截掉的账号卡住 activating。
        for token in targets:
            acct = by_token.get(token)
            if not acct:
                acct = account_service.get_account(token)
            if not acct:
                continue
            item = enrich_account(acct)
            account_service.update_account(token, apply_stage(item, STAGE_ACTIVATING), quiet=True)
        return targets

    @staticmethod
    def _cap(targets: list[str], limit: int | None) -> list[str]:
        """按「激活数量」截取前 N 个目标；limit 为空或 <=0 表示不限（全部）。"""
        if limit is not None and limit > 0:
            return targets[: int(limit)]
        return targets

    # ----------------------------- 运行 ----------------------------- #

    def _run(self, targets: list[str], cfg: dict) -> None:
        client = CdkRedeemClient(cfg["base_url"], cfg["api_key"])
        done = success = fail = skipped = review = 0
        lock = threading.Lock()
        try:
            with ThreadPoolExecutor(max_workers=cfg["concurrency"]) as executor:
                futures = [executor.submit(self._activate_account, client, token, cfg) for token in targets]
                self._bump(running=min(len(targets), cfg["concurrency"]))
                for future in futures:
                    if self._stop.is_set():
                        pass
                    try:
                        result = future.result()
                    except Exception as exc:
                        result = False
                        self._append_log(f"激活异常: {exc}", "red")
                    with lock:
                        done += 1
                        if result is True:
                            success += 1
                        elif result == "review":
                            review += 1
                        elif result is None:
                            skipped += 1
                        else:
                            fail += 1
                    self._bump(
                        done=done,
                        success=success,
                        fail=fail,
                        skipped=skipped,
                        review=review,
                        running=max(0, min(len(targets) - done, cfg["concurrency"])),
                    )
        except AuthError as exc:
            self._append_log(f"{exc}，已停止整轮激活", "red")
        finally:
            client.close()
            cdk_service.clear_reservations()
        self._bump(running=0, job_running=False, finished_at=_now())
        self._persist_stats(force=True)
        review_final = int(self._stats.get("review") or 0)
        parts: list[str] = []
        if skipped:
            parts.append(f"跳过重复 {skipped}")
        if review:
            parts.append(f"已标记激活 {review}")
        suffix = f"，{ '，'.join(parts)}" if parts else ""
        self._append_log(f"激活任务结束，成功 {success}，失败 {fail}{suffix}", "yellow")

    def _set_account(self, token: str, **fields) -> None:
        fields["plus_updated_at"] = _now()
        account_service.update_account(token, fields, quiet=True)

    def _activate_account(self, client: CdkRedeemClient, token: str, cfg: dict, log_sink=None, source: str = "batch") -> bool | None | str:
        claim_key = self._activation_claim_key(token)
        if not claim_key or not self._try_claim_account(claim_key):
            acct = account_service.get_account(token)
            email = (acct or {}).get("email") or token[:8]
            self._record_skip(email, "已在激活中，跳过重复派发", log_sink)
            return None
        try:
            acct = account_service.get_account(token)
            email = (acct or {}).get("email") or token[:8]
            if not acct or not can_run_activation(acct):
                self._record_skip(email, "不满足激活条件，已跳过", log_sink)
                return None
            item = enrich_account(acct)
            # 自动激活不走 _resolve_targets，须在此标 activating；批量路径已标记则幂等。
            if item.get("stage") != STAGE_ACTIVATING:
                account_service.update_account(token, apply_stage(item, STAGE_ACTIVATING), quiet=True)
                acct = account_service.get_account(token) or acct
            if self._stop.is_set():
                return False
            return self._activate_account_body(client, token, cfg, acct, email, log_sink, source)
        finally:
            self._release_account(claim_key)

    def _activate_account_body(
        self,
        client: CdkRedeemClient,
        token: str,
        cfg: dict,
        acct: dict,
        email: str,
        log_sink,
        source: str,
    ) -> bool | None | str:
        audit = ActivationAuditRecorder(
            email=str(email),
            access_token=token,
            job_id=self._current_job_id(),
            source=source,
        )
        set_recorder(audit)
        last_cdk = None
        last_cdk_type = None
        try:
            attempts = dict((acct or {}).get("plus_attempts") or {"UPI": 0, "IDEL": 0})
            max_attempts = int(cfg["max_attempts_per_type"])
            any_attempt = False

            # 提交前预检真实档位：已是 Plus 则直接判成功、打持久锁，绝不再烧卡。
            # 返回最新 access_token（fetch_remote_info 可能刷新 token），后续用它提交更稳。
            handled, token = self._preverify_already_plus(token, email, log_sink, audit)
            if handled:
                return True

            for cdk_type in CDK_TYPES:
                tried: set[str] = set()
                while attempts.get(cdk_type, 0) < max_attempts and not self._stop.is_set():
                    cdk = cdk_service.acquire_available(cdk_type, exclude=tried)
                    if not cdk:
                        self._append_log(f"[{email}] 无可用 {cdk_type} CDK，跳过该类型", "yellow", log_sink)
                        break
                    tried.add(cdk)
                    last_cdk = cdk
                    last_cdk_type = cdk_type
                    audit.cdk = cdk
                    audit.cdk_type = cdk_type
                    any_attempt = True
                    outcome = self._redeem_one_cdk(
                        client, token, cdk, cdk_type, cfg, attempts, max_attempts, email, log_sink, audit)
                    if outcome == "success":
                        return True
                    if outcome == "review":
                        self._mark_activated_after_submit(token, email, last_cdk, last_cdk_type, audit, log_sink)
                        return True
                    if outcome == "stopped":
                        break
                    # outcome == "next_card"：换下一张卡继续（attempts 已按需在单卡逻辑内递增）
                if self._stop.is_set():
                    break

            summary = "两种类型 CDK 均激活失败，已标记账号不可用" if any_attempt else "无可用 CDK"
            self._set_account(token, plus_status=STATUS_FAILED,
                              plus_unavailable=any_attempt,
                              plus_last_message=summary)
            acct = account_service.get_account(token)
            if acct:
                # 保留失败态 plus_status，同时把 stage 从 activating 收回 registered。
                account_service.update_account(
                    token,
                    apply_stage(
                        enrich_account(acct),
                        STAGE_REGISTERED,
                        plus_status=STATUS_FAILED,
                        plus_unavailable=any_attempt,
                        plus_last_message=summary,
                    ),
                    quiet=True,
                )
            if any_attempt:
                self._append_log(f"[{email}] 两种类型 CDK 均激活失败，标记账号不可用（下轮激活将跳过，可人工标记可用）", "red", log_sink)
            if not audit.finished_at:
                self._end_audit(
                    audit,
                    OUTCOME_FAILED,
                    summary,
                    token,
                    cdk=last_cdk,
                    cdk_type=last_cdk_type,
                    cdk_consumed=False,
                )
            return False
        except AuthError as exc:
            if not audit.finished_at:
                self._end_audit(audit, OUTCOME_FAILED, f"鉴权失败：{exc}", token, cdk=last_cdk, cdk_type=last_cdk_type, cdk_consumed=audit.cdk_consumed)
            raise
        finally:
            clear_recorder()
            acct = account_service.get_account(token)
            if acct:
                item = enrich_account(acct)
                if str(item.get("stage")) == STAGE_ACTIVATING:
                    # 未到终态就退出时复位 stage；若仍是排队中/激活中则一并清空进度字段。
                    # clear 必须作为 apply_stage extra，否则 enrich 会按 plus_status 再升格 activating。
                    clear: dict = {}
                    if item.get("plus_status") in (STATUS_QUEUED, STATUS_ACTIVATING):
                        clear = {
                            "plus_status": STATUS_UNACTIVATED,
                            "plus_cdk": None,
                            "plus_task_id": None,
                        }
                    patch = apply_stage({**item, **clear}, STAGE_REGISTERED, **clear)
                    account_service.update_account(token, patch, quiet=True)

    def _preverify_already_plus(self, token: str, email: str, log_sink, audit) -> tuple[bool, str]:
        """提交前预检真实档位：已是 Plus 直接判成功、不烧卡。

        返回 (handled, latest_token)：handled=True 表示已按「已是 Plus」收尾，调用方直接成功返回；
        handled=False 表示需继续正常兑换。latest_token 为 fetch_remote_info 刷新后的最新 access_token
        （可能与传入不同），供后续 submit 使用；查询失败时原样回传，不阻断兑换。
        """
        try:
            acct = account_service.fetch_remote_info(token, event="activation_preverify")
        except Exception:  # noqa: BLE001 —— 预检失败不应阻断正常兑换
            return False, token
        item = enrich_account(acct or {})
        latest = str(item.get("access_token") or token) or token
        if str(item.get("type") or "").strip().lower() != "plus":
            return False, latest
        msg = "提交前核实已是 Plus，跳过兑换（不烧卡）"
        self._set_account(latest, plus_redeem_locked=True)
        account_service.update_account(
            latest,
            apply_stage(item, STAGE_PLUS_ACTIVATED, plan="plus",
                        activated_at=item.get("activated_at") or _now(),
                        plus_last_message=msg),
            quiet=True,
        )
        self._append_log(f"[{email}] {msg}", "green", log_sink)
        if audit:
            audit.record_plan_verify("success", tier="plus")
            if not audit.finished_at:
                self._end_audit(audit, OUTCOME_SUCCESS, msg, latest, cdk=None, cdk_type=None, cdk_consumed=False)
        return True, latest

    def _redeem_one_cdk(self, client: CdkRedeemClient, token: str, cdk: str, cdk_type: str, cfg: dict,
                        attempts: dict, max_attempts: int, email: str, log_sink, audit) -> str:
        """对单张 CDK 完成「提交 + 持续轮询 + timeout/failed 原地重试」，返回处置结果：

          success   —— 兑换成功（已 consume、已置激活）
          next_card —— 该卡不再重试，换下一张卡（失败已计入 attempts / not_found / 重试超上限）
          review    —— 已受理但未出明确终态，按已激活收尾（timeout 重试超限），持久锁已在
          stopped   —— 收到停止信号

        重试策略：timeout（服务端返回 timeout 终态）走 /cdkey-jobs/retry 复用同卡、不计失败次数、
        上限 timeout_retry_max；failed 走 retry 复用同卡、上限 failed_retry_max，用尽才换卡并计入
        max_attempts_per_type。轮询阶段接口正常且未出终态时会一直查状态，不因时间兜底报错。
        任一次被服务端受理即打 plus_redeem_locked 持久锁，杜绝重复烧卡。
        """
        timeout_retry_max = int(cfg.get("timeout_retry_max", 5))
        failed_retry_max = int(cfg.get("failed_retry_max", 3))
        timeout_retries = 0
        failed_retries = 0
        action = "submit"
        consumed = False
        locked = False
        self._set_account(token, plus_status=STATUS_QUEUED, plus_cdk=cdk, plus_cdk_type=cdk_type,
                          plus_last_message=f"提交 {cdk_type} CDK 兑换")
        self._append_log(
            f"[{email}] 尝试 {cdk_type} CDK（第 {attempts.get(cdk_type, 0) + 1}/{max_attempts} 次）", "", log_sink)
        try:
            while not self._stop.is_set():
                label = "" if action == "submit" else f"#t{timeout_retries}f{failed_retries}"
                try:
                    cls, status, message, task_id = self._attempt(
                        client, token, cdk, cfg, log_sink=log_sink, audit=audit, action=action, label=label)
                except AuthError:
                    raise
                except RedeemError as exc:
                    cls, status, message, task_id = "fail", "error", scrub(str(exc)), ""

                # 一旦被服务端受理（进入过队列），立刻打持久锁：即便后续判超时/失败也不再烧第二张卡。
                if cls not in ("rejected", "retry_rejected") and not locked:
                    self._set_account(token, plus_redeem_locked=True)
                    locked = True

                if cls == "success":
                    cdk_service.consume(cdk, token)
                    consumed = True
                    audit.cdk_consumed = True
                    already_activated_at = (account_service.get_account(token) or {}).get("plus_activated_at")
                    self._set_account(token, plus_status=STATUS_ACTIVATED, plus_task_id=task_id,
                                      plus_last_message=message or "兑换成功",
                                      plus_activated_at=already_activated_at or _now())
                    self._append_log(f"[{email}] 激活成功（{cdk_type}）", "green", log_sink)
                    acct = account_service.get_account(token)
                    if acct:
                        item = enrich_account(acct)
                        account_service.update_account(
                            token,
                            apply_stage(
                                item,
                                STAGE_PLUS_ACTIVATED,
                                plan="plus",
                                activated_at=item.get("activated_at") or item.get("plus_activated_at") or _now(),
                            ),
                            quiet=True,
                        )
                    if audit and not audit.finished_at:
                        self._end_audit(
                            audit,
                            OUTCOME_SUCCESS,
                            message or "兑换成功",
                            token,
                            cdk=audit.cdk,
                            cdk_type=audit.cdk_type,
                            cdk_consumed=audit.cdk_consumed,
                        )
                    return "success"

                if cls == "cdk_invalid":
                    cdk_service.mark_invalid(cdk)
                    consumed = True
                    self._append_log(f"[{email}] CDK {scrub(cdk)} 无效(not_found)，换下一个", "yellow", log_sink)
                    return "next_card"

                if cls == "timeout":
                    if timeout_retries < timeout_retry_max:
                        timeout_retries += 1
                        if audit:
                            audit.log(f"服务端超时，复用同卡重入列重试 第 {timeout_retries}/{timeout_retry_max} 次", "warn")
                        self._append_log(
                            f"[{email}] {cdk_type} 兑换超时，复用同卡重试 第 {timeout_retries}/{timeout_retry_max} 次", "yellow", log_sink)
                        action = "retry"
                        continue
                    self._append_log(
                        f"[{email}] {cdk_type} 超时重试已达上限（{timeout_retry_max}），已标记为已激活", "yellow", log_sink)
                    return "review"

                if cls == "poll_stopped":
                    # 任务被停止：轮询未等到终态，不判失败、不标激活，释放占用后由上层收尾。
                    return "stopped"

                if cls in ("cancelled", "retry_rejected"):
                    # 任务已取消 / 服务端拒绝重试：retry 不可复用，回退重新 submit 同卡（受 failed 上限保护）。
                    if failed_retries < failed_retry_max:
                        failed_retries += 1
                        if audit:
                            audit.log(f"{status}，回退重新提交同卡 第 {failed_retries}/{failed_retry_max} 次", "warn")
                        self._append_log(
                            f"[{email}] {cdk_type} {scrub(message or status)}，回退重新提交同卡 第 {failed_retries}/{failed_retry_max} 次",
                            "yellow", log_sink)
                        action = "submit"
                        continue
                    attempts[cdk_type] = attempts.get(cdk_type, 0) + 1
                    self._set_account(token, plus_attempts=attempts, plus_last_message=message or status)
                    self._append_log(f"[{email}] {cdk_type} 重试上限，换下一张卡", "red", log_sink)
                    return "next_card"

                # cls in ("fail", "rejected")：本次失败——先对同一张卡重试，用尽才换卡并计入 attempts。
                if failed_retries < failed_retry_max:
                    failed_retries += 1
                    if audit:
                        audit.log(
                            f"兑换失败，复用同卡重试 第 {failed_retries}/{failed_retry_max} 次：{scrub(message or status)}", "warn")
                    self._append_log(
                        f"[{email}] {cdk_type} 失败，复用同卡重试 第 {failed_retries}/{failed_retry_max} 次：{scrub(message or status)}",
                        "yellow", log_sink)
                    action = "retry" if cls == "fail" else "submit"
                    continue
                attempts[cdk_type] = attempts.get(cdk_type, 0) + 1
                self._set_account(token, plus_attempts=attempts, plus_last_message=message or status)
                self._append_log(
                    f"[{email}] {cdk_type} 第 {attempts[cdk_type]} 次失败：{scrub(message or status)}", "red", log_sink)
                return "next_card"
            return "stopped"
        finally:
            if not consumed:
                cdk_service.release(cdk)

    def _mark_activated_after_submit(self, token: str, email: str, cdk, cdk_type, audit, log_sink) -> None:
        """CDK 已受理但未拿到明确成功终态：仍按已激活收尾，保留持久锁、不再自动烧卡。"""
        msg = "CDK 已提交受理，已标记为已激活"
        acct = account_service.get_account(token)
        if acct:
            item = enrich_account(acct)
            account_service.update_account(
                token,
                apply_stage(
                    item,
                    STAGE_PLUS_ACTIVATED,
                    plan="plus",
                    activated_at=item.get("activated_at") or item.get("plus_activated_at") or _now(),
                    plus_last_message=msg,
                ),
                quiet=True,
            )
        self._append_log(f"[{email}] {msg}", "green", log_sink)
        if audit and not audit.finished_at:
            self._end_audit(audit, OUTCOME_SUCCESS, msg, token, cdk=cdk, cdk_type=cdk_type, cdk_consumed=audit.cdk_consumed)

    def _log_raw(self, cdk: str, phase: str, js: object, log_sink=None) -> None:
        """把兑换接口的原始响应（脱敏 + 截断）写进激活日志，便于本地定位真实信封结构与状态词。"""
        try:
            text = json.dumps(js, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            text = str(js)
        self._append_log(f"[{scrub(cdk)}] {phase} 原始响应: {scrub(text[:800])}", "", log_sink)

    def _attempt(self, client: CdkRedeemClient, token: str, cdk: str, cfg: dict, log_sink=None,
                 audit: ActivationAuditRecorder | None = None, action: str = "submit", label: str = "") -> tuple[str, str, str, str]:
        """提交一次（首次 submit / 后续 retry 复用同卡）+ 持续轮询查激活结果，直到服务端明确终态。

        返回 (cls, status, message, task_id)，cls 取值：
          - success / fail / timeout / cdk_invalid / cancelled —— 服务端明确状态（见 classify）
          - poll_stopped —— 任务停止信号打断轮询（未等到终态）
          - rejected —— 提交未被受理（信封 code!=0 等硬错误），任务可能未建，调用方回退重新 submit
          - retry_rejected —— action=retry 但服务端未受理重试（retried=false），调用方回退重新 submit

        判定以「响应里该 CDK 对应的 item.status」为准，忽略外层信封成功码；仅当响应里完全没有该项时，
        才回退用信封 code 判硬错误。timeout/cancelled 现为独立终态（不再混入 fail），交由上层原地重试。

        轮询策略：接口无服务异常且未查到成功/失败等明确终态时，按 poll_interval 一直查，
        不因 poll_timeout 时间兜底报错或提前收尾（长排队兑换可等任意久）。
        """
        if action == "retry":
            js = client.retry(
                [cdk],
                exchange_cb=(lambda meta: audit.record_http(f"cdk_retry{label}", meta)) if audit else None,
            )
            self._log_raw(cdk, f"retry{label}", js, log_sink)
            rit = item_for_cdk(js, cdk)
            if not cdk_redeem_client.item_retried(rit):
                reason = item_message(rit) or "重试未受理（found/retried=false）"
                return "retry_rejected", "retry_rejected", reason, item_task_id(rit)
            task_id = item_task_id(rit)
            status = ""
            js_for_poll: object = js
        else:
            js = client.submit(
                cdk,
                token,
                exchange_cb=(lambda meta: audit.record_http("cdk_submit", meta)) if audit else None,
            )
            self._log_raw(cdk, "submit", js, log_sink)
            it = item_for_cdk(js, cdk)
            task_id = item_task_id(it)
            status = ""
            js_for_poll = js
            if it is not None:
                status = item_status(it)
                cls = classify(status)
                self._reflect_progress(token, it)
                if cls in _TERMINAL_CLS:
                    return cls, status, item_message(it), task_id
            else:
                code = cdk_redeem_client.env_code(js)
                if code not in (None, 0):
                    return "rejected", f"code={code}", cdk_redeem_client.env_msg(js) or "envelope code!=0", ""

        interval = float(cfg["poll_interval"])
        # 心跳日志：避免无限轮询时日志完全静默；默认约每 60 次或至少 5 分钟打一次。
        heartbeat_every = max(1, int(300.0 / max(interval, 0.01)))
        last_js: object = js_for_poll
        polled = 0
        while not self._stop.is_set():
            time.sleep(interval)
            if self._stop.is_set():
                break
            poll_seq = polled + 1
            sjs = client.query_status(
                [cdk],
                exchange_cb=(
                    (lambda meta, seq=poll_seq: audit.record_http(f"cdk_status#{seq}", meta))
                    if audit
                    else None
                ),
            )
            last_js = sjs
            polled += 1
            sit = item_for_cdk(sjs, cdk)
            if polled == 1:
                self._log_raw(cdk, "status#1", sjs, log_sink)
            elif polled % heartbeat_every == 0:
                self._append_log(
                    f"[{scrub(cdk)}] 仍在轮询状态（第 {polled} 次，当前 {status or 'pending'}）",
                    "",
                    log_sink,
                )
            if sit is not None:
                status = item_status(sit)
                self._reflect_progress(token, sit)
                cls = classify(status)
                if cls in _TERMINAL_CLS:
                    if polled != 1:
                        self._log_raw(cdk, f"status(final,{status or '空'})", sjs, log_sink)
                    return cls, status, item_message(sit), item_task_id(sit) or task_id
            # sit 为空或非终态：接口正常则继续等，不因时间兜底报错。
        self._log_raw(cdk, "poll_stopped", last_js, log_sink)
        return "poll_stopped", status or "pending", "激活任务已停止，轮询未等到终态", task_id

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
