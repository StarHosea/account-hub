#!/usr/bin/env python3
"""
PostgreSQL 存储后端测试脚本

用法：
  bash scripts/postgres_up.sh
  python scripts/test_storage.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

DATA_DIR = Path(__file__).resolve().parents[1] / "data"

from services.storage.db_url import mask_database_url, resolve_database_url
from services.storage.factory import create_storage_backend


def test_storage():
    """测试 PostgreSQL 存储后端"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    database_url = resolve_database_url(DATA_DIR)
    print("=" * 60)
    print("Account Hub 存储后端测试")
    print("=" * 60)
    print(f"\n存储后端: PostgreSQL")
    print(f"数据库连接: {mask_database_url(database_url)}")
    print("\n" + "=" * 60)

    try:
        print("\n[1/5] 创建存储后端...")
        storage = create_storage_backend(DATA_DIR)
        print("✅ 存储后端创建成功")

        print("\n[2/5] 获取后端信息...")
        info = storage.get_backend_info()
        print(f"✅ 后端类型: {info.get('type')}")
        print(f"   描述: {info.get('description')}")
        for key, value in info.items():
            if key not in ("type", "description"):
                print(f"   {key}: {value}")

        print("\n[3/5] 执行健康检查...")
        health = storage.health_check()
        status = health.get("status")
        if status == "healthy":
            print(f"✅ 健康状态: {status}")
        else:
            print(f"❌ 健康状态: {status}")
            print(f"   错误: {health.get('error')}")
            return False

        print("\n[4/5] 读取账号数据...")
        accounts = storage.load_accounts()
        print(f"✅ 成功读取 {len(accounts)} 个账号")

        print("\n[5/5] 测试写入功能...")
        import os

        test_account = {
            "access_token": "test_token_" + str(os.getpid()),
            "type": "Free",
            "status": "测试",
            "quota": 0,
            "email": "test@example.com",
        }
        test_accounts = accounts + [test_account]
        storage.save_accounts(test_accounts)
        print("✅ 写入测试账号成功")

        reloaded = storage.load_accounts()
        if len(reloaded) == len(test_accounts):
            print("✅ 验证写入成功")
        else:
            print(f"❌ 验证失败: 期望 {len(test_accounts)} 个账号，实际 {len(reloaded)} 个")
            return False

        storage.save_accounts(accounts)
        print("✅ 恢复原始数据")

        print("\n" + "=" * 60)
        print("✅ 所有测试通过！")
        print("=" * 60)
        return True

    except Exception as e:
        print(f"\n❌ 测试失败: {e}")
        import traceback

        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = test_storage()
    sys.exit(0 if success else 1)
