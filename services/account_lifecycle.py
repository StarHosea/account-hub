from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from services.config import DATA_DIR

EMAIL_KEY_PREFIX = "email::"

STAGE_UNREGISTERED = "unregistered"
STAGE_REGISTERING = "registering"
STAGE_REGISTERED = "registered"
STAGE_ACTIVATING = "activating"
STAGE_PLUS_ACTIVATED = "plus_activated"
STAGE_PLUS_REVIEW = "plus_review"

FREE_STAGES = {STAGE_UNREGISTERED, STAGE_REGISTERING, STAGE_REGISTERED, STAGE_ACTIVATING}
PLUS_STAGES = {STAGE_ACTIVATING, STAGE_PLUS_ACTIVATED, STAGE_PLUS_REVIEW}

STAGE_LABELS = {
    STAGE_UNREGISTERED: "未注册",
    STAGE_REGISTERING: "注册中",
    STAGE_REGISTERED: "已注册",
    STAGE_ACTIVATING: "激活中",
    STAGE_PLUS_ACTIVATED: "已激活",
    STAGE_PLUS_REVIEW: "需核查",
}

PLAN_FREE = "free"
PLAN_PLUS = "plus"

TOKEN_OK = "ok"
TOKEN_RATE_LIMITED = "rate_limited"
TOKEN_INVALID = "invalid"

LEGACY_PLUS_UNACTIVATED = "未激活"
LEGACY_PLUS_QUEUED = "排队中"
LEGACY_PLUS_ACTIVATING = "激活中"
LEGACY_PLUS_ACTIVATED = "已激活"
LEGACY_PLUS_FAILED = "激活失败"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_email(email: str) -> str:
    return str(email or "").strip().lower()


def email_storage_key(email: str) -> str:
    return f"{EMAIL_KEY_PREFIX}{_norm_email(email)}"


def is_email_key(key: str) -> bool:
    return str(key or "").startswith(EMAIL_KEY_PREFIX)


def empty_dispatch() -> dict[str, Any]:
    return {
        "dispatched": False,
        "dispatched_at": None,
        "customer": "",
        "wechat": "",
        "xianyu": "",
        "plan": "",
        "note": "",
        "dispatch_no": "",
    }


def empty_activation() -> dict[str, Any]:
    return {
        "cdk": None,
        "cdk_type": None,
        "task_id": None,
        "attempts": {"UPI": 0, "IDEL": 0},
        "last_message": None,
    }


def _legacy_token_status(status: str) -> str:
    raw = str(status or "").strip()
    if raw == "限流":
        return TOKEN_RATE_LIMITED
    if raw in ("异常", "禁用"):
        return TOKEN_INVALID
    return TOKEN_OK


def _token_status_to_legacy(token_status: str) -> str:
    if token_status == TOKEN_RATE_LIMITED:
        return "限流"
    if token_status == TOKEN_INVALID:
        return "异常"
    return "正常"


def _legacy_plan(account_type: str) -> str:
    return PLAN_PLUS if str(account_type or "").strip().lower() == "plus" else PLAN_FREE


def _plan_to_legacy(plan: str) -> str:
    return "plus" if str(plan or "").strip().lower() == PLAN_PLUS else "free"


def _legacy_plus_status(stage: str, plan: str) -> str:
    if stage == STAGE_PLUS_ACTIVATED:
        return LEGACY_PLUS_ACTIVATED
    if stage == STAGE_ACTIVATING:
        return LEGACY_PLUS_ACTIVATING if plan == PLAN_PLUS else LEGACY_PLUS_QUEUED
    if stage == STAGE_PLUS_REVIEW:
        return LEGACY_PLUS_ACTIVATED
    return LEGACY_PLUS_UNACTIVATED


