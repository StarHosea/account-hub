from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from services.cdk_redeem_client import scrub
from services.storage.activation_audit_storage import ActivationAuditStorage

COLLECTION = "activation_audit"
MAX_RECORDS = 3000
MAX_EVENTS_PER_RECORD = 5000
MAX_LOG_EVENTS_PER_RECORD = 500

OUTCOME_RUNNING = "running"
OUTCOME_SUCCESS = "success"
OUTCOME_FAILED = "failed"
OUTCOME_REVIEW = "review"

ABNORMAL_OUTCOMES = frozenset({OUTCOME_FAILED, OUTCOME_REVIEW})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_email(email: str) -> str:
    return str(email or "").strip().lower()


def _scrub_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _scrub_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_scrub_json(v) for v in value]
    if isinstance(value, str):
        return scrub(value)
    return value


class ActivationAuditRecorder:
    """单次账号激活链路的审计记录器（内存累积，结束时持久化）。"""

    def __init__(
        self,
        *,
        email: str,
        access_token: str,
        job_id: str | None = None,
        source: str = "batch",
    ) -> None:
        self.id = uuid.uuid4().hex
        self.email = str(email or "").strip()
        self.access_token = str(access_token or "").strip()
        self.job_id = job_id
        self.source = source
        self.started_at = _now()
        self.finished_at: str | None = None
        self.outcome = OUTCOME_RUNNING
        self.summary = ""
        self.cdk: str | None = None
        self.cdk_type: str | None = None
        self.cdk_consumed = False
        self.events: list[dict[str, Any]] = []

    def log(self, text: str, level: str = "info") -> None:
        log_count = sum(1 for e in self.events if e.get("kind") == "log")
        if log_count >= MAX_LOG_EVENTS_PER_RECORD:
            return
        self.events.append(
            {
                "time": _now(),
                "kind": "log",
                "text": scrub(text),
                "level": level or "info",
            }
        )

    def record_http(self, phase: str, meta: dict[str, Any]) -> None:
        if len(self.events) >= MAX_EVENTS_PER_RECORD:
            return
        self.events.append(
            {
                "time": _now(),
                "kind": "http",
                "phase": phase,
                "attempt": meta.get("attempt"),
                "method": meta.get("method"),
                "path": meta.get("path"),
                "url": meta.get("url"),
                "http_status": meta.get("http_status"),
                "request": _scrub_json(meta.get("request")),
                "response": _scrub_json(meta.get("response")),
                "error": scrub(str(meta.get("error") or "")) or None,
                "retrying": bool(meta.get("retrying")),
            }
        )

    def record_plan_verify(self, phase: str, *, tier: str = "", error: str = "") -> None:
        if len(self.events) >= MAX_EVENTS_PER_RECORD:
            return
        self.events.append(
            {
                "time": _now(),
                "kind": "plan_verify",
                "phase": phase,
                "tier": tier,
                "error": scrub(error) or None,
            }
        )

    def finish(self, outcome: str, summary: str = "", **extra: Any) -> dict:
        if self.finished_at:
            existing = activation_audit_service.get(self.id)
            if existing:
                return existing
        self.outcome = outcome
        self.summary = scrub(summary)
        self.finished_at = _now()
        for key in ("cdk", "cdk_type", "cdk_consumed"):
            if key in extra:
                setattr(self, key, extra[key])
        return activation_audit_service.save(self.to_record())

    def to_record(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "email": self.email,
            "access_token": self.access_token,
            "job_id": self.job_id,
            "source": self.source,
            "outcome": self.outcome,
            "summary": self.summary,
            "cdk": self.cdk,
            "cdk_type": self.cdk_type,
            "cdk_consumed": bool(self.cdk_consumed),
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "event_count": len(self.events),
            "events": list(self.events),
        }


