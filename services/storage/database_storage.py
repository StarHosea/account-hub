from __future__ import annotations

import json
from typing import Any

from sqlalchemy import Column, String, Text, create_engine, Integer, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

from services.storage.base import PLATFORM_CONFIG_STATE_KEY, StorageBackend

Base = declarative_base()


class AccountModel(Base):
    """账号数据模型"""
    __tablename__ = "accounts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    access_token = Column(Text, unique=True, nullable=False, index=True)
    data = Column(Text, nullable=False)  # JSON 格式存储完整账号数据


class AuthKeyModel(Base):
    """鉴权密钥数据模型"""
    __tablename__ = "auth_keys"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key_id = Column(String(255), unique=True, nullable=False, index=True)
    data = Column(Text, nullable=False)


class SettingModel(Base):
    """平台配置数据模型（单行 JSON 列存储平台设置）"""
    __tablename__ = "settings"

    key = Column(String(255), primary_key=True)
    data = Column(Text, nullable=False)  # JSON 格式存储完整配置


class CdkModel(Base):
    """CDK 池数据模型"""
    __tablename__ = "cdks"

    cdk = Column(String(512), primary_key=True)
    data = Column(Text, nullable=False)  # JSON 格式存储完整 CDK 记录


class MailboxModel(Base):
    """邮箱池数据模型"""
    __tablename__ = "mailboxes"

    email = Column(String(512), primary_key=True)
    data = Column(Text, nullable=False)


class PhoneModel(Base):
    """手机号池数据模型"""
    __tablename__ = "phones"

    phone = Column(String(255), primary_key=True)
    data = Column(Text, nullable=False)


class RegisterAbnormalModel(Base):
    """注册异常账号清单"""
    __tablename__ = "register_abnormal"

    email = Column(String(512), primary_key=True)
    data = Column(Text, nullable=False)


class StateModel(Base):
    """命名状态块数据模型（register / activation / run / 种子标志等，单键 JSON）"""
    __tablename__ = "task_state"

    key = Column(String(255), primary_key=True)
    data = Column(Text, nullable=False)


# 平台配置在 settings 表中的固定主键
SETTINGS_ROW_KEY = "config"

# 命名集合 → (模型, 主键字段名) 映射
_COLLECTION_MODELS: dict[str, tuple[type, str]] = {
    "cdks": (CdkModel, "cdk"),
    "mailboxes": (MailboxModel, "email"),
    "phones": (PhoneModel, "phone"),
    "register_abnormal": (RegisterAbnormalModel, "email"),
}