def infer_stage_from_legacy(account: dict[str, Any]) -> str:
    plus_status = str(account.get("plus_status") or LEGACY_PLUS_UNACTIVATED).strip()
    # 进行中的激活：plus_status 优先于可能仍停留在 registered 的 stage。
    # 否则 _set_account(plus_status=排队中/激活中) 经 enrich 后会被冲回「未激活」，
    # 运行监控 activation=activating 过滤也查不到。
    if plus_status in (LEGACY_PLUS_QUEUED, LEGACY_PLUS_ACTIVATING):
        return STAGE_ACTIVATING

    if account.get("stage") in STAGE_LABELS:
        return str(account["stage"])

    token = str(account.get("access_token") or "").strip()
    email = str(account.get("email") or "").strip()

    if is_email_key(token) or (email and not token.startswith("eyJ") and not token.startswith("manual::")):
        if account.get("mailbox_in_use") or account.get("_registering"):
            return STAGE_REGISTERING
        return STAGE_UNREGISTERED

    if plus_status == LEGACY_PLUS_ACTIVATED:
        return STAGE_PLUS_ACTIVATED
    if plus_status == LEGACY_PLUS_FAILED:
        return STAGE_REGISTERED
    if token:
        return STAGE_REGISTERED
    if email:
        return STAGE_UNREGISTERED
    return STAGE_REGISTERED


def infer_plan_from_legacy(account: dict[str, Any]) -> str:
    if str(account.get("plan") or "").strip().lower() in (PLAN_FREE, PLAN_PLUS):
        return str(account["plan"]).strip().lower()
    return _legacy_plan(account.get("type"))


def _normalize_dispatch(raw: object, account: dict[str, Any]) -> dict[str, Any]:
    dispatch = empty_dispatch()
    if isinstance(raw, dict):
        dispatch.update({k: raw.get(k) for k in dispatch if k in raw})
    dispatched = bool(dispatch.get("dispatched"))
    if not dispatched and bool(account.get("used")):
        dispatched = True
    dispatch["dispatched"] = dispatched
    if dispatched and not dispatch.get("dispatched_at"):
        dispatch["dispatched_at"] = account.get("checkout_at") or _now()
    meta = account.get("checkout_meta")
    if isinstance(meta, dict):
        for key in ("customer", "wechat", "xianyu", "plan", "note", "dispatch_no"):
            if meta.get(key) and not dispatch.get(key):
                dispatch[key] = str(meta.get(key) or "")
    return dispatch


def _is_legacy_activation_last_error(
    last_error: str,
    *,
    raw_plus_status: str,
    plus_last_message: str,
    stage: str,
) -> bool:
    """True when last_error holds activation/review text that belongs in plus_last_message."""
    raw = str(last_error or "").strip()
    if not raw:
        return False
    if raw_plus_status == LEGACY_PLUS_FAILED:
        if raw == "激活失败":
            return True
        if plus_last_message and raw == plus_last_message:
            return True
        if not plus_last_message:
            return True
    if stage == STAGE_PLUS_REVIEW:
        if raw.startswith("套餐核实") or raw == "激活成功但套餐核实非 Plus":
            return True
        if plus_last_message and raw == plus_last_message:
            return True
    return False


def _migrate_legacy_activation_error(item: dict[str, Any], raw_plus_status: str) -> None:
    """Enrich-time: move legacy activation/review errors from last_error into plus_last_message."""
    explicit = str(item.get("last_error") or "").strip()
    if not explicit:
        return
    plus_msg = str(item.get("plus_last_message") or "").strip()
    stage = str(item.get("stage") or infer_stage_from_legacy(item))
    if not _is_legacy_activation_last_error(
        explicit,
        raw_plus_status=raw_plus_status,
        plus_last_message=plus_msg,
        stage=stage,
    ):
        return
    if not plus_msg and explicit != "激活失败":
        item["plus_last_message"] = explicit


