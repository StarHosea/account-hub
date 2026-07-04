# E2E 测试清单 — 邮箱管理（Mailboxes）

- 页面组件: `web/src/pages/MailboxesPage.tsx`
- 类型/接口: `web/src/lib/api.ts`（Mailboxes 段，`Mailbox` / `MailboxStats` / `MailboxListParams`）
- 后端: `api/mailboxes.py`、`services/mailbox_service.py`（`MAX_IMPORT_ROWS = 2000`、`IN_USE_STALE_SECONDS = 3600`）
- 相关组件: `web/src/components/MobileFilters.tsx`、`web/src/components/StatCards.tsx`
- 路由: `web/src/App.tsx` → `/mailboxes`（`AppLayout` 内，需登录）

安全标签说明: **SAFE** = 只读/不改库存；**REVERSIBLE** = 改动可再撤销；**DANGER** = 消耗/改写真实库存，谨慎执行（应在测试数据上做）。

约定: 桌面端渲染 Semi `<Table>`；移动端渲染 `MobileList` 卡片流（`useIsMobile`）。分页 `PAGE_SIZE = 10`。搜索防抖 300ms（`useDebouncedValue`）。前端导入前置校验 `MAX_IMPORT_ROWS`（`countImportRows`）。

---

## 维度 1 · 加载 / 鉴权守卫 / 渲染 / 无 Console 报错

1. **未登录访问守卫** — 前置: 清除鉴权（无有效 admin key）。步骤: 直接打开 `/mailboxes`。预期: `fetchMailboxes` 触发后端 `require_admin` 401，`request.ts` 拦截器按 `redirectOnUnauthorized`（默认 true）跳 `${base}/login`；表格不渲染真实数据。安全: SAFE。
2. **已登录首屏加载** — 前置: 有效 admin 登录，库中已有邮箱。步骤: 打开页面。预期: 标题「邮箱管理」；`StatCards` 4 张卡渲染；表格列出首页 10 条；`loading` 结束后无骨架。安全: SAFE。
3. **空态渲染** — 前置: 邮箱库为空。步骤: 打开页面。预期: 桌面表格 `empty="暂无邮箱，先导入。"`；移动端卡片显示「暂无邮箱，先导入。」；4 张统计卡全为 0。安全: SAFE。
4. **加载失败提示** — 前置: 后端 `/api/mailboxes` 返回 5xx。步骤: 打开页面。预期: `Toast.error`「加载邮箱失败」或后端 message；不崩溃。安全: SAFE。
5. **无 Console 报错** — 步骤: 首屏 + 翻页 + 打开导入弹窗 + 关闭，全程看 DevTools Console。预期: 无 React key 警告、无未捕获异常、无受控组件警告。安全: SAFE。
6. **刷新按钮** — 步骤: 点右上「刷新」（`IconRefresh`）。预期: `load()` 重新拉取，按钮 `loading` 态短暂出现；数据与统计卡刷新。安全: SAFE。

---

## 维度 2 · 数据字段与类型核对

`Mailbox` 类型字段: `email / fetch_url / used / in_use / account_token / registered_at / imported_at / note`。

### 表格列（桌面）

7. **邮箱列** — 预期: `email` 省略号+悬浮 tooltip（`maxWidth 230`）+ `IconCopy` 复制按钮（copy 标签「邮箱」）。安全: SAFE。
8. **状态列 badge** — 前置: 造 3 种邮箱（待注册 / 注册中 / 已注册）。步骤: 观察 `statusTag()`。预期: 判定优先级 `used→「已注册」(灰) > in_use→「注册中」(蓝) > 其余→「待注册」(绿)`；即 `used=true` 时即使 `in_use=true` 也显示「已注册」。安全: SAFE。
9. **接码地址列** — 预期: `fetch_url` 等宽小字省略号+tooltip；含 `IconLink` 新开链接（`window.open(_blank,noopener)`）与 `IconCopy` 复制（标签「接码地址」）；空值显示「—」。安全: SAFE。
10. **导入时间列** — 预期: `imported_at` 经 `fmtTime` 本地化（`toLocaleString`）；空显示「—」。安全: SAFE。
11. **操作列** — 预期: `fixed:right`，仅一个删除按钮（`IconDelete` + `Popconfirm`「删除该邮箱？」）。安全: SAFE（按钮本身分级见维度 4）。
12. **未展示字段（UI 缺口）** — 预期: **注意 discrepancy** — 类型含 `account_token`（绑定账号 token）、`registered_at`（注册时间）、`note`（备注），后端 `_public` 也返回它们，但表格/卡片**均无任何列展示**。安全: SAFE。
13. **术语差异（UI ↔ 导入格式）** — 预期: **注意 discrepancy** — 列标题与搜索占位叫「接码地址」，而导入弹窗提示与后端解析注释叫「收件地址」（`邮箱---收件地址`）；同一字段 `fetch_url` 两处措辞不一致。安全: SAFE。

### 统计卡（`stats` / `MailboxStats`）

