#!/usr/bin/env sh
# 生产镜像构建：可选将 cloakbrowser 升到 npm 最新，并打印最终版本。
# 由 Dockerfile 调用；本地/可复现构建可设 CLOAKBROWSER_UPDATE_LATEST=false。
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

UPDATE_LATEST="${CLOAKBROWSER_UPDATE_LATEST:-true}"
# 任意非空值即可打散 BuildKit 缓存层，CI 应传入 run_id / 时间戳。
CACHEBUST="${CLOAKBROWSER_CACHEBUST:-0}"

echo "[cloakbrowser] cachebust=${CACHEBUST} update_latest=${UPDATE_LATEST}"

if [ "$UPDATE_LATEST" = "true" ] || [ "$UPDATE_LATEST" = "1" ] || [ "$UPDATE_LATEST" = "yes" ]; then
  echo "[cloakbrowser] installing cloakbrowser@latest from npm registry…"
  npm install cloakbrowser@latest --omit=dev --no-audit --no-fund
else
  echo "[cloakbrowser] keeping lockfile-pinned version (UPDATE_LATEST=${UPDATE_LATEST})"
fi

node -e "
const fs = require('fs');
const p = 'node_modules/cloakbrowser/package.json';
if (!fs.existsSync(p)) {
  console.error('[cloakbrowser] package missing after install');
  process.exit(1);
}
const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
console.log('[cloakbrowser] installed version:', v);
"
