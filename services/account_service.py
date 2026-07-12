from __future__ import annotations

import base64
import json
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Condition, Lock, Thread
from typing import Any

from services.account_lifecycle import (
    PLAN_FREE,
    STAGE_PLUS_REVIEW,
    STAGE_REGISTERING,
    STAGE_REGISTERED,
    STAGE_UNREGISTERED,
    apply_stage,
    email_storage_key,
    empty_activation,
    enrich_account,
    is_email_key,
    mark_dispatched,
)
from services.config import config
from services.log_service import (
    LOG_TYPE_ACCOUNT,
    log_service,
)
from services.storage.base import StorageBackend
from utils.helper import anonymize_token


def _is_tls_connection_error(message: str) -> bool:
    """检测 TLS/SSL/代理连接错误（网络问题，可重试，不计入账号失败）。"""
    text = str(message or "").lower()
    return (
        "curl: (35)" in text
        or "curl: (97)" in text        # SOCKS5 代理瞬时拒绝（住宅代理换 IP 窗口）
        or "curl: (28)" in text        # 超时
        or "curl: (7)" in text         # 连接失败
        or "curl: (56)" in text        # 接收数据失败
        or "rejected by the socks5" in text
        or "connection closed abruptly" in text
        or "connection timed out" in text
        or "tls connect error" in text
        or "openssl_internal" in text
        or "ssl: wrong_version_number" in text
        or "ssl: certificate_verify_failed" in text
        or "connection aborted" in text
        or "remote disconnected" in text
        or "connection reset by peer" in text
    )


