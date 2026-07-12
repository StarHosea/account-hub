from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone

from services.account_lifecycle import is_dispatchable
from services.account_service import account_service
from services.phone_service import phone_service

# Plus 账号发号预占过期时间（秒）：超时自动释放，防止占用泄漏。
ACCOUNT_RESERVE_STALE_SECONDS = 300


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
        # 发号信息只需要邮箱、密码、2FA 密钥。
        fields = [
            {"label": "邮箱", "value": email},
            {"label": "密码", "value": str(account.get("password") or "")},
            {"label": "2FA 密钥", "value": str(account.get("totp_secret") or "")},
        ]
        # 仅保留有值的字段，避免卡片出现空行。
        fields = [f for f in fields if f["value"]]
        return {"kind": "account", "id": token, "title": email or token[:12], "fields": fields}

    def list_dispatchable_accounts(self) -> list[dict]:
        now = datetime.now(timezone.utc)
        with self._lock:
            self._purge_stale(now)
            reserved = set(self._account_reserved)
        items = []
        for account in account_service.list_accounts():
            token = str(account.get("access_token") or "")
            if token in reserved:
                continue
            if is_dispatchable(account):
                items.append(account)
        items.sort(key=lambda a: _parse_dt(a.get("activated_at")) or _parse_dt(a.get("created_at")) or now)
        return items

    def acquire_account(self, token: str | None = None) -> dict | None:
        """选取可出库 Plus 账号并预占；可指定 token，否则取最老一个。"""
        now = datetime.now(timezone.utc)
        with self._lock:
            self._purge_stale(now)
            if token:
                chosen = account_service.get_account(token)
                if not chosen or not is_dispatchable(chosen):
                    return None
                real = str(chosen.get("access_token") or "")
                if real in self._account_reserved:
                    return None
                self._account_reserved[real] = now
                return self._account_card(chosen)
            candidates = self.list_dispatchable_accounts()
            if not candidates:
                return None
            chosen = candidates[0]
            self._account_reserved[str(chosen.get("access_token"))] = now
            return self._account_card(chosen)

    def release_account(self, token: str) -> None:
        with self._lock:
            self._account_reserved.pop(str(token or ""), None)

    def checkout_account(self, token: str, meta: dict[str, str] | None = None) -> dict:
        """出库：标记已出库并解除预占，发号信息（客户/微信/闲鱼/套餐等 meta）随出库落库。"""
        token = str(token or "")
        if not token:
            return {"ok": False, "reason": "缺少账号标识", "id": token}

        account = account_service.get_account(token)
        if not account:
            return {"ok": False, "reason": "账号不存在", "id": token}

        latest_token = str(account.get("access_token") or token)
        account_service.mark_used([latest_token], True, {latest_token: meta or {}})
        self.release_account(token)
        self.release_account(latest_token)
        return {"ok": True, "reason": "", "id": latest_token}

    def checkout_account_with_meta(self, token: str, meta: dict[str, str] | None = None) -> bool:
        token = str(token or "")
        if not token:
            return False
        payload = meta or {}
        account_service.mark_used([token], True, {token: payload})
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
        return len(self.list_dispatchable_accounts())

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

    def checkout_phone_with_meta(self, phone: str, meta: dict[str, str] | None = None) -> bool:
        return phone_service.checkout(phone, meta) is not None

    def cooldown_phone(self, phone: str) -> bool:
        return phone_service.cooldown(phone) is not None

    def invalid_phone(self, phone: str) -> bool:
        return phone_service.set_invalid([phone], True) > 0

    def release_phone(self, phone: str) -> None:
        phone_service.release(phone)

    @staticmethod
    def build_dispatch_meta(
        customer: str = "",
        wechat: str = "",
        xianyu: str = "",
        plan: str = "",
        note: str = "",
        dispatch_no: str = "",
        phone: str = "",
        account_token: str = "",
    ) -> dict[str, str]:
        return {
            "customer": str(customer or "").strip(),
            "wechat": str(wechat or "").strip(),
            "xianyu": str(xianyu or "").strip(),
            "plan": str(plan or "").strip(),
            "note": str(note or "").strip(),
            "dispatch_no": str(dispatch_no or "").strip() or f"dispatch-{uuid.uuid4().hex[:10]}",
            "phone": str(phone or "").strip(),
            "account_token": str(account_token or "").strip(),
            "checkout_at": datetime.now(timezone.utc).isoformat(),
        }


dispatch_service = DispatchService()
