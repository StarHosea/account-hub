from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class StorageBackend(ABC):
    """抽象存储后端基类"""

    @abstractmethod
    def load_accounts(self) -> list[dict[str, Any]]:
        """加载所有账号数据"""
        pass

    @abstractmethod
    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        """保存所有账号数据"""
        pass

    @abstractmethod
    def load_auth_keys(self) -> list[dict[str, Any]]:
        """加载所有鉴权密钥数据"""
        pass

    @abstractmethod
    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        """保存所有鉴权密钥数据"""
        pass

    @abstractmethod
    def load_settings(self) -> dict[str, Any] | None:
        """加载平台配置（config.json 的内容）。

        返回 None 表示后端尚无配置（首次启动），调用方需从 config.json 迁移种子数据。
        """
        pass

    @abstractmethod
    def save_settings(self, settings: dict[str, Any]) -> None:
        """持久化平台配置。"""
        pass

    @abstractmethod
    def load_collection(self, name: str) -> list[dict[str, Any]] | None:
        """加载一个命名集合（cdks / mailboxes / phones 等）。

        返回 None 表示后端从未写过该集合（首次启动），调用方需从旧 data/*.json 迁移种子数据；
        返回 [] 表示后端已存在但为空（例如用户删空），不应再触发种子迁移。
        """
        pass

    @abstractmethod
    def save_collection(self, name: str, items: list[dict[str, Any]]) -> None:
        """持久化一个命名集合（整体覆盖写）。"""
        pass

    @abstractmethod
    def load_state(self, key: str) -> dict[str, Any] | None:
        """加载一个命名状态块（register / activation / run / cumulative_total / backup_state 等）。

        返回 None 表示后端从未写过该键，调用方需用默认值初始化或从旧文件迁移。
        """
        pass

    @abstractmethod
    def save_state(self, key: str, data: dict[str, Any]) -> None:
        """持久化一个命名状态块（单键覆盖写）。"""
        pass

    @abstractmethod
    def health_check(self) -> dict[str, Any]:
        """健康检查，返回存储后端状态"""
        pass

    @abstractmethod
    def get_backend_info(self) -> dict[str, Any]:
        """获取存储后端信息"""
        pass
