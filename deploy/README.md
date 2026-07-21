# 部署说明（自动化 CI/CD）

主分支（`main`）更新后，GitHub Actions 自动构建镜像并部署到服务器。

## 链路

```
push main ──► .github/workflows/deploy.yml
              ├─ build：构建 linux/arm64 镜像 → 推送 ghcr.io/starhosea/account-hub:latest (+:<sha>)
              └─ deploy：SSH 到服务器 → docker login ghcr → compose pull → up -d
```

- 手动触发：Actions 页面 → **Deploy to server** → Run workflow（`workflow_dispatch`）。

## 服务器（140.238.56.209，Ubuntu ARM）

- 部署目录：`~/apps/account-hub/`（`docker-compose.yml` + `.env` + `data/`）
- 应用绑定 `127.0.0.1:8090`（不对外），由 1Panel **OpenResty** 反代：
  - vhost：`/opt/1panel/www/conf.d/hao-proxy.conf`（`hao.shuangdeng.space` → `127.0.0.1:8090`）
  - 证书：复用 `ssl/shuangdeng`，仅开放 80/443
- 存储：**PostgreSQL**，复用 `sub2api-postgres` 容器，独立库/账号 `account_hub`
- 开机自启：`restart: unless-stopped` + `docker.service` 已 `enabled`

## 所需 GitHub Secrets

| Secret | 值 |
|---|---|
| `DEPLOY_SSH_HOST` | `140.238.56.209` |
| `DEPLOY_SSH_USER` | `muhaoxing` |
| `DEPLOY_SSH_KEY` | 部署私钥（对应服务器 `~/.ssh/authorized_keys`） |
| `DEPLOY_SSH_PORT` | 可选，默认 `22` |

镜像拉取使用 workflow 内置 `GITHUB_TOKEN`（无需长期凭证）。

### CloakBrowser（指纹浏览器 wrapper）

生产镜像构建**默认**在 `npm install` 后再执行 `cloakbrowser@latest`，并预下载对应 stealth Chromium：

| Build-arg | 默认 | 说明 |
|---|---|---|
| `CLOAKBROWSER_UPDATE_LATEST` | `true` | `true` 时拉 npm 最新 wrapper；本地可复现构建可设 `false` 锁 package-lock |
| `CLOAKBROWSER_CACHEBUST` | `0` | CI 传入 `github.run_id`，打散缓存层，否则 `@latest` 会一直用旧缓存 |
| `CLOAKBROWSER_LICENSE_KEY` | 空 | 可选；若二进制下载需授权，在 GitHub Secrets 配置同名项 |

本地钉死版本示例：

```bash
docker build --build-arg CLOAKBROWSER_UPDATE_LATEST=false -t account-hub:local .
```

## 手动运维

```bash
cd ~/apps/account-hub
sudo docker compose pull && sudo docker compose up -d   # 更新
sudo docker compose logs -f app                          # 看日志
sudo docker compose ps                                   # 状态
```

## 注册失败诊断 → 本地 AI

在管理后台 **设置 → 诊断与存证** 配置（不用环境变量）：

- **存证策略**：`仅保留失败`（成功自动删，默认）
- **诊断对外地址**：`https://hao.shuangdeng.space`

直链（无鉴权）：

- 最近失败：`https://hao.shuangdeng.space/api/register/diag/brief.md`
- 异常列表：`https://hao.shuangdeng.space/api/register/diag/list`

本地 Mac 一键拉取并复制剪贴板：

```bash
python3 scripts/fetch-register-diag.py --remote
python3 scripts/fetch-register-diag.py --local    # 本地 127.0.0.1:8000
```
