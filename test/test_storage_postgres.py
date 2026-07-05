import os
import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine, text

from services.storage.database_storage import DatabaseStorageBackend
from services.storage.db_url import resolve_database_url
from services.storage.json_seed_migration import maybe_migrate_json_seeds
from services.storage.operation_log_storage import OperationLogStorage


def _postgres_available() -> bool:
    url = os.getenv("TEST_DATABASE_URL") or resolve_database_url()
    try:
        engine = create_engine(url, pool_pre_ping=True)
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


@unittest.skipUnless(_postgres_available(), "PostgreSQL not available (run scripts/postgres_up.sh)")
class StoragePostgresTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self.url = os.getenv("TEST_DATABASE_URL") or resolve_database_url(self.data_dir)
        engine = create_engine(self.url)
        with engine.begin() as conn:
            for table in (
                "operation_log_state",
                "operation_logs",
                "register_abnormal",
                "task_state",
                "accounts",
                "auth_keys",
                "settings",
                "cdks",
                "mailboxes",
                "phones",
            ):
                conn.execute(text(f"DROP TABLE IF EXISTS {table} CASCADE"))
        self.backend = DatabaseStorageBackend(self.url)

    def test_register_abnormal_collection_roundtrip(self) -> None:
        items = [{"email": "bad@example.com", "reason": "timeout", "fetch_url": "http://x"}]
        self.backend.save_collection("register_abnormal", items)
        loaded = self.backend.load_collection("register_abnormal")
        self.assertEqual(len(loaded or []), 1)
        self.assertEqual(loaded[0]["email"], "bad@example.com")

    def test_json_seed_migration_accounts(self) -> None:
        path = self.data_dir / "accounts.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            '[{"access_token": "tok1", "email": "a@x.com"}]',
            encoding="utf-8",
        )
        maybe_migrate_json_seeds(self.backend, self.data_dir)
        accounts = self.backend.load_accounts()
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["access_token"], "tok1")

    def test_operation_logs_add_and_list(self) -> None:
        storage = OperationLogStorage(self.url)
        storage.add({
            "id": "log1",
            "time": "2026-07-06 00:00:00",
            "type": "account",
            "summary": "test",
            "detail": {"n": 1},
        })
        items = storage.list(type="account", limit=10)
        matched = [i for i in items if i.get("id") == "log1"]
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]["summary"], "test")


if __name__ == "__main__":
    unittest.main()
