from __future__ import annotations

import base64
import json
import secrets
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Condition, Lock, Thread
from typing import Any
from urllib.parse import urlencode

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
    _REFRESH_TOKEN_KEEPALIVE_SECONDS = 3 * 24 * 60 * 60
    _REFRESH_TOKEN_KEEPALIVE_ERROR_BACKOFF_SECONDS = 6 * 60 * 60
    _REFRESH_TOKEN_KEEPALIVE_BATCH_SIZE = 3
    _TOKEN_REFRESH_ERROR_BACKOFF_SECONDS = 5 * 60
    _OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
    _OAUTH_CLIENT_ID = "app_2SKx67EdpoN0G6j64rFvigXD"
    # ChatGPT 网页端 OAuth client：开/关 2FA 的 mfa 接口要求此 client 签发的 token，
    # 与上面 platform client 不通用（抓包逆向自 chatgpt.com 网页端）。
    _OAUTH_CHATGPT_CLIENT_ID = "app_X8zY6vW2pQ9tR3dE7nK1jL5gH"
    _OAUTH_CHATGPT_REDIRECT_URI = "https://chatgpt.com/api/auth/callback/openai"
    _OAUTH_CHATGPT_SCOPE = (
        "openid email profile offline_access model.request model.read "
        "organization.read organization.write"
    )
    _MFA_ENROLL_URL = "https://chatgpt.com/backend-api/accounts/mfa/enroll"
    _MFA_ACTIVATE_URL = "https://chatgpt.com/backend-api/accounts/mfa/user/activate_enrollment"
    _MFA_INFO_URL = "https://chatgpt.com/backend-api/accounts/mfa_info"
    _MFA_DISABLE_URL = "https://chatgpt.com/backend-api/accounts/mfa/user/disable_in_house"
    _MFA_ISSUE_CHALLENGE_URL = "https://auth.openai.com/api/accounts/mfa/issue_challenge"
    _MFA_VERIFY_URL = "https://auth.openai.com/api/accounts/mfa/verify"
    _OAUTH_USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/145.0.0.0 Safari/537.36"
    )

    # 刷新进度追踪
    _refresh_progress: dict[str, dict] = {}
    _refresh_progress_lock = Lock()
    # 重新登录进度追踪
    _relogin_progress: dict[str, dict] = {}
    _relogin_progress_lock = Lock()
    # 2FA 开/关进度追踪
    _twofa_progress: dict[str, dict] = {}
    _twofa_progress_lock = Lock()

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
            f = self._get_cumulative_file()
            if f.exists():
                return int(f.read_text().strip())
        except Exception:
            pass
        return len(self._accounts)

    def _save_cumulative_total(self) -> None:
        try:
            self._get_cumulative_file().write_text(str(self._cumulative_total))
        except Exception:
            pass

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
        return {
            normalized["access_token"]: normalized
            for item in accounts
            if (normalized := self._normalize_account(item)) is not None
        }

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

    def _normalize_account(self, item: dict) -> dict | None:
        if not isinstance(item, dict):
            return None
        access_token = item.get("access_token") or item.get("accessToken") or ""
        if not access_token:
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
        normalized["plus_task_id"] = normalized.get("plus_task_id") or None
        normalized["plus_last_message"] = normalized.get("plus_last_message") or None
        normalized["plus_updated_at"] = normalized.get("plus_updated_at") or None
        return normalized

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

    def resolve_access_token(self, access_token: str) -> str:
        if not access_token:
            return ""
        with self._lock:
            return self._resolve_access_token_locked(access_token)

    def _get_account_for_token(self, access_token: str) -> tuple[str, dict | None]:
        with self._lock:
            resolved = self._resolve_access_token_locked(access_token)
            account = self._accounts.get(resolved)
            return resolved, dict(account) if account else None

    def _record_token_refresh_error(self, access_token: str, event: str, error: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            resolved = self._resolve_access_token_locked(access_token)
            current = self._accounts.get(resolved)
            if current is None:
                return
            next_item = dict(current)
            next_item["last_token_refresh_error"] = str(error or "refresh token failed")
            next_item["last_token_refresh_error_at"] = now
            account = self._normalize_account(next_item)
            if account is not None:
                self._accounts[resolved] = account
                self._save_accounts()
        log_service.add(
            LOG_TYPE_ACCOUNT,
            "refresh_token 刷新 access_token 失败",
            {"source": event, "token": anonymize_token(access_token), "error": str(error or "")},
        )

    def _recent_token_refresh_error(self, account: dict) -> bool:
        last_error_at = self._parse_time(account.get("last_token_refresh_error_at"))
        if last_error_at is None:
            return False
        return (datetime.now(timezone.utc) - last_error_at).total_seconds() < self._TOKEN_REFRESH_ERROR_BACKOFF_SECONDS

    def _recent_refresh_token_keepalive_error(self, account: dict, now: datetime) -> bool:
        last_error_at = self._parse_time(account.get("last_token_refresh_error_at"))
        if last_error_at is None:
            return False
        return (now - last_error_at).total_seconds() < self._REFRESH_TOKEN_KEEPALIVE_ERROR_BACKOFF_SECONDS

    def _refresh_token_keepalive_anchor(self, account: dict) -> datetime | None:
        return (
            self._parse_time(account.get("last_token_refresh_at"))
            or self._token_issued_at(str(account.get("access_token") or ""))
            or self._parse_time(account.get("created_at"))
        )

    def _refresh_token_keepalive_due_at(self, account: dict, now: datetime) -> datetime | None:
        if not str(account.get("refresh_token") or "").strip():
            return None
        if account.get("status") == "禁用":
            return None
        if self._recent_refresh_token_keepalive_error(account, now):
            return None
        anchor = self._refresh_token_keepalive_anchor(account)
        if anchor is None:
            return now
        due_at = anchor + timedelta(seconds=self._REFRESH_TOKEN_KEEPALIVE_SECONDS)
        return due_at if due_at <= now else None

    def _request_access_token_refresh(self, refresh_token: str, account: dict | None = None) -> dict[str, str]:
        from curl_cffi import requests
        from services.proxy_service import proxy_settings

        session = requests.Session(**proxy_settings.build_session_kwargs(account=account, impersonate="chrome110", verify=True))
        try:
            response = session.post(
                self._OAUTH_TOKEN_URL,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": self._OAUTH_USER_AGENT,
                },
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": self._OAUTH_CLIENT_ID,
                },
                timeout=60,
            )
            data = response.json() if response.text else {}
            if response.status_code != 200 or not isinstance(data, dict) or not data.get("access_token"):
                detail = ""
                if isinstance(data, dict):
                    detail = str(data.get("error_description") or data.get("error") or data.get("message") or "")
                detail = detail or self._safe_response_text(response)
                raise RuntimeError(f"oauth_refresh_http_{response.status_code}{': ' + detail if detail else ''}")
            return {
                "access_token": str(data.get("access_token") or "").strip(),
                "refresh_token": str(data.get("refresh_token") or refresh_token).strip(),
                "id_token": str(data.get("id_token") or "").strip(),
            }
        finally:
            session.close()

    def _apply_refreshed_tokens(self, old_access_token: str, token_data: dict, event: str) -> str:
        now = datetime.now(timezone.utc).isoformat()
        with self._image_slot_condition:
            old_token = self._resolve_access_token_locked(old_access_token)
            current = self._accounts.get(old_token)
            if current is None:
                return old_token
            new_token = str(token_data.get("access_token") or old_token).strip()
            if not new_token:
                return old_token

            next_item = dict(current)
            next_item["access_token"] = new_token
            if token_data.get("refresh_token"):
                next_item["refresh_token"] = str(token_data.get("refresh_token") or "").strip()
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
                self._accounts.pop(old_token, None)
                self._token_aliases[old_token] = new_token
                old_inflight = int(self._image_inflight.pop(old_token, 0))
                if old_inflight:
                    self._image_inflight[new_token] = int(self._image_inflight.get(new_token, 0)) + old_inflight
            self._accounts[new_token] = account
            self._save_accounts()
            self._image_slot_condition.notify_all()

        log_service.add(
            LOG_TYPE_ACCOUNT,
            "refresh_token 已刷新 access_token",
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
            refresh_token = str(account.get("refresh_token") or "").strip()
            if not refresh_token:
                return active_token
            if not force and self._recent_token_refresh_error(account):
                return active_token
            try:
                token_data = self._request_access_token_refresh(refresh_token, account)
            except Exception as exc:
                error_str = str(exc or "")
                self._record_token_refresh_error(active_token, event, error_str)
                # 如果是 app_session_terminated 错误，尝试密码重新登录
                if "app_session_terminated" in error_str.lower():
                    # 获取账号信息（email, password）
                    email = str(account.get("email") or "").strip()
                    password = str(account.get("password") or "").strip()
                    if email and password:
                        # 创建新线程执行密码重新登录
                        t = Thread(
                            target=self._password_re_login_thread,
                            args=(active_token, email, password, event),
                            daemon=True,
                        )
                        t.start()
                return active_token
            return self._apply_refreshed_tokens(active_token, token_data, event)

    def _password_re_login_thread(self, access_token: str, email: str, password: str, event: str, progress_id: str | None = None) -> None:
        """密码重新登录线程入口"""
        try:
            account = self.get_account(access_token)
            # 账号已开 2FA 时，登录会触发 mfa_challenge，需带上存储的 totp_secret 自动过；
            # 同时复用账号绑定邮箱的 OTP 取码（登录也可能触发邮箱步进）。
            totp_secret = str((account or {}).get("totp_secret") or "").strip() or None
            otp_fetch = self._mailbox_otp_fetcher(email)
            # 住宅代理偶发瞬时拒绝/断连（curl 97/28），登录请求是裸调用不自带重试，
            # 故在此对整个登录做幂等重试（每次重新生成 PKCE/device_id）。
            result = {}
            for attempt in range(3):
                result = self._login_with_password(
                    email, password,
                    account=account,
                    totp_secret=totp_secret,
                    otp_fetch=otp_fetch,
                )
                if result.get("ok") or not _is_tls_connection_error(str(result.get("error") or "")):
                    break
                time.sleep(1.5 * (attempt + 1))
            if result.get("ok"):
                # 登录成功，更新账号
                new_access_token = result.get("access_token", "")
                new_refresh_token = result.get("refresh_token", "")
                new_id_token = result.get("id_token", "")
                new_expires_at = result.get("expires_at")

                # 构建 token_data 供 _apply_refreshed_tokens 使用
                token_data = {
                    "access_token": new_access_token,
                    "refresh_token": new_refresh_token,
                    "id_token": new_id_token,
                }

                # 使用 _apply_refreshed_tokens 更新账号（处理 token 别名）
                new_token = self._apply_refreshed_tokens(access_token, token_data, f"{event}:password_relogin")

                # 额外更新 source_type 和 status（静默，避免重复日志）
                self.update_account(new_token, {
                    "source_type": result.get("source_type", "password"),
                    "status": "正常",
                }, quiet=True)

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

    def _login_with_password(
        self,
        email: str,
        password: str,
        *,
        client_id: str | None = None,
        redirect_uri: str | None = None,
        scope: str | None = None,
        keep_session: bool = False,
        otp_fetch=None,
        totp_secret: str | None = None,
        on_progress=None,
        account: dict | None = None,
    ) -> dict:
        """通过邮箱+密码登录，返回 {access_token, refresh_token, id_token, ...}

        默认走 platform client（与注册流程一致）。传入 client_id/redirect_uri/scope
        可换成 ChatGPT 网页端 client（开/关 2FA 用）。keep_session=True 时成功返回里
        附带存活的 session（调用方负责 close），用于后续带 cookie 的 mfa 重认证请求。
        """
        from curl_cffi import requests

        def prog(percent, message):
            if on_progress:
                try:
                    on_progress(percent, message)
                except Exception:
                    pass

        prog(15, "正在登录账号")
        # 常量
        auth_base = "https://auth.openai.com"
        platform_oauth_audience = "https://api.openai.com/v1"
        platform_auth0_client = "eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9"
        platform_oauth_client_id = client_id or self._OAUTH_CLIENT_ID
        platform_oauth_redirect_uri = redirect_uri or "https://platform.openai.com/auth/callback"
        oauth_scope = scope or "openid profile email offline_access"
        app_base = "https://chatgpt.com" if "chatgpt.com" in platform_oauth_redirect_uri else "https://platform.openai.com"
        user_agent = self._OAUTH_USER_AGENT
        keep_alive = False  # 仅在成功且 keep_session 时置 True，避免 finally 误关存活 session

        # 创建 session：走该账号专属代理（号一号一 IP），缺省回退全局代理
        from services.proxy_service import proxy_settings
        session_kwargs = proxy_settings.build_session_kwargs(
            account=account, impersonate="chrome110", verify=False
        )
        session = requests.Session(**session_kwargs)
        
        try:
            device_id = str(uuid.uuid4())
            
            # ─── 方式2: OAuth authorize 流程 ──────────────────────────
            # 使用 Platform Client + PKCE（与注册流程相同）
            
            from utils.pkce import generate_pkce
            code_verifier, code_challenge = generate_pkce()
            
            # ② 发起 OAuth authorize 请求 (使用 Platform Client + PKCE)
            session.cookies.set("oai-did", device_id, domain=".auth.openai.com")
            session.cookies.set("oai-did", device_id, domain="auth.openai.com")
            params = {
                "issuer": auth_base,
                "client_id": platform_oauth_client_id,
                "audience": platform_oauth_audience,
                "redirect_uri": platform_oauth_redirect_uri,
                "device_id": device_id,
                "screen_hint": "login_or_signup",
                "max_age": "0",
                "login_hint": email,
                "scope": oauth_scope,
                "response_type": "code",
                "response_mode": "query",
                "state": secrets.token_urlsafe(32),
                "nonce": secrets.token_urlsafe(32),
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "auth0Client": platform_auth0_client,
            }
            authorize_url = f"{auth_base}/api/accounts/authorize?{urlencode(params)}"
            resp = session.get(
                authorize_url,
                headers={
                    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
                    "user-agent": user_agent,
                    "sec-ch-ua": '"Chromium";v="145", "Google Chrome";v="145", "Not/A)Brand";v="99"',
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"Windows"',
                    "sec-fetch-dest": "document",
                    "sec-fetch-mode": "navigate",
                    "sec-fetch-site": "cross-site",
                    "sec-fetch-user": "?1",
                    "upgrade-insecure-requests": "1",
                    "referer": "https://platform.openai.com/",
                },
                allow_redirects=True,
                timeout=30,
            )
            
            if resp.status_code not in (200, 302):
                return {"ok": False, "error": f"authorize_failed_{resp.status_code}", "detail": {"url": resp.url, "text": resp.text[:500]}}
            
            # 检测最终 URL 是否指向错误页面
            final_url = str(resp.url)
            if "/error" in final_url and "payload=" in final_url:
                from urllib.parse import parse_qs, urlparse
                try:
                    parsed_query = parse_qs(urlparse(final_url).query)
                    error_payload_b64 = parsed_query.get("payload", [""])[0]
                    error_payload_b64 += "=" * ((4 - len(error_payload_b64) % 4) % 4)
                    error_payload = json.loads(base64.b64decode(error_payload_b64))
                    error_code = error_payload.get("errorCode", "")
                    if error_code == "rate_limit_exceeded":
                        return {"ok": False, "error": "rate_limit_exceeded", "detail": error_payload}
                    else:
                        return {"ok": False, "error": f"authorize_error_{error_code}", "detail": error_payload}
                except Exception as e:
                    return {"ok": False, "error": "authorize_redirect_error", "detail": {"url": final_url, "parse_error": str(e)}}
            
            # ③ 提交密码验证
            login_headers = {
                "accept": "application/json",
                "accept-language": "zh-CN,zh;q=0.9",
                "content-type": "application/json",
                "origin": auth_base,
                "priority": "u=1, i",
                "user-agent": user_agent,
                "sec-ch-ua": '"Chromium";v="145", "Google Chrome";v="145", "Not/A)Brand";v="99"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                "referer": f"{auth_base}/email-verification",
                "oai-device-id": device_id,
            }
            
            # 添加 sentinel token
            try:
                from utils.sentinel import build_sentinel_token
                sentinel_val, oai_sc_val = build_sentinel_token(session, device_id, "password_verify")
                login_headers["openai-sentinel-token"] = sentinel_val
                if oai_sc_val:
                    session.cookies.set("oai-sc", oai_sc_val, domain=".openai.com")
            except Exception:
                pass
            
            login_resp = session.post(
                f"{auth_base}/api/accounts/password/verify",
                headers=login_headers,
                json={"password": password},
                timeout=30,
            )
            
            login_data = {}
            try:
                login_data = login_resp.json() if login_resp.text else {}
            except Exception:
                pass
            
            if login_resp.status_code != 200:
                error_code = login_data.get("error", {}).get("code", "")
                error_msg = login_data.get("error", {}).get("message", "")
                if error_code == "unsupported_country_region_territory":
                    return {"ok": False, "error": "unsupported_country_region_territory", "detail": login_data}
                elif error_code == "invalid_state":
                    return {"ok": False, "error": "invalid_state", "detail": login_data}
                elif "Invalid credentials" in error_msg or "wrong password" in error_msg.lower():
                    return {"ok": False, "error": "invalid_password", "detail": login_data}
                return {"ok": False, "error": f"password_verify_failed_{login_resp.status_code}", "detail": login_data}
            
            # 获取 authorization code
            continue_url = str(login_data.get("continue_url") or "").strip()
            auth_code = ""
            if continue_url:
                from urllib.parse import parse_qs, urlparse
                parsed_params = parse_qs(urlparse(continue_url).query)
                auth_code = str((parsed_params.get("code") or [""])[0]).strip()
            
            # ─── 处理邮箱 OTP 验证 ──────────────────────────
            if not auth_code:
                page_type = ""
                page_info = login_data.get("page")
                if isinstance(page_info, dict):
                    page_type = str(page_info.get("type") or "")
                
                if page_type == "email_otp_verification":
                    # 登录触发邮箱 OTP 步进验证。若提供了取码回调（账号绑定了可读邮箱），
                    # 自动发码 → 取码 → 校验，拿到 auth_code 后继续；否则标记需验证码。
                    if otp_fetch is not None:
                        prog(35, "等待邮箱验证码")
                        auth_code = self._complete_login_email_otp(session, device_id, auth_base, user_agent, otp_fetch)
                    if not auth_code:
                        return {"ok": False, "error": "need_verification_code", "detail": login_data}
                elif page_type == "mfa_challenge":
                    # 账号已开 TOTP 2FA，登录要求验证器码。有存的 secret 时自动算码过 challenge。
                    if totp_secret:
                        prog(35, "校验 2FA 动态码")
                        page_payload = page_info.get("payload") if isinstance(page_info, dict) else {}
                        factor_id = str((page_payload or {}).get("factor_id") or "")
                        auth_code = self._complete_login_mfa_challenge(session, device_id, auth_base, user_agent, factor_id, totp_secret)
                    if not auth_code:
                        return {"ok": False, "error": "need_mfa_code", "detail": login_data}
                else:
                    return {"ok": False, "error": "no_auth_code", "detail": login_data}
            
            # ④ 用 code 换 token (使用 Platform Client + code_verifier，与注册流程相同)
            platform_base = app_base
            token_resp = session.post(
                f"{auth_base}/api/accounts/oauth/token",
                headers={
                    "accept": "*/*",
                    "accept-language": "zh-CN,zh;q=0.9",
                    "auth0-client": platform_auth0_client,
                    "cache-control": "no-cache",
                    "content-type": "application/json",
                    "origin": platform_base,
                    "pragma": "no-cache",
                    "priority": "u=1, i",
                    "referer": f"{platform_base}/",
                    "sec-ch-ua": '"Chromium";v="145", "Google Chrome";v="145", "Not/A)Brand";v="99"',
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"Windows"',
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-site",
                    "user-agent": user_agent,
                },
                json={
                    "client_id": platform_oauth_client_id,
                    "code_verifier": code_verifier,
                    "grant_type": "authorization_code",
                    "code": auth_code,
                    "redirect_uri": platform_oauth_redirect_uri,
                },
                verify=False,
                timeout=60,
            )
            
            token_data = {}
            try:
                token_data = token_resp.json() if token_resp.text else {}
            except Exception:
                pass
            
            if token_resp.status_code != 200 or not token_data.get("access_token"):
                return {"ok": False, "error": "token_exchange_failed", "detail": token_data}
            
            access_token = str(token_data.get("access_token") or "").strip()
            refresh_token = str(token_data.get("refresh_token") or "").strip()
            id_token = str(token_data.get("id_token") or "").strip()
            
            # ⑤ 用 access_token 获取用户信息
            user_info = {}
            try:
                me_resp = session.get(
                    "https://chatgpt.com/backend-api/me",
                    headers={
                        "accept": "application/json",
                        "authorization": f"Bearer {access_token}",
                        "user-agent": user_agent,
                    },
                    timeout=30,
                )
                if me_resp.status_code == 200:
                    user_info = me_resp.json() if me_resp.text else {}
            except Exception:
                pass
            
            # 解析 JWT payload
            jwt_payload = self._decode_jwt_payload(access_token)
            
            email_from_jwt = str(jwt_payload.get("https://api.openai.com/profile", {}).get("email") or "").strip()
            account_id_from_jwt = str(
                jwt_payload.get("https://api.openai.com/auth", {}).get("chatgpt_account_id") or ""
            ).strip()
            
            account_info = user_info.get("account") if isinstance(user_info.get("account"), dict) else {}
            result = {
                "ok": True,
                "email": email_from_jwt or email,
                "account_id": account_id_from_jwt or account_info.get("account_id", ""),
                "access_token": access_token,
                "refresh_token": refresh_token,
                "id_token": id_token,
                "expires_at": jwt_payload.get("exp"),
                "source_type": "password",
                "device_id": device_id,
            }
            if keep_session:
                result["session"] = session
                keep_alive = True

            return result

        finally:
            if not keep_alive:
                session.close()

    def _complete_login_email_otp(self, session, device_id: str, auth_base: str, user_agent: str, otp_fetch) -> str:
        """登录遇到邮箱 OTP 步进时：发码 → 取码 → 校验，返回 auth_code（失败返回 ""）。"""
        from urllib.parse import parse_qs, urlparse

        common = {
            "accept": "application/json",
            "content-type": "application/json",
            "oai-device-id": device_id,
            "origin": auth_base,
            "referer": f"{auth_base}/email-verification",
            "user-agent": user_agent,
        }
        # 发码前先记录信箱里当前最新邮件的到达时间。邮件常有延迟，且 OpenAI 有时重发相同的码，
        # 故不能按码值判断新旧——发码后只接受「到达时间晚于此基线」的邮件里的验证码。
        baseline_time = None
        if hasattr(otp_fetch, "peek"):
            try:
                baseline_time = otp_fetch.peek()
            except Exception:
                baseline_time = None
        try:
            session.get(
                f"{auth_base}/api/accounts/email-otp/send",
                headers={"accept": "application/json", "oai-device-id": device_id, "user-agent": user_agent,
                         "referer": f"{auth_base}/email-verification"},
                verify=False, timeout=30,
            )
        except Exception:
            pass
        try:
            code = otp_fetch(after=baseline_time)  # 只接受发码后新到达的邮件里的码（按到达时间判断）
        except TypeError:
            code = otp_fetch()  # 兼容不支持 after 的回调
        except Exception:
            code = None
        if not code:
            return ""
        headers = dict(common)
        try:
            from utils.sentinel import build_sentinel_token
            sentinel_val, _ = build_sentinel_token(session, device_id, "authorize_continue")
            headers["openai-sentinel-token"] = sentinel_val
        except Exception:
            pass
        try:
            resp = session.post(f"{auth_base}/api/accounts/email-otp/validate", headers=headers, json={"code": code}, verify=False, timeout=30)
            data = resp.json() if resp.text else {}
        except Exception:
            return ""
        continue_url = str(data.get("continue_url") or "").strip()
        if not continue_url:
            return ""
        return str((parse_qs(urlparse(continue_url).query).get("code") or [""])[0]).strip()

    def _complete_login_mfa_challenge(self, session, device_id: str, auth_base: str, user_agent: str, factor_id: str, totp_secret: str) -> str:
        """登录遇到 TOTP MFA 挑战时：issue_challenge → 用存的 secret 算码 verify，返回 auth_code。"""
        from urllib.parse import parse_qs, urlparse

        from utils.totp import generate_totp

        if not factor_id or not totp_secret:
            return ""
        headers = {
            "accept": "application/json",
            "content-type": "application/json",
            "oai-device-id": device_id,
            "origin": auth_base,
            "referer": f"{auth_base}/mfa-challenge",
            "user-agent": user_agent,
        }
        try:
            from utils.sentinel import build_sentinel_token
            sentinel_val, _ = build_sentinel_token(session, device_id, "authorize_continue")
            headers["openai-sentinel-token"] = sentinel_val
        except Exception:
            pass
        try:
            session.post(f"{auth_base}/api/accounts/mfa/issue_challenge", headers=headers,
                         json={"id": factor_id, "type": "totp", "force_fresh_challenge": False}, verify=False, timeout=30)
        except Exception:
            pass
        try:
            resp = session.post(f"{auth_base}/api/accounts/mfa/verify", headers=headers,
                                json={"id": factor_id, "type": "totp", "code": generate_totp(totp_secret)}, verify=False, timeout=30)
            data = resp.json() if resp.text else {}
        except Exception:
            return ""
        continue_url = str(data.get("continue_url") or "").strip()
        if not continue_url:
            return ""
        return str((parse_qs(urlparse(continue_url).query).get("code") or [""])[0]).strip()

    def _mailbox_otp_fetcher(self, email: str):
        """返回一个从账号绑定邮箱读取登录验证码的回调；无可用邮箱则返回 None。"""
        try:
            from services.mailbox_service import mailbox_service
            from services.register import mail_provider
        except Exception:
            return None
        fetch_url = mailbox_service.get_fetch_url(email)
        if not fetch_url:
            return None
        mail_config = {
            "request_timeout": 30,
            "wait_timeout": 90,
            "wait_interval": 3,
            "providers": [{"type": mail_provider.API_MAILBOX_TYPE, "enable": True}],
            "proxy": "",
        }
        mailbox = {"provider": mail_provider.API_MAILBOX_TYPE, "address": email, "fetch_url": fetch_url}

        class _OtpFetcher:
            """取码回调：__call__ 等待验证码（可只接受某到达时间之后的新邮件）；peek() 读当前最新邮件到达时间。"""

            def peek(self):
                return mail_provider.peek_received_at(mail_config, mailbox)

            def __call__(self, after=None):
                return mail_provider.wait_for_code(mail_config, mailbox, after_received_at=after)

        return _OtpFetcher()

    def _establish_chatgpt_session(self, email: str, password: str, totp_secret: str | None = None, on_progress=None, account: dict | None = None) -> dict:
        """密码登录拿到可调 mfa 接口的新鲜会话 + token（开/关 2FA 用）。

        实测：密码登录（platform client + 必要时邮箱 OTP / TOTP 步进）拿到的 token，pwd_auth_time
        新鲜，直接就能调 chatgpt.com/backend-api 的 mfa/enroll 等接口——无需再换 ChatGPT 网页端
        client 的 token（后者是机密客户端，公开 PKCE 的 oauth/token 换不了）。

        totp_secret：账号已开 2FA 时登录会要求验证器码（关闭流程用），传入以自动过 challenge。
        account：传入则该会话走账号专属代理（号一号一 IP），开/关 2FA 与登录共用同一出口。
        """
        login = self._login_with_password(
            email, password,
            keep_session=True,
            otp_fetch=self._mailbox_otp_fetcher(email),
            totp_secret=totp_secret,
            on_progress=on_progress,
            account=account,
        )
        if not login.get("ok"):
            return login
        return {
            "ok": True,
            "session": login.get("session"),
            "access_token": str(login.get("access_token") or ""),
            "refresh_token": str(login.get("refresh_token") or ""),
            "id_token": str(login.get("id_token") or ""),
            "device_id": str(login.get("device_id") or ""),
        }

    def _mfa_headers(self, token: str, device_id: str) -> dict:
        """chatgpt.com/backend-api 的 mfa 接口请求头（Bearer + device id）。"""
        return {
            "accept": "application/json",
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "oai-device-id": device_id,
            "oai-language": "en-US",
            "origin": "https://chatgpt.com",
            "referer": "https://chatgpt.com/",
            "user-agent": self._OAUTH_USER_AGENT,
        }

    def _mfa_auth_headers(self, device_id: str, session) -> dict:
        """auth.openai.com 上 challenge/verify 重认证请求头（带 sentinel）。"""
        headers = {
            "accept": "application/json",
            "content-type": "application/json",
            "oai-device-id": device_id,
            "origin": "https://auth.openai.com",
            "referer": "https://auth.openai.com/",
            "user-agent": self._OAUTH_USER_AGENT,
        }
        try:
            from utils.sentinel import build_sentinel_token
            sentinel_val, _ = build_sentinel_token(session, device_id, "authorize_continue")
            headers["openai-sentinel-token"] = sentinel_val
        except Exception:
            pass
        return headers

    @staticmethod
    def _extract_totp_factor_id(info_data: dict) -> str:
        """从 mfa_info 响应里取已激活的 totp 因子 id。"""
        if not isinstance(info_data, dict):
            return ""
        factors = info_data.get("factors")
        totp_list = factors.get("totp") if isinstance(factors, dict) else None
        if isinstance(totp_list, list):
            for item in totp_list:
                if isinstance(item, dict) and item.get("id"):
                    return str(item.get("id"))
        return ""

    def enable_2fa(self, access_token: str, on_progress=None) -> dict:
        """为账号开启 TOTP 2FA：密码登录 → enroll → 算码 → activate → 存 secret。"""
        from utils.totp import build_otpauth_url, generate_totp

        def prog(percent, message):
            if on_progress:
                try:
                    on_progress(percent, message)
                except Exception:
                    pass

        account = self.get_account(access_token)
        if not account:
            return {"ok": False, "error": "account_not_found", "items": self.list_accounts()}
        email = str(account.get("email") or "").strip()
        password = str(account.get("password") or "").strip()
        if not email or not password:
            return {"ok": False, "error": "missing_credentials", "items": self.list_accounts()}
        if str(account.get("totp_secret") or "").strip():
            return {"ok": False, "error": "already_enabled", "items": self.list_accounts()}

        prog(10, "正在登录账号")
        try:
            login = self._establish_chatgpt_session(email, password, on_progress=on_progress, account=account)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": "login_exception", "detail": str(exc), "items": self.list_accounts()}
        if not login.get("ok"):
            return {"ok": False, "error": login.get("error") or "login_failed", "detail": login.get("detail"), "items": self.list_accounts()}
        session = login.get("session")
        token = str(login.get("access_token") or "")
        device_id = str(login.get("device_id") or "")
        # 密码登录拿到的是该账号最新 token，写回账号库（token 可能轮换，后续以新 token 为准）
        access_token = self._apply_refreshed_tokens(access_token, login, "enable_2fa") or access_token
        try:
            headers = self._mfa_headers(token, device_id)
            prog(60, "申请 2FA 密钥")
            resp = session.post(self._MFA_ENROLL_URL, headers=headers, json={"factor_type": "totp"}, timeout=30, verify=False)
            data = resp.json() if resp.text else {}
            secret = str(data.get("secret") or "").strip()
            session_id = str(data.get("session_id") or "").strip()
            if resp.status_code != 200 or not secret or not session_id:
                return {"ok": False, "error": f"enroll_failed_{resp.status_code}", "detail": data, "items": self.list_accounts()}
            code = generate_totp(secret)
            prog(85, "提交验证码确认开启")
            act = session.post(self._MFA_ACTIVATE_URL, headers=headers, json={"code": code, "factor_type": "totp", "session_id": session_id}, timeout=30, verify=False)
            act_data = act.json() if act.text else {}
            if act.status_code != 200 or not act_data.get("success"):
                return {"ok": False, "error": f"activate_failed_{act.status_code}", "detail": act_data, "items": self.list_accounts()}
            otpauth = build_otpauth_url(secret, email)
            self.update_account(access_token, {"totp_secret": secret, "otpauth_url": otpauth}, quiet=True)
            prog(100, "2FA 已开启")
            log_service.add(LOG_TYPE_ACCOUNT, "开启2FA成功", {"token": anonymize_token(access_token)})
            return {"ok": True, "secret": secret, "otpauth_url": otpauth, "items": self.list_accounts()}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": "enable_exception", "detail": str(exc), "items": self.list_accounts()}
        finally:
            try:
                session.close()
            except Exception:
                pass

    def disable_2fa(self, access_token: str, on_progress=None) -> dict:
        """关闭账号的 TOTP 2FA：密码登录 → 取 factor → (必要时重认证) → disable → 清 secret。"""
        from utils.totp import generate_totp

        def prog(percent, message):
            if on_progress:
                try:
                    on_progress(percent, message)
                except Exception:
                    pass

        account = self.get_account(access_token)
        if not account:
            return {"ok": False, "error": "account_not_found", "items": self.list_accounts()}
        email = str(account.get("email") or "").strip()
        password = str(account.get("password") or "").strip()
        secret = str(account.get("totp_secret") or "").strip()
        if not email or not password:
            return {"ok": False, "error": "missing_credentials", "items": self.list_accounts()}

        prog(10, "正在登录账号")
        try:
            login = self._establish_chatgpt_session(email, password, totp_secret=secret, on_progress=on_progress, account=account)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": "login_exception", "detail": str(exc), "items": self.list_accounts()}
        if not login.get("ok"):
            return {"ok": False, "error": login.get("error") or "login_failed", "detail": login.get("detail"), "items": self.list_accounts()}
        session = login.get("session")
        token = str(login.get("access_token") or "")
        device_id = str(login.get("device_id") or "")
        # 密码登录拿到的是该账号最新 token，写回账号库（token 可能轮换，后续以新 token 为准）
        access_token = self._apply_refreshed_tokens(access_token, login, "disable_2fa") or access_token
        try:
            headers = self._mfa_headers(token, device_id)
            prog(60, "读取 2FA 信息")
            info = session.get(self._MFA_INFO_URL, headers=headers, timeout=30, verify=False)
            info_data = info.json() if info.text else {}
            factor_id = self._extract_totp_factor_id(info_data)
            if not factor_id:
                # 远端已无 totp 因子，视为已关闭，清掉本地记录
                self.update_account(access_token, {"totp_secret": None, "otpauth_url": None}, quiet=True)
                prog(100, "2FA 已关闭")
                return {"ok": True, "items": self.list_accounts()}

            def _disable():
                r = session.post(self._MFA_DISABLE_URL, headers=headers, json={"factor_id": factor_id}, timeout=30, verify=False)
                return r, (r.json() if r.text else {})

            prog(85, "关闭 2FA")
            resp, data = _disable()
            if resp.status_code != 200 and secret:
                # 需要重认证：issue_challenge + verify（用存的 secret 算当前码），再重试关闭
                auth_headers = self._mfa_auth_headers(device_id, session)
                session.post(self._MFA_ISSUE_CHALLENGE_URL, headers=auth_headers, json={"id": factor_id, "type": "totp", "force_fresh_challenge": False}, timeout=30, verify=False)
                session.post(self._MFA_VERIFY_URL, headers=auth_headers, json={"id": factor_id, "type": "totp", "code": generate_totp(secret)}, timeout=30, verify=False)
                resp, data = _disable()
            if resp.status_code != 200:
                return {"ok": False, "error": f"disable_failed_{resp.status_code}", "detail": data, "items": self.list_accounts()}
            self.update_account(access_token, {"totp_secret": None, "otpauth_url": None}, quiet=True)
            prog(100, "2FA 已关闭")
            log_service.add(LOG_TYPE_ACCOUNT, "关闭2FA成功", {"token": anonymize_token(access_token)})
            return {"ok": True, "items": self.list_accounts()}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": "disable_exception", "detail": str(exc), "items": self.list_accounts()}
        finally:
            try:
                session.close()
            except Exception:
                pass

    def start_2fa_task(self, action: str, access_token: str) -> str:
        """后台线程跑 enable/disable 2FA，返回 progress_id 供前端轮询阶段进度。"""
        progress_id = uuid.uuid4().hex
        with self._twofa_progress_lock:
            self._twofa_progress[progress_id] = {
                "action": action, "percent": 0, "message": "准备中",
                "done": False, "ok": False, "error": None, "items": None,
                "secret": None, "otpauth_url": None,
            }

        def _on_progress(percent, message):
            with self._twofa_progress_lock:
                p = self._twofa_progress.get(progress_id)
                if p is not None:
                    p["percent"] = int(percent)
                    p["message"] = str(message)

        def _run():
            try:
                fn = self.enable_2fa if action == "enable" else self.disable_2fa
                result = fn(access_token, on_progress=_on_progress)
            except Exception as exc:  # noqa: BLE001
                result = {"ok": False, "error": "task_exception", "detail": str(exc), "items": self.list_accounts()}
            with self._twofa_progress_lock:
                p = self._twofa_progress.get(progress_id)
                if p is not None:
                    err = result.get("error")
                    detail = result.get("detail")
                    fail_msg = f"失败：{err or '未知错误'}"
                    if detail:
                        fail_msg += f"（{str(detail)[:120]}）"
                    p.update({
                        "done": True, "percent": 100,
                        "ok": bool(result.get("ok")),
                        "error": err,
                        "detail": (str(detail)[:300] if detail else None),
                        "items": result.get("items"),
                        "secret": result.get("secret"),
                        "otpauth_url": result.get("otpauth_url"),
                        "message": ("完成" if result.get("ok") else fail_msg),
                    })

        Thread(target=_run, daemon=True, name=f"twofa-{action}").start()
        return progress_id

    def get_2fa_progress(self, progress_id: str) -> dict | None:
        with self._twofa_progress_lock:
            progress = self._twofa_progress.get(progress_id)
            return dict(progress) if progress else None

    def list_expiring_access_tokens(self) -> list[str]:
        with self._lock:
            return [
                token
                for account in self._accounts.values()
                if str(account.get("refresh_token") or "").strip()
                and (token := str(account.get("access_token") or "").strip())
                and self._token_needs_refresh(token)
            ]

    def list_refresh_token_keepalive_tokens(self) -> list[str]:
        now = datetime.now(timezone.utc)
        due_items: list[tuple[datetime, str]] = []
        with self._lock:
            for account in self._accounts.values():
                due_at = self._refresh_token_keepalive_due_at(account, now)
                token = str(account.get("access_token") or "").strip()
                if due_at is not None and token:
                    due_items.append((due_at, token))
        due_items.sort(key=lambda item: item[0])
        return [token for _, token in due_items[: self._REFRESH_TOKEN_KEEPALIVE_BATCH_SIZE]]

    def keepalive_refresh_tokens(self, access_tokens: list[str]) -> dict[str, Any]:
        access_tokens = list(dict.fromkeys(token for token in access_tokens if token))
        if not access_tokens:
            return {"refreshed": 0, "errors": [], "items": self.list_accounts()}

        refreshed = 0
        errors = []
        for access_token in access_tokens:
            before = self.resolve_access_token(access_token)
            after = self.refresh_access_token(before, force=True, event="refresh_token_keepalive")
            account = self.get_account(after)
            if account and str(account.get("last_token_refresh_error") or "").strip():
                errors.append({
                    "token": anonymize_token(before),
                    "error": str(account.get("last_token_refresh_error") or "refresh token failed"),
                })
                continue
            if account:
                refreshed += 1

        return {
            "refreshed": refreshed,
            "errors": errors,
            "items": self.list_accounts(),
            "relogined": 0,
        }

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
            access_token = self._resolve_access_token_locked(access_token)
            current = self._accounts.get(access_token)
            if current is None:
                return
            next_item = dict(current)
            next_item["last_used_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            account = self._normalize_account(next_item)
            if account is None:
                return
            self._accounts[access_token] = account
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
        with self._lock:
            access_token = self._resolve_access_token_locked(access_token)
            account = self._accounts.get(access_token)
            return dict(account) if account else None

    def list_accounts(self) -> list[dict]:
        """返回所有账号的副本，并为每个账号附加当前图片在途数 image_inflight。

        image_inflight 为内存态并发计数(账号正在生成、尚未结束的图片数)。号池空闲时
        若某账号该值持续 > 0，说明其并发槽位泄漏、已被静默排除出调度，可借此在 UI 上诊断。
        """
        with self._lock:
            result = []
            for item in self._accounts.values():
                account = dict(item)
                token = account.get("access_token") or ""
                account["image_inflight"] = int(self._image_inflight.get(token, 0))
                result.append(account)
            return result

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
        import re
        return bool(re.fullmatch(r"[A-Z2-7=]+", raw.upper()))

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
                current = self._accounts.get(access_token)
                if current is None:
                    added += 1
                    self._cumulative_total += 1
                    self._save_cumulative_total()
                    current = {"created_at": self._now()}
                else:
                    skipped += 1
                incoming = dict(payload)
                if not incoming.get("created_at"):
                    incoming.pop("created_at", None)
                account = self._normalize_account(
                    {
                        **current,
                        **incoming,
                        "access_token": access_token,
                        "type": str(incoming.get("type") or current.get("type") or "free"),
                    }
                )
                if account is not None:
                    self._accounts[access_token] = account
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
            target_set = {self._resolve_access_token_locked(token) for token in target_set if token}
            removed = sum(self._accounts.pop(token, None) is not None for token in target_set)
            for token in target_set:
                self._image_inflight.pop(token, None)
            self._token_aliases = {
                old: new
                for old, new in self._token_aliases.items()
                if old not in target_set and new not in target_set
            }
            if removed:
                if self._accounts:
                    self._index %= len(self._accounts)
                else:
                    self._index = 0
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, f"删除 {removed} 个账号", {"removed": removed})
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
                resolved = self._resolve_access_token_locked(token)
                current = self._accounts.get(resolved)
                if current is None:
                    continue
                incoming_meta = _normalize_checkout_meta(meta_by_token.get(token) or meta_by_token.get(resolved))
                state_changed = bool(current.get("used")) != bool(used)
                meta_changed = incoming_meta != _normalize_checkout_meta(current.get("checkout_meta"))
                if not state_changed and not meta_changed:
                    continue
                current["used"] = bool(used)
                if used:
                    current["checkout_at"] = current.get("checkout_at") or datetime.now(timezone.utc).isoformat()
                    current["checkout_meta"] = incoming_meta
                else:
                    current["checkout_at"] = None
                    current["checkout_meta"] = None
                updated += 1
            if updated:
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, f"标记账号{'已用' if used else '未用'}", {"count": updated})
        return {"updated": updated, "items": self.list_accounts()}

    def update_account(self, access_token: str, updates: dict, quiet: bool = False) -> dict | None:
        if not access_token:
            return None
        with self._lock:
            access_token = self._resolve_access_token_locked(access_token)
            current = self._accounts.get(access_token)
            if current is None:
                return None
            account = self._normalize_account({**current, **updates, "access_token": access_token})
            if account is None:
                return None
            if account.get("status") == "限流" and config.auto_remove_rate_limited_accounts:
                self._accounts.pop(access_token, None)
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, "自动移除限流账号", {"token": anonymize_token(access_token)})
                return None
            self._accounts[access_token] = account
            self._save_accounts()
            if not quiet:
                log_service.add(LOG_TYPE_ACCOUNT, "更新账号",
                                {"token": anonymize_token(access_token), "status": account.get("status")})
            return dict(account)
        return None

    def _record_refresh_success(self, access_token: str) -> None:
        with self._lock:
            access_token = self._resolve_access_token_locked(access_token)
            current = self._accounts.get(access_token)
            if current is None:
                return
            next_item = dict(current)
            next_item["invalid_count"] = 0
            next_item["last_invalid_at"] = None
            next_item["last_refresh_error"] = None
            next_item["last_refresh_error_at"] = None
            account = self._normalize_account(next_item)
            if account is not None:
                self._accounts[access_token] = account

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
            access_token = self._resolve_access_token_locked(access_token)
            current = self._accounts.get(access_token)
            if current is None:
                return True
            should_defer = defer_invalid_removal and self._should_defer_invalid_token(current, now)
            next_item = dict(current)
            next_item["invalid_count"] = int(next_item.get("invalid_count") or 0) + 1
            next_item["last_invalid_at"] = now.isoformat()
            next_item["last_refresh_error"] = str(error or "invalid access token")
            next_item["last_refresh_error_at"] = now.isoformat()
            account = self._normalize_account(next_item)
            if account is not None:
                self._accounts[access_token] = account
                self._save_accounts()
            if should_defer:
                log_service.add(
                    LOG_TYPE_ACCOUNT,
                    "暂缓标记异常账号",
                    {"source": event, "token": anonymize_token(access_token), "error": str(error or "")},
                )
                return False
        return True

    def mark_image_result(self, access_token: str, success: bool) -> dict | None:
        if not access_token:
            return None
        self.release_image_slot(access_token)
        with self._lock:
            access_token = self._resolve_access_token_locked(access_token)
            current = self._accounts.get(access_token)
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
                self._accounts.pop(access_token, None)
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, "自动移除限流账号", {"token": anonymize_token(access_token)})
                return None
            self._accounts[access_token] = account
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
            result = {"refreshed": 0, "errors": [], "items": items, "relogined": 0}
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

        # 自动重新登录异常账号（仅当配置开启时）
        relogined = 0
        if config.auto_relogin_after_refresh:
            for token in access_tokens:
                account = self.get_account(token)
                if not account:
                    continue
                status = str(account.get("status") or "").strip()
                if status != "异常":
                    continue
                email = str(account.get("email") or "").strip()
                password = str(account.get("password") or "").strip()
                if not email or not password:
                    continue
                t = Thread(
                    target=self._password_re_login_thread,
                    args=(token, email, password, "auto_relogin_after_refresh"),
                    daemon=True,
                )
                t.start()
                relogined += 1

        result = {
            "refreshed": refreshed,
            "errors": errors,
            "items": self.list_accounts(),
            "relogined": relogined,
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