14. **4 项计数映射** — 预期: 卡片依次为 邮箱总数`total` / 待注册`unused`(绿 success) / 已注册`used` / 注册中`in_use`(蓝 primary)。安全: SAFE。
15. **计数口径核对** — 前置: 库中含 used / in_use / 普通 三类。预期: 后端 `stats()`：`used = Σused`、`in_use = Σ(in_use 且 not used)`、`unused = total - used - in_use`；四数关系为 `unused + used + in_use = total`（`in_use` 已排除 used 的重叠，不会双计）。安全: SAFE。
16. **stats 为全库口径** — 前置: 库中 >10 条含各状态。步骤: 施加搜索或状态筛选。预期: 统计卡数字**不随筛选/搜索变化**（后端 `list_mailboxes` 内注释「全库口径，不随筛选变化」，`stats()` 独立于过滤后的 items）；仅表格行数变化。安全: SAFE。

---

## 维度 3 · 交互（搜索 / 筛选 / 分页 / 选择 / 弹窗）

17. **搜索防抖** — 步骤: 搜索框快速输入。预期: 300ms 后才发一次 `/api/mailboxes?q=`；`onChange` 立即 `setPage(1)` 回首页。安全: SAFE。
18. **搜索多字段命中** — 前置: 造邮箱与接码地址各含关键词的记录。步骤: 分别搜邮箱、接码地址片段。预期: 均命中（后端匹配 `email` + `fetch_url`，大小写不敏感）；placeholder「搜索邮箱 / 接码地址」与后端一致。安全: SAFE。
19. **搜索清除** — 步骤: 点搜索框 `showClear` 清除。预期: 恢复全量列表。安全: SAFE。
20. **状态筛选 待注册(unused)** — 步骤: 下拉选「待注册」。预期: `status=unused`，`setPage(1)`；仅 `not used 且 not in_use` 的邮箱。安全: SAFE。
21. **状态筛选 已注册(used)** — 步骤: 选「已注册」。预期: `status=used`，仅 `used=true`。安全: SAFE。
22. **状态筛选 注册中(in_use)** — 步骤: 选「注册中」。预期: `status=in_use`，仅 `in_use 且 not used`（后端显式排除 used）。安全: SAFE。
23. **状态筛选 全部** — 步骤: 选「全部状态」（value=""）。预期: 不传 `status`，返回全量。安全: SAFE。
24. **分页翻页** — 前置: >10 条。步骤: 点第 2 页。预期: `page` 变更触发重新拉取（`useEffect` 依赖含 page）；桌面 `pagination` 与移动 `Pagination`（`total>pageSize` 才显示）同步。安全: SAFE。
25. **翻页后选中过滤** — 前置: 选中若干行后翻页。步骤: 观察 `selected`。预期: `load()` 内 `setSelected` 只保留当前页仍存在的 email（跨页选中被裁剪）。安全: SAFE（设计行为，勿误判为 bug）。
26. **全选本页 / 单选** — 步骤: 桌面 `rowSelection`（rowKey=email），移动端「全选本页」Checkbox + 卡片 Checkbox。预期: `allOnPageSelected` 联动正确；选中后出现「已选 N 项」批量操作条。安全: SAFE。
27. **导入弹窗 打开+取消** — 步骤: 点「导入」打开 Modal，输入后点取消/遮罩。预期: `maskClosable={false}` 仅按钮关闭；取消不落库；移动端 `fullScreen`；TextArea `rows`(桌面10/移动12) 等宽字体。安全: SAFE。
28. **导出无二次弹窗（口径核对）** — 步骤: 点「导出」。预期: **注意** — 邮箱导出是**直接下载**，无导出选项弹窗/下拉（不同于 CDK 的导出下拉）；直接 `fetchMailboxesExportText()` 生成 `.txt` blob 下载。安全: SAFE。
29. **导出空库提示** — 前置: 库为空或导出文本为空。步骤: 点「导出」。预期: `Toast.warning`「没有可导出的邮箱」，不触发下载。安全: SAFE。
30. **导入超限拦截** — 前置: 粘贴 >2000 行。步骤: 点导入确认。预期: 前端 `countImportRows` 命中 `MAX_IMPORT_ROWS`，`Toast.warning`「单次最多导入 2000 条…」，不发请求。安全: SAFE。
31. **导入空文本拦截** — 步骤: 空 TextArea 点导入。预期: `Toast.warning`「请粘贴邮箱」。安全: SAFE。

---

## 维度 4 · 按钮清单与安全分级（枚举全部）

> 顶部操作区

32. **刷新** `IconRefresh` — `load()` 重新加载。安全: **SAFE**。
33. **导入**（打开 Modal） `IconUpload` primary — 仅打开弹窗。安全: **SAFE**（打开动作）。
34. **导出** `IconDownload` — `fetchMailboxesExportText()` 拉取 `邮箱---收件地址` 文本并下载 `mailboxes-<ts>.txt`。安全: **SAFE**。

> 导入弹窗内

35. **导入确认（okText「导入」）** — `importMailboxes(text)`，按邮箱去重新增/更新取件地址；Toast「导入完成，新增 X，更新 Y，跳过重复 Z」。安全: **REVERSIBLE**（新增的邮箱可再删除；先导入后删组合用于回归）。

