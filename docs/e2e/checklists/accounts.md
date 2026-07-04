# E2E 测试清单 — 账号管理页 (Accounts)

来源：`web/src/pages/AccountsPage.tsx`、`web/src/components/MobileFilters.tsx`、`web/src/components/StatCards.tsx`、`web/src/lib/api.ts`，后端 `api/accounts.py` / `services/account_service.py`。

安全标签：**SAFE**（只读/可逆无副作用）、**REVERSIBLE**（有副作用但可撤销，如导入后删除）、**DANGER**（作用于真实账号，部分不可逆——务必在测试环境或对一次性可弃账号执行）。

> 重要口径（与源码核对后的实际实现，测试前须知）：
> - 本页 **恒定 `activation=activated`**（`buildParams` 硬编码），列表只展示「已激活」账号；**没有** 待激活/激活中/激活失败/需核查 的筛选 UI。
> - `avail`（可用/不可用）并入「状态」下拉，不是独立筛选：有效→`avail=available`、不可用→`avail=unavailable`、失效→`status=dead`。
> - 表格 **没有任何列排序**（未定义 `sorter`）。「排序」维度记为不适用（negative check）。
> - `reLoginAccounts` / `fetchReLoginProgress`、`exportCredentials` 在本页 **未被引入/未接任何按钮**；`markAccountsUsed`/`handleMarkUsed` 有定义但 **未渲染任何按钮或「出库元信息」弹窗**。相关用例记为「本页不可达」的负向断言。
> - 首屏默认筛选：`statusFilter="valid"`（有效）、套餐/出库为空。故首屏只展示「有效且已激活」账号。

真实文案锚点：
- StatCards：`账户总数` `存活` `失效` `已激活` `需核查`（仅当 `summary.needs_review>0` 才出现）`未出库`
- 列头：`邮箱` `Token` `套餐` `状态` `密码` `2FA` `出库信息` `取件地址` `错误信息` `指纹Seed` `国家` `出口IP` `注册日期` `激活日期` `更新时间` `操作`
- 状态 Tag 文案：`有效`/`失效`/`不可用`/`校验中`/`设置 2FA 中`/`关闭 2FA 中`
- 套餐 Tag：`Plus`（amber）/`Free`（grey）；出库 Tag：`已出库`（grey）/`未出库`（cyan）
- 顶栏按钮：`刷新` `同步`(Dropdown: `导入`/`导出账号（邮箱格式）…`/`导出迁移 JSON…`)；选中后追加 `删除选中` `标记可用` `撤销激活`
- 弹窗：`编辑账户`（`保存`/`取消`）、`导入账号`（`导入`/`取消`）

---

## 维度 1 — 加载 / 鉴权守卫 / 首屏渲染 / 无 Console 报错

### 1.1 未登录访问跳转 — SAFE
- 前置：清空本地登录凭据（未持有有效 admin token）。
- 步骤：直接访问账号管理路由。
- 预期：`GET /api/accounts` 返回 401（后端 `require_admin`），前端 `request` 的 `redirectOnUnauthorized` 逻辑将页面重定向到登录页，不停留在空表。

### 1.2 首屏加载骨架 — SAFE
- 前置：已登录 admin。
- 步骤：进入页面。
- 预期：Table 出现 `loading` 态（Spin）→ 数据返回后消失；标题 `账号管理` 渲染；`GET /api/accounts?...&activation=activated&status=alive&avail=available&page=1&page_size=10` 被调用一次（默认 `statusFilter=valid`）。

### 1.3 首屏无 Console 报错 — SAFE
- 步骤：打开 DevTools Console，加载页面并静置 6s（覆盖一次 5s 轮询）。
- 预期：无红色 error、无未捕获 Promise、无 React key 警告（列表以 `access_token` 为 key）。

### 1.4 空数据文案 — SAFE
- 前置：账号库为空（或筛选后无结果）。
- 步骤：加载页面。
- 预期：桌面 Table 显示 `暂无账号，先导入入库，或用右上角注册机注册。`；移动端卡片流显示 `暂无账号，先导入入库，或用注册机注册。`

### 1.5 后台轻量轮询 — SAFE
- 前置：页面可见、无进行中操作（`busy=false`）。
- 步骤：静置观察网络面板 ~11s。
- 预期：每 5s 触发一次静默 `load(true)`（不显示 loading）；切到后台标签页（`visibilityState!=="visible"`）时暂停；`busy=true` 期间暂停。

### 1.6 加载失败提示 — SAFE
- 前置：后端 `/api/accounts` 返回 5xx。
- 步骤：加载页面。
- 预期：Toast.error 显示错误信息或「加载账户失败」；不崩溃。

