from __future__ import annotations

import threading
from datetime import datetime, timezone

from services.config import config


COLLECTION = "register_abnormal"

PROXY_DIAG_KEYS = (
    "proxy_region",
    "proxy_host",
    "proxy_scheme",
    "proxy_sid",
    "exit_ip",
    "proxy_mode",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_email(email: str) -> str:
    return str(email or "").strip().lower()


class RegisterAbnormalService:
    """注册机异常账号清单：主键=邮箱。

    记录注册过程发生异常的账号，供人工排查。
    这些账号不进入号池（账号管理）。由 openai_register.worker() 在各类失败路径调用 add() 写入。
    """

    def __init__(self, storage=None) -> None:
        self._storage = storage if storage is not None else config.get_storage_backend()
        self._lock = threading.RLock()
        self._items: dict[str, dict] = self._load()
        self.reconcile_account_placeholders()

    # ----------------------------- 持久化 ----------------------------- #

    def _load(self) -> dict[str, dict]:
        items = self._storage.load_collection(COLLECTION)
        if items is None:
            items = []
            self._storage.save_collection(COLLECTION, [])
        return self._items_to_map(items)

    def _items_to_map(self, items: list) -> dict[str, dict]:
        result: dict[str, dict] = {}
        for item in items or []:
            normalized = self._normalize(item)
            if normalized:
                result[_norm_email(normalized["email"])] = normalized
        return result

    def _save(self) -> None:
        self._storage.save_collection(COLLECTION, list(self._items.values()))

    def _refresh_from_storage_locked(self) -> None:
        latest = self._storage.load_collection(COLLECTION)
        if latest is None:
            return
        self._items = self._items_to_map(latest)

    @staticmethod
    def _normalize(item: dict) -> dict | None:
        if not isinstance(item, dict):
            return None
        email = str(item.get("email") or "").strip()
        if not email:
            return None
        return {
            "email": email,
            "fetch_url": str(item.get("fetch_url") or "").strip(),
            "reason": str(item.get("reason") or "").strip(),
            "access_token": str(item.get("access_token") or "").strip() or None,
            "password": str(item.get("password") or "").strip() or None,
            "eligible": item.get("eligible") if isinstance(item.get("eligible"), bool) else None,
            "recording_path": str(item.get("recording_path") or "").strip() or None,
            "created_at": item.get("created_at") or _now(),
            **{key: item.get(key) for key in PROXY_DIAG_KEYS if item.get(key) not in (None, "")},
        }

    # ----------------------------- 对外只读视图 ----------------------------- #

    def list_items(self) -> list[dict]:
        with self._lock:
            self._refresh_from_storage_locked()
            # 最近的异常排前面，便于排查。
            return sorted(
                (dict(v) for v in self._items.values()),
                key=lambda x: str(x.get("created_at") or ""),
                reverse=True,
            )

    def stats(self) -> dict:
        with self._lock:
            self._refresh_from_storage_locked()
            items = list(self._items.values())
            total = len(items)
            no_trial = sum(1 for a in items if a.get("eligible") is False)
            return {"total": total, "no_trial": no_trial, "other": total - no_trial}

    def export_text(self) -> str:
        """导出为 `邮箱---取件地址---原因` 每行一条。"""
        with self._lock:
            self._refresh_from_storage_locked()
            return "\n".join(
                f"{a.get('email') or ''}---{a.get('fetch_url') or ''}---{a.get('reason') or ''}"
                for a in self.list_items()
            )

    # ----------------------------- 写操作 ----------------------------- #

    def add(self, email: str, fetch_url: str = "", reason: str = "", **extra) -> dict | None:
        """按邮箱 upsert 一条异常记录。（Phase B 由注册 worker 调用。）"""
        email = str(email or "").strip()
        if not email:
            return None
        with self._lock:
            self._refresh_from_storage_locked()
            key = _norm_email(email)
            existing = self._items.get(key) or {}
            merged = {
                "email": email,
                "fetch_url": fetch_url or existing.get("fetch_url") or "",
                "reason": reason or existing.get("reason") or "",
                "access_token": extra.get("access_token") or existing.get("access_token"),
                "password": extra.get("password") or existing.get("password"),
                "eligible": extra.get("eligible", existing.get("eligible")),
                "recording_path": extra.get("recording_path") or existing.get("recording_path"),
                "created_at": existing.get("created_at") or _now(),
            }
            for key in PROXY_DIAG_KEYS:
                if key in extra and extra.get(key) not in (None, ""):
                    merged[key] = extra[key]
                elif existing.get(key) not in (None, ""):
                    merged[key] = existing[key]
            normalized = self._normalize(merged)
            if normalized is None:
                return None
            self._items[key] = normalized
            self._save()
            if not str(normalized.get("access_token") or "").strip():
                self._release_registering_placeholder(
                    email,
                    str(normalized.get("reason") or ""),
                )
            return dict(normalized)

    def _release_registering_placeholder(self, email: str, reason: str) -> None:
        from services.account_service import account_service

        account_service.release_registration(
            email,
            error=reason,
            remove_placeholder=True,
        )

    def reconcile_account_placeholders(self) -> int:
        """启动时清理异常清单中无 token 条目对应的「注册中」占位账号。"""
        cleaned = 0
        with self._lock:
            for item in self._items.values():
                if str(item.get("access_token") or "").strip():
                    continue
                email = str(item.get("email") or "").strip()
                if not email:
                    continue
                self._release_registering_placeholder(
                    email,
                    str(item.get("reason") or ""),
                )
                cleaned += 1
        return cleaned

    def peek(self, email: str) -> dict | None:
        with self._lock:
            self._refresh_from_storage_locked()
            item = self._items.get(_norm_email(email))
            return dict(item) if item else None

    def delete(self, emails: list[str]) -> int:
        removed = 0
        with self._lock:
            self._refresh_from_storage_locked()
            for email in emails or []:
                if self._items.pop(_norm_email(email), None) is not None:
                    removed += 1
            if removed:
                self._save()
        return removed


register_abnormal_service = RegisterAbnormalService()
