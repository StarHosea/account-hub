from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from services.config import DATA_DIR, config

PHONE_FILE = DATA_DIR / "phones.json"

# 导入分隔符：手机号----接码地址（与邮箱池保持一致）。
SEP = "----"

# 单个手机号最多出库 3 次，满 3 自动标记「已使用」。
MAX_USES = 3
# 每次出库后自动冷却时长（秒）：1 小时。
COOLDOWN_SECONDS = 3600
# 发号预占的过期时间（秒）：超过则视为陈旧，可被重新选中（防止占用泄漏）。
RESERVE_STALE_SECONDS = 300


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _now() -> str:
    return _now_dt().isoformat()


def _parse_dt(value: object) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _cooldown_until(now: datetime) -> str:
    """从 now 起冷却 COOLDOWN_SECONDS 后的 ISO 时间戳。"""
    return datetime.fromtimestamp(now.timestamp() + COOLDOWN_SECONDS, tz=timezone.utc).isoformat()


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
    account_token = str(value.get("account_token") or "").strip()
    if not (customer or wechat or xianyu or plan or note or checkout_at or dispatch_no or account_token):
        return None
    return {
        "customer": customer,
        "wechat": wechat,
        "xianyu": xianyu,
        "plan": plan,
        "note": note,
        "dispatch_no": dispatch_no,
        "account_token": account_token,
        "checkout_at": checkout_at or _now(),
    }


def _norm_phone(phone: str) -> str:
    """去除空白，作为去重键（保留 + 前缀）。"""
    return "".join(str(phone or "").split())


def parse_phone_lines(text: str) -> list[dict[str, str]]:
    """解析批量导入文本，每行 `手机号---接码地址`（分隔符至少两个连字符 `-`）。

    - 忽略空行与 `#` 注释行；
    - 没有分隔符的行视为「仅手机号」，接码地址留空；
    - 按手机号去重（后者覆盖前者）。
    """
    parsed: dict[str, dict[str, str]] = {}
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"-{2,}", line, maxsplit=1)
        phone = parts[0].strip()
        fetch_url = parts[1].strip() if len(parts) == 2 else ""
        if not phone:
            continue
        parsed[_norm_phone(phone)] = {"phone": phone, "fetch_url": fetch_url}
    return list(parsed.values())


