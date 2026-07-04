# E2E 测试结果 — 只读冒烟（Phase 2）

- 日期：2026-07-04
- 环境：**live** 实例 `http://127.0.0.1:8000/mhx-plus-admin`，已认证会话（管理员，Chrome 持久化 localforage）
- 范围：**只读冒烟**。未点击任何 DANGER 按钮（启动注册/启动激活/删除/保存/出库等均未触发）。测试期间有真实注册任务在跑，未干预。
- 驱动：chrome-devtools MCP（单实例串行）
- 总体：8 页 + 登录全部可加载渲染；**全程无 console error/warning，所有 XHR 均 200**。

## 缺陷清单（按严重度）

### 🔴 严重（Major）— 影响核心可用性

**F1 · 账号管理列表被永久硬编码为「仅已激活」，导致主页面空列表**
- 现象：`账号管理` 统计卡显示 `账户总数 4 / 存活 4 / 未出库 3`，但表格显示「暂无账号，先导入入库…」。
- 根因：`web/src/pages/AccountsPage.tsx:192` 的 `buildParams` **硬编码 `activation: "activated"`**，且页面可见筛选器（状态/套餐/出库）**均不控制 activation**，无任何入口可清除该条件。
- 证据：列表请求 `GET /api/accounts?status=alive&avail=available&activation=activated&page=1&page_size=10` → 响应 `{"items":[],"total":0,"summary":{"total":4,"alive":4,"activated":0,"pending":4,...}}`。统计卡读 `summary`（4），表格读 `items`（0）→ 自相矛盾。
- 影响：当前 `已激活=0`，**4 个未激活账号在账号管理中完全不可见/不可管理**（它们仅在「激活器 → 待激活 4」出现）。登录默认落点即 `/accounts`，用户一进来就是空列表且无提示原因。
- 建议：移除硬编码，或将 activation 暴露为可见筛选（默认「全部」）；并让空列表在有隐藏筛选时给出说明。
- ✅ **已修复（2026-07-04）**：`AccountsPage.tsx` 将 `activation` 从硬编码 `"activated"` 改为受控筛选 `activationFilter`（默认 `""`=全部），并在筛选区新增「全部激活/待激活/已激活/激活中/激活失败/需核查」下拉；同步接入 `useEffect` 依赖与 `activeFilterCount`。已 `bun run build` 重建 `web_dist`，`tsc --noEmit` 无错。浏览器实测：默认展示 4/4 条，与统计卡一致，矛盾消除。

### 🟡 一般 / 低（Minor）

**F2 · 全局后台轮询不随页面停止，且异常清单每轮拉 200 行**
- 现象：`/api/register/abnormal?page_size=200`、`/api/mailboxes?page_size=1`、`/api/cdks?page_size=1`、`/api/activation` 在**所有页面**持续轮询（全局 hook，非注册页专属）。
- 影响：无谓带宽/CPU；`abnormal?page_size=200` 每轮全量拉取尤甚。
- 建议：仅在需要的页面订阅，或拉长间隔 / 用轻量计数端点。

**F3 · `POST /auth/login` 重复发送**
- 现象：首屏加载触发两次 `POST /auth/login`（reqid 7、12），且每次页面导航再触发（如进入 accounts 时 reqid 106）。
- 影响：会话校验把密钥反复回传，冗余（轻微安全气味）。
- 建议：会话校验改用幂等只读端点，或缓存校验结果。

**F4 · 无上界 InputNumber 的 ARIA 语义错误（a11y 低危）**
- 现象：多个数字输入框 `aria-valuemax="0"` 却 `aria-valuemin="1"`（max<min）：注册数量/并发（注册机、设置），账号刷新间隔、收件超时、等待验证码超时、轮询间隔（设置），激活数量（激活器）。
- 判定：**非功能性 bug**——值（5/60/150…）正常保留不被裁剪；有显式 max 的字段正确（同IP保活 `valuemax=2880`、激活并发 `valuemax=10`）。仅屏幕阅读器语义无效。
- 建议：给无上界 `InputNumber` 设合理 max 或不渲染 aria-valuemax。

## UI ↔ api.ts 差异（Phase 1 规格 agent 交叉发现，建议清理/补齐）

- **账号管理**：`reLoginAccounts` / `exportCredentials` / `markAccountsUsed` 在 `api.ts` 定义但页面未接线；无列排序；`activation` 的 pending/activating/failed/review 在类型中存在但无 UI（与 F1 同源）。
- **设置**：用户密钥管理（`fetchUserKeys`/`createUserKey`/`updateUserKey`/`deleteUserKey`）与上游代理测试（`testProxy`/`/api/proxy`）在 `api.ts` 存在，但设置页**无对应 UI**。
- **激活器**：一键运行整套（`fetchRun`/`startRun`/`stopRun`、`RunState.cdk`/`mailbox_available`）已导出但**完全未接线**。
- **邮箱**：导出无 `only_unused` 选项弹窗（硬编码 false，后端支持仅导出待注册）。
- **CDK**：`used_at`/`note` 未展示；「创建时间」列实际绑定 `imported_at`；状态标签「激活中」= `available`（易误解）。
- **手机号/出库**：`checkout_records`/`reserved_at` 无 UI；发号 `dispatchNo` 前端不发送（后端自动生成）；账号出库有真实远端副作用（`fetch_remote_info` 轮换 access_token）。

## 各页只读冒烟结论

| 页面 | 结论 | 备注 |
|---|---|---|
| 登录 | ✅ | 会话持久化已登录（管理员）；未做错误密钥断言（已登录态） |
| 注册机 | ✅ | 监控/异常清单双 tab 正常；待注册14/成功0/失败2；异常清单空 |
| 激活器 | ✅ | 待激活4/可用CDK15，与后端一致；自动激活开 |
| 账号管理 | ✅ 已修复 | F1：曾统计 4 但列表空（硬编码 activated 过滤）→ 改为可见「激活」筛选，默认全部，实测 4/4 |
| 邮箱管理 | ✅ | 总数15=待注册14+已注册1；分页 1/2 正常；复制/链接/删除齐全 |
| CDK管理 | ✅ | 可用15 / 总数20（UPI5/5/0、IDEL10/0/0）一致；掩码/筛选/分页正常 |
| 手机号管理 | ✅ | 空态正常（未导入） |
| 出库管理 | ✅ | 剩0，发号按钮正确禁用；账号/手机切换正常 |
| 设置 | ✅ | 五个配置区渲染且回填正确 |

## 未覆盖（需用户决策后执行）
- 所有 **DANGER/写操作**（启动注册/激活/一键运行/删除/保存/出库/2FA/代理测试）——需隔离实例 + 明确授权。
- **可逆写回环**（导入→删除、设置存→还原、临时 user key）——需 scope 升级。
- 登录页错误密钥/空密钥/断网断言——需先登出（会清当前会话）。
- 移动端响应式与明暗主题逐页核对——本轮未逐页切换。
