#!/usr/bin/env python3
"""
存储后端数据迁移脚本

用法：
  python scripts/migrate_storage.py --from json --to postgres
  python scripts/migrate_storage.py --from postgres --to git
  python scripts/migrate_storage.py --export backup-dir/
  python scripts/migrate_storage.py --import backup-dir/

本地 PostgreSQL（无现成实例时）：
  bash scripts/postgres_up.sh
  export STORAGE_BACKEND=postgres
  export DATABASE_URL=postgresql://account_hub:account_hub@127.0.0.1:5432/account_hub
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

DATA_DIR = Path(__file__).resolve().parents[1] / "data"

from services.storage.base import PLATFORM_CONFIG_STATE_KEY
from services.storage.factory import create_storage_backend

_COLLECTION_NAMES = ("cdks", "mailboxes", "phones", "register_abnormal")
_STATE_KEYS = ("register", "activation", "run", "cumulative_total", "backup_state", PLATFORM_CONFIG_STATE_KEY)


def _dump_storage(storage, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "accounts.json").write_text(
        json.dumps(storage.load_accounts(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (out_dir / "auth_keys.json").write_text(
        json.dumps({"items": storage.load_auth_keys()}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    for name in _COLLECTION_NAMES:
        items = storage.load_collection(name)
        if items is None:
            items = []
        (out_dir / f"{name}.json").write_text(
            json.dumps({"items": items}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    for key in _STATE_KEYS:
        data = storage.load_state(key)
        if data is not None:
            (out_dir / f"{key}.json").write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
    print(f"[migrate] Exported snapshot to {out_dir}")


def _load_json_list(path: Path) -> list:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = raw.get("items")
    return raw if isinstance(raw, list) else []


def _import_dir(storage, in_dir: Path) -> None:
    accounts_path = in_dir / "accounts.json"
    if accounts_path.exists():
        accounts = json.loads(accounts_path.read_text(encoding="utf-8"))
        if isinstance(accounts, list):
            storage.save_accounts(accounts)
            print(f"[migrate] Imported {len(accounts)} accounts")

    auth_path = in_dir / "auth_keys.json"
    if auth_path.exists():
        storage.save_auth_keys(_load_json_list(auth_path))
        print("[migrate] Imported auth_keys")

    for name in _COLLECTION_NAMES:
        path = in_dir / f"{name}.json"
        if path.exists():
            items = _load_json_list(path)
            storage.save_collection(name, items)
            print(f"[migrate] Imported {name} ({len(items)})")

    for key in _STATE_KEYS:
        path = in_dir / f"{key}.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                storage.save_state(key, data)
                print(f"[migrate] Imported state {key}")


def _copy_storage(from_storage, to_storage) -> None:
    accounts = from_storage.load_accounts()
    to_storage.save_accounts(accounts)
    print(f"[migrate] accounts: {len(accounts)}")

    auth_keys = from_storage.load_auth_keys()
    to_storage.save_auth_keys(auth_keys)
    print(f"[migrate] auth_keys: {len(auth_keys)}")

    for name in _COLLECTION_NAMES:
        items = from_storage.load_collection(name)
        if items is None:
            continue
        to_storage.save_collection(name, items)
        print(f"[migrate] {name}: {len(items)}")

    for key in _STATE_KEYS:
        data = from_storage.load_state(key)
        if data is not None:
            to_storage.save_state(key, data)
            print(f"[migrate] state {key}")


def migrate_data(from_backend: str, to_backend: str) -> None:
    print(f"[migrate] Migrating from {from_backend} to {to_backend}")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    original_backend = os.environ.get("STORAGE_BACKEND")
    try:
        os.environ["STORAGE_BACKEND"] = from_backend
        from_storage = create_storage_backend(DATA_DIR)
        os.environ["STORAGE_BACKEND"] = to_backend
        to_storage = create_storage_backend(DATA_DIR)
        _copy_storage(from_storage, to_storage)
        print("[migrate] Migration completed successfully!")
    finally:
        if original_backend:
            os.environ["STORAGE_BACKEND"] = original_backend
        elif "STORAGE_BACKEND" in os.environ:
            del os.environ["STORAGE_BACKEND"]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="账号管理平台存储后端迁移工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  bash scripts/postgres_up.sh
  export DATABASE_URL=postgresql://account_hub:account_hub@127.0.0.1:5432/account_hub
  python scripts/migrate_storage.py --from json --to postgres

环境变量:
  STORAGE_BACKEND  - json | postgres | git（数据库后端使用 PostgreSQL）
  DATABASE_URL     - PostgreSQL 连接串
  POSTGRES_*       - 分项连接参数（见 services/storage/db_url.py）
        """,
    )
    parser.add_argument("--from", dest="from_backend", choices=["json", "sqlite", "postgres", "git"])
    parser.add_argument("--to", dest="to_backend", choices=["json", "sqlite", "postgres", "git"])
    parser.add_argument("--export", dest="export_dir", metavar="DIR", help="导出当前后端快照到目录")
    parser.add_argument("--import", dest="import_dir", metavar="DIR", help="从目录快照导入当前后端")

    args = parser.parse_args()
    if args.from_backend and args.to_backend:
        migrate_data(args.from_backend, args.to_backend)
    elif args.export_dir:
        storage = create_storage_backend(DATA_DIR)
        _dump_storage(storage, Path(args.export_dir))
    elif args.import_dir:
        storage = create_storage_backend(DATA_DIR)
        _import_dir(storage, Path(args.import_dir))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