def _normalize_checkout_meta(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    customer = str(value.get("customer") or "").strip()
    wechat = str(value.get("wechat") or "").strip()
    xianyu = str(value.get("xianyu") or "").strip()
    plan = str(value.get("plan") or "").strip()
    note = str(value.get("note") or "").strip()
    checkout_at = str(value.get("checkout_at") or "").strip()
    dispatch_no = str(value.get("dispatch_no") or "").strip()
    phone = str(value.get("phone") or "").strip()
    if not (customer or wechat or xianyu or plan or note or checkout_at or dispatch_no or phone):
        return None
    return {
        "customer": customer,
        "wechat": wechat,
        "xianyu": xianyu,
        "plan": plan,
        "note": note,
        "dispatch_no": dispatch_no,
        "phone": phone,
        "checkout_at": checkout_at or datetime.now(timezone.utc).isoformat(),
    }


class AccountService:
    """账号池服务，使用 token -> account 的 dict 保存账号。"""

    _NEW_ACCOUNT_INVALID_GRACE_SECONDS = 10 * 60
    _INVALID_CONFIRM_SECONDS = 30
    _ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 24 * 60 * 60
    _TOKEN_REFRESH_ERROR_BACKOFF_SECONDS = 5 * 60

    # 刷新进度追踪
    _refresh_progress: dict[str, dict] = {}
    _refresh_progress_lock = Lock()
    # 重新登录进度追踪
    _relogin_progress: dict[str, dict] = {}
    _relogin_progress_lock = Lock()

    def __init__(self, storage_backend: StorageBackend):
        self.storage = storage_backend
        self._lock = Lock()
        self._token_refresh_lock = Lock()
        self._image_slot_condition = Condition(self._lock)
        self._index = 0
        self._accounts = self._load_accounts()
        self._image_inflight: dict[str, int] = {}
        self._token_aliases: dict[str, str] = {}
        self._cumulative_total = self._load_cumulative_total()

    def _get_cumulative_file(self) -> Path:
        from services.config import DATA_DIR
        return DATA_DIR / ".cumulative_total"

    def _load_cumulative_total(self) -> int:
        try:
            data = self.storage.load_state("cumulative_total")
            if isinstance(data, dict) and data.get("value") is not None:
                return int(data["value"])
            # 后端无记录：尝试从旧 .cumulative_total 文件一次性迁移
            f = self._get_cumulative_file()
            if f.exists():
                n = int(f.read_text().strip())
                self.storage.save_state("cumulative_total", {"value": n})
                return n
        except Exception:
            pass
        return len(self._accounts)

    def _save_cumulative_total(self) -> None:
        try:
            self.storage.save_state("cumulative_total", {"value": int(self._cumulative_total)})
        except Exception:
            pass

    def reconcile_stuck_activations(self) -> int:
        """启动对账：把硬杀残留、卡在「排队中/激活中」的账号复位为「未激活」，供重启后重新激活。

        清 plus_cdk/plus_task_id/plus_last_message；**保留 plus_attempts**（续着已试次数，避免无限重试）；
        不动 plus_unavailable 及「已激活/激活失败」终态。同时把 stage 从 activating 复位为 registered。
        返回复位数量。
        """
        from services.account_lifecycle import PLAN_PLUS, STAGE_ACTIVATING, STAGE_PLUS_ACTIVATED, STAGE_REGISTERED, apply_stage, enrich_account

        reset = 0
        for acct in self.list_accounts():
            item = enrich_account(acct)
            if item.get("plus_status") in ("已激活", "激活失败"):
                continue
            if item.get("plus_activated_at"):
                continue
            token = item.get("access_token")
            if not token:
                continue
            stuck_plus = item.get("plus_status") in ("排队中", "激活中")
            stuck_stage = str(item.get("stage")) == STAGE_ACTIVATING
            if not stuck_plus and not stuck_stage:
                continue
            if item.get("plus_redeem_locked"):
                # 重启前已提交并被服务端受理过 CDK：按已激活保留，避免重复烧卡。
                patch = apply_stage(
                    {**item, "plus_last_message": "重启前已提交 CDK，已标记为已激活"},
                    STAGE_PLUS_ACTIVATED,
                    plan=PLAN_PLUS,
                    activated_at=item.get("activated_at") or item.get("plus_activated_at") or None,
                )
                self.update_account(token, patch, quiet=True)
                reset += 1
                continue
            patch: dict = {
                "plus_status": "未激活",
                "plus_cdk": None,
                "plus_task_id": None,
                "plus_last_message": None,
            }
            if stuck_stage:
                patch = apply_stage({**item, **patch}, STAGE_REGISTERED)
            self.update_account(token, patch, quiet=True)
            reset += 1
        return reset

    def migrate_plus_review_accounts(self) -> int:
        """将历史 plus_review 账号持久化为 plus_activated。幂等。"""
        from services.account_lifecycle import PLAN_PLUS, STAGE_PLUS_ACTIVATED, STAGE_PLUS_REVIEW, apply_stage, enrich_account

        changed = 0
        with self._lock:
            for key, raw in list(self._accounts.items()):
                stage = str(raw.get("stage") or "")
                if stage != STAGE_PLUS_REVIEW:
                    continue
                item = apply_stage(
                    enrich_account(raw),
                    STAGE_PLUS_ACTIVATED,
                    plan=PLAN_PLUS,
                    activated_at=raw.get("plus_activated_at") or raw.get("activated_at"),
                )
                account = self._normalize_account(item)
                if account is None:
                    continue
                self._accounts[key] = account
                changed += 1
            if changed:
                self._save_accounts()
        return changed

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    @staticmethod
    def _decode_jwt_payload(token: str) -> dict:
        try:
            payload = str(token or "").split(".")[1]
            payload += "=" * ((4 - len(payload) % 4) % 4)
            import base64
            import json
            data = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    @staticmethod
    def _parse_time(value: object) -> datetime | None:
        raw = str(value or "").strip()
        if not raw:
            return None
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except Exception:
            try:
                parsed = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
            except Exception:
                return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    @staticmethod
    def _timestamp_to_iso(value: object) -> str:
        try:
            ts = int(value)
        except (TypeError, ValueError):
            return ""
        tz = timezone(timedelta(hours=8))
        return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(tz).isoformat()

    def _load_accounts(self) -> dict[str, dict]:
        accounts = self.storage.load_accounts()
        result: dict[str, dict] = {}
        for item in accounts:
            normalized = self._normalize_account(item)
            if normalized is None:
                continue
            key = self._account_dict_key(normalized)
            if key:
                result[key] = normalized
        return result

    def _save_accounts(self) -> None:
        self.storage.save_accounts(list(self._accounts.values()))

    @staticmethod
    def _is_image_account_available(account: dict) -> bool:
        if not isinstance(account, dict):
            return False
        if account.get("status") in {"禁用", "限流", "异常"}:
            return False
        if bool(account.get("image_quota_unknown")):
            return True
        return int(account.get("quota") or 0) > 0

    @classmethod
    def _account_matches_plan_type(cls, account: dict, plan_type: str | None = None) -> bool:
        if not plan_type:
            return True
        normalized_plan = cls._normalize_account_type(plan_type)
        normalized_account = cls._normalize_account_type(account.get("type"))
        if not normalized_plan or not normalized_account:
            return False
        return normalized_plan.lower() == normalized_account.lower()

    @classmethod
    def _account_matches_source_type(cls, account: dict, source_type: str | None = None) -> bool:
        if not source_type:
            return True
        return cls._normalize_source_type(account.get("source_type")) == cls._normalize_source_type(source_type)

    @classmethod
    def _account_matches_any_plan_type(cls, account: dict, plan_types: set[str] | tuple[str, ...] | None = None) -> bool:
        if not plan_types:
            return True
        normalized_account = cls._normalize_account_type(account.get("type"))
        normalized_plans = {
            normalized
            for plan_type in plan_types
            if (normalized := cls._normalize_account_type(plan_type))
        }
        return bool(normalized_account and normalized_account in normalized_plans)

    @staticmethod
    def _normalize_source_type(value: object) -> str:
        return str(value or "web").strip().lower() or "web"

    @staticmethod
    def _normalize_account_type(value: object) -> str | None:
        raw = str(value or "").strip()
        if not raw:
            return None
        key = raw.lower().replace("-", "_").replace(" ", "_")
        compact = key.replace("_", "")
        aliases = {
            "free": "free",
            "plus": "Plus",
            "pro": "Pro",
            "prolite": "ProLite",
            "team": "Team",
            "business": "Team",
            "enterprise": "Enterprise",
        }
        return aliases.get(compact) or aliases.get(key) or raw

    def _search_account_type(self, payload: object) -> str | None:
        if isinstance(payload, dict):
            for key in ("plan_type", "account_plan", "account_type", "subscription_type", "type"):
                plan = self._normalize_account_type(payload.get(key))
                if plan:
                    return plan
            for value in payload.values():
                plan = self._search_account_type(value)
                if plan:
                    return plan
        elif isinstance(payload, list):
            for value in payload:
                plan = self._search_account_type(value)
                if plan:
                    return plan
        return None

    @staticmethod
    def _account_dict_key(item: dict) -> str:
        email = str(item.get("email") or "").strip()
        if email:
            return email_storage_key(email)
        token = str(item.get("access_token") or "").strip()
        if token and not is_email_key(token):
            return token
        return ""

    def _normalize_account(self, item: dict) -> dict | None:
        if not isinstance(item, dict):
            return None
        access_token = str(item.get("access_token") or item.get("accessToken") or "").strip()
        if is_email_key(access_token):
            access_token = ""
        email = str(item.get("email") or "").strip()
        if not access_token and not email:
            return None
        normalized = dict(item)
        normalized.pop("accessToken", None)
        normalized["access_token"] = access_token
        # 兼容早期成品号数据：曾把整行「邮箱/密码/2FA 文本」误存进 access_token，
        # 这里在归一化时反解析一次，自动补回 email/password/totp_secret/mail_link。
        if " ---- " in str(access_token):
            legacy_accounts, _ = self.parse_import_blob(str(access_token))
            legacy = legacy_accounts[0] if legacy_accounts else {}
            for key in ("email", "mail_link", "password", "totp_secret"):
                if legacy.get(key) and not normalized.get(key):
                    normalized[key] = legacy.get(key)
        if str(normalized.get("type") or "").strip().lower() == "codex":
            normalized["export_type"] = "codex"
            normalized.pop("type", None)
        normalized["type"] = normalized.get("type") or "free"
        normalized["status"] = normalized.get("status") or "正常"
        normalized["quota"] = max(0, int(normalized.get("quota") if normalized.get("quota") is not None else 0))
        normalized["image_quota_unknown"] = bool(normalized.get("image_quota_unknown"))
        normalized["email"] = normalized.get("email") or None
        normalized["user_id"] = normalized.get("user_id") or None
        normalized["proxy"] = str(normalized.get("proxy") or "").strip()
        normalized["country"] = str(normalized.get("country") or "").strip() or None
        normalized["exit_ip"] = str(normalized.get("exit_ip") or "").strip() or None
        source_type = normalized.get("source_type")
        if not source_type and str(normalized.get("export_type") or "").strip().lower() == "codex":
            source_type = "codex"
        normalized["source_type"] = self._normalize_source_type(source_type)
        limits_progress = normalized.get("limits_progress")
        normalized["limits_progress"] = limits_progress if isinstance(limits_progress, list) else []
        normalized["default_model_slug"] = normalized.get("default_model_slug") or None
        normalized["restore_at"] = normalized.get("restore_at") or None
        normalized["success"] = int(normalized.get("success") or 0)
        normalized["fail"] = int(normalized.get("fail") or 0)
        normalized["invalid_count"] = int(normalized.get("invalid_count") or 0)
        normalized["last_used_at"] = normalized.get("last_used_at")
        normalized["last_invalid_at"] = normalized.get("last_invalid_at") or None
        normalized["last_refresh_error"] = normalized.get("last_refresh_error") or None
        normalized["last_refresh_error_at"] = normalized.get("last_refresh_error_at") or None
        normalized["last_token_refresh_at"] = normalized.get("last_token_refresh_at") or None
        normalized["last_token_refresh_error"] = normalized.get("last_token_refresh_error") or None
        normalized["last_token_refresh_error_at"] = normalized.get("last_token_refresh_error_at") or None
        normalized["created_at"] = normalized.get("created_at") or AccountService._now()
        # 2FA (TOTP) 相关：开启后保存 base32 secret 与 otpauth URL，用于展示和关闭时算码。
        normalized["totp_secret"] = normalized.get("totp_secret") or None
        normalized["otpauth_url"] = normalized.get("otpauth_url") or None
        # 导出消费标记：账号导出给客户后标记「已用」，便于区分未用库存。
        normalized["used"] = bool(normalized.get("used"))
        normalized["checkout_at"] = normalized.get("checkout_at") or None
        normalized["checkout_meta"] = _normalize_checkout_meta(normalized.get("checkout_meta")) or None
        # Plus 激活相关字段（由 activation_service 维护）。
        plus_status = str(normalized.get("plus_status") or "未激活").strip() or "未激活"
        if plus_status not in {"未激活", "排队中", "激活中", "已激活", "激活失败"}:
            plus_status = "未激活"
        normalized["plus_status"] = plus_status
        attempts = normalized.get("plus_attempts")
        attempts = attempts if isinstance(attempts, dict) else {}
        normalized["plus_attempts"] = {"UPI": int(attempts.get("UPI") or 0), "IDEL": int(attempts.get("IDEL") or 0)}
        normalized["plus_cdk"] = normalized.get("plus_cdk") or None
        _cdk_type = str(normalized.get("plus_cdk_type") or "").strip().upper()
        normalized["plus_cdk_type"] = _cdk_type if _cdk_type in ("UPI", "IDEL") else None
        normalized["plus_task_id"] = normalized.get("plus_task_id") or None
        normalized["plus_last_message"] = normalized.get("plus_last_message") or None
        normalized["plus_updated_at"] = normalized.get("plus_updated_at") or None
        # 首次激活成功（plus_status→已激活）的时间戳，仅写一次，供账号管理「激活日期」列展示。
        normalized["plus_activated_at"] = normalized.get("plus_activated_at") or None
        # 指纹 Seed：注册内核迁移后会写入专用随机种子；存量/当前号先回退到注册时的 oai-device-id。
        normalized["fingerprint_seed"] = normalized.get("fingerprint_seed") or normalized.get("oai-device-id") or None
        # 激活不可用标记：某邮箱账号两种类型 CDK 均连续激活失败后置位，下轮激活自动跳过，
        # 直到人工「标记可用」重置。与 plus_status 分离，保证重置后仍持久生效。
        normalized["plus_unavailable"] = bool(normalized.get("plus_unavailable"))
        return enrich_account(normalized)

    @staticmethod
    def _jwt_exp(access_token: str) -> int:
        try:
            return int(AccountService._decode_jwt_payload(access_token).get("exp") or 0)
        except (TypeError, ValueError):
            return 0

    @classmethod
    def _token_expires_in(cls, access_token: str) -> int | None:
        exp = cls._jwt_exp(access_token)
        if exp <= 0:
            return None
        return exp - int(time.time())

    @classmethod
    def _token_needs_refresh(cls, access_token: str, *, force: bool = False) -> bool:
        if force:
            return True
        remaining = cls._token_expires_in(access_token)
        return remaining is not None and remaining <= cls._ACCESS_TOKEN_REFRESH_SKEW_SECONDS

    @classmethod
    def _token_issued_at(cls, access_token: str) -> datetime | None:
        try:
            iat = int(cls._decode_jwt_payload(access_token).get("iat") or 0)
        except (TypeError, ValueError):
            return None
        if iat <= 0:
            return None
        return datetime.fromtimestamp(iat, tz=timezone.utc)

    @staticmethod
    def _safe_response_text(response: object, limit: int = 300) -> str:
        try:
            return str(getattr(response, "text", "") or "")[:limit]
        except Exception:
            return ""

    def _resolve_access_token_locked(self, access_token: str) -> str:
        token = str(access_token or "").strip()
        seen: set[str] = set()
        while token and token not in self._accounts and token in self._token_aliases and token not in seen:
            seen.add(token)
            token = self._token_aliases.get(token, token)
        return token

    def _resolve_storage_key_locked(self, identifier: str) -> str:
        """Map API identifier (JWT / email:: / email) to the in-memory accounts dict key."""
        token = str(identifier or "").strip()
        if not token:
            return ""
        aliased = self._resolve_access_token_locked(token)
        if aliased in self._accounts:
            return aliased
        if token in self._accounts:
            return token
        if is_email_key(token):
            return token if token in self._accounts else ""
        if self._looks_like_email(token):
            email_key = email_storage_key(token)
            if email_key in self._accounts:
                return email_key
        norm = token.lower()
        for key, raw in self._accounts.items():
            if not isinstance(raw, dict):
                continue
            stored_token = str(raw.get("access_token") or "").strip()
            if stored_token and stored_token in {token, aliased}:
                return key
            email = str(raw.get("email") or "").strip().lower()
            if email and email == norm:
                return key
        return ""

    def _rekey_account_locked(self, old_key: str) -> str:
        raw = self._accounts.get(old_key)
        if not isinstance(raw, dict):
            return old_key
        normalized = self._normalize_account(dict(raw))
        if normalized is None:
            return old_key
        new_key = self._account_dict_key(normalized)
        if not new_key:
            return old_key
        if new_key != old_key:
            self._accounts.pop(old_key, None)
        self._accounts[new_key] = normalized
        return new_key

    def resolve_access_token(self, access_token: str) -> str:
        if not access_token:
            return ""
        with self._lock:
            return self._resolve_access_token_locked(access_token)

    def _get_account_for_token(self, access_token: str) -> tuple[str, dict | None]:
        with self._lock:
            storage_key = self._resolve_storage_key_locked(access_token)
            if not storage_key:
                return "", None
            account = self._accounts.get(storage_key)
            return storage_key, dict(account) if account else None

    def _record_token_refresh_error(self, access_token: str, event: str, error: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            storage_key = self._resolve_storage_key_locked(access_token)
            current = self._accounts.get(storage_key) if storage_key else None
            if current is None:
                return
            next_item = dict(current)
            next_item["last_token_refresh_error"] = str(error or "refresh token failed")
            next_item["last_token_refresh_error_at"] = now
            account = self._normalize_account(next_item)
            if account is not None:
                self._accounts[storage_key] = account
                self._save_accounts()
        log_service.add(
            LOG_TYPE_ACCOUNT,
            "刷新 access_token 失败",
            {"source": event, "token": anonymize_token(access_token), "error": str(error or "")},
        )

    def _recent_token_refresh_error(self, account: dict) -> bool:
        last_error_at = self._parse_time(account.get("last_token_refresh_error_at"))
        if last_error_at is None:
            return False
        return (datetime.now(timezone.utc) - last_error_at).total_seconds() < self._TOKEN_REFRESH_ERROR_BACKOFF_SECONDS

    def _apply_refreshed_tokens(self, old_access_token: str, token_data: dict, event: str) -> str:
        now = datetime.now(timezone.utc).isoformat()
        with self._image_slot_condition:
            storage_key = self._resolve_storage_key_locked(old_access_token)
            current = self._accounts.get(storage_key) if storage_key else None
            if current is None:
                return old_access_token
            old_token = str(current.get("access_token") or old_access_token).strip()
            new_token = str(token_data.get("access_token") or old_token).strip()
            if not new_token:
                return old_token

            next_item = dict(current)
            next_item["access_token"] = new_token
            if token_data.get("id_token"):
                next_item["id_token"] = str(token_data.get("id_token") or "").strip()
            next_item["last_token_refresh_at"] = now
            next_item["last_token_refresh_error"] = None
            next_item["last_token_refresh_error_at"] = None
            next_item["invalid_count"] = 0
            next_item["last_invalid_at"] = None
            next_item["last_refresh_error"] = None
            next_item["last_refresh_error_at"] = None

            account = self._normalize_account(next_item)
            if account is None:
                return old_token

            rotated = new_token != old_token
            if rotated:
                self._token_aliases[old_token] = new_token
                old_inflight = int(self._image_inflight.pop(old_token, 0))
                if old_inflight:
                    self._image_inflight[new_token] = int(self._image_inflight.get(new_token, 0)) + old_inflight
            self._accounts[storage_key] = account
            self._save_accounts()
            self._image_slot_condition.notify_all()

        log_service.add(
            LOG_TYPE_ACCOUNT,
            "浏览器登录已刷新 access_token",
            {"source": event, "token": anonymize_token(new_token), "rotated": rotated},
        )
        return new_token

    def refresh_access_token(self, access_token: str, *, force: bool = False, event: str = "refresh_access_token") -> str:
        if not access_token:
            return ""
        with self._token_refresh_lock:
            resolved_token, account = self._get_account_for_token(access_token)
            if not account:
                return access_token
            active_token = str(account.get("access_token") or resolved_token or access_token)
            if not self._token_needs_refresh(active_token, force=force):
                return active_token
            if not force and self._recent_token_refresh_error(account):
                return active_token
            # token 失效 → 走浏览器 UI 登录取新 token（不再有 refresh_token 无头刷新）。
            # 无邮箱/无密码的号（外部购号未存密码）无法浏览器登录，保持现 token 不动。
            email = str(account.get("email") or "").strip()
            password = str(account.get("password") or "").strip()
            totp_secret = str(account.get("totp_secret") or "").strip()
            account_proxy = str(account.get("proxy") or "").strip()
            if not email or not password:
                return active_token
        # 浏览器登录（并发闸在 openai_account_ops 内）：锁外同步执行，拿到新 token 再落库返回，
        # 保证 fetch_remote_info 等调用方能在同一次调用里拿到有效新 token（否则会误判失效移除账号）。
        from services.register import openai_account_ops
        from services.activation_audit_context import get_recorder
        recorder = get_recorder()
        if recorder is not None:
            recorder.record_http(
                "openai_browser_login",
                {
                    "method": "BROWSER",
                    "path": "/browser-login",
                    "url": "",
                    "request": {"email": email, "event": event, "force": force},
                    "http_status": None,
                    "response": None,
                },
            )
        result = openai_account_ops.run_browser_login(
            email, password, totp_secret=totp_secret, account_proxy=account_proxy,
            country=str(account.get("country") or ""),
        )
        if recorder is not None:
            recorder.record_http(
                "openai_browser_login_result",
                {
                    "method": "BROWSER",
                    "path": "/browser-login",
                    "url": "",
                    "request": {"email": email, "event": event},
                    "http_status": 200 if result.get("ok") else 500,
                    "response": {
                        "ok": bool(result.get("ok")),
                        "error": str(result.get("error") or ""),
                        "has_access_token": bool(result.get("access_token")),
                    },
                    "error": None if result.get("ok") else str(result.get("error") or "browser login failed"),
                },
            )
        if not result.get("ok"):
            self._record_token_refresh_error(active_token, event, str(result.get("error") or ""))
            return active_token
        token_data = {"access_token": str(result.get("access_token") or "")}
        new_token = self._apply_refreshed_tokens(active_token, token_data, event)
        updates = {"source_type": "web", "status": "正常"}
        reset_pwd = str(result.get("reset_password") or "")
        if reset_pwd:
            updates["password"] = reset_pwd
        self.update_account(new_token, updates, quiet=True)
        return new_token

    def _password_re_login_thread(self, access_token: str, email: str, password: str, event: str, progress_id: str | None = None) -> None:
        """密码重新登录线程入口"""
        try:
            account = self.get_account(access_token)
            # 账号已开 2FA 时，登录会触发 mfa_challenge，需带上存储的 totp_secret 自动过；
            # 同时复用账号绑定邮箱的 OTP 取码（登录也可能触发邮箱步进）。
            totp_secret = str((account or {}).get("totp_secret") or "").strip()
            account_proxy = str((account or {}).get("proxy") or "").strip()
            account_country = str((account or {}).get("country") or "").strip()
            # 浏览器 UI 登录取新 token（用账号存的 password+totp；密码错/无密码时 loginChatGPT
            # 内部走邮箱 OTP / 忘记密码兜底）。住宅代理偶发瞬时断连，做幂等重试（每次全新浏览器会话）。
            from services.register import openai_account_ops
            result = {}
            for attempt in range(2):
                result = openai_account_ops.run_browser_login(
                    email, password,
                    totp_secret=totp_secret,
                    account_proxy=account_proxy,
                    country=account_country,
                )
                if result.get("ok") or not _is_tls_connection_error(str(result.get("error") or "")):
                    break
                time.sleep(1.5 * (attempt + 1))
            if result.get("ok"):
                # 登录成功，更新账号
                new_access_token = result.get("access_token", "")

                # 构建 token_data 供 _apply_refreshed_tokens 使用（浏览器登录只产 access_token）
                token_data = {"access_token": new_access_token}

                # 使用 _apply_refreshed_tokens 更新账号（处理 token 别名）
                new_token = self._apply_refreshed_tokens(access_token, token_data, f"{event}:password_relogin")

                # 额外更新 source_type/status；走了忘记密码重设则回写新密码（静默，避免重复日志）
                updates = {"source_type": "web", "status": "正常"}
                reset_pwd = str(result.get("reset_password") or "")
                if reset_pwd:
                    updates["password"] = reset_pwd
                self.update_account(new_token, updates, quiet=True)

                log_service.add(
                    LOG_TYPE_ACCOUNT,
                    "更新账号",
                    {
                        "source": event,
                        "old_token": anonymize_token(access_token),
                        "new_token": anonymize_token(new_access_token),
                        "email": email,
                        "status": "成功",
                    },
                )
                if progress_id:
                    self.update_relogin_progress(progress_id, access_token, "成功")
            else:
                # 登录失败
                error_type = result.get("error", "")
                if error_type == "password_verify_failed_403" and isinstance(result.get("detail"), dict):
                    log_service.add(
                        LOG_TYPE_ACCOUNT,
                        "更新账号",
                        {
                            "source": event,
                            "token": anonymize_token(access_token),
                            "email": email,
                            "status": "失败",
                            "error": error_type,
                            "detail": result.get("detail", {}),
                        },
                    )
                    detail_error = result["detail"].get("error", {})
                    if isinstance(detail_error, dict) and detail_error.get("code") == "account_deactivated":
                        # 账号已删除/停用 → 标记为禁用
                        self.update_account(access_token, {"status": "禁用", "quota": 0}, quiet=True)
                        account = self.get_account(access_token) or {}
                        log_service.add(
                            LOG_TYPE_ACCOUNT,
                            "账号已停用-标记禁用",
                            {
                                "source": event,
                                "token": anonymize_token(access_token),
                                "email": email,
                                "detail": result.get("detail", {}),
                            },
                        )
                        if progress_id:
                            self.update_relogin_progress(progress_id, access_token, "禁用")
                    else:
                        # 永久故障：将账号标记为异常（或自动移除）
                        self.remove_invalid_token(access_token, f"{event}:password_relogin_failed", quiet=True)
                        if progress_id:
                            self.update_relogin_progress(progress_id, access_token, "异常", error_type)
                else:
                    log_service.add(
                        LOG_TYPE_ACCOUNT,
                        "更新账号",
                        {
                            "source": event,
                            "token": anonymize_token(access_token),
                            "email": email,
                            "status": "失败",
                            "error": error_type,
                            "detail": result.get("detail", {}),
                        },
                    )
                    # 永久故障：将账号标记为异常（或自动移除）
                    self.remove_invalid_token(access_token, f"{event}:password_relogin_failed", quiet=True)
                    if progress_id:
                        self.update_relogin_progress(progress_id, access_token, "异常", error_type)
        except Exception as exc:
            log_service.add(
                LOG_TYPE_ACCOUNT,
                "更新账号",
                {
                    "source": event,
                    "token": anonymize_token(access_token),
                    "email": email,
                    "status": "异常",
                    "error": str(exc),
                },
            )
            # 将账号标记为异常（或自动移除）
            self.remove_invalid_token(access_token, f"{event}:password_relogin_exception", quiet=True)
            if progress_id:
                self.update_relogin_progress(progress_id, access_token, "异常", str(exc))

    def list_expiring_access_tokens(self) -> list[str]:
        with self._lock:
            return [
                token
                for account in self._accounts.values()
                if (token := str(account.get("access_token") or "").strip())
                and self._token_needs_refresh(token)
            ]

    def list_tokens(self) -> list[str]:
        with self._lock:
            return list(self._accounts)

    def _list_ready_candidate_tokens(
            self,
            excluded_tokens: set[str] | None = None,
            plan_type: str | None = None,
            source_type: str | None = None,
            plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> list[str]:
        excluded = set(excluded_tokens or set())
        return [
            token
            for item in self._accounts.values()
            if self._is_image_account_available(item)
               and self._account_matches_plan_type(item, plan_type)
               and self._account_matches_any_plan_type(item, plan_types)
               and self._account_matches_source_type(item, source_type)
               and (token := item.get("access_token") or "")
               and token not in excluded
        ]

    def _list_available_candidate_tokens(
            self,
            excluded_tokens: set[str] | None = None,
            plan_type: str | None = None,
            source_type: str | None = None,
            plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> list[str]:
        max_concurrency = max(1, int(config.image_account_concurrency or 1))
        return [
            token
            for token in self._list_ready_candidate_tokens(excluded_tokens, plan_type, source_type, plan_types)
            if int(self._image_inflight.get(token, 0)) < max_concurrency
        ]

    def _acquire_next_candidate_token(
            self,
            excluded_tokens: set[str] | None = None,
            plan_type: str | None = None,
            source_type: str | None = None,
            plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> str:
        with self._image_slot_condition:
            while True:
                if not self._list_ready_candidate_tokens(excluded_tokens, plan_type, source_type, plan_types):
                    raise RuntimeError(
                        f"no available {plan_type or source_type or ''} image quota".replace("  ", " ").strip()
                        if plan_type or source_type else "no available image quota"
                    )
                tokens = self._list_available_candidate_tokens(excluded_tokens, plan_type, source_type, plan_types)
                if tokens:
                    access_token = tokens[self._index % len(tokens)]
                    self._index += 1
                    self._image_inflight[access_token] = int(self._image_inflight.get(access_token, 0)) + 1
                    return access_token
                self._image_slot_condition.wait(timeout=1.0)

    def release_image_slot(self, access_token: str) -> None:
        if not access_token:
            return
        with self._image_slot_condition:
            access_token = self._resolve_access_token_locked(access_token)
            current_inflight = int(self._image_inflight.get(access_token, 0))
            if current_inflight <= 1:
                self._image_inflight.pop(access_token, None)
            else:
                self._image_inflight[access_token] = current_inflight - 1
            self._image_slot_condition.notify_all()

    def get_available_access_token(
            self,
            plan_type: str | None = None,
            source_type: str | None = None,
            plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> str:
        """从候选池中获取一个可用的图片生图 token。

        基于本地缓存做初筛，然后通过 fetch_remote_info 做远程验证（token 有效性、配额等）。
        限制最大尝试次数防止 token rotation 导致无限循环。
        """
        max_attempts = 20  # 防止无限循环
        attempted_tokens: set[str] = set()
        for _attempt in range(max_attempts):
            access_token = self._acquire_next_candidate_token(
                excluded_tokens=attempted_tokens,
                plan_type=plan_type,
                source_type=source_type,
                plan_types=plan_types,
            )
            attempted_tokens.add(access_token)
            try:
                account = self.fetch_remote_info(access_token, "get_available_access_token")
            except Exception:
                self.release_image_slot(access_token)
                continue
            # fetch_remote_info 内部可能因 token rotation 导致 access_token 变化，
            # 把新 token 也加入排除列表，防止重复尝试
            resolved = str((account or {}).get("access_token") or "")
            if resolved and resolved != access_token:
                attempted_tokens.add(resolved)
            if (
                    self._is_image_account_available(account or {})
                    and self._account_matches_plan_type(account or {}, plan_type)
                    and self._account_matches_any_plan_type(account or {}, plan_types)
                    and self._account_matches_source_type(account or {}, source_type)
            ):
                return str((account or {}).get("access_token") or access_token)
            self.release_image_slot(access_token)
        raise RuntimeError(
            f"no available {plan_type or source_type or ''} image quota (tried {len(attempted_tokens)} tokens)".replace("  ", " ").strip()
            if plan_type or source_type else f"no available image quota (tried {len(attempted_tokens)} tokens)"
        )

    def get_text_access_token(self, excluded_tokens: set[str] | None = None) -> str:
        excluded = set(excluded_tokens or set())
        with self._lock:
            candidates = [
                token
                for account in self._accounts.values()
                if account.get("status") not in {"禁用", "异常"}
                   and (token := account.get("access_token") or "")
                   and token not in excluded
            ]
            if not candidates:
                return ""
            access_token = candidates[self._index % len(candidates)]
            self._index += 1
        return self.refresh_access_token(access_token, event="get_text_access_token") or access_token

    def mark_text_used(self, access_token: str) -> None:
        if not access_token:
            return
        with self._lock:
            storage_key = self._resolve_storage_key_locked(access_token)
            current = self._accounts.get(storage_key) if storage_key else None
            if current is None:
                return
            next_item = dict(current)
            next_item["last_used_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            account = self._normalize_account(next_item)
            if account is None:
                return
            self._accounts[storage_key] = account
            self._save_accounts()

    def remove_invalid_token(self, access_token: str, event: str, quiet: bool = False) -> bool:
        if not config.auto_remove_invalid_accounts:
            self.update_account(access_token, {"status": "异常", "quota": 0}, quiet=quiet)
            return False
        removed = bool(self.delete_accounts([access_token])["removed"])
        if removed:
            log_service.add(LOG_TYPE_ACCOUNT, "自动移除异常账号",
                            {"source": event, "token": anonymize_token(access_token)})
        elif access_token:
            self.update_account(access_token, {"status": "异常", "quota": 0}, quiet=quiet)
        return removed

    def get_account(self, access_token: str) -> dict | None:
        if not access_token:
            return None
        _, account = self._get_account_for_token(access_token)
        return account

    def list_accounts(self) -> list[dict]:
        """返回所有账号的副本，并为每个账号附加当前图片在途数 image_inflight。

        image_inflight 为内存态并发计数(账号正在生成、尚未结束的图片数)。号池空闲时
        若某账号该值持续 > 0，说明其并发槽位泄漏、已被静默排除出调度，可借此在 UI 上诊断。
        """
        with self._lock:
            result = []
            for item in self._accounts.values():
                account = enrich_account(dict(item))
                token = account.get("access_token") or ""
                account["image_inflight"] = int(self._image_inflight.get(token, 0))
                result.append(account)
            return result

    def find_by_email(self, email: str) -> dict | None:
        norm = str(email or "").strip().lower()
        if not norm:
            return None
        with self._lock:
            for item in self._accounts.values():
                if str(item.get("email") or "").strip().lower() == norm:
                    return enrich_account(dict(item))
            key = email_storage_key(norm)
            item = self._accounts.get(key)
            return enrich_account(dict(item)) if item else None

    def upsert_mailbox_record(self, email: str, fetch_url: str, *, stage: str = STAGE_UNREGISTERED) -> dict:
        email = str(email or "").strip()
        fetch_url = str(fetch_url or "").strip()
        key = email_storage_key(email)
        with self._lock:
            current = dict(self._accounts.get(key) or {"email": email})
            current["email"] = email
            current["fetch_url"] = fetch_url or current.get("fetch_url")
            token = str(current.get("access_token") or "").strip()
            if is_email_key(token):
                current.pop("access_token", None)
            current = apply_stage(current, stage)
            account = self._normalize_account(current)
            if account is None:
                raise ValueError(f"invalid mailbox record: {email}")
            self._accounts[key] = account
            self._save_accounts()
            return dict(self._accounts[key])

    def reserve_emails_for_register(self, emails: list[str]) -> list[str]:
        reserved: list[str] = []
        with self._lock:
            for email in emails or []:
                norm = str(email or "").strip()
                if not norm:
                    continue
                key = email_storage_key(norm)
                current = self._accounts.get(key)
                if current is None:
                    current = {"email": norm, "fetch_url": ""}
                else:
                    current = dict(current)
                    token = str(current.get("access_token") or "").strip()
                    if is_email_key(token):
                        current.pop("access_token", None)
                item = apply_stage(dict(current), STAGE_REGISTERING, _registering=True)
                self._accounts[key] = self._normalize_account(item)
                reserved.append(norm)
            if reserved:
                self._save_accounts()
        return reserved

    def complete_registration(self, email: str, payload: dict) -> dict | None:
        with self._lock:
            norm = str(email or "").strip().lower()
            email_key = email_storage_key(norm)
            payload = dict(payload or {})
            new_token = str(payload.get("access_token") or "").strip()

            # 注册成功时 add_account_items 往往已先写入带 password/2FA 的真实 token 行；
            # 若这里误命中 email:: 占位行再覆盖同 token 键，会把凭据冲掉。
            current: dict = {}
            if new_token and new_token in self._accounts:
                current = dict(self._accounts[new_token])
            else:
                key = None
                for k, item in self._accounts.items():
                    if str(item.get("email") or "").strip().lower() == norm:
                        key = k
                        break
                if key is None:
                    key = email_key
                current = dict(self._accounts.get(key) or {"email": email})

            # 防止二次合并时空值冲掉已写入的密码/2FA；仅回传 otpauth_url 时自动补全 totp_secret。
            incoming_password = str(payload.get("password") or "").strip()
            incoming_totp = str(payload.get("totp_secret") or "").strip()
            incoming_otpauth = str(payload.get("otpauth_url") or "").strip()
            if not incoming_totp and incoming_otpauth:
                incoming_totp = self._totp_secret_from_otpauth(incoming_otpauth)
            if incoming_password:
                payload["password"] = incoming_password
            else:
                payload.pop("password", None)
            if incoming_totp:
                payload["totp_secret"] = incoming_totp
            else:
                payload.pop("totp_secret", None)
            if incoming_otpauth:
                payload["otpauth_url"] = incoming_otpauth
            else:
                payload.pop("otpauth_url", None)

            merged = {**current, **payload, "email": email, "_registering": False}
            if not str(merged.get("totp_secret") or "").strip():
                merged_totp = self._totp_secret_from_otpauth(merged.get("otpauth_url"))
                if merged_totp:
                    merged["totp_secret"] = merged_totp
            merged = apply_stage(
                merged,
                STAGE_REGISTERED,
                registered_at=merged.get("registered_at") or AccountService._now(),
            )
            new_token = str(merged.get("access_token") or "").strip()

            if new_token:
                self._accounts.pop(new_token, None)
            for stale_key in list(self._accounts.keys()):
                if stale_key == email_key:
                    continue
                stale = self._accounts.get(stale_key)
                if (
                    isinstance(stale, dict)
                    and str(stale.get("email") or "").strip().lower() == norm
                ):
                    self._accounts.pop(stale_key, None)

            storage_key = email_key if norm else (new_token or email_key)
            self._accounts[storage_key] = self._normalize_account(merged)
            account = dict(self._accounts[storage_key])
            self._save_accounts()
            return account

    def release_registration(
        self, email: str, error: str = "", *, remove_placeholder: bool = False,
    ) -> None:
        norm = str(email or "").strip().lower()
        if not norm:
            return
        with self._lock:
            key = None
            for k, item in self._accounts.items():
                if str(item.get("email") or "").strip().lower() == norm:
                    key = k
                    break
            email_key = email_storage_key(norm)
            if key is None:
                key = email_key
            current = dict(self._accounts.get(key) or {"email": email})
            token = str(current.get("access_token") or "").strip()
            has_credentials = (
                token.startswith("eyJ")
                or token.startswith("manual::")
                or bool(str(current.get("password") or "").strip())
            )
            if remove_placeholder and not has_credentials:
                self._accounts.pop(key, None)
                if email_key != key:
                    self._accounts.pop(email_key, None)
            else:
                if is_email_key(token):
                    current.pop("access_token", None)
                current = apply_stage(
                    current,
                    STAGE_UNREGISTERED,
                    _registering=False,
                    last_error=error or current.get("last_error"),
                )
                self._accounts[key] = self._normalize_account(current)
            self._save_accounts()

    def list_limited_tokens(self) -> list[str]:
        with self._lock:
            return [
                token
                for item in self._accounts.values()
                if item.get("status") == "限流"
                   and (token := item.get("access_token") or "")
            ]

    @staticmethod
    def _account_payload_token(item: dict) -> str:
        return str(item.get("access_token") or item.get("accessToken") or "").strip()

    @staticmethod
    def _looks_like_email(value: str) -> bool:
        return bool(value and "@" in value and "." in value.split("@")[-1])

    @staticmethod
    def _looks_like_totp_secret(value: str) -> bool:
        raw = str(value or "").strip().replace(" ", "")
        if len(raw) < 16:
            return False
        return bool(re.fullmatch(r"[A-Z2-7=]+", raw.upper()))

    @staticmethod
    def _totp_secret_from_otpauth(value: object) -> str:
        raw = str(value or "").strip()
        if not raw:
            return ""
        match = re.search(r"[?&]secret=([^&]+)", raw, flags=re.IGNORECASE)
        if not match:
            return ""
        secret = match.group(1).strip().replace(" ", "")
        # otpauth URI 里常见的 base32 padding URL 编码兜底。
        secret = secret.replace("%3D", "=").replace("%3d", "=")
        return secret.upper() if secret else ""

    @staticmethod
    def _extract_access_token(text: str) -> str:
        import re
        raw = str(text or "")
        match = re.search(r"(eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+)", raw)
        return match.group(1).strip() if match else ""

    @classmethod
    def parse_import_blob(cls, text: str) -> tuple[list[dict], list[str]]:
        import re

        items: list[dict] = []
        tokens: list[str] = []
        for raw_line in str(text or "").splitlines():
            line = raw_line.strip()
            if not line:
                continue

            # 账号池格式：`邮箱---密码---2FA--Accesstoken`（--/--- 混合分隔、无 key:value 标签）。
            # 判别：首段是邮箱且次段不是 URL（http 开头）——借此与旧「邮箱----接码地址URL----密码----2FA」
            # 凭据导出区分（其次段是取件地址 URL）。token 用全行 JWT 正则提取，兼容 token 内含 `-`/`--`。
            if "：" not in line and ":" not in line and re.search(r"-{2,}", line):
                fields = [seg.strip() for seg in re.split(r"-{2,}", line)]
                second = fields[1] if len(fields) > 1 else ""
                if fields and cls._looks_like_email(fields[0]) and not second.lower().startswith("http"):
                    dashed_token = cls._extract_access_token(line)
                    dashed: dict[str, str] = {"email": fields[0]}
                    if second and not second.startswith("eyJ"):
                        dashed["password"] = second
                    third = fields[2] if len(fields) > 2 else ""
                    if third and not third.startswith("eyJ"):
                        dashed["totp_secret"] = third
                    dashed["access_token"] = dashed_token or f"manual::{fields[0]}"
                    items.append(dashed)
                    continue

            payload: dict[str, str] = {}
            access_token = cls._extract_access_token(line)
            if access_token:
                payload["access_token"] = access_token

            email_match = re.search(r"(?:邮箱|email)\s*[:：]\s*(.+?)(?=(?:\s*----\s*(?:接码邮箱|Recv URL|密码|2FA密钥|2FA密匙|token|access[_ ]?token)\s*[:：])|$)", line, flags=re.IGNORECASE)
            if email_match:
                payload["email"] = email_match.group(1).strip()

            mail_link_match = re.search(r"(?:接码邮箱|Recv URL|接码)\s*[:：]\s*(.+?)(?=(?:\s*----\s*(?:邮箱|email|密码|2FA密钥|2FA密匙|token|access[_ ]?token)\s*[:：])|$)", line, flags=re.IGNORECASE)
            if mail_link_match:
                payload["mail_link"] = mail_link_match.group(1).strip()

            password_match = re.search(r"(?:密码|password)\s*[:：]\s*(.+?)(?=(?:\s*----\s*(?:邮箱|email|接码邮箱|Recv URL|2FA密钥|2FA密匙|token|access[_ ]?token)\s*[:：])|$)", line, flags=re.IGNORECASE)
            if password_match:
                payload["password"] = password_match.group(1).strip()

            totp_match = re.search(r"(?:2FA密钥|2FA密匙|2fa|totp|totp_secret|secret)\s*[:：]\s*(.+?)(?=(?:\s*----\s*(?:邮箱|email|接码邮箱|Recv URL|密码|token|access[_ ]?token)\s*[:：])|$)", line, flags=re.IGNORECASE)
            if totp_match:
                payload["totp_secret"] = totp_match.group(1).strip()

            parts = [part.strip() for part in re.split(r"[\s,|;]+", line) if part.strip()]
            for part in parts:
                if cls._looks_like_email(part) and not payload.get("email"):
                    payload["email"] = part
                elif cls._looks_like_totp_secret(part) and not payload.get("totp_secret"):
                    payload["totp_secret"] = part
                elif not payload.get("password") and not cls._looks_like_email(part) and not part.startswith("http") and part != payload.get("access_token"):
                    payload["password"] = part

            if payload.get("access_token"):
                items.append(payload)
            elif payload.get("email") or payload.get("password") or payload.get("totp_secret") or payload.get("mail_link"):
                payload["access_token"] = f"manual::{payload.get('email') or uuid.uuid4().hex[:12]}"
                items.append(payload)
            elif access_token:
                tokens.append(access_token)
        return items, tokens

    @staticmethod
    def _prepare_account_payload(item: dict) -> dict | None:
        if not isinstance(item, dict):
            return None
        access_token = AccountService._account_payload_token(item)
        if not access_token:
            return None
        payload = dict(item)
        payload.pop("accessToken", None)
        payload["access_token"] = access_token
        # 接码地址不落在账号对象上（GET 时按邮箱动态挂 mail_link），仅用于导入端登记邮箱，此处剥离。
        payload.pop("mail_link", None)
        payload.pop("fetch_url", None)
        # CPA/Codex 导出文件里的 `type=codex` 是导出格式，不是号池套餐类型。
        if str(payload.get("type") or "").strip().lower() == "codex":
            payload["export_type"] = "codex"
            payload["source_type"] = "codex"
            payload.pop("type", None)
        if str(payload.get("export_type") or "").strip().lower() == "codex":
            payload["source_type"] = "codex"
        if payload.get("plan_type") and not payload.get("type"):
            payload["type"] = str(payload.get("plan_type") or "").strip()
        return payload

    def add_account_items(self, items: list[dict]) -> dict:
        payloads = [
            payload
            for item in items
            if (payload := self._prepare_account_payload(item)) is not None
        ]
        result = self._add_account_payloads(payloads)
        self._register_imported_mailboxes(items)
        return result

    def _register_imported_mailboxes(self, items: list[dict]) -> None:
        """迁移导入时，把随账号带入的邮箱接码地址登记进邮箱管理（mailbox_service）。

        兼容读取 `mail_link`（新）与 `fetch_url`（旧/凭据格式）两种键；登记失败不影响导入主流程。
        """
        pairs: list[tuple[str, str, str]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            email = str(item.get("email") or "").strip()
            fetch_url = str(item.get("mail_link") or item.get("fetch_url") or "").strip()
            if email and fetch_url:
                pairs.append((email, fetch_url, self._account_payload_token(item)))
        if not pairs:
            return
        try:
            from services.mailbox_service import mailbox_service
            for email, fetch_url, token in pairs:
                mailbox_service.register_imported(email, fetch_url, token)
        except Exception:
            pass

    def add_accounts(self, tokens: list[str], source_type: str = "web") -> dict:
        tokens = list(dict.fromkeys(token for token in tokens if token))
        if not tokens:
            return {"added": 0, "skipped": 0, "items": self.list_accounts()}
        return self._add_account_payloads([
            {"access_token": token, "source_type": self._normalize_source_type(source_type)}
            for token in tokens
        ])

    def _add_account_payloads(self, payloads: list[dict]) -> dict:
        deduped: dict[str, dict] = {}
        for payload in payloads:
            if not isinstance(payload, dict):
                continue
            access_token = self._account_payload_token(payload)
            if not access_token:
                continue
            current = deduped.get(access_token, {})
            deduped[access_token] = {**current, **payload, "access_token": access_token}

        if not deduped:
            return {"added": 0, "skipped": 0, "items": self.list_accounts()}

        with self._lock:
            added = 0
            skipped = 0
            for access_token, payload in deduped.items():
                incoming = dict(payload)
                if not incoming.get("created_at"):
                    incoming.pop("created_at", None)
                preview = self._normalize_account(
                    {
                        **incoming,
                        "access_token": access_token,
                        "type": str(incoming.get("type") or "free"),
                    }
                )
                if preview is None:
                    continue
                storage_key = self._account_dict_key(preview)
                if not storage_key:
                    continue
                current = self._accounts.get(storage_key)
                if current is None:
                    added += 1
                    self._cumulative_total += 1
                    self._save_cumulative_total()
                    current = {"created_at": self._now()}
                else:
                    skipped += 1
                account = self._normalize_account(
                    {
                        **current,
                        **incoming,
                        "access_token": access_token,
                        "type": str(incoming.get("type") or current.get("type") or "free"),
                    }
                )
                if account is not None:
                    self._accounts[storage_key] = account
            self._save_accounts()
            items = [dict(item) for item in self._accounts.values()]
            log_service.add(LOG_TYPE_ACCOUNT, f"新增 {added} 个账号，跳过 {skipped} 个",
                            {"added": added, "skipped": skipped})
        return {"added": added, "skipped": skipped, "items": items}

    def delete_accounts(self, tokens: list[str]) -> dict:
        target_set = set(token for token in tokens if token)
        if not target_set:
            return {"removed": 0, "items": self.list_accounts()}
        with self._lock:
            storage_keys: set[str] = set()
            audit_tokens: list[str] = []
            released_emails: list[str] = []
            for token in target_set:
                storage_key = self._resolve_storage_key_locked(token)
                if not storage_key:
                    continue
                storage_keys.add(storage_key)
                raw = self._accounts.get(storage_key)
                if isinstance(raw, dict):
                    audit_token = str(raw.get("access_token") or storage_key).strip()
                    if audit_token:
                        audit_tokens.append(audit_token)
                        self._image_inflight.pop(audit_token, None)
                    email = str(raw.get("email") or "").strip()
                    if email:
                        released_emails.append(email)
            removed = sum(self._accounts.pop(key, None) is not None for key in storage_keys)
            for key in storage_keys:
                self._image_inflight.pop(key, None)
            self._token_aliases = {
                old: new
                for old, new in self._token_aliases.items()
                if old not in storage_keys and new not in storage_keys
            }
            if removed:
                if self._accounts:
                    self._index %= len(self._accounts)
                else:
                    self._index = 0
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, f"删除 {removed} 个账号", {"removed": removed})
                try:
                    from services.activation_audit_service import activation_audit_service

                    activation_audit_service.delete_by_access_tokens(audit_tokens or list(storage_keys))
                except Exception:
                    pass
                if released_emails:
                    try:
                        from services.mailbox_service import mailbox_service

                        mailbox_service.mark_used(released_emails, False)
                    except Exception:
                        pass
            items = [dict(item) for item in self._accounts.values()]
        return {"removed": removed, "items": items}

    def mark_used(self, tokens: list[str], used: bool, meta_by_token: dict[str, dict[str, str]] | None = None) -> dict:
        """批量标记账号「已用/未用」。返回 {updated, items}。"""
        target = [t for t in (tokens or []) if t]
        if not target:
            return {"updated": 0, "items": self.list_accounts()}
        updated = 0
        meta_by_token = meta_by_token or {}
        with self._lock:
            for token in target:
                storage_key = self._resolve_storage_key_locked(token)
                current = self._accounts.get(storage_key) if storage_key else None
                if current is None:
                    continue
                stored_token = str(current.get("access_token") or storage_key).strip()
                incoming_meta = _normalize_checkout_meta(
                    meta_by_token.get(token) or meta_by_token.get(stored_token) or meta_by_token.get(storage_key)
                )
                state_changed = bool(current.get("used")) != bool(used)
                meta_changed = incoming_meta != _normalize_checkout_meta(current.get("checkout_meta"))
                if not state_changed and not meta_changed:
                    continue
                if used:
                    current = mark_dispatched(current, incoming_meta)
                else:
                    dispatch = dict(current.get("dispatch") or {})
                    dispatch["dispatched"] = False
                    dispatch["dispatched_at"] = None
                    current["dispatch"] = dispatch
                    current["used"] = False
                    current["checkout_at"] = None
                    current["checkout_meta"] = None
                current = enrich_account(current)
                self._accounts[storage_key] = self._normalize_account(current)
                updated += 1
            if updated:
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, f"标记账号{'已用' if used else '未用'}", {"count": updated})
        return {"updated": updated, "items": self.list_accounts()}

    def revoke_activation(self, tokens: list[str], *, revoke_cdk: bool = True) -> dict:
        """撤销激活：将 plus_review 账号复位为免费已注册态，重新进入激活队列。

        revoke_cdk=True 时同步把绑定的 CDK 从 used/invalid 复位为 available。
        """
        from services.cdk_service import cdk_service

        target = [t for t in (tokens or []) if t]
        if not target:
            return {"updated": 0, "cdk_revoked": 0, "skipped": 0, "items": self.list_accounts()}
        updated = 0
        skipped = 0
        cdks_to_revoke: list[str] = []
        revoked_tokens: list[str] = []
        with self._lock:
            for token in target:
                storage_key = self._resolve_storage_key_locked(token)
                current = self._accounts.get(storage_key) if storage_key else None
                if current is None:
                    skipped += 1
                    continue
                item = enrich_account(current)
                if str(item.get("stage") or "") != STAGE_PLUS_REVIEW:
                    skipped += 1
                    continue
                cdk = str((item.get("activation") or {}).get("cdk") or item.get("plus_cdk") or "").strip()
                if revoke_cdk and cdk:
                    cdks_to_revoke.append(cdk)
                next_item = apply_stage(
                    item,
                    STAGE_REGISTERED,
                    plan=PLAN_FREE,
                    plus_unavailable=False,
                    plus_redeem_locked=False,
                    plus_activated_at=None,
                    activated_at=None,
                    plus_last_message=None,
                    plus_cdk=None,
                    plus_cdk_type=None,
                    plus_task_id=None,
                    plus_attempts={"UPI": 0, "IDEL": 0},
                    activation=empty_activation(),
                )
                account = self._normalize_account(next_item)
                if account is None:
                    skipped += 1
                    continue
                account["last_activation_audit_id"] = None
                self._accounts[storage_key] = account
                audit_token = str(account.get("access_token") or storage_key).strip()
                if audit_token:
                    revoked_tokens.append(audit_token)
                updated += 1
            if updated:
                self._save_accounts()
        cdk_revoked = cdk_service.revoke_use(cdks_to_revoke) if revoke_cdk and cdks_to_revoke else 0
        if updated:
            try:
                from services.activation_audit_service import activation_audit_service

                activation_audit_service.delete_by_access_tokens(revoked_tokens)
            except Exception:
                pass
            log_service.add(
                LOG_TYPE_ACCOUNT,
                "撤销激活：复位为免费可激活",
                {"count": updated, "cdk_revoked": cdk_revoked, "revoke_cdk": revoke_cdk},
            )
        return {
            "updated": updated,
            "cdk_revoked": cdk_revoked,
            "skipped": skipped,
            "items": self.list_accounts(),
        }

    def update_account(self, access_token: str, updates: dict, quiet: bool = False) -> dict | None:
        if not access_token:
            return None
        with self._lock:
            storage_key = self._resolve_storage_key_locked(access_token)
            current = self._accounts.get(storage_key) if storage_key else None
            if current is None:
                return None
            stored_token = str(current.get("access_token") or storage_key).strip()
            account = self._normalize_account({**current, **updates, "access_token": stored_token})
            if account is None:
                return None
            if account.get("status") == "限流" and config.auto_remove_rate_limited_accounts:
                self._accounts.pop(storage_key, None)
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, "自动移除限流账号", {"token": anonymize_token(stored_token)})
                return None
            next_key = self._account_dict_key(account)
            if not next_key:
                return None
            if next_key != storage_key:
                self._accounts.pop(storage_key, None)
            self._accounts[next_key] = account
            self._save_accounts()
            if not quiet:
                log_service.add(LOG_TYPE_ACCOUNT, "更新账号",
                                {"token": anonymize_token(stored_token), "status": account.get("status")})
            return dict(account)
        return None

    def _record_refresh_success(self, access_token: str) -> None:
        with self._lock:
            storage_key = self._resolve_storage_key_locked(access_token)
            current = self._accounts.get(storage_key) if storage_key else None
            if current is None:
                return
            next_item = dict(current)
            next_item["invalid_count"] = 0
            next_item["last_invalid_at"] = None
            next_item["last_refresh_error"] = None
            next_item["last_refresh_error_at"] = None
            account = self._normalize_account(next_item)
            if account is not None:
                self._accounts[storage_key] = account

    def _should_defer_invalid_token(self, account: dict | None, now: datetime) -> bool:
        if not isinstance(account, dict):
            return False
        created_at = self._parse_time(account.get("created_at"))
        if created_at is not None and (now - created_at).total_seconds() < self._NEW_ACCOUNT_INVALID_GRACE_SECONDS:
            return True
        last_invalid_at = self._parse_time(account.get("last_invalid_at"))
        invalid_count = int(account.get("invalid_count") or 0)
        if invalid_count <= 1:
            return True
        if last_invalid_at is not None and (now - last_invalid_at).total_seconds() < self._INVALID_CONFIRM_SECONDS:
            return True
        return False

    def _record_invalid_token_seen(
        self,
        access_token: str,
        event: str,
        error: str,
        defer_invalid_removal: bool = True,
    ) -> bool:
        now = datetime.now(timezone.utc)
        with self._lock:
            storage_key = self._resolve_storage_key_locked(access_token)
            current = self._accounts.get(storage_key) if storage_key else None
            if current is None:
                return True
            stored_token = str(current.get("access_token") or access_token).strip()
            should_defer = defer_invalid_removal and self._should_defer_invalid_token(current, now)
            next_item = dict(current)
            next_item["invalid_count"] = int(next_item.get("invalid_count") or 0) + 1
            next_item["last_invalid_at"] = now.isoformat()
            next_item["last_refresh_error"] = str(error or "invalid access token")
            next_item["last_refresh_error_at"] = now.isoformat()
            account = self._normalize_account(next_item)
            if account is not None:
                self._accounts[storage_key] = account
                self._save_accounts()
            if should_defer:
                log_service.add(
                    LOG_TYPE_ACCOUNT,
                    "暂缓标记异常账号",
                    {"source": event, "token": anonymize_token(stored_token), "error": str(error or "")},
                )
                return False
        return True

    def mark_image_result(self, access_token: str, success: bool) -> dict | None:
        if not access_token:
            return None
        self.release_image_slot(access_token)
        with self._lock:
            storage_key = self._resolve_storage_key_locked(access_token)
            current = self._accounts.get(storage_key) if storage_key else None
            if current is None:
                return None
            next_item = dict(current)
            next_item["last_used_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            image_quota_unknown = bool(next_item.get("image_quota_unknown"))
            if success:
                next_item["success"] = int(next_item.get("success") or 0) + 1
                if not image_quota_unknown:
                    next_item["quota"] = max(0, int(next_item.get("quota") or 0) - 1)
                if not image_quota_unknown and next_item["quota"] == 0:
                    next_item["status"] = "限流"
                    next_item["restore_at"] = next_item.get("restore_at") or None
                elif next_item.get("status") == "限流":
                    next_item["status"] = "正常"
            else:
                next_item["fail"] = int(next_item.get("fail") or 0) + 1
            account = self._normalize_account(next_item)
            if account is None:
                return None
            if account.get("status") == "限流" and config.auto_remove_rate_limited_accounts:
                self._accounts.pop(storage_key, None)
                self._save_accounts()
                log_service.add(
                    LOG_TYPE_ACCOUNT,
                    "自动移除限流账号",
                    {"token": anonymize_token(str(account.get("access_token") or access_token))},
                )
                return None
            self._accounts[storage_key] = account
            self._save_accounts()
            return dict(account)
        return None

    def fetch_remote_info(
        self,
        access_token: str,
        event: str = "fetch_remote_info",
        defer_invalid_removal: bool = True,
    ) -> dict[str, Any] | None:
        if not access_token:
            raise ValueError("access_token is required")

        active_token = self.refresh_access_token(access_token, event=f"{event}:preflight") or access_token
        try:
            from services.openai_backend_api import InvalidAccessTokenError, OpenAIBackendAPI
            result = OpenAIBackendAPI(active_token).get_user_info()
        except InvalidAccessTokenError as exc:
            refreshed_token = self.refresh_access_token(active_token, force=True, event=f"{event}:invalid_access_token")
            if refreshed_token and refreshed_token != active_token:
                try:
                    result = OpenAIBackendAPI(refreshed_token).get_user_info()
                except InvalidAccessTokenError as retry_exc:
                    if self._record_invalid_token_seen(
                        refreshed_token,
                        event,
                        str(retry_exc),
                        defer_invalid_removal=defer_invalid_removal,
                    ):
                        self.remove_invalid_token(refreshed_token, event)
                    raise
                active_token = refreshed_token
            else:
                if self._record_invalid_token_seen(
                    active_token,
                    event,
                    str(exc),
                    defer_invalid_removal=defer_invalid_removal,
                ):
                    self.remove_invalid_token(active_token, event)
                raise
        self._record_refresh_success(active_token)
        return self.update_account(active_token, result)

    # ---- 刷新进度追踪 ----

    def init_refresh_progress(self, progress_id: str, total: int) -> None:
        """初始化刷新进度记录。"""
        with self._refresh_progress_lock:
            self._refresh_progress[progress_id] = {
                "total": total,
                "processed": 0,
                "done": False,
                "error": None,
                "status_counts": {"正常": 0, "限流": 0, "异常": 0, "禁用": 0},
                "total_quota": 0,
            }

    def update_refresh_progress(self, progress_id: str, token: str) -> None:
        """刷新单个账号后，更新进度计数。"""
        account = self.get_account(token)
        status = str(account.get("status") or "正常").strip() if account else "正常"
        quota = max(0, int(account.get("quota") or 0)) if account else 0

        with self._refresh_progress_lock:
            progress = self._refresh_progress.get(progress_id)
            if progress is None:
                return
            progress["processed"] += 1
            progress["status_counts"][status] = progress["status_counts"].get(status, 0) + 1
            progress["total_quota"] += quota

    def finish_refresh_progress(self, progress_id: str, result: dict | None = None, error: str | None = None) -> None:
        """标记刷新完成。"""
        with self._refresh_progress_lock:
            progress = self._refresh_progress.get(progress_id)
            if progress is None:
                return
            progress["done"] = True
            progress["result"] = result
            if error:
                progress["error"] = error

    def get_refresh_progress(self, progress_id: str) -> dict | None:
        """查询刷新进度。"""
        with self._refresh_progress_lock:
            progress = self._refresh_progress.get(progress_id)
            return dict(progress) if progress else None

    def clean_refresh_progress(self, progress_id: str) -> None:
        """清理过期进度记录。"""
        with self._refresh_progress_lock:
            self._refresh_progress.pop(progress_id, None)

    # ---- 重新登录进度追踪 ----

    def init_relogin_progress(self, progress_id: str, total: int) -> None:
        """初始化重新登录进度记录。"""
        with self._relogin_progress_lock:
            self._relogin_progress[progress_id] = {
                "total": total,
                "processed": 0,
                "done": False,
                "error": None,
                "results": [],
            }

    def update_relogin_progress(self, progress_id: str, token: str, status: str, error: str | None = None) -> None:
        """更新单个重新登录进度。当所有账号处理完毕时自动标记完成。"""
        with self._relogin_progress_lock:
            progress = self._relogin_progress.get(progress_id)
            if progress is None:
                return
            progress["processed"] += 1
            progress["results"].append({
                "token": anonymize_token(token),
                "status": status,
                "error": error,
            })
            if progress["processed"] >= progress["total"]:
                progress["done"] = True

    def finish_relogin_progress(self, progress_id: str, result: dict | None = None, error: str | None = None) -> None:
        """标记重新登录完成。"""
        with self._relogin_progress_lock:
            progress = self._relogin_progress.get(progress_id)
            if progress is None:
                return
            progress["done"] = True
            progress["result"] = result
            if error:
                progress["error"] = error

    def get_relogin_progress(self, progress_id: str) -> dict | None:
        """查询重新登录进度。"""
        with self._relogin_progress_lock:
            progress = self._relogin_progress.get(progress_id)
            return dict(progress) if progress else None

    def clean_relogin_progress(self, progress_id: str) -> None:
        """清理过期进度记录。"""
        with self._relogin_progress_lock:
            self._relogin_progress.pop(progress_id, None)

    def refresh_accounts(
        self,
        access_tokens: list[str],
        progress_id: str | None = None,
        defer_invalid_removal: bool = True,
    ) -> dict[str, Any]:
        access_tokens = list(dict.fromkeys(token for token in access_tokens if token))
        if not access_tokens:
            items = self.list_accounts()
            result = {"refreshed": 0, "errors": [], "items": items}
            if progress_id:
                self.finish_refresh_progress(progress_id, result)
            return result

        refreshed = 0
        errors = []
        max_workers = min(10, len(access_tokens))

        if progress_id:
            self.init_refresh_progress(progress_id, len(access_tokens))

        executor = ThreadPoolExecutor(max_workers=max_workers)
        try:
            futures = {
                executor.submit(self.fetch_remote_info, token, "refresh_accounts", defer_invalid_removal): token
                for token in access_tokens
            }
            for future in as_completed(futures):
                token = futures[future]
                try:
                    account = future.result()
                except (KeyboardInterrupt, SystemExit):
                    executor.shutdown(wait=False, cancel_futures=True)
                    raise
                except Exception as exc:
                    error_str = str(exc)
                    # TLS/代理连接错误是网络问题，不计入账号失败
                    if not _is_tls_connection_error(error_str):
                        errors.append({"token": anonymize_token(token), "error": error_str})
                else:
                    if account is not None:
                        refreshed += 1

                if progress_id:
                    self.update_refresh_progress(progress_id, token)
        except (KeyboardInterrupt, SystemExit):
            if progress_id:
                self.finish_refresh_progress(progress_id, error="cancelled")
            executor.shutdown(wait=False, cancel_futures=True)
            raise
        else:
            executor.shutdown(wait=True, cancel_futures=True)

        result = {
            "refreshed": refreshed,
            "errors": errors,
            "items": self.list_accounts(),
        }

        if progress_id:
            self.finish_refresh_progress(progress_id, result)

        return result

    def re_login_accounts(self, access_tokens: list[str], progress_id: str | None = None) -> dict[str, Any]:
        """对选中账号执行密码重新登录流程。

        仅对包含 email + password 的账号有效。
        登录成功后自动将状态设为"正常"。
        """
        access_tokens = list(dict.fromkeys(token for token in access_tokens if token))
        if not access_tokens:
            result = {"relogined": 0, "skipped": 0, "errors": [], "items": self.list_accounts()}
            if progress_id:
                self.finish_relogin_progress(progress_id, result)
            return result

        if progress_id:
            self.init_relogin_progress(progress_id, len(access_tokens))

        relogined = 0
        skipped = 0
        errors = []

        for token in access_tokens:
            account = self.get_account(token)
            if not account:
                errors.append({"token": anonymize_token(token), "error": "账号不存在"})
                if progress_id:
                    self.update_relogin_progress(progress_id, token, "跳过", "账号不存在")
                continue

            email = str(account.get("email") or "").strip()
            password = str(account.get("password") or "").strip()
            if not email or not password:
                skipped += 1
                if progress_id:
                    self.update_relogin_progress(progress_id, token, "跳过", "无邮箱密码")
                continue

            # 在新线程中执行密码重新登录
            t = Thread(
                target=self._password_re_login_thread,
                args=(token, email, password, "manual_relogin", progress_id),
                daemon=True,
            )
            t.start()
            relogined += 1

        result = {
            "relogined": relogined,
            "skipped": skipped,
            "errors": errors,
            "items": self.list_accounts(),
        }
        if progress_id:
            # 如果所有账号都已同步处理完毕（没有启动线程），直接标记完成
            if relogined == 0:
                self.finish_relogin_progress(progress_id, result)
            else:
                # 有线程在运行，等线程结束后再完成
                pass
        return result

    def build_export_items(self, access_tokens: list[str] | None = None) -> list[dict[str, str]]:
        target_tokens = set(token for token in (access_tokens or []) if token)
        with self._lock:
            accounts = [
                dict(item)
                for item in self._accounts.values()
                if not target_tokens or str(item.get("access_token") or "") in target_tokens
            ]

        items: list[dict[str, str]] = []
        for account in accounts:
            access_token = str(account.get("access_token") or "").strip()
            refresh_token = str(account.get("refresh_token") or "").strip()
            id_token = str(account.get("id_token") or "").strip()
            if not access_token or not refresh_token or not id_token:
                continue

            access_payload = self._decode_jwt_payload(access_token)
            id_payload = self._decode_jwt_payload(id_token)
            auth_claim = access_payload.get("https://api.openai.com/auth")
            auth_claim = auth_claim if isinstance(auth_claim, dict) else {}
            profile_claim = access_payload.get("https://api.openai.com/profile")
            profile_claim = profile_claim if isinstance(profile_claim, dict) else {}

            email = (
                str(account.get("email") or "").strip()
                or str(profile_claim.get("email") or "").strip()
                or str(id_payload.get("email") or "").strip()
            )
            account_id = (
                str(account.get("account_id") or "").strip()
                or str(auth_claim.get("chatgpt_account_id") or "").strip()
                or str(account.get("user_id") or "").strip()
            )
            item = {
                # 导出真实套餐类型（而非硬编码 codex），保证导入端 _normalize_account 往返一致。
                "type": str(account.get("type") or "free"),
                "email": email,
                "account_id": account_id,
                "access_token": access_token,
                "refresh_token": refresh_token,
                "id_token": id_token,
                "expired": self._timestamp_to_iso(access_payload.get("exp")),
                "last_refresh": self._timestamp_to_iso(access_payload.get("iat")),
            }
            # 账号来源（如 codex），导入端据此还原 source_type。
            source_type = str(account.get("source_type") or "").strip()
            if source_type:
                item["source_type"] = source_type
            password = str(account.get("password") or "").strip()
            if password:
                item["password"] = password
            # 邮箱接码地址存在独立的 mailbox_service（按邮箱为键），不在账号对象上。
            # 迁移时一并带出，否则目标系统无法自动取邮箱 OTP（开启 2FA / 重新登录会卡 need_verification_code）。
            if email:
                try:
                    from services.mailbox_service import mailbox_service
                    mail_link = str(mailbox_service.get_fetch_url(email) or "").strip()
                except Exception:
                    mail_link = ""
                if mail_link:
                    item["mail_link"] = mail_link
            # 迁移到另一套系统时保留账号级代理及其地区信息，导入端 _normalize_account 会原样收下。
            proxy = str(account.get("proxy") or "").strip()
            if proxy:
                item["proxy"] = proxy
            country = str(account.get("country") or "").strip()
            if country:
                item["country"] = country
            exit_ip = str(account.get("exit_ip") or "").strip()
            if exit_ip:
                item["exit_ip"] = exit_ip
            # 2FA (TOTP)：迁移时保留 base32 secret 与 otpauth URL，否则目标系统无法算码。
            totp_secret = str(account.get("totp_secret") or "").strip()
            if totp_secret:
                item["totp_secret"] = totp_secret
            otpauth_url = str(account.get("otpauth_url") or "").strip()
            if otpauth_url:
                item["otpauth_url"] = otpauth_url
            # 保留原始注册时间，便于迁移后区分库存新旧。
            created_at = str(account.get("created_at") or "").strip()
            if created_at:
                item["created_at"] = created_at
            items.append(item)
        return items

    def get_stats(self) -> dict:
        with self._lock:
            items = list(self._accounts.values())
        total = len(items)
        active = sum(1 for a in items if a.get("status") == "正常")
        limited = sum(1 for a in items if a.get("status") == "限流")
        abnormal = sum(1 for a in items if a.get("status") == "异常")
        disabled = sum(1 for a in items if a.get("status") == "禁用")
        total_quota = sum(max(0, int(a.get("quota") or 0)) for a in items if a.get("status") == "正常")
        unlimited = sum(1 for a in items if a.get("status") == "正常" and bool(a.get("image_quota_unknown")))
        total_success = sum(int(a.get("success") or 0) for a in items)
        total_fail = sum(int(a.get("fail") or 0) for a in items)
        by_type = {}
        for a in items:
            t = a.get("type", "unknown")
            by_type[t] = by_type.get(t, 0) + 1
        return {
            "total": total,
            "cumulative_total": self._cumulative_total,
            "active": active,
            "limited": limited,
            "abnormal": abnormal,
            "disabled": disabled,
            "total_quota": total_quota,
            "unlimited_quota_count": unlimited,
            "total_success": total_success,
            "total_fail": total_fail,
            "by_type": by_type,
        }

    def account_health(self) -> dict:
        stats = self.get_stats()
        return {
            "healthy": stats["active"] > 0 or stats["unlimited_quota_count"] > 0,
            "status": "ok" if stats["active"] > 0 else "degraded",
            **stats,
        }


account_service = AccountService(config.get_storage_backend())