def _compose_last_error(item: dict[str, Any], raw_plus_status: str) -> str | None:
    """Registration + token refresh errors only; activation failures stay in plus_last_message."""
    explicit = str(item.get("last_error") or "").strip()
    plus_msg = str(item.get("plus_last_message") or "").strip()
    stage = str(item.get("stage") or "")
    parts: list[str] = []
    if explicit and not _is_legacy_activation_last_error(
        explicit,
        raw_plus_status=raw_plus_status,
        plus_last_message=plus_msg,
        stage=stage,
    ):
        parts.append(explicit)
    for key in ("last_refresh_error", "last_token_refresh_error", "last_token_rotate_error"):
        value = str(item.get(key) or "").strip()
        if value and value not in parts:
            parts.append(value)
    return "；".join(parts) or None


def _normalize_activation(account: dict[str, Any]) -> dict[str, Any]:
    activation = empty_activation()
    raw = account.get("activation")
    if isinstance(raw, dict):
        activation.update(raw)
    attempts = activation.get("attempts")
    if not isinstance(attempts, dict):
        attempts = account.get("plus_attempts") if isinstance(account.get("plus_attempts"), dict) else {}
    activation["attempts"] = {
        "UPI": int(attempts.get("UPI") or 0),
        "IDEL": int(attempts.get("IDEL") or 0),
    }
    activation["cdk"] = activation.get("cdk") or account.get("plus_cdk")
    activation["cdk_type"] = activation.get("cdk_type") or account.get("plus_cdk_type")
    activation["task_id"] = activation.get("task_id") or account.get("plus_task_id")
    # plus_last_message 由 activation_service 直接写入，优先于嵌套 activation.last_message（避免部分更新后旧文案残留）。
    activation["last_message"] = account.get("plus_last_message") or activation.get("last_message")
    return activation


def _retire_plus_review_stage(item: dict[str, Any]) -> None:
    """plus_review 已废弃：激活成功即已激活，读盘时统一升格为 plus_activated。"""
    if str(item.get("stage") or "") != STAGE_PLUS_REVIEW:
        return
    item["stage"] = STAGE_PLUS_ACTIVATED
    item["plan"] = PLAN_PLUS
    if not item.get("plus_activated_at") and not item.get("activated_at"):
        item["plus_activated_at"] = _now()


def enrich_account(account: dict[str, Any]) -> dict[str, Any]:
    """Normalize lifecycle fields and keep legacy fields in sync for older code paths."""
    raw_plus_status = str(account.get("plus_status") or "").strip()
    item = deepcopy(account)
    item["plan"] = infer_plan_from_legacy(item)
    item["stage"] = infer_stage_from_legacy(item)
    _retire_plus_review_stage(item)
    item["token_status"] = item.get("token_status") or _legacy_token_status(item.get("status"))
    item["dispatch"] = _normalize_dispatch(item.get("dispatch"), item)
    _migrate_legacy_activation_error(item, raw_plus_status)
    item["activation"] = _normalize_activation(item)
    item["stage_label"] = STAGE_LABELS.get(str(item["stage"]), str(item["stage"]))

    item["last_error"] = _compose_last_error(item, raw_plus_status)

    item["updated_at"] = item.get("updated_at") or item.get("last_token_refresh_at") or item.get("created_at") or _now()
    if item.get("plus_activated_at") and not item.get("activated_at"):
        item["activated_at"] = item.get("plus_activated_at")
    if item.get("registered_at") is None and item.get("created_at") and item["stage"] != STAGE_UNREGISTERED:
        item["registered_at"] = item.get("created_at")

    # legacy mirrors
    item["type"] = _plan_to_legacy(item["plan"])
    item["status"] = _token_status_to_legacy(str(item["token_status"]))
    item["plus_status"] = _legacy_plus_status(str(item["stage"]), str(item["plan"]))
    # 保留激活服务直接写入的细粒度进度（排队中 / 激活中 / 激活失败），
    # 避免仅由 stage+plan 推导时把「激活中」压成「排队中」或冲回「未激活」。
    if raw_plus_status == LEGACY_PLUS_FAILED:
        item["plus_status"] = LEGACY_PLUS_FAILED
    elif raw_plus_status in (LEGACY_PLUS_QUEUED, LEGACY_PLUS_ACTIVATING):
        item["plus_status"] = raw_plus_status
    item["plus_attempts"] = dict(item["activation"]["attempts"])
    item["plus_cdk"] = item["activation"].get("cdk")
    item["plus_cdk_type"] = item["activation"].get("cdk_type")
    item["plus_task_id"] = item["activation"].get("task_id")
    item["plus_last_message"] = item["activation"].get("last_message")
    item["used"] = bool(item["dispatch"].get("dispatched"))
    token = str(item.get("access_token") or "").strip()
    if not token or is_email_key(token):
        item["access_token"] = ""
    if item["used"]:
        item["checkout_at"] = item.get("checkout_at") or item["dispatch"].get("dispatched_at")
        item["checkout_meta"] = {
            k: str(item["dispatch"].get(k) or "")
            for k in ("customer", "wechat", "xianyu", "plan", "note", "dispatch_no")
            if item["dispatch"].get(k)
        } or item.get("checkout_meta")
    return item