class PhoneService:
    """手机号池服务：维护 `手机号----接码地址` 列表，并支持发号（预占→出库）状态机。

    状态字段：
    - used / used_count：人工或出库累计，满 MAX_USES 自动 used=True；
    - cooldown_until：每次出库后冷却 1h，冷却中不可再被选号；
    - invalid：人工标记无效，永久不再被选号；
    - reserved_at：发号预占时间戳，RESERVE_STALE_SECONDS 内独占（防多人重复出库）。
    """

    def __init__(self, store_file: Path = PHONE_FILE):
        self._store_file = store_file
        self._storage = config.get_storage_backend()
        self._lock = threading.RLock()
        self._phones: dict[str, dict] = self._load()

    # ----------------------------- 持久化 ----------------------------- #

    def _load(self) -> dict[str, dict]:
        items = self._storage.load_collection("phones")
        if items is None:
            items = self._read_legacy_items()
            result = self._items_to_map(items)
            self._storage.save_collection("phones", list(result.values()))
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
        for item in items:
            normalized = self._normalize(item)
            if normalized:
                result[_norm_phone(normalized["phone"])] = normalized
        return result

    def _save(self) -> None:
        self._storage.save_collection("phones", list(self._phones.values()))

    def reconcile_reserved(self) -> int:
        """启动对账：清理所有 reserved_at（发号预占是瞬时态，重启即失效）。

        不动 cooldown_until/used_count 等正常消耗态。返回清理数。
        """
        with self._lock:
            n = 0
            for p in self._phones.values():
                if p.get("reserved_at"):
                    p["reserved_at"] = None
                    n += 1
            if n:
                self._save()
            return n

    @staticmethod
    def _normalize(item: dict) -> dict | None:
        if not isinstance(item, dict):
            return None
        phone = str(item.get("phone") or "").strip()
        if not phone:
            return None
        try:
            used_count = max(0, int(item.get("used_count") or 0))
        except (TypeError, ValueError):
            used_count = 0
        used = bool(item.get("used")) or used_count >= MAX_USES
        return {
            "phone": phone,
            "fetch_url": str(item.get("fetch_url") or "").strip(),
            "used": used,
            "used_count": used_count,
            "invalid": bool(item.get("invalid")),
            "cooldown_until": item.get("cooldown_until") or None,
            "reserved_at": item.get("reserved_at") or None,
            "last_used_at": item.get("last_used_at") or None,
            "imported_at": item.get("imported_at") or _now(),
            "note": str(item.get("note") or ""),
            "checkout_at": item.get("checkout_at") or None,
            "checkout_meta": _normalize_checkout_meta(item.get("checkout_meta")) or None,
            "checkout_records": [
                normalized
                for record in (item.get("checkout_records") if isinstance(item.get("checkout_records"), list) else [])
                if (normalized := _normalize_checkout_meta(record)) is not None
            ],
        }

    # ----------------------------- 状态判定 ----------------------------- #

    @staticmethod
    def _is_cooling(item: dict, now: datetime) -> bool:
        cd = _parse_dt(item.get("cooldown_until"))
        return bool(cd and cd > now)

    @staticmethod
    def _is_reserved(item: dict, now: datetime) -> bool:
        r = _parse_dt(item.get("reserved_at"))
        return bool(r and (now - r).total_seconds() < RESERVE_STALE_SECONDS)

    def _is_available(self, item: dict, now: datetime) -> bool:
        """可被发号选中：未失效、未用尽、不在冷却、未被他人预占。"""
        if item.get("invalid") or item.get("used") or item.get("used_count", 0) >= MAX_USES:
            return False
        if self._is_cooling(item, now) or self._is_reserved(item, now):
            return False
        return True

    # ----------------------------- 只读 ----------------------------- #

    def list_phones(self) -> list[dict]:
        with self._lock:
            return [dict(item) for item in self._phones.values()]

    def counts(self) -> dict:
        now = _now_dt()
        with self._lock:
            total = len(self._phones)
            used = sum(1 for p in self._phones.values() if p["used"])
            invalid = sum(1 for p in self._phones.values() if p["invalid"])
            cooling = sum(
                1 for p in self._phones.values()
                if not p["used"] and not p["invalid"] and self._is_cooling(p, now)
            )
            available = sum(1 for p in self._phones.values() if self._is_available(p, now))
            total_uses = sum(p["used_count"] for p in self._phones.values())
            return {
                "total": total,
                "available": available,
                "cooldown": cooling,
                "used": used,
                "invalid": invalid,
                "total_uses": total_uses,
            }

    def export_text(self, only_unused: bool = False) -> str:
        """导出为 `手机号----接码地址` 文本；无接码地址的仅输出手机号。"""
        with self._lock:
            lines: list[str] = []
            for item in self._phones.values():
                if only_unused and item["used"]:
                    continue
                lines.append(f"{item['phone']}{SEP}{item['fetch_url']}" if item["fetch_url"] else item["phone"])
            return "\n".join(lines)

    # ----------------------------- 写操作 ----------------------------- #

    def import_text(self, text: str) -> dict[str, int]:
        parsed = parse_phone_lines(text)
        added = 0
        updated = 0
        with self._lock:
            for entry in parsed:
                key = _norm_phone(entry["phone"])
                existing = self._phones.get(key)
                if existing:
                    new_url = entry["fetch_url"]
                    if new_url and existing["fetch_url"] != new_url:
                        existing["fetch_url"] = new_url
                        updated += 1
                else:
                    self._phones[key] = self._normalize({**entry, "imported_at": _now()})
                    added += 1
            self._save()
        return {"added": added, "updated": updated, "total": len(self._phones)}

    def delete(self, phones: list[str]) -> int:
        removed = 0
        with self._lock:
            for phone in phones or []:
                if self._phones.pop(_norm_phone(phone), None) is not None:
                    removed += 1
            if removed:
                self._save()
        return removed

    def mark_used(self, phones: list[str], used: bool) -> int:
        """人工标记使用状态。标记为未使用会同时清零次数、解除冷却/无效。"""
        changed = 0
        with self._lock:
            for phone in phones or []:
                item = self._phones.get(_norm_phone(phone))
                if item is None:
                    continue
                item["used"] = bool(used)
                if not used:
                    item["used_count"] = 0
                    item["cooldown_until"] = None
                    item["invalid"] = False
                    item["reserved_at"] = None
                    item["checkout_at"] = None
                    item["checkout_meta"] = None
                changed += 1
            if changed:
                self._save()
        return changed

    def add_usage(self, phones: list[str], delta: int = 1, meta_by_phone: dict[str, dict[str, str]] | None = None) -> int:
        """累计使用次数 +delta（默认 +1）。已使用的号不再累加；满 MAX_USES 自动标记已使用。"""
        changed = 0
        meta_by_phone = meta_by_phone or {}
        with self._lock:
            for phone in phones or []:
                item = self._phones.get(_norm_phone(phone))
                if item is None or item["used"]:
                    continue
                item["used_count"] = min(MAX_USES, item["used_count"] + delta)
                item["last_used_at"] = _now()
                meta = _normalize_checkout_meta(meta_by_phone.get(phone) or meta_by_phone.get(_norm_phone(phone)))
                if meta:
                    item["checkout_at"] = meta["checkout_at"]
                    item["checkout_meta"] = meta
                    records = item.get("checkout_records") if isinstance(item.get("checkout_records"), list) else []
                    records.append(meta)
                    item["checkout_records"] = records
                if item["used_count"] >= MAX_USES:
                    item["used"] = True
                changed += 1
            if changed:
                self._save()
        return changed

    def set_invalid(self, phones: list[str], invalid: bool = True) -> int:
        changed = 0
        with self._lock:
            for phone in phones or []:
                item = self._phones.get(_norm_phone(phone))
                if item is None:
                    continue
                item["invalid"] = bool(invalid)
                if invalid:
                    item["reserved_at"] = None
                changed += 1
            if changed:
                self._save()
        return changed

    # ----------------------------- 发号（预占 → 出库） ----------------------------- #

    def acquire_for_dispatch(self) -> dict | None:
        """原子选号并预占：取「导入时间最老」的可用号，标记 reserved_at 后返回。

        预占后其它请求在 RESERVE_STALE_SECONDS 内不会选到同一个号，避免多人重复出库。
        无可用返回 None。
        """
        now = _now_dt()
        with self._lock:
            candidates = [p for p in self._phones.values() if self._is_available(p, now)]
            if not candidates:
                return None
            candidates.sort(key=lambda p: _parse_dt(p.get("imported_at")) or now)
            chosen = candidates[0]
            chosen["reserved_at"] = now.isoformat()
            self._save()
            return dict(chosen)

    def checkout(self, phone: str, meta: dict[str, str] | None = None) -> dict | None:
        """出库：次数 +1、记录时间、自动冷却 1h、解除预占；满 MAX_USES 标记已使用。"""
        with self._lock:
            item = self._phones.get(_norm_phone(phone))
            if item is None:
                return None
            now = _now_dt()
            item["used_count"] = min(MAX_USES, item["used_count"] + 1)
            item["last_used_at"] = now.isoformat()
            item["cooldown_until"] = _cooldown_until(now)
            item["reserved_at"] = None
            normalized_meta = _normalize_checkout_meta({**(meta or {}), "checkout_at": (meta or {}).get("checkout_at") or now.isoformat()})
            if normalized_meta:
                item["checkout_at"] = normalized_meta["checkout_at"]
                item["checkout_meta"] = normalized_meta
                records = item.get("checkout_records") if isinstance(item.get("checkout_records"), list) else []
                records.append(normalized_meta)
                item["checkout_records"] = records
            if item["used_count"] >= MAX_USES:
                item["used"] = True
            self._save()
            return dict(item)

    def cooldown(self, phone: str) -> dict | None:
        """人工置冷却 1h（不消耗次数），并解除预占。"""
        with self._lock:
            item = self._phones.get(_norm_phone(phone))
            if item is None:
                return None
            now = _now_dt()
            item["cooldown_until"] = _cooldown_until(now)
            item["reserved_at"] = None
            self._save()
            return dict(item)

    def release(self, phone: str) -> None:
        """释放预占（发号后未出库就放弃 / 选下一个），不消耗。"""
        with self._lock:
            item = self._phones.get(_norm_phone(phone))
            if item is not None and item.get("reserved_at"):
                item["reserved_at"] = None
                self._save()


phone_service = PhoneService()
