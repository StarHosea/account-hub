from __future__ import annotations

import re
import threading
from datetime import datetime, timedelta, timezone

from services.config import config

# 单次批量导入上限（防止一次性提交超大文本拖慢全量重写）。
MAX_IMPORT_ROWS = 2000

# 占用态超过该秒数视为陈旧（注册进程崩溃残留），可被重新领用。
IN_USE_STALE_SECONDS = 3600


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_email(email: str) -> str:
    return str(email or "").strip().lower()


def _is_http_url(url: str) -> bool:
    return bool(re.match(r"^https?://", str(url or "").strip(), flags=re.IGNORECASE))


def parse_mailbox_lines(text: str) -> list[dict[str, str]]:
    """解析批量导入文本，每行格式 `邮箱---收件地址`（分隔符至少两个连字符 `-`）。

    忽略空行与 `#` 注释行；按邮箱去重（后者覆盖前者）。
    """
    parsed: dict[str, dict[str, str]] = {}
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"-{2,}", line, maxsplit=1)
        if len(parts) != 2:
            continue
        email = parts[0].strip()
        fetch_url = parts[1].strip()
        if not email or not fetch_url or not _is_http_url(fetch_url):
            continue
        parsed[_norm_email(email)] = {"email": email, "fetch_url": fetch_url}
    return list(parsed.values())


