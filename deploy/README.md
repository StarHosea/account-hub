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

## 手动运维

```bash
cd ~/apps/account-hub
sudo docker compose pull && sudo docker compose up -d   # 更新
sudo docker compose logs -f app                          # 看日志
sudo docker compose ps                                   # 状态
```
