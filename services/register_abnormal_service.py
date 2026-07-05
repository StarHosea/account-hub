from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from services.config import DATA_DIR, config


COLLECTION = "register_abnormal"
LEGACY_FILE = DATA_DIR / "register_abnormal.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_email(email: str) -> str:
    return str(email or "").strip().lower()


class RegisterAbnormalService:
    """注册机异常账号清单：主键=邮箱。

    记录注册过程发生异常的账号，供人工排查。
    这些账号不进入号池（账号管理）。由 openai_register.worker() 在各类失败路径调用 add() 写入。
    """

    def __init__(self, store_file: Path = LEGACY_FILE, storage=None) -> None:
        self._store_file = store_file
        self._storage = storage if storage is not None else config.get_storage_backend()
        self._lock = threading.RLock()
        self._items: dict[str, dict] = self._load()

    # ----------------------------- 持久化 ----------------------------- #

    def _load(self) -> dict[str, dict]:
        items = self._storage.load_collection(COLLECTION)
        if items is None:
            items = self._read_legacy_items()
            result = self._items_to_map(items)
            self._storage.save_collection(COLLECTION, list(result.values()))
            return result
        return self._items_to_map(items)

    def _read_legacy_items(self) -> list:
        try:
            data = json.loads(self._store_file.read_text(encoding="utf-8"))
        except Exception:
            return []
        items = data if isinstance(data, list) else data.get("items") if isinstance(data, dict) else None
        return items if isinstance(items, list) else []

    def _items_to_map(self, items: list) -> dict[str, dict]:
        result: dict[str, dict] = {}
        for item in items or []:
            normalized = self._normalize(item)
            if normalized:
                result[_norm_email(normalized["email"])] = normalized
        return result

    def _save(self) -> None:
        self._storage.save_collection(COLLECTION, list(self._items.values()))

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
            "created_at": item.get("created_at") or _now(),
        }

    # ----------------------------- 对外只读视图 ----------------------------- #

    def list_items(self) -> list[dict]:
        with self._lock:
            # 最近的异常排前面，便于排查。
            return sorted(
                (dict(v) for v in self._items.values()),
                key=lambda x: str(x.get("created_at") or ""),
                reverse=True,
            )

    def stats(self) -> dict:
        with self._lock:
            items = list(self._items.values())
            total = len(items)
            no_trial = sum(1 for a in items if a.get("eligible") is False)
            return {"total": total, "no_trial": no_trial, "other": total - no_trial}

    def export_text(self) -> str:
        """导出为 `邮箱---取件地址---原因` 每行一条。"""
        with self._lock:
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
            key = _norm_email(email)
            existing = self._items.get(key) or {}
            merged = {
                "email": email,
                "fetch_url": fetch_url or existing.get("fetch_url") or "",
                "reason": reason or existing.get("reason") or "",
                "access_token": extra.get("access_token") or existing.get("access_token"),
                "password": extra.get("password") or existing.get("password"),
                "eligible": extra.get("eligible", existing.get("eligible")),
                "created_at": existing.get("created_at") or _now(),
            }
            normalized = self._normalize(merged)
            if normalized is None:
                return None
            self._items[key] = normalized
            self._save()
            return dict(normalized)

    def delete(self, emails: list[str]) -> int:
        removed = 0
        with self._lock:
            for email in emails or []:
                if self._items.pop(_norm_email(email), None) is not None:
                    removed += 1
            if removed:
                self._save()
        return removed


register_abnormal_service = RegisterAbnormalService()
