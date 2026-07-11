# 激活监控与会员批量出库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复批量激活页运行账号被前 200 条截断的问题，并为会员账号当前勾选项增加批量标记出库和撤销出库操作。

**Architecture:** 激活页复用账号列表接口现有的 `activation=activating` 服务端筛选，在分页前缩小数据集。会员页复用现有 `handleMarkUsed` 与 `/api/accounts/mark-used`，只增加受 `planType === "plus"` 和选中状态控制的确认按钮。

**Tech Stack:** React 19、TypeScript、Semi UI、Vite、Python unittest/pytest、FastAPI 现有账号 API。

---

## 文件结构

- Create: `test/test_web_account_actions.py`：对关键前端请求参数与会员批量操作入口做源码契约回归测试。
- Modify: `web/src/pages/ActivatorPage.tsx`：运行监控轮询仅请求进行中账号。
- Modify: `web/src/pages/AccountsPage.tsx`：会员账号选中工具栏增加批量出库与撤销出库入口。

### Task 1: 建立失败回归测试

**Files:**
- Create: `test/test_web_account_actions.py`

- [ ] **Step 1: 写入失败测试**

```python
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WebAccountActionsTest(unittest.TestCase):
    def test_activator_requests_only_activating_accounts(self) -> None:
        source = (ROOT / "web/src/pages/ActivatorPage.tsx").read_text(encoding="utf-8")
        self.assertIn('fetchAccounts({ activation: "activating", page_size: 200 })', source)

    def test_plus_selection_exposes_batch_dispatch_actions(self) -> None:
        source = (ROOT / "web/src/pages/AccountsPage.tsx").read_text(encoding="utf-8")
        self.assertIn("标记出库", source)
        self.assertIn("撤销出库", source)
        self.assertIn("handleMarkUsed(selectedKeys, true)", source)
        self.assertIn("handleMarkUsed(selectedKeys, false)", source)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `.venv/bin/python -m unittest test.test_web_account_actions -v`

Expected: 两个测试失败，分别提示缺少激活筛选请求和批量操作文案/调用。

### Task 2: 修复激活运行监控查询

**Files:**
- Modify: `web/src/pages/ActivatorPage.tsx`
- Test: `test/test_web_account_actions.py`

- [ ] **Step 1: 将轮询请求改为服务端筛选**

```tsx
const pullAccounts = () =>
  fetchAccounts({ activation: "activating", page_size: 200 })
    .then((r) => setAccounts(r.items))
    .catch(() => {});
```

- [ ] **Step 2: 运行目标测试**

Run: `.venv/bin/python -m unittest test.test_web_account_actions.WebAccountActionsTest.test_activator_requests_only_activating_accounts -v`

Expected: `1 passed`。

### Task 3: 增加会员批量出库工具栏操作

**Files:**
- Modify: `web/src/pages/AccountsPage.tsx`
- Test: `test/test_web_account_actions.py`

- [ ] **Step 1: 在会员账号选中工具栏加入确认操作**

在 `selectedKeys.length > 0` 区域、删除按钮之后加入：

```tsx
{planType === "plus" ? (
  <>
    <Popconfirm
      title={`将选中的 ${selectedKeys.length} 个账号标记为已出库？`}
      onConfirm={() => void handleMarkUsed(selectedKeys, true)}
    >
      <Button size="small" type="primary" theme="light" loading={busy}>
        标记出库
      </Button>
    </Popconfirm>
    <Popconfirm
      title={`撤销选中的 ${selectedKeys.length} 个账号的出库标记？`}
      onConfirm={() => void handleMarkUsed(selectedKeys, false)}
    >
      <Button size="small" type="warning" theme="light" loading={busy}>
        撤销出库
      </Button>
    </Popconfirm>
  </>
) : null}
```

- [ ] **Step 2: 运行全部新增回归测试**

Run: `.venv/bin/python -m unittest test.test_web_account_actions -v`

Expected: `2 passed`。

- [ ] **Step 3: 提交功能改动**

```bash
git add test/test_web_account_actions.py web/src/pages/ActivatorPage.tsx web/src/pages/AccountsPage.tsx docs/superpowers/plans/2026-07-11-activation-monitor-and-batch-dispatch.md
git commit -m "fix(web): 修复激活监控并支持批量出库"
```

### Task 4: 完整验证

**Files:**
- Verify: `web/src/pages/ActivatorPage.tsx`
- Verify: `web/src/pages/AccountsPage.tsx`

- [ ] **Step 1: 运行相关后端与契约测试**

Run: `.venv/bin/python -m unittest test.test_web_account_actions test.test_account_lifecycle -v`

Expected: 所有测试通过。

- [ ] **Step 2: 运行前端生产构建**

Run: `npm run build`（工作目录 `web/`）

Expected: TypeScript/Vite 构建退出码为 0，并更新 `web_dist/`。

- [ ] **Step 3: 检查桌面与移动布局**

Run: `npm run dev -- --host 127.0.0.1`（工作目录 `web/`），在桌面和移动视口打开会员账号页。

Expected: 勾选会员账号后两个批量按钮可见且不溢出；免费账号页不显示；激活页运行监控正常渲染。

- [ ] **Step 4: 检查变更完整性**

Run: `git diff --check && git status --short && git diff origin/main...HEAD --stat`

Expected: 无空白错误；没有 `.env`、私钥或凭证进入待发布改动。

### Task 5: 发布生产

**Files:**
- Verify: `.github/workflows/deploy.yml`
- Verify: `deploy/README.md`

- [ ] **Step 1: 提交构建产物与剩余改动**

Run: `git add -A`，检查暂存区不含密钥后提交剩余改动。

- [ ] **Step 2: 同步主分支并推送当前分支**

Run: `git fetch origin`，随后 `git rebase origin/main` 和 `git push -u origin HEAD`。

Expected: 当前分支基于最新 `origin/main` 且远端可见。

- [ ] **Step 3: 创建并合并 PR**

Run: `gh pr create --base main ...`，随后 `gh pr merge <number> --merge --delete-branch=false`。

Expected: PR 合并进 `main`。

- [ ] **Step 4: 确认生产部署**

Run: `gh run list --workflow=deploy.yml --limit 3` 并监控对应运行完成，然后请求 `https://hao.shuangdeng.space`。

Expected: `Deploy to server` 成功，生产地址返回可访问状态。