def apply_stage(account: dict[str, Any], stage: str, **extra: Any) -> dict[str, Any]:
    item = enrich_account(account)
    item["stage"] = stage
    item.update(extra)
    return enrich_account(item)


def account_in_view(account: dict[str, Any], view: str) -> bool:
    item = enrich_account(account)
    stage = str(item.get("stage") or "")
    plan = str(item.get("plan") or PLAN_FREE)
    if view == "free":
        if stage in (STAGE_UNREGISTERED, STAGE_REGISTERING, STAGE_ACTIVATING):
            return False
        if stage not in FREE_STAGES:
            return False
        if stage == STAGE_ACTIVATING and plan == PLAN_PLUS:
            return False
        return True
    if view == "plus":
        if stage not in PLUS_STAGES:
            return False
        if stage == STAGE_ACTIVATING and plan != PLAN_PLUS:
            return False
        return plan == PLAN_PLUS
    return True


def is_dispatchable(account: dict[str, Any]) -> bool:
    item = enrich_account(account)
    stage = str(item.get("stage"))
    if stage != STAGE_PLUS_ACTIVATED or str(item.get("plan")) != PLAN_PLUS:
        return False
    return (
        str(item.get("token_status")) == TOKEN_OK
        and not bool(item.get("dispatch", {}).get("dispatched"))
        and str(item.get("access_token") or "").startswith("eyJ")
    )


def is_exportable_pool(account: dict[str, Any], view: str) -> bool:
    item = enrich_account(account)
    token = str(item.get("access_token") or "")
    if not token or is_email_key(token):
        return False
    if view == "plus":
        return (
            str(item.get("stage")) == STAGE_PLUS_ACTIVATED
            and str(item.get("plan")) == PLAN_PLUS
        )
    return str(item.get("stage")) == STAGE_REGISTERED and str(item.get("plan")) == PLAN_FREE


def summary_for_view(accounts: list[dict[str, Any]], view: str) -> dict[str, int]:
    buckets: dict[str, int] = {}
    undispatched = 0
    for raw in accounts:
        if not account_in_view(raw, view):
            continue
        item = enrich_account(raw)
        stage = str(item.get("stage") or "")
        buckets[stage] = buckets.get(stage, 0) + 1
        if view == "plus" and not item.get("dispatch", {}).get("dispatched"):
            undispatched += 1
    summary = {
        "total": sum(buckets.values()),
        "undispatched": undispatched,
    }
    if view == "free":
        summary.update({
            "unregistered": buckets.get(STAGE_UNREGISTERED, 0),
            "registering": buckets.get(STAGE_REGISTERING, 0),
            "registered": buckets.get(STAGE_REGISTERED, 0),
            "activating": buckets.get(STAGE_ACTIVATING, 0),
        })
    else:
        summary.update({
            "activating": buckets.get(STAGE_ACTIVATING, 0),
            "plus_activated": buckets.get(STAGE_PLUS_ACTIVATED, 0),
        })
    return summary


