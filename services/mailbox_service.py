from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from services.config import DATA_DIR

MAILBOX_FILE = DATA_DIR / "mailboxes.json"

# 占用态超过该秒数视为陈旧（注册进程崩溃残留），可被重新领用。
IN_USE_STALE_SECONDS = 3600


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_email(email: str) -> str:
    return str(email or "").strip().lower()


def parse_mailbox_lines(text: str) -> list[dict[str, str]]:
    """解析批量导入文本，每行格式 `邮箱----取件地址URL`。

    忽略空行与 `#` 注释行；按邮箱去重（后者覆盖前者）。
    """
    parsed: dict[str, dict[str, str]] = {}
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("----", 1)
        if len(parts) != 2:
            continue
        email = parts[0].strip()
        fetch_url = parts[1].strip()
        if not email or not fetch_url:
            continue
        parsed[_norm_email(email)] = {"email": email, "fetch_url": fetch_url}
    return list(parsed.values())


class MailboxService:
    """API 邮箱池服务：维护批量导入的 `邮箱----取件地址` 列表。

    used=True 表示该邮箱已注册过账号（或被人工标记不再使用），注册机会跳过它。
    """

    def __init__(self, store_file: Path = MAILBOX_FILE):
        self._store_file = store_file
        self._lock = threading.RLock()
        self._mailboxes: dict[str, dict] = self._load()

    # ----------------------------- 持久化 ----------------------------- #

    def _load(self) -> dict[str, dict]:
        try:
            data = json.loads(self._store_file.read_text(encoding="utf-8"))
        except Exception:
            return {}
        result: dict[str, dict] = {}
        items = data if isinstance(data, list) else data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return {}
        for item in items:
            normalized = self._normalize(item)
            if normalized:
                result[_norm_email(normalized["email"])] = normalized
        return result

    def _save(self) -> None:
        self._store_file.parent.mkdir(parents=True, exist_ok=True)
        payload = {"items": list(self._mailboxes.values())}
        self._store_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @staticmethod
    def _normalize(item: dict) -> dict | None:
        if not isinstance(item, dict):
            return None
        email = str(item.get("email") or "").strip()
        fetch_url = str(item.get("fetch_url") or "").strip()
        if not email or not fetch_url:
            return None
        return {
            "email": email,
            "fetch_url": fetch_url,
            "used": bool(item.get("used")),
            "in_use": bool(item.get("in_use")),
            "account_token": item.get("account_token") or None,
            "registered_at": item.get("registered_at") or None,
            "imported_at": item.get("imported_at") or _now(),
            "in_use_at": item.get("in_use_at") or None,
            "note": str(item.get("note") or ""),
        }

    # ----------------------------- 对外只读视图 ----------------------------- #

    @staticmethod
    def _public(item: dict) -> dict:
        """对外视图：不暴露内部占用细节以外的字段（取件地址本身需要展示，故保留）。"""
        return {
            "email": item["email"],
            "fetch_url": item["fetch_url"],
            "used": bool(item["used"]),
            "in_use": bool(item.get("in_use")),
            "account_token": item.get("account_token"),
            "registered_at": item.get("registered_at"),
            "imported_at": item.get("imported_at"),
            "note": item.get("note") or "",
        }

    def list_mailboxes(self) -> list[dict]:
        with self._lock:
            return [self._public(item) for item in self._mailboxes.values()]

    def stats(self) -> dict[str, int]:
        with self._lock:
            total = len(self._mailboxes)
            used = sum(1 for m in self._mailboxes.values() if m["used"])
            in_use = sum(1 for m in self._mailboxes.values() if m.get("in_use") and not m["used"])
            return {"total": total, "used": used, "unused": total - used - in_use, "in_use": in_use}

    # ----------------------------- 写操作 ----------------------------- #

    def import_text(self, text: str) -> dict[str, int]:
        parsed = parse_mailbox_lines(text)
        added = 0
        updated = 0
        with self._lock:
            for entry in parsed:
                key = _norm_email(entry["email"])
                existing = self._mailboxes.get(key)
                if existing:
                    # 已存在：仅更新取件地址，保留 used/绑定信息。
                    if existing["fetch_url"] != entry["fetch_url"]:
                        existing["fetch_url"] = entry["fetch_url"]
                        updated += 1
                else:
                    self._mailboxes[key] = self._normalize({**entry, "imported_at": _now()})
                    added += 1
            self._save()
        return {"added": added, "updated": updated, "total": len(self._mailboxes)}

    def delete(self, emails: list[str]) -> int:
        removed = 0
        with self._lock:
            for email in emails or []:
                if self._mailboxes.pop(_norm_email(email), None) is not None:
                    removed += 1
            if removed:
                self._save()
        return removed

    def mark_used(self, emails: list[str], used: bool) -> int:
        changed = 0
        with self._lock:
            for email in emails or []:
                item = self._mailboxes.get(_norm_email(email))
                if item is None:
                    continue
                item["used"] = bool(used)
                if not used:
                    item["account_token"] = None
                    item["registered_at"] = None
                item["in_use"] = False
                item["in_use_at"] = None
                changed += 1
            if changed:
                self._save()
        return changed

    # ----------------------------- 注册机用 ----------------------------- #

    def _is_available(self, item: dict) -> bool:
        if item["used"]:
            return False
        if item.get("in_use"):
            in_use_at = str(item.get("in_use_at") or "")
            try:
                ts = datetime.fromisoformat(in_use_at)
                ts = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
                age = (datetime.now(timezone.utc) - ts).total_seconds()
                return age >= IN_USE_STALE_SECONDS
            except Exception:
                return True
        return True

    def acquire_unused(self) -> dict | None:
        """原子领取一个可用邮箱并标记占用，返回 {email, fetch_url}；无可用返回 None。"""
        with self._lock:
            for item in self._mailboxes.values():
                if self._is_available(item):
                    item["in_use"] = True
                    item["in_use_at"] = _now()
                    self._save()
                    return {"email": item["email"], "fetch_url": item["fetch_url"]}
        return None

    def release(self, email: str) -> None:
        """把占用态释放回未使用（用于流程主动放弃且未消费验证码时）。"""
        with self._lock:
            item = self._mailboxes.get(_norm_email(email))
            if item is not None and item.get("in_use") and not item["used"]:
                item["in_use"] = False
                item["in_use_at"] = None
                self._save()

    def bind_account(self, email: str, account_token: str) -> None:
        """注册成功：标记 used 并记录绑定账号。"""
        with self._lock:
            item = self._mailboxes.get(_norm_email(email))
            if item is None:
                return
            item["used"] = True
            item["in_use"] = False
            item["in_use_at"] = None
            item["account_token"] = str(account_token or "") or None
            item["registered_at"] = _now()
            self._save()


mailbox_service = MailboxService()
