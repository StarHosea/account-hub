#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未找到 docker，请先安装 Docker Desktop 或 docker CLI" >&2
  exit 1
fi

COMPOSE_FILE="docker-compose.postgres.yml"
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose -f "$COMPOSE_FILE")
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose -f "$COMPOSE_FILE")
else
  echo "错误：未找到 docker compose / docker-compose" >&2
  exit 1
fi

echo "[postgres] 启动本地 PostgreSQL 容器..."
"${DC[@]}" up -d

echo "[postgres] 等待健康检查..."
for _ in $(seq 1 30); do
  if "${DC[@]}" exec -T postgres pg_isready -U account_hub -d account_hub >/dev/null 2>&1; then
    echo "[postgres] 就绪"
    echo
    echo "连接串（复制到运行环境）："
    echo "  DATABASE_URL=postgresql://account_hub:account_hub@127.0.0.1:5433/account_hub"
    exit 0
  fi
  sleep 1
done

echo "错误：PostgreSQL 启动超时，请检查 docker compose -f $COMPOSE_FILE logs postgres" >&2
exit 1
