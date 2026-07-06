from __future__ import annotations

from pathlib import Path

from services.storage.base import StorageBackend
from services.storage.database_storage import DatabaseStorageBackend
from services.storage.db_url import mask_database_url, resolve_database_url


def create_storage_backend(data_dir: Path) -> StorageBackend:
    """创建 PostgreSQL 存储后端（唯一支持的后端）。"""
    _ = data_dir  # 保留参数以兼容既有调用方
    database_url = resolve_database_url(data_dir)
    lowered = database_url.lower()
    if "postgres" not in lowered:
        raise ValueError(
            "仅支持 PostgreSQL 存储。"
            f" 当前 DATABASE_URL={mask_database_url(database_url)}。"
            " 本地请先运行: bash scripts/postgres_up.sh"
        )
    print(f"[storage] Using PostgreSQL storage: {mask_database_url(database_url)}")
    return DatabaseStorageBackend(database_url)
