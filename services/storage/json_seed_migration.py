from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from services.storage.base import PLATFORM_CONFIG_STATE_KEY, StorageBackend
from services.storage.database_storage import DatabaseStorageBackend

# 命名集合：data/{name}.json
_COLLECTION_FILES = ("cdks", "mailboxes", "phones", "register_abnormal")

# 命名状态：data/{key}.json
_STATE_FILES = (
    "register",
    "activation",
    "run",
    "cumulative_total",
    "backup_state",
    PLATFORM_CONFIG_STATE_KEY,
)

_MARKER = "__json_seed_migrated__"


def _read_json_list(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if isinstance(raw, dict):
        raw = raw.get("items")
    return raw if isinstance(raw, list) else []


def _read_json_object(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return raw if isinstance(raw, dict) else None


def _read_auth_keys(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if isinstance(raw, dict):
        raw = raw.get("items")
    return raw if isinstance(raw, list) else []


def maybe_migrate_json_seeds(backend: StorageBackend, data_dir: Path) -> None:
    """数据库后端首次启动：从 data/*.json 一次性导入种子数据。"""
    if not isinstance(backend, DatabaseStorageBackend):
        return
    if backend.load_state(_MARKER) is not None:
        return

    migrated: list[str] = []

    accounts_path = data_dir / "accounts.json"
    if not backend.load_accounts() and accounts_path.exists():
        items = _read_json_list(accounts_path)
        if items:
            backend.save_accounts(items)
            migrated.append(f"accounts({len(items)})")

    auth_path = data_dir / "auth_keys.json"
    if not backend.load_auth_keys() and auth_path.exists():
        items = _read_auth_keys(auth_path)
        if items:
            backend.save_auth_keys(items)
            migrated.append(f"auth_keys({len(items)})")

    for name in _COLLECTION_FILES:
        if backend.load_collection(name) is not None:
            continue
        path = data_dir / f"{name}.json"
        if not path.exists():
            continue
        items = _read_json_list(path)
        if items:
            backend.save_collection(name, items)
            migrated.append(f"{name}({len(items)})")

    for key in _STATE_FILES:
        if backend.load_state(key) is not None:
            continue
        path = data_dir / f"{key}.json"
        data = _read_json_object(path)
        if data is not None:
            backend.save_state(key, data)
            migrated.append(key)

    backend.save_state(_MARKER, {"migrated_at": migrated or [], "done": True})
    if migrated:
        print(f"[storage] JSON seed migration into PostgreSQL: {', '.join(migrated)}")
