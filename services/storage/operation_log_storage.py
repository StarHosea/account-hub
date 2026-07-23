from __future__ import annotations

import json
import os
from typing import Any

from sqlalchemy import Column, String, Text, create_engine, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

from services.config import DATA_DIR
from services.storage.db_url import resolve_database_url

LogBase = declarative_base()


class OperationLogRow(LogBase):
    __tablename__ = "operation_logs"

    id = Column(String(64), primary_key=True)
    time = Column(String(32), nullable=False, index=True)
    type = Column(String(32), nullable=False, index=True)
    summary = Column(Text, nullable=False, default="")
    data = Column(Text, nullable=False)


class OperationLogStorage:
    """账号操作日志：PostgreSQL 持久化。"""

    _SEEDED_KEY = "__seeded__:operation_logs"

    def __init__(self, database_url: str | None = None) -> None:
        url = (database_url or os.getenv("DATABASE_URL") or resolve_database_url(DATA_DIR)).strip()
        self.database_url = url
        self.engine = create_engine(url, pool_pre_ping=True, pool_recycle=3600)
        LogBase.metadata.create_all(self.engine)
        self._Session = sessionmaker(bind=self.engine)
        self._ensure_state_table()

    def _ensure_state_table(self) -> None:
        with self.engine.begin() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE IF NOT EXISTS operation_log_state ("
                "key TEXT PRIMARY KEY, data TEXT NOT NULL)"
            )

    def _is_seeded(self) -> bool:
        with self.engine.connect() as conn:
            row = conn.execute(
                text("SELECT data FROM operation_log_state WHERE key = :key"),
                {"key": self._SEEDED_KEY},
            ).fetchone()
        if not row:
            return False
        try:
            return bool(json.loads(row[0]).get("seeded"))
        except Exception:
            return False

    def _mark_seeded(self) -> None:
        payload = json.dumps({"seeded": True}, ensure_ascii=False)
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO operation_log_state(key, data) VALUES (:key, :data) "
                    "ON CONFLICT(key) DO UPDATE SET data = excluded.data"
                ),
                {"key": self._SEEDED_KEY, "data": payload},
            )

    @staticmethod
    def _parse_line(raw_line: str, line_number: int) -> dict[str, Any] | None:
        import hashlib

        try:
            item = json.loads(raw_line)
        except Exception:
            return None
        if not isinstance(item, dict):
            return None
        parsed = dict(item)
        if not parsed.get("id"):
            payload = f"{line_number}:{raw_line}".encode("utf-8", errors="ignore")
            parsed["id"] = hashlib.sha1(payload).hexdigest()[:24]
        return parsed

    @staticmethod
    def _row_from_item(item: dict[str, Any]) -> OperationLogRow:
        detail = item.get("detail")
        if not isinstance(detail, dict):
            detail = {k: v for k, v in item.items() if k not in {"id", "time", "type", "summary"}}
        return OperationLogRow(
            id=str(item.get("id") or ""),
            time=str(item.get("time") or ""),
            type=str(item.get("type") or ""),
            summary=str(item.get("summary") or ""),
            data=json.dumps(detail or {}, ensure_ascii=False),
        )

    def add(self, item: dict[str, Any]) -> None:
        session = self._Session()
        try:
            session.merge(self._row_from_item(item))
            session.commit()
            self._mark_seeded()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def list(
        self,
        *,
        type: str = "",
        start_date: str = "",
        end_date: str = "",
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        session = self._Session()
        try:
            query = session.query(OperationLogRow).order_by(OperationLogRow.time.desc())
            if type:
                query = query.filter(OperationLogRow.type == type)
            rows = query.limit(max(limit * 5, limit)).all()
            items: list[dict[str, Any]] = []
            for row in rows:
                item = self._item_from_row(row)
                if not self._matches_filters(item, type=type, start_date=start_date, end_date=end_date):
                    continue
                items.append(item)
                if len(items) >= limit:
                    break
            return items
        finally:
            session.close()

    def delete(self, ids: list[str]) -> dict[str, int]:
        target_ids = {str(item or "").strip() for item in ids if str(item or "").strip()}
        if not target_ids:
            return {"removed": 0}
        session = self._Session()
        try:
            removed = (
                session.query(OperationLogRow)
                .filter(OperationLogRow.id.in_(target_ids))
                .delete(synchronize_session=False)
            )
            session.commit()
            return {"removed": int(removed)}
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def clear(self) -> dict[str, int]:
        session = self._Session()
        try:
            removed = session.query(OperationLogRow).delete(synchronize_session=False)
            session.commit()
            return {"removed": int(removed)}
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    @staticmethod
    def _item_from_row(row: OperationLogRow) -> dict[str, Any]:
        try:
            detail = json.loads(row.data)
        except Exception:
            detail = {}
        if not isinstance(detail, dict):
            detail = {}
        return {
            "id": row.id,
            "time": row.time,
            "type": row.type,
            "summary": row.summary,
            "detail": detail,
        }

    @staticmethod
    def _matches_filters(
        item: dict[str, Any],
        *,
        type: str = "",
        start_date: str = "",
        end_date: str = "",
    ) -> bool:
        t = str(item.get("time") or "")
        day = t[:10]
        if type and item.get("type") != type:
            return False
        if start_date and day < start_date:
            return False
        if end_date and day > end_date:
            return False
        return True