def filter_accounts(
    accounts: list[dict[str, Any]],
    *,
    view: str | None = None,
    stage: str | None = None,
    q: str | None = None,
    dispatched: bool | None = None,
) -> list[dict[str, Any]]:
    keyword = str(q or "").strip().lower()
    result: list[dict[str, Any]] = []
    for raw in accounts:
        item = enrich_account(raw)
        if view and not account_in_view(item, view):
            continue
        if stage and str(item.get("stage") or "") != stage:
            continue
        if dispatched is not None and bool(item.get("dispatch", {}).get("dispatched")) != dispatched:
            continue
        if keyword:
            hay = " ".join(
                str(item.get(k) or "")
                for k in ("email", "password", "access_token", "activation")
            ).lower()
            cdk = str((item.get("activation") or {}).get("cdk") or "")
            if keyword not in hay and keyword not in cdk.lower():
                continue
        result.append(item)
    return result


def mark_dispatched(account: dict[str, Any], meta: dict[str, str] | None = None) -> dict[str, Any]:
    item = enrich_account(account)
    dispatch = dict(item.get("dispatch") or empty_dispatch())
    dispatch["dispatched"] = True
    dispatch["dispatched_at"] = _now()
    for key, value in (meta or {}).items():
        if key in dispatch:
            dispatch[key] = str(value or "")
    item["dispatch"] = dispatch
    return enrich_account(item)


def migrate_legacy(account_service, mailbox_service) -> int:
    """Merge mailbox pool into accounts and backfill lifecycle fields. Idempotent."""
    marker = DATA_DIR / ".lifecycle_migrated_v1"
    if marker.exists():
        changed = 0
        with account_service._lock:
            for key, raw in list(account_service._accounts.items()):
                enriched = enrich_account(raw)
                account_service._accounts[key] = enriched
                next_key = account_service._rekey_account_locked(key)
                if enriched != raw or next_key != key:
                    changed += 1
            if changed:
                account_service._save_accounts()
        return changed

    backup_dir = DATA_DIR / "backup_before_lifecycle"
    backup_dir.mkdir(parents=True, exist_ok=True)

    changed = 0
    with account_service._lock:
        by_email: dict[str, str] = {}
        for key, raw in account_service._accounts.items():
            email = _norm_email(str(raw.get("email") or ""))
            if email:
                by_email[email] = key

        for mailbox in mailbox_service.list_mailboxes():
            email = str(mailbox.get("email") or "").strip()
            if not email:
                continue
            norm = _norm_email(email)
            key = by_email.get(norm)
            if key:
                item = dict(account_service._accounts[key])
            else:
                key = email_storage_key(email)
                item = {"email": email, "access_token": key}
                by_email[norm] = key

            item["fetch_url"] = str(mailbox.get("fetch_url") or item.get("fetch_url") or "")
            if mailbox.get("in_use") and not mailbox.get("used"):
                item["_registering"] = True
                item["stage"] = STAGE_REGISTERING
            elif mailbox.get("used") and not item.get("access_token", "").startswith("eyJ"):
                item.setdefault("stage", STAGE_REGISTERED)
            elif not mailbox.get("used"):
                item.setdefault("stage", STAGE_UNREGISTERED)

            if mailbox.get("registered_at") and not item.get("registered_at"):
                item["registered_at"] = mailbox.get("registered_at")
            if mailbox.get("account_token"):
                item["access_token"] = str(mailbox.get("account_token"))

            enriched = enrich_account(item)
            next_key = account_service._rekey_account_locked(key)
            if next_key != key:
                account_service._accounts.pop(key, None)
                key = next_key
            account_service._accounts[key] = enriched
            changed += 1

        for key, raw in list(account_service._accounts.items()):
            enriched = enrich_account(raw)
            next_key = account_service._rekey_account_locked(key)
            if next_key != key:
                account_service._accounts.pop(key, None)
                key = next_key
            if enriched != account_service._accounts.get(key):
                account_service._accounts[key] = enriched
                changed += 1

        account_service._save_accounts()

    marker.write_text(json.dumps({"migrated_at": _now(), "changed": changed}, ensure_ascii=False), encoding="utf-8")
    return changed