class ActivationAuditService:
    def __init__(self) -> None:
        self._storage = ActivationAuditStorage()
        self._lock = threading.RLock()
        self._items: dict[str, dict] = self._load()

    def _load(self) -> dict[str, dict]:
        items = self._storage.load()
        if items is None:
            self._storage.save([])
            return {}
        result: dict[str, dict] = {}
        for item in items or []:
            normalized = self._normalize(item)
            if normalized:
                result[normalized["id"]] = normalized
        return result

    def _save(self) -> None:
        ordered = sorted(
            self._items.values(),
            key=lambda x: str(x.get("started_at") or ""),
            reverse=True,
        )
        if len(ordered) > MAX_RECORDS:
            ordered = ordered[:MAX_RECORDS]
            self._items = {item["id"]: item for item in ordered}
        self._storage.save(ordered)

    @staticmethod
    def _normalize(item: dict) -> dict | None:
        if not isinstance(item, dict):
            return None
        audit_id = str(item.get("id") or "").strip()
        if not audit_id:
            return None
        events = item.get("events")
        if not isinstance(events, list):
            events = []
        return {
            "id": audit_id,
            "email": str(item.get("email") or "").strip(),
            "access_token": str(item.get("access_token") or "").strip(),
            "job_id": item.get("job_id"),
            "source": str(item.get("source") or "batch"),
            "outcome": str(item.get("outcome") or OUTCOME_RUNNING),
            "summary": str(item.get("summary") or "").strip(),
            "cdk": item.get("cdk"),
            "cdk_type": item.get("cdk_type"),
            "cdk_consumed": bool(item.get("cdk_consumed")),
            "started_at": item.get("started_at") or _now(),
            "finished_at": item.get("finished_at"),
            "event_count": int(item.get("event_count") or len(events)),
            "events": events[:MAX_EVENTS_PER_RECORD],
        }

    @staticmethod
    def _summary_row(item: dict, *, attempt_count: int = 1) -> dict:
        return {
            "id": item.get("id"),
            "email": item.get("email"),
            "access_token": item.get("access_token"),
            "job_id": item.get("job_id"),
            "source": item.get("source"),
            "outcome": item.get("outcome"),
            "summary": item.get("summary"),
            "cdk": item.get("cdk"),
            "cdk_type": item.get("cdk_type"),
            "cdk_consumed": item.get("cdk_consumed"),
            "started_at": item.get("started_at"),
            "finished_at": item.get("finished_at"),
            "event_count": item.get("event_count"),
            "attempt_count": max(1, int(attempt_count or 1)),
        }

    @staticmethod
    def _attempt_counts(items: list[dict]) -> dict[str, int]:
        counts: dict[str, int] = {}
        for item in items:
            email = _norm_email(str(item.get("email") or ""))
            if email:
                counts[email] = counts.get(email, 0) + 1
        return counts

    @staticmethod
    def _latest_per_email(items: list[dict]) -> list[dict]:
        """每个邮箱只保留 started_at 最新的一条（列表展示用）。"""
        by_email: dict[str, dict] = {}
        orphans: list[dict] = []
        ordered = sorted(items, key=lambda x: str(x.get("started_at") or ""), reverse=True)
        for item in ordered:
            email = _norm_email(str(item.get("email") or ""))
            if not email:
                orphans.append(item)
                continue
            if email not in by_email:
                by_email[email] = item
        result = list(by_email.values()) + orphans
        result.sort(key=lambda x: str(x.get("started_at") or ""), reverse=True)
        return result

    def save(self, record: dict) -> dict:
        normalized = self._normalize(record)
        if normalized is None:
            raise ValueError("invalid activation audit record")
        with self._lock:
            self._items[normalized["id"]] = normalized
            self._save()
            return dict(normalized)

    def get(self, audit_id: str) -> dict | None:
        with self._lock:
            item = self._items.get(str(audit_id or "").strip())
            return dict(item) if item else None

    def latest_for_account(self, *, access_token: str = "", email: str = "") -> dict | None:
        token = str(access_token or "").strip()
        norm_email = _norm_email(email)
        with self._lock:
            candidates = [
                item for item in self._items.values()
                if (token and str(item.get("access_token") or "") == token)
                or (norm_email and _norm_email(str(item.get("email") or "")) == norm_email)
            ]
        if not candidates:
            return None
        candidates.sort(key=lambda x: str(x.get("started_at") or ""), reverse=True)
        return dict(candidates[0])

    def list_items(
        self,
        *,
        q: str | None = None,
        outcome: str | None = None,
        abnormal_only: bool = False,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        keyword = str(q or "").strip().lower()
        outcome_filter = str(outcome or "").strip().lower() or None
        with self._lock:
            all_items = list(self._items.values())
        attempt_counts = self._attempt_counts(all_items)
        items = self._latest_per_email(all_items)
        filtered: list[dict] = []
        for item in items:
            if abnormal_only and item.get("outcome") not in ABNORMAL_OUTCOMES:
                continue
            if outcome_filter and str(item.get("outcome") or "") != outcome_filter:
                continue
            if keyword:
                hay = " ".join(
                    str(item.get(k) or "")
                    for k in ("email", "summary", "cdk", "id", "job_id")
                ).lower()
                if keyword not in hay:
                    continue
            email = _norm_email(str(item.get("email") or ""))
            count = attempt_counts.get(email, 1) if email else 1
            filtered.append(self._summary_row(item, attempt_count=count))
        total = len(filtered)
        start = max(0, (max(1, page) - 1) * max(1, page_size))
        end = start + max(1, page_size)
        return {
            "items": filtered[start:end],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    def stats(self) -> dict:
        with self._lock:
            all_items = list(self._items.values())
        latest = self._latest_per_email(all_items)
        return {
            "total": len(all_items),
            "accounts": len(latest),
            "failed": sum(1 for i in latest if i.get("outcome") == OUTCOME_FAILED),
            "review": sum(1 for i in latest if i.get("outcome") == OUTCOME_REVIEW),
            "success": sum(1 for i in latest if i.get("outcome") == OUTCOME_SUCCESS),
        }


activation_audit_service = ActivationAuditService()
