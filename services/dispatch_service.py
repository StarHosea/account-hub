from __future__ import annotations

import threading
from datetime import datetime, timezone

from services.account_service import account_service
from services.mailbox_service import mailbox_service
from services.phone_service import phone_service

# Plus 账号发号预占过期时间（秒）：超时自动释放，防止占用泄漏。
ACCOUNT_RESERVE_STALE_SECONDS = 300

# 视为「失效」的账号状态，不再发号。
DEAD_STATUS = {"异常", "禁用"}


def _parse_dt(value: object) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        try:
            dt = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
        except Exception:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class DispatchService:
    """发号编排：Plus 账号按激活时间最老优先「预占→出库」。

    手机号的状态机在 phone_service 内（冷却/3次/预占）；本服务负责账号侧的内存预占，
    确保多人同时发号不会拿到同一个账号。预占为内存态 + 过期自动释放。
    """

    def __init__(self):
        self._lock = threading.RLock()
        # access_token -> 预占时间（datetime）
        self._account_reserved: dict[str, datetime] = {}

    # ----------------------------- 账号发号 ----------------------------- #

    def _purge_stale(self, now: datetime) -> None:
        stale = [
            token
            for token, ts in self._account_reserved.items()
            if (now - ts).total_seconds() >= ACCOUNT_RESERVE_STALE_SECONDS
        ]
        for token in stale:
            self._account_reserved.pop(token, None)

    @staticmethod
    def _account_card(account: dict) -> dict:
        email = str(account.get("email") or "").strip()
        token = str(account.get("access_token") or "")
        fields = [
            {"label": "邮箱", "value": email},
            {"label": "密码", "value": str(account.get("password") or "")},
            {"label": "2FA 密钥", "value": str(account.get("totp_secret") or "")},
            {"label": "otpauth", "value": str(account.get("otpauth_url") or "")},
            {"label": "接码地址", "value": (mailbox_service.get_fetch_url(email) or "") if email else ""},
            {"label": "access_token", "value": token},
            {"label": "激活时间", "value": str(account.get("plus_updated_at") or "")},
        ]
        # 仅保留有值的字段，避免卡片出现空行。
        fields = [f for f in fields if f["value"]]
        return {"kind": "account", "id": token, "title": email or token[:12], "fields": fields}

    def acquire_account(self) -> dict | None:
        """选取「激活时间最老」的已激活、未出库、存活账号并预占；无可用返回 None。"""
        now = datetime.now(timezone.utc)
        with self._lock:
            self._purge_stale(now)
            candidates = [
                a
                for a in account_service.list_accounts()
                if str(a.get("plus_status") or "") == "已激活"
                and not a.get("used")
                and str(a.get("status") or "") not in DEAD_STATUS
                and str(a.get("access_token") or "") not in self._account_reserved
            ]
            if not candidates:
                return None
            candidates.sort(key=lambda a: _parse_dt(a.get("plus_updated_at")) or _parse_dt(a.get("created_at")) or now)
            chosen = candidates[0]
            self._account_reserved[str(chosen.get("access_token"))] = now
            return self._account_card(chosen)

    def release_account(self, token: str) -> None:
        with self._lock:
            self._account_reserved.pop(str(token or ""), None)

    def checkout_account(self, token: str) -> bool:
        """出库：标记账号已出库，解除预占。"""
        token = str(token or "")
        if not token:
            return False
        account_service.mark_used([token], True)
        self.release_account(token)
        return True

    def invalid_account(self, token: str) -> bool:
        """标记账号无效：置禁用并解除预占。"""
        token = str(token or "")
        if not token:
            return False
        account_service.update_account(token, {"status": "禁用"}, quiet=True)
        self.release_account(token)
        return True

    def account_available_count(self) -> int:
        now = datetime.now(timezone.utc)
        with self._lock:
            self._purge_stale(now)
            return sum(
                1
                for a in account_service.list_accounts()
                if str(a.get("plus_status") or "") == "已激活"
                and not a.get("used")
                and str(a.get("status") or "") not in DEAD_STATUS
                and str(a.get("access_token") or "") not in self._account_reserved
            )

    # ----------------------------- 手机发号（委托 phone_service） ----------------------------- #

    @staticmethod
    def _phone_card(phone: dict) -> dict:
        from services.phone_service import MAX_USES

        fields = [
            {"label": "手机号", "value": str(phone.get("phone") or "")},
            {"label": "接码地址", "value": str(phone.get("fetch_url") or "")},
            {"label": "已用次数", "value": f"{int(phone.get('used_count') or 0)}/{MAX_USES}"},
        ]
        fields = [f for f in fields if f["value"]]
        return {
            "kind": "phone",
            "id": str(phone.get("phone") or ""),
            "title": str(phone.get("phone") or ""),
            "fields": fields,
            "used_count": int(phone.get("used_count") or 0),
            "max_uses": MAX_USES,
        }

    def acquire_phone(self) -> dict | None:
        phone = phone_service.acquire_for_dispatch()
        return self._phone_card(phone) if phone else None

    def checkout_phone(self, phone: str) -> bool:
        return phone_service.checkout(phone) is not None

    def cooldown_phone(self, phone: str) -> bool:
        return phone_service.cooldown(phone) is not None

    def invalid_phone(self, phone: str) -> bool:
        return phone_service.set_invalid([phone], True) > 0

    def release_phone(self, phone: str) -> None:
        phone_service.release(phone)


dispatch_service = DispatchService()
