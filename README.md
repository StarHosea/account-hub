<h1 align="center">小鲸鱼</h1>


<p align="center">小鲸鱼是一套自托管的账号池管理平台，提供账号导入、注册自动化、CDK 兑换、号池运维、代理配置与统一运行日志等能力，帮助你集中管理和监控大量账号资源，并支持 Docker 一键部署。</p>

> [!WARNING]
> 免责声明：
>
> 本项目仅供个人学习、技术研究与非商业性技术交流使用。
>
> - 请在遵守相关平台服务条款与当地法律法规的前提下使用本项目。
> - 严禁将本项目用于任何违法、违规、批量滥用或规模化牟利用途。
> - 使用者应自行承担全部使用风险与由此产生的一切后果。
> - 使用本项目即视为你已充分理解并同意本免责声明的全部内容。

## 快速开始

已发布镜像支持 `linux/amd64` 与 `linux/arm64`，在 x86 服务器和 Apple Silicon / ARM Linux 设备上都会自动拉取匹配架构的版本。

### Docker 运行

```bash
git clone git@github.com:StarHosea/account-hub.git
cd account-hub
docker compose up -d
```

启动前请先在 `config.json` 中设置 `auth-key`，也可以在 `docker-compose.yml` 中通过环境变量覆盖。

- Web 面板：`http://localhost:3000`
- API 地址：`http://localhost:3000/v1`
- 数据目录：`./data`

### 本地开发

启动后端：

```bash
git clone git@github.com:StarHosea/account-hub.git
cd account-hub
uv sync
uv run main.py
```

启动前端：

```bash
cd account-hub/web
bun install
bun run dev
```

后续更新新版本：

```bash
docker compose pull
docker compose down
docker compose up -d
```

### 存储后端配置

支持通过环境变量 `STORAGE_BACKEND` 切换存储方式：

- `json` - 本地 JSON 文件（默认）
- `sqlite` - 本地 SQLite 数据库
- `postgres` - 外部 PostgreSQL（需配置 `DATABASE_URL`）
- `git` - Git 私有仓库（需配置 `GIT_REPO_URL` 和 `GIT_TOKEN`）

示例：使用 PostgreSQL

```yaml
environment:
  - STORAGE_BACKEND=postgres
  - DATABASE_URL=postgresql://user:password@host:5432/dbname
```

## 功能

### 号池管理

- 集中管理账号池，展示邮箱、状态、密码、邮件链接、创建时间与激活时间
- 自动刷新账号状态、类型、额度与恢复时间（异步进度追踪）
- 轮询可用账号执行任务，遇到失效凭据时自动剔除
- 定时检查异常账号并自动刷新，支持密码重新登录恢复账号
- 支持搜索、筛选、批量刷新、导出、手动编辑与清理账号
- 支持多种账号导入方式，可批量导入外部来源的账号

### 注册自动化（注册机）

- 内置注册机入口，支持自动化批量注册与入库
- 注册流程模块化拆分，便于扩展与维护
- 注册完成后可按配置自动激活账号

### CDK 管理

- 内置 CDK 兑换与管理页面
- 支持 CDK 的生成、发放、核销与状态追踪

### 代理与运维

- 支持在网页端配置全局 HTTP / HTTPS / SOCKS5 / SOCKS5H 代理
- 全局运行日志面板，集中查看后台任务与运行状态
- 账号敏感字段图标化展示，兼顾可读性与隐私

## 效果展示

<table width="100%">
  <tr>
    <td width="50%"><img src="https://i.ibb.co/PsT9YHBV/account-pool.png" alt="account pool" border="0"></td>
  </tr>
</table>

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=StarHosea/account-hub&type=date&legend=top-left)](https://www.star-history.com/?repos=StarHosea%2Faccount-hub&type=date&legend=top-left)
