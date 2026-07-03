from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone

from services.account_service import account_service
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
        # 发号信息只需要邮箱、密码、2FA 密钥。
        fields = [
            {"label": "邮箱", "value": email},
            {"label": "密码", "value": str(account.get("password") or "")},
            {"label": "2FA 密钥", "value": str(account.get("totp_secret") or "")},
        ]
        # 仅保留有值的字段，避免卡片出现空行。
        fields = [f for f in fields if f["value"]]
        return {"kind": "account", "id": token, "title": email or token[:12], "fields": fields}

    @staticmethod
    def _is_plus(account: dict) -> bool:
        """真实套餐是否为 Plus（按远端核验回填的 type 判定，而非激活态）。"""
        return str(account.get("type") or "").strip().lower() == "plus"

    def acquire_account(self) -> dict | None:
        """选取「最老」的 Plus 套餐、未出库、存活账号并预占；无可用返回 None。

        可发号来源 = 账号管理中「未出库的 Plus 套餐账号」（按真实 type 判定，而非激活态）。
        """
        now = datetime.now(timezone.utc)
        with self._lock:
            self._purge_stale(now)
            candidates = [
                a
                for a in account_service.list_accounts()
                if self._is_plus(a)
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

    def checkout_account(self, token: str, meta: dict[str, str] | None = None) -> dict:
        """出库：出库前二次实时核验账号仍是可用的 Plus，通过才标记已出库。

        通过时把发号信息（客户/微信/闲鱼/套餐等 meta）随出库一并落库。
        返回 {"ok": bool, "reason": str, "id": 最新token}。核验不通过或刷新失败时
        不出库、不做任何标记，交由前端提示后让管理员「不可用，下一个」。
        """
        token = str(token or "")
        if not token:
            return {"ok": False, "reason": "缺少账号标识", "id": token}

        # 实时刷新（刷新 access_token + 拉取远端 user info，回填 type/status）；token 可能轮换。
        try:
            account = account_service.fetch_remote_info(token, event="dispatch_checkout")
        except Exception as exc:  # 网络/失效等：不出库，保留预占等待人工换号。
            return {"ok": False, "reason": f"核验失败：{exc}".strip(), "id": token}

        if not account:
            return {"ok": False, "reason": "核验失败：账号已失效", "id": token}

        latest_token = str(account.get("access_token") or token)
        if not self._is_plus(account):
            plan = str(account.get("type") or "").strip() or "未知"
            return {"ok": False, "reason": f"核验未通过：账号非 Plus（当前套餐 {plan}）", "id": latest_token}
        if str(account.get("status") or "") in DEAD_STATUS:
            return {"ok": False, "reason": f"核验未通过：账号不可用（{account.get('status')}）", "id": latest_token}

        account_service.mark_used([latest_token], True, {latest_token: meta or {}})
        # token 可能轮换，新旧都解除预占，避免占用泄漏。
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
        now = datetime.now(timezone.utc)
        with self._lock:
            self._purge_stale(now)
            return sum(
                1
                for a in account_service.list_accounts()
                if self._is_plus(a)
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
