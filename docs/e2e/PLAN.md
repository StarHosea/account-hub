# 小海豚 Account Hub — 端到端（E2E）测试计划

> 目标：从**页面视角**逐页验证每个功能是否可用、是否有 bug（渲染、交互、数据、报错）。
> 采用「先定计划 → 子 agent 执行」的方式。本文件为**主计划**；各页详细用例见 `docs/e2e/checklists/<page>.md`。

## 0. 被测环境

| 项 | 值 |
|---|---|
| 前端 | React SPA（Semi UI v2），`web/src`，构建产物 `web_dist` |
| 访问地址 | `http://127.0.0.1:8000/mhx-plus-admin`（`ADMIN_PATH` 默认 `/mhx-plus-admin`；非该前缀路径一律 404 隐藏） |
| 后端 | FastAPI，`127.0.0.1:8000`，`uv run python main.py`（当前已在运行） |
| 登录 | Bearer `auth-key`（`/v1/auth/login`）。**测试需要此 key，须由用户提供。** |
| 浏览器驱动 | chrome-devtools MCP（**单实例共享 Chrome**，浏览器步骤需串行，避免抢占） |

### ⚠️ 现场风险（测试前必读）
- **当前有一个真实注册任务正在运行**（`node_engine/worker.js` 正用付费代理注册真实 iCloud 邮箱，`register.json`：`done 2/3, running 1`）。
- 存在**真实数据**：账号 5 个，以及真实邮箱/CDK/手机号。
- 多个功能有**真实花费 / 不可逆副作用**（见第 2 节分级）。**默认只做只读冒烟**，任何写操作需用户明确授权，且强烈建议在隔离实例上进行。

## 1. 页面清单（8 页 + 登录）

| 路由 | 页面 | 源文件 |
|---|---|---|
| `/login` | 登录 | `pages/LoginPage.tsx` |
| `/register` | 注册机 | `pages/RegisterPage.tsx` + `components/Register*.tsx` |
| `/activator` | 激活器 | `pages/ActivatorPage.tsx` |
| `/accounts` | 账号管理 | `pages/AccountsPage.tsx` |
| `/mailboxes` | 邮箱管理 | `pages/MailboxesPage.tsx` |
| `/cdks` | CDK 管理 | `pages/CdksPage.tsx` |
| `/phones` | 手机号管理 | `pages/PhonesPage.tsx` |
| `/dispatch` | 出库管理 | `pages/DispatchPage.tsx` |
| `/settings` | 设置 | `pages/SettingsPage.tsx` |

## 2. 功能安全分级（决定测试深度）

**✅ 安全（只读/可逆冒烟）** — 默认全部执行：
- 页面加载无白屏、无 console error、无 4xx/5xx 网络请求
- 列表/统计/汇总数据渲染；空态、加载态、错误态
- 搜索、筛选、分页、tab 切换
- 打开弹窗/抽屉后**取消**（不提交）
- 只读配置读取（设置、代理、激活配置、注册配置、trial-check）
- 导出（**不带 mark_used**）、复制、暗色模式、移动端抽屉、日志面板、注册机 SSE 实时流

**⚠️ 可逆写操作** — 仅在隔离实例或用户授权后：
- 导入→删除 的一次性回环（假邮箱/假手机号/假 CDK）
- 设置保存→还原、创建→删除临时 user key

**⛔ 高危 / 有花费 / 不可逆** — 默认**禁止**，仅隔离+mock 上游+显式授权：
- 注册机 start/stop/reset（会打断/触发真实注册）
- 激活器 start、一键运行（**真实 CDK 兑换 = 花钱**）
- 账号 2FA 开/关（改真实 ChatGPT 账号）、删除、mark-used、revoke、re-login、refresh
- 出库 checkout/cooldown/invalid（消耗真实库存）
- 代理测试 proxy/test（真实外发）

## 3. 每页统一验收维度（所有 checklist 遵循）

对每个页面，子 agent 需覆盖：
1. **加载**：路由可达、鉴权守卫正确、首屏渲染、无 console error、无失败网络请求
2. **数据**：列表列/字段与 `web/src/lib/api.ts` 类型一致；统计卡数值与后端返回一致；空/错误态
3. **交互**：搜索、筛选、分页、tab、排序、行选择、弹窗打开/校验/取消
4. **动作**：枚举页面所有按钮 → 标注 安全/可逆/高危；安全的实测，其余仅验证「存在且能打开确认框」后取消
5. **响应式**：桌面 + 移动端（`use-is-mobile`，抽屉导航 `MobileFilters`）
6. **一致性**：暗色/亮色主题；文案；图标化敏感字段

## 4. 执行编排

### Phase 1 — 规格 agent（并行 · 安全 · 无浏览器 · 无需 auth）
每页一个子 agent，读取该页 `.tsx` + 相关 `api.ts` 端点，产出**可执行用例清单**，写入 `docs/e2e/checklists/<page>.md`。产物与环境/scope 无关，可复用。

### Phase 2 — 执行 agent（串行 · 需 auth-key · 共享 Chrome）
1. 打开 `http://127.0.0.1:8000/mhx-plus-admin` → 登录页冒烟（错误 key 被拒、正确 key 通过）
2. 按页顺序执行各 checklist 的**安全项**；每页记录：console 日志、网络失败、截图、发现的问题
3. 汇总缺陷清单（severity：阻断/严重/一般/建议）到 `docs/e2e/RESULTS.md`

> 浏览器为单实例：Phase 2 逐页串行，不并行抢占。可逆/高危项仅在用户选择对应 scope 且在隔离实例时执行。

## 5. 待用户确认（阻塞 Phase 2）
1. **环境**：隔离新实例（推荐）/ 直接测 live :8000
2. **测试深度**：只读冒烟 / +可逆写操作 / 全量含高危
3. **auth-key**：用户粘贴（凭据自动读取已被安全策略拦截，不会自行提取）

## 6. 缺陷记录模板
```
[页面] · [用例] · [严重级]
现象：
复现步骤：
预期 / 实际：
证据：截图/console/network
```