> 列内 / 卡片内（单条）

36. **复制邮箱 / 复制接码地址 / 新开接码链接** — `copy` / `window.open`。安全: **SAFE**。
37. **列内 删除**（`IconDelete` + `Popconfirm`「删除该邮箱？」） — `deleteMailboxes([email])`；Toast「删除 N 个」。安全: **DANGER**（永久移除）。
38. **移动卡片 标记已注册/待注册**（`IconTick`/`IconClose`） — `markMailboxes([email], !used)`。安全: **DANGER**（改写状态；标记待注册会清 `account_token`+`registered_at`+复位 in_use）。

> 批量操作条（`selected.length>0` 时出现）

39. **标记已注册** `IconTick` — `markMailboxes(selected, true)`；Toast「已标记 N 个为已注册」。安全: **DANGER**（批量置 used，注册机将跳过这些邮箱）。
40. **标记待注册** `IconClose` — `markMailboxes(selected, false)`；后端分支会**清 `account_token` + `registered_at` 并复位 `in_use`**。安全: **DANGER**（批量改写，抹掉绑定/注册记录）。
41. **删除选中**（`Popconfirm`「删除选中的 N 个？」） — `deleteMailboxes(selected)`。安全: **DANGER**（批量永久移除）。

> 每个 DANGER 用例通用预期: 二次确认（Popconfirm）生效；成功 Toast 文案正确；`load(true)` 静默刷新；统计卡随之更新。空选点「标记」时 `Toast.warning`「请先选择邮箱」。

---

## 维度 5 · 响应式（桌面 + 移动）

42. **桌面表格布局** — 前置: 宽视口。预期: `<Table>` `tableLayout=fixed`、`scroll={{x:1020}}` 横向滚动，操作列 `fixed:right`；顶部标题 heading 3。安全: SAFE。
43. **移动卡片流切换** — 前置: 窄视口（`useIsMobile` 命中）。预期: 改为 `MobileList` 卡片；标题 heading 4；顶部操作按钮 `flexWrap` 换行；筛选控件宽度 100%。安全: SAFE。
44. **移动筛选抽屉** — 步骤: 点「搜索 / 筛选（N）」。预期: `MobileFilters` 从右侧 `SideSheet`(82%) 划出；`activeCount = (有搜索词?1:0)+(有状态筛选?1:0)`；含「查看结果」关闭按钮与「条件即时生效」提示。初始无筛选时无角标。安全: SAFE。
45. **移动卡片结构** — 预期: 每卡顶行 勾选+邮箱(点击复制)+状态 Tag；接码行含复制/新开；底部「标记已注册/待注册」大按钮 + 删除(Popconfirm)；选中卡边框变 primary。安全: SAFE（按钮分级见维度 4）。
46. **移动分页** — 预期: `Pagination` 仅在 `total>pageSize` 出现且居中。安全: SAFE。
47. **移动导入弹窗全屏** — 预期: 导入 Modal `fullScreen`，TextArea `rows=12`。安全: SAFE。

---

## 维度 6 · 主题（明/暗）与 i18n

48. **暗色主题** — 步骤: 切换 dark。预期: `StatCards` 用 `var(--semi-color-success/primary)` 语义色在暗色下对比正常；状态 Tag（灰/蓝/绿 light）可辨；等宽接码地址可读。安全: SAFE。
49. **明色主题** — 预期: 同上；选中态/卡片边框 `--semi-color-primary` 正常。安全: SAFE。
50. **中文文案一致性** — 预期: 全部固定中文（「邮箱管理」「导入」「导出」「刷新」「待注册/已注册/注册中」「标记已注册/待注册」「删除选中」等）；无 i18n key 泄漏、无未翻译英文（图标除外）。安全: SAFE。
51. **动态文案** — 预期: 「导入完成，新增 X，更新 Y，跳过重复 Z」「删除 N 个」「已标记 N 个为已注册/待注册」「已选 N 项」渲染正确，无占位符残留。安全: SAFE。

---

## 已知 UI ↔ api.ts / 后端 差异汇总

- `Mailbox.account_token` / `registered_at` / `note` 后端返回但页面**无任何 UI 展示**（见 #12）。
- 同一字段 `fetch_url` 在列表/搜索称「接码地址」，在导入提示/后端称「收件地址」，措辞不一致（见 #13）。
- 统计卡为**全库口径**，不随筛选/搜索变化（见 #16）。
- 邮箱**导出无选项弹窗**：UI 只调 `fetchMailboxesExportText()`（默认 `only_unused=false` 导出全部）；api.ts 的 `fetchMailboxesExportText(onlyUnused)` 与后端 `/api/mailboxes/export?only_unused=` **支持仅导出待注册，但前端未暴露该入口**（见 #28）。
- 状态优先级 `used > in_use`：`used=true` 的邮箱即便 `in_use=true` 也显示「已注册」，且不计入 `in_use` 统计（见 #8/#15）。
