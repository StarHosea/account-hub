---
name: deploy-production
description: account-hub 生产发布闭环：提交本地全部改动 → 创建 PR → 合并 PR → 等待/确认 GitHub Actions 部署生产。触发：部署生产、上线、发布、merge 并部署、push main 部署。
---

# 部署生产

用户说「部署生产」「上线」「发布」时，按顺序执行完整闭环，不要只 commit 或只建 PR。

## 铁律

- **先验证再提交**：相关单测/构建能跑则先跑；失败则修完再继续。
- **不提交密钥**：`.env`、凭证、私钥不进 git。
- **合并目标分支为 `main`**：push `main` 触发 CI/CD（见 `deploy/README.md`）。
- **合并后必须确认部署**：看 Actions 或生产健康，不能假设成功。

## 工作流

```
1. 验证 → 2. 提交全部本地改动 → 3. 同步 main → 4. 创建 PR → 5. 合并 PR → 6. 确认生产部署
```

### 1) 验证

按改动范围选跑（能跑必跑）：

```bash
# Node 注册机相关
node --test node_engine/test/*.test.mjs

# Python 相关
.venv/bin/python -m pytest test/ -q --tb=short -x

# 仅 web/ 改动
cd web && npm run build
```

### 2) 提交本地所有代码

并行查看状态：

```bash
git status
git diff
git log -5 --oneline
```

暂存并提交（排除 `.env` 等敏感文件）：

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix: 简明说明 why（1-2 句）

EOF
)"
```

- 当前开发分支多为 `vibe`；若在别的分支，沿用当前分支即可。
- 用户明确要求提交时才可以 commit；本 skill 触发即视为已授权。

### 3) 同步 `main`

PR 前让分支基于最新 `main`，减少冲突：

```bash
git fetch origin
git rebase origin/main
# 或：git merge origin/main
git push -u origin HEAD
# rebase 后若已 push 过：git push --force-with-lease
```

### 4) 创建 PR

```bash
gh pr create --base main --title "标题" --body "$(cat <<'EOF'
## Summary
- …

## Test plan
- [ ] …

EOF
)"
```

- 用 `gh`；返回 PR URL 给用户。
- `git diff origin/main...HEAD` 与全部待合并 commit 都要看过，body 覆盖**所有** commit，不只最新一条。

### 5) 合并 PR

```bash
gh pr merge <number> --merge --delete-branch=false
```

- 默认 `--merge`（与仓库现有 merge commit 风格一致）；用户指定 squash/rebase 时再改。
- 合并后：`git checkout main && git pull origin main`

### 6) 确认生产部署

push/merge 到 `main` 后自动触发 `.github/workflows/deploy.yml`：

1. Build `linux/arm64` 镜像 → `ghcr.io/starhosea/account-hub:latest`
2. SSH 到 `140.238.56.209` → `docker compose pull && up -d`

```bash
gh run list --workflow=deploy.yml --limit 3
gh run watch   # 最近一次 deploy workflow
```

**成功标准**：

- Actions `Deploy to server` job 绿
- 生产 `https://hao.shuangdeng.space` 可访问（或用户指定的对外地址）
- 若改了注册机：提醒用户**重新发起注册任务**（旧 worker 不热加载 node 代码；新容器 spawn 新进程）

**手动重部署**（Actions 页面）：**Deploy to server** → Run workflow。

## 与本仓库其他规则的关系

| 改动 | 本地额外步骤 |
|------|----------------|
| `services/`、`api/`、`main.py` | 重启本地 `main.py`（`:8000`） |
| `web/` | `cd web && npm run build`（`web_dist/`） |
| 仅 `.md` / `docs/` | workflow `paths-ignore`，**不会**触发镜像部署 |

## 完成汇报

向用户说明：

1. commit hash / PR URL
2. merge 结果
3. deploy workflow 状态（链接或结论）
4. 生产地址与需人工验证项（如有）