---

## 维度 2 — 数据渲染与类型一致性

### 2.1 全部列渲染且映射正确 — SAFE
- 前置：库中至少 1 个字段齐全的账号。
- 步骤：核对每列渲染。
- 预期（对照 `api.ts` 的 `Account` 类型）：
  - `邮箱`：`email` 省略号 + `showTooltip`，右侧复制按钮（IconCopy）；空值显示 `—`。
  - `Token`：`···` + `access_token.slice(-10)`，等宽字体。
  - `套餐`：`type==="plus"`（大小写/空格不敏感）→ `Plus`(amber)，否则 `Free`(grey)。
  - `状态`：见 2.3。
  - `密码`：`password` 敏感图标（见 2.5）。
  - `2FA`：`totp_secret` 敏感图标（见 2.5）。
  - `出库信息`：`used===true`→`已出库`(grey)，否则 `未出库`(cyan)。
  - `取件地址`：`mail_link`（后端由 `mailbox_service.get_fetch_url(email)` 注入）省略号，空→`-`。
  - `错误信息`：拼接 `plus_last_message`(仅当 `plus_status==="激活失败"`)、`last_refresh_error`、`last_token_refresh_error`，以 `；` 连接，danger 文本；无→`-`。
  - `指纹Seed`：`fingerprint_seed`(string|number) 等宽省略；空→`-`。
  - `国家`：`country`→blue Tag；空→`-`。
  - `出口IP`：`exit_ip`，`title` 悬浮显示 `proxy`；空→`-`。
  - `注册日期`：`created_at` 经 `formatDateTime`（UTC 补 `Z` → `YYYY-MM-DD HH:mm`），空→`—`。
  - `激活日期`：`plus_activated_at`；空→`-`。
  - `更新时间`：`last_token_refresh_at` 经 `formatDateTime`。

### 2.2 日期格式化边界 — SAFE
- 步骤：构造 `created_at` 为①带 `Z`、②不带时区、③非法字符串 三种。
- 预期：①②正常格式化为本地 `YYYY-MM-DD HH:mm`；③回退为 `slice(0,16).replace("T"," ")`；`null`→`—`。

### 2.3 状态列合并逻辑 — SAFE
- 步骤：分别构造账号处于：正常 / `status∈{异常,禁用}` / `plus_unavailable=true` / 正在校验 / 正在开关 2FA。
- 预期：优先级依次为 `设置 2FA 中`/`关闭 2FA 中`(blue,Spin) > `校验中`(blue,Spin) > `失效`(red，当 status 异常/禁用) > `不可用`(red，plus_unavailable) > `有效`(green)。

### 2.4 StatCards 与后端 summary 一致 — SAFE
- 前置：记录后端 `summary`（全库、过滤前统计）。
- 步骤：核对 6（或 5）张卡片。
- 预期：`账户总数=total`、`存活=alive`(status∈正常/限流)、`失效=dead`(异常/禁用)、`已激活=activated`(plus_status=已激活)、`未出库=unused`(!used)。`需核查=needs_review` 卡片 **仅当 needs_review>0** 渲染（`summary.pending` 不在本页卡片展示，但类型存在）。卡片值不随筛选变化（后端统计在过滤前算）。

### 2.5 敏感字段图标显示与复制 — SAFE / DANGER(复制真实凭据)
- 前置：账号①有密码/有 2FA、②无密码/无 2FA。
- 步骤：观察 `密码`(IconKey)、`2FA`(IconShield) 图标；悬浮；点击。
- 预期：
  - 无值：dim/半透明图标 + Tooltip `未设置密码` / `未设置2FA 密钥`，不可点击。
  - 有值：primary borderless 图标按钮；悬浮 Tooltip 以等宽显示 **真实明文**（注意：截图/录屏会泄露）；点击 `copyToClipboard`，`aria-label=复制密码/复制2FA 密钥`。复制真实凭据本身为敏感动作（DANGER，测试时避免泄露）。

### 2.6 类型未覆盖字段的负向检查 — SAFE
- 步骤：确认 `Account` 中 `quota`、`plus_status`、`plus_cdk`、`checkout_meta`、`last_used_at`、`success/fail`、`user_id`、`default_model_slug`、`restore_at` 等未在本页列直接展示。
- 预期：这些字段不渲染为独立列；`plus_status`/`plus_last_message` 只间接影响「状态」「错误信息」；`plus_activated_at` 用于「激活日期」；`checkout_meta` 本页无入口写入（见维度 4 说明）。