class DatabaseStorageBackend(StorageBackend):
    """数据库存储后端（PostgreSQL）"""

    def __init__(self, database_url: str):
        self.database_url = database_url
        self.engine = create_engine(
            database_url,
            pool_pre_ping=True,  # 自动检测连接是否有效
            pool_recycle=3600,   # 1小时回收连接
        )
        Base.metadata.create_all(self.engine)
        self._upgrade_schema()
        self.Session = sessionmaker(bind=self.engine)

    def _upgrade_schema(self) -> None:
        """兼容旧库：access_token 列扩为 TEXT（JWT 可超 2048）。"""
        if "postgresql" not in self.database_url and "postgres" not in self.database_url:
            return
        try:
            with self.engine.begin() as conn:
                conn.execute(text("ALTER TABLE accounts ALTER COLUMN access_token TYPE TEXT"))
        except Exception:
            pass

    def load_accounts(self) -> list[dict[str, Any]]:
        """从数据库加载账号数据"""
        session = self.Session()
        try:
            accounts = []
            for row in session.query(AccountModel).all():
                try:
                    account_data = json.loads(row.data)
                    if isinstance(account_data, dict):
                        accounts.append(account_data)
                except json.JSONDecodeError:
                    continue
            return accounts
        finally:
            session.close()

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        """保存账号数据到数据库"""
        self._save_rows(AccountModel, accounts, "access_token")

    def load_auth_keys(self) -> list[dict[str, Any]]:
        """从数据库加载鉴权密钥数据"""
        return self._load_rows(AuthKeyModel)

    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        """保存鉴权密钥数据到数据库"""
        self._save_rows(AuthKeyModel, auth_keys, "id", "key_id")

    def load_state(self, key: str) -> dict[str, Any] | None:
        """加载命名状态块（无记录返回 None）。平台配置走 settings 表。"""
        if key == PLATFORM_CONFIG_STATE_KEY:
            return self._load_platform_config()
        data = self._get_state_raw(key)
        return data if isinstance(data, dict) else None

    def save_state(self, key: str, data: dict[str, Any]) -> None:
        """保存命名状态块（单键 upsert）。平台配置走 settings 表。"""
        if key == PLATFORM_CONFIG_STATE_KEY:
            self._save_platform_config(data)
            return
        self._set_state_raw(key, data or {})

    def _load_platform_config(self) -> dict[str, Any] | None:
        session = self.Session()
        try:
            row = session.get(SettingModel, SETTINGS_ROW_KEY)
            if row is None:
                return None
            try:
                data = json.loads(row.data)
            except json.JSONDecodeError:
                return None
            return data if isinstance(data, dict) else None
        finally:
            session.close()

    def _save_platform_config(self, settings: dict[str, Any]) -> None:
        session = self.Session()
        try:
            payload = json.dumps(settings or {}, ensure_ascii=False)
            row = session.get(SettingModel, SETTINGS_ROW_KEY)
            if row is None:
                session.add(SettingModel(key=SETTINGS_ROW_KEY, data=payload))
            else:
                row.data = payload
            session.commit()
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()

    # ----------------------------- 命名集合（cdks/mailboxes/phones/register_abnormal） ----------------------------- #

    def load_collection(self, name: str) -> list[dict[str, Any]] | None:
        """加载命名集合。空表且未打过种子标志 → 返回 None；否则返回列表。"""
        try:
            model, _ = self._collection_model(name)
        except ValueError:
            return None  # 未注册 collection：视为暂无此表，触发初始化而非崩溃
        rows = self._load_rows(model)
        if rows:
            return rows
        # 表为空：区分「从未种子」与「用户删空」
        if self._get_state_raw(self._seeded_key(name)) is None:
            return None
        return []

    def save_collection(self, name: str, items: list[dict[str, Any]]) -> None:
        """整表覆盖写命名集合，并打上种子标志。"""
        try:
            model, key_field = self._collection_model(name)
        except ValueError:
            return  # 未注册 collection：暂不持久化
        self._save_rows(model, items, key_field)
        self._set_state_raw(self._seeded_key(name), {"seeded": True})

    @staticmethod
    def _collection_model(name: str) -> tuple[type, str]:
        if name not in _COLLECTION_MODELS:
            raise ValueError(f"Unknown collection: {name}")
        return _COLLECTION_MODELS[name]

    @staticmethod
    def _seeded_key(name: str) -> str:
        return f"__seeded__:{name}"

    def _get_state_raw(self, key: str) -> Any:
        session = self.Session()
        try:
            row = session.get(StateModel, key)
            if row is None:
                return None
            try:
                return json.loads(row.data)
            except json.JSONDecodeError:
                return None
        finally:
            session.close()

    def _set_state_raw(self, key: str, value: Any) -> None:
        session = self.Session()
        try:
            payload = json.dumps(value, ensure_ascii=False)
            row = session.get(StateModel, key)
            if row is None:
                session.add(StateModel(key=key, data=payload))
            else:
                row.data = payload
            session.commit()
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()

    def _load_rows(self, model: type[AccountModel] | type[AuthKeyModel]) -> list[dict[str, Any]]:
        session = self.Session()
        try:
            items = []
            for row in session.query(model).all():
                try:
                    item_data = json.loads(row.data)
                    if isinstance(item_data, dict):
                        items.append(item_data)
                except json.JSONDecodeError:
                    continue
            return items
        finally:
            session.close()

    def _save_rows(
        self,
        model: type[AccountModel] | type[AuthKeyModel],
        items: list[dict[str, Any]],
        source_key: str,
        target_key: str | None = None,
    ) -> None:
        session = self.Session()
        try:
            session.query(model).delete()
            for item in items:
                if not isinstance(item, dict):
                    continue
                key_value = str(item.get(source_key) or "").strip()
                if not key_value:
                    continue
                session.add(
                    model(
                        **{target_key or source_key: key_value},
                        data=json.dumps(item, ensure_ascii=False),
                    )
                )
            session.commit()
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()

    def health_check(self) -> dict[str, Any]:
        """健康检查"""
        try:
            session = self.Session()
            try:
                # 尝试执行简单查询
                session.execute(text("SELECT 1"))
                count = session.query(AccountModel).count()
                auth_key_count = session.query(AuthKeyModel).count()
                return {
                    "status": "healthy",
                    "backend": "database",
                    "database_url": self._mask_password(self.database_url),
                    "account_count": count,
                    "auth_key_count": auth_key_count,
                }
            finally:
                session.close()
        except Exception as e:
            return {
                "status": "unhealthy",
                "backend": "database",
                "error": str(e),
            }

    def get_backend_info(self) -> dict[str, Any]:
        """获取存储后端信息"""
        return {
            "type": "postgresql",
            "db_type": "postgresql",
            "description": "PostgreSQL 数据库存储",
            "database_url": self._mask_password(self.database_url),
        }

    @staticmethod
    def _mask_password(url: str) -> str:
        """隐藏数据库连接字符串中的密码"""
        if "://" not in url:
            return url
        try:
            protocol, rest = url.split("://", 1)
            if "@" in rest:
                credentials, host = rest.split("@", 1)
                if ":" in credentials:
                    username, _ = credentials.split(":", 1)
                    return f"{protocol}://{username}:****@{host}"
            return url
        except Exception:
            return url
