from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote_plus

# 与 docker-compose.postgres.yml 默认值一致
DEFAULT_POSTGRES_USER = "account_hub"
DEFAULT_POSTGRES_PASSWORD = "account_hub"
DEFAULT_POSTGRES_HOST = "127.0.0.1"
DEFAULT_POSTGRES_PORT = "5433"
DEFAULT_POSTGRES_DB = "account_hub"


def _build_postgres_url(
    *,
    user: str,
    password: str,
    host: str,
    port: str,
    database: str,
) -> str:
    user_q = quote_plus(user)
    password_q = quote_plus(password)
    return f"postgresql://{user_q}:{password_q}@{host}:{port}/{database}"


def resolve_database_url(data_dir: Path | None = None) -> str:
    """解析主库 PostgreSQL URL。

    优先级：
    1. DATABASE_URL
    2. POSTGRES_* 分项环境变量
    3. 本地 Docker 默认（docker-compose.postgres.yml）
    """
    _ = data_dir  # 保留参数以兼容既有调用方
    explicit = os.getenv("DATABASE_URL", "").strip()
    if explicit:
        return explicit

    user = os.getenv("POSTGRES_USER", DEFAULT_POSTGRES_USER).strip() or DEFAULT_POSTGRES_USER
    password = os.getenv("POSTGRES_PASSWORD", DEFAULT_POSTGRES_PASSWORD).strip() or DEFAULT_POSTGRES_PASSWORD
    host = os.getenv("POSTGRES_HOST", DEFAULT_POSTGRES_HOST).strip() or DEFAULT_POSTGRES_HOST
    port = os.getenv("POSTGRES_PORT", DEFAULT_POSTGRES_PORT).strip() or DEFAULT_POSTGRES_PORT
    database = os.getenv("POSTGRES_DB", DEFAULT_POSTGRES_DB).strip() or DEFAULT_POSTGRES_DB
    return _build_postgres_url(user=user, password=password, host=host, port=port, database=database)


def mask_database_url(url: str) -> str:
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