---

## 维度 3 — 交互（搜索 / 筛选 / 分页 / 选择 / 排序 / 弹窗开关）

### 3.1 搜索 q（防抖 300ms）— SAFE
- 步骤：在 `搜索邮箱 / 密码 / CDK / Token` 输入框输入关键字。
- 预期：`setPage(1)` 立即；300ms 后 `debouncedQuery` 触发 `load`，请求带 `q=<kw>`；后端按 email/password/plus_cdk/access_token 模糊匹配。`showClear` 清空后恢复全量。

### 3.2 状态筛选（含 avail 合并）— SAFE
- 步骤：`全部状态`/`有效`/`失效`/`不可用` 逐一切换。
- 预期：`全部状态`→无 status/avail；`有效`→`avail=available`（且不带 status）；`失效`→`status=dead`；`不可用`→`avail=unavailable`。每次 `setPage(1)`。

### 3.3 套餐筛选 — SAFE
- 步骤：`全部套餐`/`Free`/`Plus` 切换。
- 预期：`plan=free`/`plan=plus`/无；后端 free 含 type 为空或 `free`。`setPage(1)`。

### 3.4 出库筛选 — SAFE
- 步骤：`全部出库`/`已出库`/`未出库` 切换。
- 预期：`used=true`/`used=false`/无。`setPage(1)`。

### 3.5 组合筛选叠加 — SAFE
- 步骤：同时设关键字 + 有效 + Plus + 未出库。
- 预期：请求含全部参数 + 恒定 `activation=activated`；结果为交集；`activeFilterCount` 计为 4（移动端筛选按钮角标显示 `（4）`）。

### 3.6 分页 — SAFE
- 前置：total > 10。
- 步骤：切换页码。
- 预期：`page` 更新触发 `load`，请求 `page=n&page_size=10`；桌面用 Table 内置 Pagination，移动端仅当 `total>pageSize` 显示独立 Pagination。切筛选后回到第 1 页。

### 3.7 行选择 / 跨页选择保持 — SAFE
- 步骤：勾选若干行 → 观察顶栏 `已选 N`。
- 预期：`selectedKeys` 记录 token；顶栏出现 `删除选中/标记可用/撤销激活`；`load` 后会剔除当前页已不存在的 key（`selectedKeys.filter`）。

### 3.8 全选本页 — SAFE
- 步骤：桌面用 Table 表头全选；移动端用 `全选本页` Checkbox。
- 预期：`allOnPageSelected` 为真时再点取消全选；仅作用于当前页 items。

### 3.9 排序（负向）— SAFE
- 步骤：点击各列列头。
- 预期：**无排序行为**（未配置 sorter），顺序恒为后端返回顺序。记为「本页不支持列排序」。

### 3.10 打开并取消每个弹窗 — SAFE
- 编辑弹窗：点行内 `编辑状态/代理`(IconEdit) → `编辑账户` 弹出（回填 `status`/`proxy`）→ 点 `取消` 或遮罩(注意 `maskClosable=false`，仅按钮/✕关闭)→ 无请求发出。
- 导入弹窗：`同步`→`导入` → `导入账号` 弹出 → `取消` 关闭并清空 `importFileName`/拖拽态 → 无请求。
- 导出「选项」（负向）：导出是 Dropdown 菜单项，**非弹窗**，无格式选项对话框（无 export options 弹窗）。
- 出库元信息弹窗（负向）：本页 **无 mark-used meta 弹窗**（`handleMarkUsed` 未渲染入口）。
- 2FA（负向）：开/关 2FA 无独立配置弹窗，关闭走 Popconfirm 二次确认，开启为直接按钮。

### 3.11 导入弹窗三种格式识别 — REVERSIBLE（会真的入库，见 4.x）
- 步骤：在 `导入账号` 文本框分别粘贴：①`[{...access_token...}]` 迁移 JSON、②`邮箱---密码---2FA--Accesstoken` 账号池行、③每行一个 access_token。也测试选择文件/拖拽 `.json/.txt`。
- 预期：前端按 `[`/`{` 走 JSON 解析（无 access_token→`JSON 里没有找到带 access_token 的账号`）、含 `---` 交后端 `parse_import_blob`、否则按行拆分 token；空输入→`请粘贴要导入的 access_token 或迁移 JSON`；非法 JSON→`JSON 解析失败…`。仅点 `导入` 才提交。

---

## 维度 4 — 按钮 / 行内动作全量枚举 + 安全分级

