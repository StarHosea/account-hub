from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from sqlalchemy import Column, String, Text, create_engine, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

from services.config import DATA_DIR
from services.storage.db_url import resolve_database_url

AuditBase = declarative_base()


class ActivationAuditRow(AuditBase):
    """激活审计专用表（与账号主库同 PostgreSQL 实例）。"""

    __tablename__ = "activation_audit"

    id = Column(String(64), primary_key=True)
    data = Column(Text, nullable=False)


class ActivationAuditStorage:
    """激活审计持久化：始终使用 PostgreSQL。

    优先级：
    1. ACTIVATION_AUDIT_DATABASE_URL
    2. DATABASE_URL / POSTGRES_* / 本地 Docker 默认（与主库共用）
  """

    _SEEDED_KEY = "__seeded__:activation_audit"
    _LEGACY_SQLITE_PATH = DATA_DIR / "activation_audit.db"

    def __init__(self, database_url: str | None = None) -> None:
        url = (
            database_url
            or os.getenv("ACTIVATION_AUDIT_DATABASE_URL")
            or resolve_database_url(DATA_DIR)
        ).strip()
        self.database_url = url
        self.engine = create_engine(url, pool_pre_ping=True, pool_recycle=3600)
        AuditBase.metadata.create_all(self.engine)
        self._Session = sessionmaker(bind=self.engine)
        self._ensure_state_table()

    def _ensure_state_table(self) -> None:
        with self.engine.begin() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE IF NOT EXISTS activation_audit_state ("
                "key TEXT PRIMARY KEY, data TEXT NOT NULL)"
            )

    def _get_seeded(self) -> bool:
        with self.engine.connect() as conn:
            row = conn.execute(
                text("SELECT data FROM activation_audit_state WHERE key = :key"),
                {"key": self._SEEDED_KEY},
            ).fetchone()
        if not row:
            return False
        try:
            payload = json.loads(row[0])
            return bool(payload.get("seeded"))
        except Exception:
            return False

    def _mark_seeded(self) -> None:
        payload = json.dumps({"seeded": True}, ensure_ascii=False)
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO activation_audit_state(key, data) VALUES (:key, :data) "
                    "ON CONFLICT(key) DO UPDATE SET data = excluded.data"
                ),
                {"key": self._SEEDED_KEY, "data": payload},
            )

    def load(self) -> list[dict[str, Any]] | None:
        session = self._Session()
        try:
            rows = session.query(ActivationAuditRow).all()
            if not rows:
                if not self._get_seeded():
                    return None
                return []
            items: list[dict[str, Any]] = []
            for row in rows:
                try:
                    item = json.loads(row.data)
                    if isinstance(item, dict):
                        items.append(item)
                except json.JSONDecodeError:
                    continue
            return items
        finally:
            session.close()

    def save(self, items: list[dict[str, Any]]) -> None:
        session = self._Session()
        try:
            session.query(ActivationAuditRow).delete()
            for item in items or []:
                audit_id = str(item.get("id") or "").strip()
                if not audit_id:
                    continue
                session.add(ActivationAuditRow(
                    id=audit_id,
                    data=json.dumps(item, ensure_ascii=False),
                ))
            session.commit()
            self._mark_seeded()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def migrate_from_json_file(self) -> list[dict[str, Any]] | None:
        """一次性从旧版 data/activation_audit.json 迁移。"""
        path = DATA_DIR / "activation_audit.json"
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if isinstance(raw, dict):
            raw = raw.get("items")
        if not isinstance(raw, list) or not raw:
            return None
        self.save(raw)
        backup = DATA_DIR / "activation_audit.json.migrated"
        try:
            path.rename(backup)
        except Exception:
            pass
        return raw

    def migrate_from_legacy_sqlite(self) -> list[dict[str, Any]] | None:
        """一次性从旧版独立 SQLite activation_audit.db 迁入当前 PostgreSQL。"""
        if not self._LEGACY_SQLITE_PATH.exists():
            return None
        if self.load() not in (None, []):
            return None
        legacy_url = f"sqlite:///{self._LEGACY_SQLITE_PATH}"
        try:
            legacy_engine = create_engine(legacy_url)
            with legacy_engine.connect() as conn:
                rows = conn.execute(text("SELECT id, data FROM activation_audit")).fetchall()
        except Exception:
            return None
        if not rows:
            return None
        items: list[dict[str, Any]] = []
        for row in rows:
            try:
                item = json.loads(row[1])
                if isinstance(item, dict):
                    items.append(item)
            except Exception:
                continue
        if not items:
            return None
        self.save(items)
        backup = DATA_DIR / "activation_audit.db.migrated"
        try:
            self._LEGACY_SQLITE_PATH.rename(backup)
        except Exception:
            pass
        print(f"[activation_audit] migrated {len(items)} records from legacy SQLite to PostgreSQL")
        return items
