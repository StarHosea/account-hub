from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from services.config import DATA_DIR

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


class CdkService:
    """Plus CDK 池服务：维护带本地类型(UPI/IDEL)的 CDK 列表。"""

    def __init__(self, store_file: Path = CDK_FILE):
        self._store_file = store_file
        self._lock = threading.RLock()
        self._cdks: dict[str, dict] = self._load()

    # ----------------------------- 持久化 ----------------------------- #

    def _load(self) -> dict[str, dict]:
        try:
            data = json.loads(self._store_file.read_text(encoding="utf-8"))
        except Exception:
            return {}
        items = data if isinstance(data, list) else data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return {}
        result: dict[str, dict] = {}
        for item in items:
            normalized = self._normalize(item)
            if normalized:
                result[normalized["cdk"]] = normalized
        return result

    def _save(self) -> None:
        self._store_file.parent.mkdir(parents=True, exist_ok=True)
        payload = {"items": list(self._cdks.values())}
        self._store_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

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
        with self._lock:
            wanted = normalize_type(cdk_type) if cdk_type else None
            lines = [item["cdk"] for item in self._cdks.values() if wanted is None or item["type"] == wanted]
            return "\n".join(lines)

    # ----------------------------- 写操作 ----------------------------- #

    def import_text(self, text: str, cdk_type: str) -> dict[str, int]:
        cdk_type = normalize_type(cdk_type)
        parsed = parse_cdk_lines(text)
        if len(parsed) > MAX_IMPORT_ROWS:
            raise ValueError(f"单次最多导入 {MAX_IMPORT_ROWS} 条，当前解析到 {len(parsed)} 条，请分批导入")
        added = 0
        updated = 0
        skipped = 0
        with self._lock:
            for cdk in parsed:
                existing = self._cdks.get(cdk)
                if existing:
                    if existing["type"] != cdk_type:
                        existing["type"] = cdk_type
                        updated += 1
                    else:
                        # 完全重复（类型也相同）：跳过，计入 skipped。
                        skipped += 1
                else:
                    self._cdks[cdk] = self._normalize({"cdk": cdk, "type": cdk_type, "imported_at": _now()})
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
        """领取一个该类型的可用 CDK（失败不消耗，可被复用，故不在此置占用）。

        exclude 用于在同一账号的多次尝试中跳过刚失败过的 CDK，避免原地打转。
        无可用返回 None。
        """
        cdk_type = normalize_type(cdk_type)
        exclude = exclude or set()
        with self._lock:
            for item in self._cdks.values():
                if item["type"] == cdk_type and item["status"] == STATUS_AVAILABLE and item["cdk"] not in exclude:
                    return item["cdk"]
        return None

    def consume(self, cdk: str, bound_token: str) -> None:
        """成功兑换：置 used 并记录绑定账号。"""
        with self._lock:
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
            item = self._cdks.get(str(cdk).strip())
            if item is None:
                return
            item["status"] = STATUS_INVALID
            item["used_at"] = _now()
            self._save()


cdk_service = CdkService()