> 异步进度轮询流：`校验/刷新`(refresh, `fetchRefreshProgress` 每 500ms)、`2FA 开/关`(`fetch2FAProgress` 每 800ms)、`导入后台校验`(refresh progress 每 800ms)。轮询期间 `refreshing`/`twofaPending` 置位驱动状态列 Spin。

### 顶栏 / 列表级
| # | 动作(真实文案) | API | 分级 | 说明 |
|---|---|---|---|---|
| 4.1 | `刷新`(IconRefresh, 顶栏) | `fetchAccounts` | **SAFE** | 仅重拉当前页，显示 `loading`。 |
| 4.2 | `同步`→`导入` | `createAccounts` (+后台 `refreshAccounts`) | **REVERSIBLE** | 真入库；可后续删除。成功 Toast `导入完成，新增 N 个，正在后台校验…`。 |
| 4.3 | `同步`→`导出账号（邮箱格式）（全部/选中 N）` | `exportAccountPool(selectedKeys)` | **SAFE** | `mark_used` 默认 false，不改状态；下载 `accounts-pool-<ts>.txt`；空→`没有可导出的账号`。 |
| 4.4 | `同步`→`导出迁移 JSON（全部/选中 N）` | `exportAccounts(selectedKeys,"json")` | **SAFE** | 不标记出库；下载 `accounts-migration-<ts>.json`；后端要求账号同时有 access/refresh/id token，否则 400。 |
| 4.5 | `删除选中`(danger, Popconfirm `删除选中的 N 个账号？`) | `deleteAccounts(selectedKeys)` | **DANGER(不可逆)** | 永久删除；Toast `删除 N 个账户`。 |
| 4.6 | `标记可用`(secondary, Popconfirm) | `markPlusAvailable(sel,true)` | **DANGER** | 清不可用标记并 **重置激活态为未激活+尝试清零**，使其重进激活；无变更→`没有需要变更的账号`。 |
| 4.7 | `撤销激活`(danger, Popconfirm `⚠️ 撤销…` okType=danger okText=`确认撤销`) | `revokeActivation(sel)` | **DANGER** | 复位 plus_status/CDK 绑定/尝试次数（不动真实 type）；仅纠正误标。Toast `已撤销 N 个…`。 |

### 行内动作（`操作` 列 / 移动端卡片操作行）
| # | 动作(title) | API | 分级 | 说明 |
|---|---|---|---|---|
| 4.8 | `收邮件（打开邮箱链接）`(IconMail) | 无(前端 `window.open(mail_link)`) | **SAFE** | 无 `mail_link` 时按钮 disabled。 |
| 4.9 | `校验/刷新`(IconRefresh) | `refreshAccounts([token])`→轮询 `fetchRefreshProgress` | **DANGER** | 对真实账号发起远端校验/刷新 token；逐账号结果入日志，失败标红并 `openLog(true)`；成功 Toast `刷新完成`。 |
| 4.10 | `标记激活可用`(IconTickCircle, 仅 `plus_unavailable` 账号显示, Popconfirm) | `markPlusAvailable([token],true)` | **DANGER** | 同 4.6，单账号。 |
| 4.11 | `开启 2FA`(IconShield tertiary, 无 totp 时) | `enable2FA(token)`→轮询 `fetch2FAProgress` | **DANGER(不可逆副作用)** | 对真实账号绑定 TOTP；失败 Toast `开启2FA失败：<detail>` 并 openLog；成功 Toast `已开启 2FA`。 |
| 4.12 | `关闭 2FA`(IconShield warning, 有 totp 时, Popconfirm `确认关闭 2FA？`) | `disable2FA(token)`→轮询 | **DANGER** | 移除两步验证；成功 Toast `已关闭 2FA`。 |
| 4.13 | `编辑状态/代理`(IconEdit) → `编辑账户` 弹窗 `保存` | `updateAccount(token,{status,proxy})` | **DANGER** | 改真实账号 status/proxy；status=限流 且开启自动移除时后端会删除该账号；Toast `已更新`。无改动后端返回 400 `还没有检测到改动…`。 |
| 4.14 | `删除`(IconDelete danger, Popconfirm `删除该账号？`) | `deleteAccounts([token])` | **DANGER(不可逆)** | 单账号永久删除。 |

### 本页不可达 / 未接线（负向断言）
| # | 能力 | 状态 |
|---|---|---|
| 4.15 | 重新登录 re-login (`reLoginAccounts`) | **本页无按钮**（api.ts 有函数，AccountsPage 未引入）。DANGER 能力，此页不应出现入口。 |
| 4.16 | 凭据导出 `exportCredentials`(邮箱----接码----密码----2FA) | **本页无入口**（未引入）。 |
| 4.17 | 出库标记 `markAccountsUsed` / 「已出库」按钮 / 出库元信息弹窗 | **本页无渲染**（`handleMarkUsed` 定义但未接 UI）。带 `mark_used` 的导出（export-with-mark_used）在本页也不可触发（两处导出 `markUsed` 恒 false）。 |