class MailboxService:
    """API 邮箱池服务：维护批量导入的 `邮箱----取件地址` 列表。

    used=True 表示该邮箱已注册过账号（或被人工标记不再使用），注册机会跳过它。
    """

    def __init__(self, storage=None):
        self._storage = storage if storage is not None else config.get_storage_backend()
        self._lock = threading.RLock()
        self._mailboxes: dict[str, dict] = self._load()

    # ----------------------------- 持久化 ----------------------------- #

    def _load(self) -> dict[str, dict]:
        items = self._storage.load_collection("mailboxes")
        if items is None:
            items = []
            self._storage.save_collection("mailboxes", [])
        return self._items_to_map(items)

    def _items_to_map(self, items: list) -> dict[str, dict]:
        result: dict[str, dict] = {}
        for item in items:
            normalized = self._normalize(item)
            if normalized:
                result[_norm_email(normalized["email"])] = normalized
        return result

    def _save(self) -> None:
        self._storage.save_collection("mailboxes", list(self._mailboxes.values()))

    def reconcile_in_use(self) -> int:
        """启动对账：把硬杀残留、in_use=True 且 used=False 的邮箱立即复位 in_use=False、清 in_use_at。

        比 IN_USE_STALE_SECONDS(1 小时) 超时回收更快，启动即释放。不动 cooldown_until。返回复位数。
        """
        with self._lock:
            n = 0
            for m in self._mailboxes.values():
                if m.get("in_use") and not m.get("used"):
                    m["in_use"] = False
                    m["in_use_at"] = None
                    n += 1
            if n:
                self._save()
            return n

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
            # 冷却截止时间：环境类失败（Cloudflare/超时等，与邮箱本身无关）释放回池后短暂冷却，
            # 避免同一邮箱被下个任务立刻重领而空转。到点自动重新可用。
            "cooldown_until": item.get("cooldown_until") or None,
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

    def get_fetch_url(self, email: str) -> str | None:
        """按邮箱取「取件地址」，供号池列表展示邮件链接。"""
        with self._lock:
            item = self._mailboxes.get(_norm_email(email))
            return item["fetch_url"] if item else None

    def export_text(self, only_unused: bool = False) -> str:
        """导出为 `邮箱---收件地址` 每行一条（与导入格式一致，可回环）。"""
        with self._lock:
            lines = [
                f"{item['email']}---{item['fetch_url']}"
                for item in self._mailboxes.values()
                if not (only_unused and (item.get("used") or item.get("in_use")))
            ]
            return "\n".join(lines)

    def stats(self) -> dict[str, int]:
        with self._lock:
            total = len(self._mailboxes)
            used = sum(1 for m in self._mailboxes.values() if m["used"])
            in_use = sum(1 for m in self._mailboxes.values() if m.get("in_use") and not m["used"])
            return {"total": total, "used": used, "unused": total - used - in_use, "in_use": in_use}

    # ----------------------------- 写操作 ----------------------------- #

    def import_text(self, text: str) -> dict[str, int]:
        parsed = parse_mailbox_lines(text)
        if len(parsed) > MAX_IMPORT_ROWS:
            raise ValueError(f"单次最多导入 {MAX_IMPORT_ROWS} 条，当前解析到 {len(parsed)} 条，请分批导入")
        added = 0
        updated = 0
        skipped = 0
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
                        # 完全重复（取件地址也相同）：跳过，计入 skipped。
                        skipped += 1
                else:
                    self._mailboxes[key] = self._normalize({**entry, "imported_at": _now()})
                    added += 1
            self._save()
        return {"added": added, "updated": updated, "skipped": skipped, "total": len(self._mailboxes)}

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
        # 环境类失败释放后的冷却期：未到点则暂不可领用。
        cooldown_until = str(item.get("cooldown_until") or "")
        if cooldown_until:
            try:
                cd = datetime.fromisoformat(cooldown_until)
                cd = cd if cd.tzinfo else cd.replace(tzinfo=timezone.utc)
                if datetime.now(timezone.utc) < cd:
                    return False
            except Exception:
                pass  # 冷却时间戳非法：忽略冷却，按占用态逻辑继续判断
        if item.get("in_use"):
            in_use_at = str(item.get("in_use_at") or "")
            if not in_use_at:
                return False  # 占用中但无时间戳：保守视为不可用（原来错误 return True 会导致重复领取）
            try:
                ts = datetime.fromisoformat(in_use_at)
                ts = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
                age = (datetime.now(timezone.utc) - ts).total_seconds()
                return age >= IN_USE_STALE_SECONDS
            except Exception:
                return False  # 时间戳非法：保守视为占用中（原来错误 return True）
        return True

    def acquire_unused(self) -> dict | None:
        """原子领取一个可用邮箱并标记占用，返回 {email, fetch_url}；无可用返回 None。"""
        with self._lock:
            for item in self._mailboxes.values():
                if self._is_available(item):
                    item["in_use"] = True
                    item["in_use_at"] = _now()
                    item["cooldown_until"] = None  # 领用即清冷却（能被领说明冷却已过或无冷却）
                    self._save()
                    return {"email": item["email"], "fetch_url": item["fetch_url"]}
        return None

    def release(self, email: str, cooldown_seconds: float = 0) -> None:
        """把占用态释放回未使用（用于流程主动放弃、或环境类失败可重试时）。

        cooldown_seconds>0 时写冷却截止时间，冷却期内 _is_available 返回 False，
        避免刚失败的邮箱被下一个任务立刻重领而空转（如 Cloudflare 拦截、网络超时）。
        """
        with self._lock:
            item = self._mailboxes.get(_norm_email(email))
            if item is not None and item.get("in_use") and not item["used"]:
                item["in_use"] = False
                item["in_use_at"] = None
                if cooldown_seconds and cooldown_seconds > 0:
                    until = datetime.now(timezone.utc) + timedelta(seconds=cooldown_seconds)
                    item["cooldown_until"] = until.isoformat()
                else:
                    item["cooldown_until"] = None
                self._save()

    def mark_used_bad(self, email: str, note: str = "") -> None:
        """把邮箱标记为不可再用（used=True）：用于「邮箱疑似已注册过账号」等永久性失败，
        避免注册机反复领用同一坏邮箱空转。不绑定账号 token。
        """
        with self._lock:
            item = self._mailboxes.get(_norm_email(email))
            if item is None:
                return
            item["used"] = True
            item["in_use"] = False
            item["in_use_at"] = None
            item["cooldown_until"] = None
            if note:
                item["note"] = note
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

    def register_imported(self, email: str, fetch_url: str, account_token: str | None = None) -> bool:
        """迁移导入账号时把其绑定邮箱登记进邮箱管理：写入/更新取件地址。

        迁移的是存量已注册账号，故标记 used 并绑定账号 token，避免注册机再次领用。
        返回是否新增。
        """
        email = str(email or "").strip()
        fetch_url = str(fetch_url or "").strip()
        if not email or not fetch_url:
            return False
        key = _norm_email(email)
        token = str(account_token or "").strip() or None
        with self._lock:
            existing = self._mailboxes.get(key)
            if existing is None:
                self._mailboxes[key] = self._normalize({
                    "email": email, "fetch_url": fetch_url, "used": True,
                    "account_token": token, "registered_at": _now(), "imported_at": _now(),
                })
                self._save()
                return True
            changed = False
            if existing["fetch_url"] != fetch_url:  # 更新取件地址
                existing["fetch_url"] = fetch_url
                changed = True
            if token and not existing.get("account_token"):  # 补绑（不覆盖已有绑定）
                existing["account_token"] = token
                existing["used"] = True
                existing["registered_at"] = existing.get("registered_at") or _now()
                changed = True
            if changed:
                self._save()
            return False


mailbox_service = MailboxService()
