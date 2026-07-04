from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from services.config import DATA_DIR, config

CDK_FILE = DATA_DIR / "cdks.json"

# 单次批量导入上限（防止一次性提交超大文本拖慢全量重写）。
MAX_IMPORT_ROWS = 2000

# 本地 CDK 分类标签（仅用于激活策略「每类各试 3 次」，不参与兑换请求）。
CDK_TYPES = ("UPI", "IDEL")

# 状态：available 可用 / used 已成功消耗 / invalid 服务端判定无效(not_found)。
STATUS_AVAILABLE = "available"
STATUS_USED = "used"
STATUS_INVALID = "invalid"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_type(value: str) -> str:
    t = str(value or "").strip().upper()
    return t if t in CDK_TYPES else CDK_TYPES[0]


def parse_cdk_lines(text: str) -> list[str]:
    """解析批量导入文本，一行一个 CDK，忽略空行与 `#` 注释，按出现顺序去重。"""
    seen: set[str] = set()
    result: list[str] = []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line in seen:
            continue
        seen.add(line)
        result.append(line)
    return result


def parse_cdk_type_lines(text: str) -> list[tuple[str, str | None]]:
    """解析 `CDK-类型` 批量导入文本，返回 (cdk, inline_type|None)，按 CDK 去重。

    行内类型可选：按**最后一个** `-` 切分，若后缀是合法类型(UPI/IDEL)则采用，否则整行视为 CDK
    并由调用方回退到请求级类型（兼容裸 CDK 粘贴，及 CDK 本身含 `-` 的情况）。
    """
    seen: set[str] = set()
    result: list[tuple[str, str | None]] = []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        cdk, inline_type = line, None
        if "-" in line:
            head, _, tail = line.rpartition("-")
            suffix = tail.strip().upper()
            if head.strip() and suffix in CDK_TYPES:
                cdk, inline_type = head.strip(), suffix
        if not cdk or cdk in seen:
            continue
        seen.add(cdk)
        result.append((cdk, inline_type))
    return result