---

## 维度 5 — 响应式（桌面 + 移动 MobileFilters 抽屉）

### 5.1 桌面布局 — SAFE
- 前置：视口宽度 > 移动断点（`useIsMobile` 为 false）。
- 预期：筛选控件（搜索 240px + 三个 130px 下拉）横向排列；渲染 `Table`（`scroll={{x:1400}}`，邮箱列 `fixed:left`、操作列 `fixed:right`、rowSelection `fixed`）；StatCards 为 `minmax(150px,1fr)` 自适应网格。

### 5.2 移动端切换卡片流 — SAFE
- 前置：视口 < 断点（`useIsMobile` true）。
- 预期：渲染 `AccountMobileList` 卡片（非 Table）；标题降为 heading=4；StatCards 变两列紧凑（标题左值右）；筛选收进 `搜索 / 筛选（N）` 按钮。

### 5.3 MobileFilters 抽屉开合 — SAFE
- 步骤：移动端点 `搜索 / 筛选` → 右侧 `SideSheet`(width 82%) 划出 → 内含全部筛选控件（宽度 100%）+ `查看结果` + 提示 `条件即时生效，关闭后查看列表`。
- 预期：筛选即时生效（改动立即触发 load）；点 `查看结果`/✕ 关闭抽屉；角标 `activeCount` 与生效条件数一致。

### 5.4 移动端卡片信息完整性 — SAFE
- 预期：每卡片含 勾选框 + 邮箱(点击复制) + 状态 Tag；标签行 套餐/出库/国家；信息行 Token 尾 10 位 + 密码图标 + 2FA 图标 + 更新时间；操作行 收邮件/校验刷新/2FA/编辑/删除（分级同维度 4）。

### 5.5 移动端全选与分页 — SAFE
- 预期：`全选本页` Checkbox 作用当前页；`total>pageSize` 才出现底部居中 Pagination。

### 5.6 编辑/导入弹窗移动端全屏 — SAFE
- 预期：`编辑账户`、`导入账号` Modal 在移动端 `fullScreen`；取消行为一致。

---

## 维度 6 — 主题（明/暗）与 i18n

### 6.1 明/暗主题切换 — SAFE
- 步骤：切换 light/dark。
- 预期：所有颜色走 `var(--semi-color-*)`（成功/危险/警告/primary/border/fill/disabled-text）；Tag 颜色（amber/grey/green/red/blue/cyan）在两主题下对比度可读；敏感图标 dim 态 `--semi-color-disabled-text` 生效；导入拖拽区 hover 边框 `--semi-color-primary` 两主题皆可见。无写死的黑/白色导致暗色下不可读。

### 6.2 文案一致性（i18n）— SAFE
- 步骤：核对全部可见文案。
- 预期：当前为中文硬编码文案（列头、Tag、按钮、Toast、Popconfirm、空态、弹窗均为中文）。若引入 i18n 框架，需覆盖上文所有「真实文案锚点」，且 `Plus`/`Free`/`Token`/`2FA`/`CDK` 等术语保持不翻译。当前无语言切换入口→记为「单语（中文）」基线。

### 6.3 Toast / 日志文案渲染 — SAFE
- 步骤：触发一次校验（4.9）与一次失败 2FA（4.11）。
- 预期：进度/结果写入日志面板（`log.info/success/error`，scope 形如 `校验 · <email>`、`开启2FA · <email>`）；失败时自动 `openLog(true)` 打开日志抽屉；Toast 文案与源码一致（如 `刷新完成`/`开启2FA失败：<detail>`，其中后端 `失败：` 前缀被去重）。

---

## 附：安全执行顺序建议
1. 先跑全部 **SAFE**（维度 1、2、3.1–3.10、5、6）——不触碰真实账号状态。
2. **REVERSIBLE**：导入一批一次性 token（4.2），验证后用 `删除选中`(4.5) 清理。
3. **DANGER** 仅对可弃测试账号执行，逐项验证：4.9 校验 → 4.13 编辑 → 4.11/4.12 2FA → 4.6/4.10 标记可用 → 4.7 撤销激活 → 4.14/4.5 删除。避免对生产真实账号执行 2FA 开关、删除、撤销激活等不可逆操作。
</content>
</invoke>
