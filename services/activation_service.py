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
    STAGE_PLUS_REVIEW,
    STAGE_REGISTERED,
    apply_stage,
    enrich_account,
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
    OUTCOME_REVIEW,
    OUTCOME_SUCCESS,
    ActivationAuditRecorder,
    activation_audit_service,
)
from services.config import config

from services.activation_audit_context import clear_recorder, get_recorder, set_recorder

CDK_TYPES = ("UPI", "IDEL")

# 已完成 CDK 兑换（含待人工核查）的 stage，下轮激活不再选中。
_ACTIVATION_DONE_STAGES = frozenset({STAGE_PLUS_ACTIVATED, STAGE_PLUS_REVIEW})


def is_activation_eligible(account: dict) -> bool:
    """与 start() → _resolve_targets 默认分支相同的可选中口径。"""
    item = enrich_account(account)
    if item.get("stage") in _ACTIVATION_DONE_STAGES:
        return False
    if item.get("plus_activated_at"):
        return False
    if item.get("plus_unavailable"):
        return False
    return item.get("stage") == STAGE_REGISTERED and item.get("plan") == PLAN_FREE


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

    @staticmethod
    def _empty_stats() -> dict:
        # running：在跑并发数（int，UI 展示）；job_running：整个批次是否运行中（bool，决定重启续跑）。
        return {"total": 0, "done": 0, "success": 0, "fail": 0, "running": 0, "job_running": False,
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
        # 不一致告警：plus_status 已判定为「已激活」，但真实档位仍非 Plus（例如 CDK 服务端「假成功」，
        # 或激活链路提前置位）。这类账号计入待激活口径无意义，需人工核查真实档位与 CDK 归属。
        needs_review = sum(
            1 for a in accounts
            if a.get("plus_status") == STATUS_ACTIVATED
            and str(a.get("type") or "").strip().lower() != "plus"
        )
        pending = sum(1 for a in accounts if is_activation_eligible(a))
        return {
            "free": free,
            "activated": activated,
            "activating": activating,
            "total": len(accounts),
            "plus_by_type": plus_by_type,
            "not_plus_by_type": not_plus_by_type,
            "needs_review": needs_review,
            "pending": pending,
        }

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
                account_service.update_account(real, apply_stage(item, STAGE_ACTIVATING), quiet=True)
                result.append(real)
            return self._cap(result, limit)
        default = [
            str(enrich_account(a).get("access_token") or "")
            for a in accounts
            if is_activation_eligible(a)
        ]
        return self._cap([t for t in default if t], limit)

    @staticmethod
    def _cap(targets: list[str], limit: int | None) -> list[str]:
        """按「激活数量」截取前 N 个目标；limit 为空或 <=0 表示不限（全部）。"""
        if limit is not None and limit > 0:
            return targets[: int(limit)]
        return targets

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
        self._bump(running=0, job_running=False, finished_at=_now())
        self._persist_stats(force=True)
        self._append_log(f"激活任务结束，成功 {success}，失败 {fail}", "yellow")

    def _set_account(self, token: str, **fields) -> None:
        fields["plus_updated_at"] = _now()
        account_service.update_account(token, fields, quiet=True)

    def _verify_plan(self, token: str, email: str, log_sink=None, audit: ActivationAuditRecorder | None = None) -> None:
        """激活成功后向 OpenAI 核实真实套餐（读 plan_type 覆盖 type），确保档位是核实过的真值。

        走 account_service.fetch_remote_info：内部会刷新 token、拉 get_user_info 并 update_account 合并，
        真实 plan_type 覆盖 type。核实失败时 CDK 已消耗、激活仍计成功，账号保持「已激活」并进入
        plus_review（需人工核查），下轮激活不再选中。
        """
        try:
            if audit:
                audit.record_plan_verify("start")
            acct = account_service.fetch_remote_info(token, event="activation_verify")
            tier = str((acct or {}).get("type") or "未知")
            level = "green" if tier.lower() == "plus" else "yellow"
            self._append_log(f"[{email}] 已核实套餐：{tier}", level, log_sink)
            if audit:
                audit.record_plan_verify("success", tier=tier)
            if acct:
                item = enrich_account(acct)
                if tier.lower() == "plus":
                    account_service.update_account(
                        str(item.get("access_token") or token),
                        apply_stage(item, STAGE_PLUS_ACTIVATED, plan="plus", activated_at=item.get("activated_at") or _now()),
                        quiet=True,
                    )
                    if audit:
                        self._end_audit(audit, OUTCOME_SUCCESS, f"激活成功，套餐已核实为 {tier}", token, cdk=audit.cdk, cdk_type=audit.cdk_type, cdk_consumed=audit.cdk_consumed)
                else:
                    review_msg = "激活成功但套餐核实非 Plus"
                    account_service.update_account(
                        str(item.get("access_token") or token),
                        apply_stage(item, STAGE_PLUS_REVIEW, plus_last_message=review_msg),
                        quiet=True,
                    )
                    if audit:
                        self._end_audit(audit, OUTCOME_REVIEW, review_msg, token, cdk=audit.cdk, cdk_type=audit.cdk_type, cdk_consumed=audit.cdk_consumed)
        except Exception as exc:  # noqa: BLE001
            err = scrub(str(exc))
            msg = f"套餐核实失败：{err}"
            self._append_log(f"[{email}] {msg}，待人工核查", "yellow", log_sink)
            if audit:
                audit.record_plan_verify("error", error=err)
            acct = account_service.get_account(token)
            if acct:
                account_service.update_account(
                    token,
                    apply_stage(
                        enrich_account(acct),
                        STAGE_PLUS_REVIEW,
                        plus_last_message=msg,
                    ),
                    quiet=True,
                )
            if audit:
                self._end_audit(audit, OUTCOME_REVIEW, msg, token, cdk=audit.cdk, cdk_type=audit.cdk_type, cdk_consumed=audit.cdk_consumed)

    def _activate_account(self, client: CdkRedeemClient, token: str, cfg: dict, log_sink=None, source: str = "batch") -> bool:
        if self._stop.is_set():
            return False
        acct = account_service.get_account(token)
        email = (acct or {}).get("email") or token[:8]
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
                    consumed = False
                    self._set_account(token, plus_status=STATUS_QUEUED, plus_cdk=cdk, plus_cdk_type=cdk_type, plus_last_message=f"提交 {cdk_type} CDK 兑换")
                    self._append_log(f"[{email}] 尝试 {cdk_type} CDK（第 {attempts.get(cdk_type, 0) + 1}/{max_attempts} 次）", "", log_sink)
                    try:
                        try:
                            cls, status, message, task_id = self._attempt(client, token, cdk, cfg, log_sink=log_sink, audit=audit)
                        except AuthError:
                            raise
                        except RedeemError as exc:
                            cls, status, message, task_id = "fail", "error", str(exc), ""

                        if cls == "success":
                            cdk_service.consume(cdk, token)
                            consumed = True
                            audit.cdk_consumed = True
                            already_activated_at = (account_service.get_account(token) or {}).get("plus_activated_at")
                            self._set_account(token, plus_status=STATUS_ACTIVATED, plus_task_id=task_id,
                                              plus_last_message=message or "兑换成功",
                                              plus_activated_at=already_activated_at or _now())
                            self._append_log(f"[{email}] 激活成功（{cdk_type}）", "green", log_sink)
                            self._verify_plan(token, email, log_sink, audit=audit)
                            return True
                        if cls == "cdk_invalid":
                            cdk_service.mark_invalid(cdk)
                            consumed = True
                            self._append_log(f"[{email}] CDK {scrub(cdk)} 无效(not_found)，换下一个", "yellow", log_sink)
                            continue
                        attempts[cdk_type] = attempts.get(cdk_type, 0) + 1
                        self._set_account(token, plus_attempts=attempts, plus_last_message=message or status)
                        self._append_log(f"[{email}] {cdk_type} 第 {attempts[cdk_type]} 次失败：{scrub(message or status)}", "red", log_sink)
                    finally:
                        if not consumed:
                            cdk_service.release(cdk)

            summary = "两种类型 CDK 均激活失败，已标记账号不可用" if any_attempt else "无可用 CDK"
            self._set_account(token, plus_status=STATUS_FAILED,
                              plus_unavailable=any_attempt,
                              plus_last_message=summary)
            acct = account_service.get_account(token)
            if acct:
                account_service.update_account(token, apply_stage(enrich_account(acct), STAGE_REGISTERED), quiet=True)
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

    def _log_raw(self, cdk: str, phase: str, js: object, log_sink=None) -> None:
        """把兑换接口的原始响应（脱敏 + 截断）写进激活日志，便于本地定位真实信封结构与状态词。"""
        try:
            text = json.dumps(js, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            text = str(js)
        self._append_log(f"[{scrub(cdk)}] {phase} 原始响应: {scrub(text[:800])}", "", log_sink)

    def _attempt(self, client: CdkRedeemClient, token: str, cdk: str, cfg: dict, log_sink=None, audit: ActivationAuditRecorder | None = None) -> tuple[str, str, str, str]:
        """一次提交 + 轮询到终态。返回 (cls, status, message, task_id)。

        判定以「响应里该 CDK 对应的 item.status」为准：只要能在响应中定位到该项，就按 item 状态分类，
        **忽略外层信封 code**（不同服务端成功码可能是 0 / 200 等，不能据此直接判失败——这正是旧逻辑把
        每次提交都误判为失败、导致「查不到成功状态 / CDK 不消耗 / 刷新才发现已是 Plus」的根因）。
        仅当响应里完全没有该项时，才回退用信封 code/msg 判断是否硬错误，否则视为已受理并进入轮询。
        """
        js = client.submit(
            cdk,
            token,
            exchange_cb=(lambda meta: audit.record_http("cdk_submit", meta)) if audit else None,
        )
        self._log_raw(cdk, "submit", js, log_sink)
        it = item_for_cdk(js, cdk)
        task_id = item_task_id(it)
        status = ""
        if it is not None:
            status = item_status(it)
            cls = classify(status)
            self._reflect_progress(token, it)
            if cls in ("success", "fail", "cdk_invalid"):
                return cls, status, item_message(it), task_id
        else:
            code = cdk_redeem_client.env_code(js)
            if code not in (None, 0):
                return "fail", f"code={code}", cdk_redeem_client.env_msg(js) or "envelope code!=0", ""

        deadline = time.time() + float(cfg["poll_timeout"])
        interval = float(cfg["poll_interval"])
        last_js: object = js
        polled = 0
        while time.time() < deadline and not self._stop.is_set():
            time.sleep(interval)
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
            if sit is not None:
                status = item_status(sit)
                self._reflect_progress(token, sit)
                cls = classify(status)
                if cls in ("success", "fail", "cdk_invalid"):
                    if polled != 1:
                        self._log_raw(cdk, f"status(final,{status or '空'})", sjs, log_sink)
                    return cls, status, item_message(sit), item_task_id(sit) or task_id
            # sit 为空：可能完成后已从队列消失，也可能仍在处理；继续轮询直到超时。
        self._log_raw(cdk, "timeout", last_js, log_sink)
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