class CdkService:
    """Plus CDK 池服务：维护带本地类型(UPI/IDEL)的 CDK 列表。"""

    def __init__(self, store_file: Path = CDK_FILE):
        self._store_file = store_file
        self._storage = config.get_storage_backend()
        self._lock = threading.RLock()
        self._cdks: dict[str, dict] = self._load()
        # 进行中（已领取尚未出终态）的 CDK：并发激活时防止同一 CDK 被多个账号同时领用。
        # 值为领取时刻（epoch 秒），供后台 reaper 按龄回收「进程存活期间」卡死的占用。
        # 仅内存态，不持久化——进程重启后一切以持久化的 status 为准。
        self._reserved: dict[str, float] = {}

    # ----------------------------- 持久化 ----------------------------- #

    def _load(self) -> dict[str, dict]:
        items = self._storage.load_collection("cdks")
        if items is None:
            # 后端首次启动：从旧 data/cdks.json 迁移种子数据（无则以空集合打标志）。
            items = self._read_legacy_items()
            result = self._items_to_map(items)
            self._storage.save_collection("cdks", list(result.values()))
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
                result[normalized["cdk"]] = normalized
        return result

    def _save(self) -> None:
        self._storage.save_collection("cdks", list(self._cdks.values()))

    @staticmethod
    def _normalize(item: dict) -> dict | None:
        if not isinstance(item, dict):
            return None
        cdk = str(item.get("cdk") or "").strip()
        if not cdk:
            return None
        status = str(item.get("status") or STATUS_AVAILABLE).strip()
        if status not in (STATUS_AVAILABLE, STATUS_USED, STATUS_INVALID):
            status = STATUS_AVAILABLE
        return {
            "cdk": cdk,
            "type": normalize_type(item.get("type")),
            "status": status,
            "bound_token": item.get("bound_token") or None,
            "used_at": item.get("used_at") or None,
            "imported_at": item.get("imported_at") or _now(),
            "note": str(item.get("note") or ""),
        }

    # ----------------------------- 只读 ----------------------------- #

    def list_cdks(self) -> list[dict]:
        with self._lock:
            return [dict(item) for item in self._cdks.values()]

    def counts(self) -> dict:
        """按类型 × 状态统计，供前端汇总。"""
        with self._lock:
            summary = {t: {STATUS_AVAILABLE: 0, STATUS_USED: 0, STATUS_INVALID: 0} for t in CDK_TYPES}
            for item in self._cdks.values():
                bucket = summary.setdefault(item["type"], {STATUS_AVAILABLE: 0, STATUS_USED: 0, STATUS_INVALID: 0})
                bucket[item["status"]] = bucket.get(item["status"], 0) + 1
            total_available = sum(b[STATUS_AVAILABLE] for b in summary.values())
            return {"by_type": summary, "available": total_available, "total": len(self._cdks)}

    def export_text(self, cdk_type: str | None = None) -> str:
        """导出为 `CDK-类型` 每行一条（类型为 UPI/IDEL），便于按 A7 约定的格式回环导入。"""
        with self._lock:
            wanted = normalize_type(cdk_type) if cdk_type else None
            lines = [
                f"{item['cdk']}-{item['type']}"
                for item in self._cdks.values()
                if wanted is None or item["type"] == wanted
            ]
            return "\n".join(lines)

    # ----------------------------- 写操作 ----------------------------- #

    def import_text(self, text: str, cdk_type: str) -> dict[str, int]:
        """批量导入 `CDK-类型`；行内类型缺省时回退到请求级 cdk_type。"""
        default_type = normalize_type(cdk_type)
        parsed = parse_cdk_type_lines(text)
        if len(parsed) > MAX_IMPORT_ROWS:
            raise ValueError(f"单次最多导入 {MAX_IMPORT_ROWS} 条，当前解析到 {len(parsed)} 条，请分批导入")
        added = 0
        updated = 0
        skipped = 0
        with self._lock:
            for cdk, inline_type in parsed:
                resolved_type = normalize_type(inline_type) if inline_type else default_type
                existing = self._cdks.get(cdk)
                if existing:
                    if existing["type"] != resolved_type:
                        existing["type"] = resolved_type
                        updated += 1
                    else:
                        # 完全重复（类型也相同）：跳过，计入 skipped。
                        skipped += 1
                else:
                    self._cdks[cdk] = self._normalize({"cdk": cdk, "type": resolved_type, "imported_at": _now()})
                    added += 1
            self._save()
        return {"added": added, "updated": updated, "skipped": skipped, "total": len(self._cdks)}

    def delete(self, cdks: list[str]) -> int:
        removed = 0
        with self._lock:
            for cdk in cdks or []:
                if self._cdks.pop(str(cdk).strip(), None) is not None:
                    removed += 1
            if removed:
                self._save()
        return removed

    # ----------------------------- 激活引擎用 ----------------------------- #

    def acquire_available(self, cdk_type: str, exclude: set[str] | None = None) -> str | None:
        """领取一个该类型的可用 CDK：原子地「选中 + 置为进行中」，避免并发激活时同一 CDK
        被多个账号同时领用（一码多账号）。失败不消耗，需调用 release 归还；成功/无效由
        consume/mark_invalid 转终态。

        exclude 用于在同一账号的多次尝试中跳过刚失败过的 CDK，避免原地打转。
        无可用返回 None。
        """
        cdk_type = normalize_type(cdk_type)
        exclude = exclude or set()
        with self._lock:
            for item in self._cdks.values():
                if (
                    item["type"] == cdk_type
                    and item["status"] == STATUS_AVAILABLE
                    and item["cdk"] not in exclude
                    and item["cdk"] not in self._reserved
                ):
                    self._reserved[item["cdk"]] = time.time()
                    return item["cdk"]
        return None

    def release(self, cdk: str) -> None:
        """归还一个「进行中」但未成功消耗的 CDK，使其可被其他账号再次领用（状态仍为 available）。"""
        with self._lock:
            self._reserved.pop(str(cdk).strip(), None)

    def reconcile_reserved(self, max_age: float | None = None) -> int:
        """回收「进行中」但已卡死的 CDK 预占（进程存活期间的兜底，不改持久化 status）。

        max_age 为 None 或 <=0 时清空所有预占（启动对账语义）；否则只清领取时间超过 max_age 秒
        的项，避免误伤仍在正常激活中的 CDK。返回回收数量。
        """
        with self._lock:
            if not self._reserved:
                return 0
            if max_age is None or max_age <= 0:
                count = len(self._reserved)
                self._reserved.clear()
                return count
            now = time.time()
            stale = [c for c, ts in self._reserved.items() if (now - ts) >= max_age]
            for c in stale:
                self._reserved.pop(c, None)
            return len(stale)

    def consume(self, cdk: str, bound_token: str) -> None:
        """成功兑换：置 used 并记录绑定账号。"""
        with self._lock:
            self._reserved.pop(str(cdk).strip(), None)
            item = self._cdks.get(str(cdk).strip())
            if item is None:
                return
            item["status"] = STATUS_USED
            item["bound_token"] = str(bound_token or "") or None
            item["used_at"] = _now()
            self._save()

    def mark_invalid(self, cdk: str) -> None:
        """服务端 not_found：置 invalid（不再被领用）。"""
        with self._lock:
            self._reserved.pop(str(cdk).strip(), None)
            item = self._cdks.get(str(cdk).strip())
            if item is None:
                return
            item["status"] = STATUS_INVALID
            item["used_at"] = _now()
            self._save()

    def revoke_use(self, cdks: list[str]) -> int:
        """危险操作：批量「撤销使用」——把选中的 CDK 从 used/invalid 复位为 available，
        清除绑定账号(bound_token)与 used_at，使其可被重新领用。

        仅用于**程序异常错误标记了 CDK 使用状态**时的人工纠正；不校验该 CDK 在服务端是否真的可再用。
        返回复位数量。
        """
        revoked = 0
        with self._lock:
            for cdk in cdks or []:
                key = str(cdk).strip()
                self._reserved.pop(key, None)
                item = self._cdks.get(key)
                if item is None or item.get("status") == STATUS_AVAILABLE:
                    continue
                item["status"] = STATUS_AVAILABLE
                item["bound_token"] = None
                item["used_at"] = None
                revoked += 1
            if revoked:
                self._save()
        return revoked


cdk_service = CdkService()
