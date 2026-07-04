# E2E 测试清单 — 注册机页 (RegisterPage)

- 源文件: `web/src/pages/RegisterPage.tsx`
- 相关组件: `web/src/components/StatCards.tsx`（通用统计卡，本页实际用内联 `OverviewCard`）、`web/src/components/LogPanel.tsx`（全局侧边「日志」，SSE 转发目标）、`web/src/components/RegisterPanel.tsx`（**号池管理页**页头启停条）、`web/src/components/RegisterConfigCard.tsx`（**设置页**注册配置卡）
- 数据/流: `web/src/lib/use-register-stream.ts`（`/api/register/events` SSE，挂在 AppLayout）、`web/src/store/settings.ts`（register 相关 action）
- API: `web/src/lib/api.ts` Register / register-abnormal / trial-check 段
- 后端: `api/register.py`、`services/register_service.py`、`api/system.py`
- 鉴权: 全部 register 接口 `require_admin`；本页应处于已登录 admin 会话下（经 `useAuthGuard`）。

> ⚠️ **实时运行警告**: 线上有一次**真实注册任务正在运行**。以下标 **DANGER** 的动作（启动/停止/重置统计、清空日志、删除异常账号）**一律只测到「确认弹窗弹出 → 取消」为止，绝不点确认执行**。DANGER 用例的「预期」只断言 UI 状态与二次确认，不断言真实副作用。

关键实现事实（用于断言）:
- 本页**不直接建 SSE**：读全局 `useSettingsStore.registerConfig`，由 AppLayout 的 `useRegisterStream` 持续喂入；首挂若无 config 调 `loadRegister(true)`（静默）。
- 资源概览 + 异常清单**每 5s 轮询**，且仅当 `document.visibilityState === "visible"` 时执行（后台标签页暂停）。
- 概览四卡: 「待注册（可用邮箱）」=`fetchMailboxes({page_size:1}).stats.unused`；「注册中」=`stats.running`；「成功」=`stats.success`；「失败」=`stats.fail`。待注册为 0 时该卡标红。
- 进度条 `percent = min(100, round(success/total*100))`（用 **success 而非 done**）；运行中描边 `--semi-color-success`。
- 启动前置校验: `mailboxUnused===0` → `Toast.warning` 拦截、不启动；`autoActivate && cdkAvailable===0` → 仅 `Toast.warning` 提示但仍继续 `toggleRegister()`。
- `启动数量/并发数` 编辑经 `setRegisterTotal/Threads` 只改本地 store，**运行中禁用**；真正落库发生在 `toggleRegister()` 启动前的 `updateRegisterConfig(buildRegisterPayload)`。
- Tab: `monitor`（注册监控，badge=running 数）/ `abnormal`（异常清单，badge=abnormalTotal）。
- 安全标签: SAFE / REVERSIBLE / **DANGER**（见上）。

---

## 1. 加载 / 鉴权守卫 / 首屏 / 无 console 报错

1. **首屏渲染** — 前置: admin 已登录。步骤: 访问 `/register`。预期: 标题「注册机」；四张概览卡、`启动设置`卡、`注册监控/异常清单` Tabs 均渲染；无 console error。标签: SAFE
2. **未登录守卫** — 前置: 清会话。步骤: 直接访问 `/register`。预期: `useAuthGuard` 跳 `/login`。标签: SAFE
3. **store 冷启动兜底** — 前置: 直接刷新 `/register`（SSE 尚未回帧）。步骤: 观察首屏。预期: `registerConfig` 为空时 `OverviewCard` 用 `?? 0` 兜底显示 0，进度条 0%，`注册数量/并发数` 回退 1；不崩溃、无 NaN。标签: SAFE
4. **SSE 接管刷新** — 前置: 停在页面。步骤: 等待 SSE 帧到达。预期: 概览与「正在注册账号」表随 `registerConfig` 更新，无需手动刷新。标签: SAFE
5. **后台标签暂停轮询** — 前置: 切到其他标签页。步骤: 观察网络。预期: `visibilityState!=="visible"` 时 5s 轮询跳过（不再打 mailboxes/cdks/activation/abnormal）；切回后恢复。标签: SAFE

## 2. 数据渲染 & 字段对齐（api.ts 类型 / 后端 stats）

6. **概览卡数据源正确** — 前置: 有数据。步骤: 核对四卡。预期: 待注册=`MailboxStats.unused`、注册中=`RegisterConfig.stats.running`、成功=`stats.success`、失败=`stats.fail`；数值与后端一致。标签: SAFE
7. **进度条口径** — 前置: 目标数 total>0。步骤: 核对进度。预期: 百分比= `success/total`（非 done/total），封顶 100%；total 缺省或 0 时显示 0%。标签: SAFE
8. **正在注册表列** — 前置: 有 running 任务。步骤: 看「正在注册账号」表。预期: 两列「邮箱」「注册详细状态」；`email` 空时显示灰字「任务 {index}」；`step` 文案按 `level`（red/green/yellow）着色；`rowKey=index`；无分页、`scroll.y=300`。标签: SAFE
9. **空态** — 前置: 无 running 任务。步骤: 看该表。预期: `Empty` 文案「当前没有正在注册的账号」。标签: SAFE
10. **资源为 0 告警条** — 前置: 可用邮箱=0（或开自动激活且 CDK=0）。步骤: 看`启动设置`卡头右侧。预期: `zerosWarning` 显示「以下资源为 0：可用邮箱/可用 CDK（自动激活需要）」，warning 图标+黄字。标签: SAFE
11. **stats 扩展字段未呈现（对齐检查）** — 前置: 后端 stats 含 `done/elapsed_seconds/avg_seconds/success_rate/current_available`。步骤: 全页查找。预期: 这些字段**本页均未展示**（见「差异记录」）；断言不因缺失报错即可，不要求 UI 显示。标签: SAFE

## 3. 交互（Tabs / 搜索 / 刷新 / 弹窗开+取消）

12. **Tab 切换** — 前置: 无。步骤: 在「注册监控」「异常清单」间切换。预期: `activeKey` 更新、内容切换；监控 tab badge=running 数（>0 才显示），异常 tab badge=abnormalTotal。标签: SAFE
13. **数量/并发编辑（未运行）** — 前置: 注册**未运行**。步骤: 改「注册数量」「并发数」。预期: InputNumber `min=1`；值写入 store、进度条分母随 total 变化；**注意仅本地，未落库**（落库需启动，见差异记录）。标签: REVERSIBLE
14. **数量/并发禁用（运行中）** — 前置: 运行中。步骤: 尝试改两个 InputNumber。预期: `disabled`，不可编辑。标签: SAFE
15. **异常清单搜索** — 前置: 异常清单 tab。步骤: 输入关键词按 Enter（或点刷新）。预期: 调 `fetchRegisterAbnormal({q, page_size:200})`，列表按关键词过滤；`showClear` 可一键清空。后端实际匹配 email/reason/**fetch_url**（占位符仅写「邮箱 / 原因」，见差异）。标签: SAFE
16. **刷新按钮** — 前置: 异常 tab。步骤: 点「刷新」。预期: 重新拉取异常清单，`abnormalLoading` 期间表格 loading 态。标签: SAFE
17. **删除弹窗开+取消** — 前置: 勾选 ≥1 条异常。步骤: 点「删除」弹出 Popconfirm →「取消」。预期: 弹窗标题「确认删除所选异常账号？」、内容「将删除 N 条记录」；取消后**不发 DELETE**、选择保留。标签: SAFE（仅验证弹窗；执行属 DANGER，见 #26）
18. **停止弹窗开+取消** — 前置: 运行中。步骤: 点「停止」弹 Popconfirm →「取消」。预期: 标题「确认停止注册？」内容「将中断正在进行的注册流程」；取消后任务继续运行、不发 stop。标签: SAFE（仅验证弹窗）
19. **清空日志弹窗/禁用** — 前置: 无日志时。步骤: 看「清空日志」按钮。预期: `registerLogs` 为空时按钮 `disabled`；有日志时可点（点击行为属 DANGER，见 #25）。标签: SAFE
20. **未选中时删除禁用** — 前置: 未勾选异常行。步骤: 看「删除」按钮。预期: `disabled`（`!selectedAbnormal.length`）。标签: SAFE

## 4. 动作按钮枚举（每个都打标签）

> 本页动作。DANGER 项**只测到弹窗/状态，不执行**。

21. **[启动注册] IconPlay** — 前置: 未运行、可用邮箱>0。步骤: 观察按钮（**不点确认执行**）。预期: 未运行时显示 solid primary「启动注册」；点击会 `toggleRegister()`（先 `updateRegisterConfig` 落 total/threads 再 `startRegister`）。可安全验证的分支见 #23/#24。标签: **DANGER**（拉起真实注册）
22. **[停止] IconStop（Popconfirm）** — 前置: 运行中。步骤: 见 #18 只开弹窗后取消。预期: 确认才会 `stopRegister`（中断在途浏览器）。标签: **DANGER**
23. **[启动] 无邮箱拦截（安全可执行）** — 前置: 可用邮箱=0。步骤: 点「启动注册」。预期: `Toast.warning("可用邮箱为 0，无法开始注册…")` 且**不启动**（`toggleRegister` 不被调用）——此分支不产生真实注册，可安全断言。标签: SAFE
24. **[启动] 自动激活缺 CDK 提示** — 前置: `auto_activate_after_register=true`、CDK=0、但可用邮箱>0。步骤: 观察点击后 toast。预期: 弹 `Toast.warning("已开启「注册后自动激活」但可用 CDK 为 0…")` **随后仍会 `toggleRegister()` 启动**——因会真启动，测试时避免在有邮箱环境点击；仅在 dry 环境验证 toast 文案。标签: **DANGER**（会启动）
25. **[清空日志] IconDelete** — 前置: 有日志。步骤: 观察（**不点**）。预期: 点击 `clearRegisterLogs()` → `POST /api/register/clear-logs`，清后 `Toast.success("已清空注册日志")`；仅清 logs 保留 stats。日志不可恢复。标签: **DANGER**
26. **[删除] 异常账号 IconDelete（Popconfirm）** — 前置: 勾选异常。步骤: 见 #17 只开弹窗后取消。预期: 确认才 `deleteRegisterAbnormal(emails)` → `DELETE /api/register/abnormal`。标签: **DANGER**
27. **[导出] 异常清单 IconDownload** — 前置: 异常 tab。步骤: 点「导出」。预期: `fetchRegisterAbnormalExportText()`（`GET /api/register/abnormal/export`）→ 生成 `register-abnormal-<ts>.txt` Blob 下载；纯读、不改服务端。标签: SAFE
28. **[刷新] 异常 IconRefresh** — 见 #16。标签: SAFE
29. **[行选择] 复选框** — 前置: 异常 tab。步骤: 勾/取消勾选行。预期: `selectedAbnormal` 随 `rowKey=email` 更新，联动「删除」禁用态与弹窗内「将删除 N 条」计数。标签: SAFE

### 关联页动作（读到但不在本页 —— 交叉引用）

30. **RegisterPanel（号池管理页头）启停 Switch** — 前置: 号池管理页。步骤: 观察。预期: `running` 时 Tag「运行中」(amber)、停止走 `Modal.confirm("确认停止注册机？")`；启动无确认直接 `toggle()`。启动/停止均 **DANGER**；「配置」按钮跳 `/settings` 为 SAFE。
31. **RegisterConfigCard（设置页）** — 前置: 设置页、注册未运行。步骤: 观察。预期: 「保存」`saveRegister`（运行中 `disabled`）为 REVERSIBLE；「重置统计」Popconfirm「确认重置统计？」→ `resetRegister` 为 **DANGER**（清空当前注册统计）；各输入（目标数量/并发/代理/区域多选/号一号一 IP/保活时长/2FA/邮箱模式/CloudMail 参数/收件超时三项）运行中全 `disabled`，属 REVERSIBLE 配置。

## 5. 响应式（桌面 + 移动）

32. **概览网格自适应** — 前置: 桌面 vs 移动。步骤: 切换视口。预期: `isMobile`（`useIsMobile`）为真时四卡 `repeat(2,1fr)`（两列），标题降为 `heading=4`；桌面 `repeat(4, minmax(0,200px))` 单行四卡、`heading=3`。标签: SAFE
33. **启动设置卡换行** — 前置: 窄屏。步骤: 看 `启动设置` 卡内 `Space wrap`。预期: 数量/并发/按钮在窄屏自动换行，不溢出；InputNumber 宽 140 不被截断。标签: SAFE
34. **表格横向滚动** — 前置: 窄屏、异常列较宽。步骤: 看异常表。预期: 列（邮箱 240 / 取件地址 / 原因 / 时间 160）在窄屏可横向滚动，`scroll.y=360` 纵向滚动生效；`ellipsis+showTooltip` 长文本悬浮可见。标签: SAFE
35. **主体最大宽** — 前置: 超宽屏。步骤: 观察。预期: 外层 `maxWidth:1080` 限制，内容不无限拉伸。标签: SAFE

## 6. 主题（明/暗）+ i18n

36. **明暗主题** — 前置: 切 light/dark。步骤: 遍历本页。预期: 卡片/文字/进度条/表格/日志区均用 `--semi-color-*`；日志级别色 red=`danger`/green=`success`/yellow=`warning` 两主题均可辨；`OverviewCard` 危险值用 `--semi-color-danger`。标签: SAFE
37. **日志区配色与等宽** — 前置: 有日志。步骤: 看`详细日志`。预期: 等宽字体 `--semi-font-mono`，时间前缀 `text-2` 灰、正文按 level 着色；空态「暂无日志」。标签: SAFE
38. **i18n / 文案** — 前置: 无。步骤: 检查文案。预期: 全中文硬编码（「注册机」「待注册（可用邮箱）」「注册中」「成功」「失败」「启动设置」「注册数量」「并发数」「启动注册」「停止」「注册监控」「异常清单」「正在注册账号」「详细日志」「清空日志」「导出」「刷新」「删除」等），无多语言切换、无缺失占位符。标签: SAFE

---

## 子专题 A — SSE 实时进度流（use-register-stream.ts）

- 端点: `GET {apiUrl}/api/register/events?token=<authKey>`（EventSource，token 走 query，因 EventSource 不能带 header）。后端每 0.5s 比对 payload，有变化才推 `data:`。
- onmessage: `JSON.parse` → `setRegisterConfig(data)`；并把**新增**日志行转发到全局「日志」侧边面板（scope=「注册机」）。level 映射: red→error、green→success、其它(含 yellow)→info。
- 首次连接只记录 `lastLen` 基线，不回灌历史日志；`logs.length < lastLen`（统计被重置）时从 0 重新转发。
- onerror: `es.close()` 并置空，**无自动重连**。

S1. **SSE 连接建立** — 前置: 已登录。步骤: 进入含 AppLayout 的任意页，查网络。预期: 一条 `text/event-stream` 长连接 `/api/register/events?token=…`，持续收帧。标签: SAFE
S2. **概览随帧更新** — 前置: 注册运行中。步骤: 观察四卡与进度条。预期: running/success/fail 随 SSE 帧变化，无需刷新。标签: SAFE
S3. **正在注册表随帧刷新** — 前置: 运行中。步骤: 看监控表。预期: `progress`（`RegisterProgressItem`）逐任务实时刷新 email/step/level。标签: SAFE
S4. **日志转发到侧边面板** — 前置: 运行中、打开右上「日志」侧边。步骤: 等新日志。预期: 新增行以 scope「注册机」出现在 `LogPanel`；level 按映射着色；历史行首连不回灌。标签: SAFE
S5. **无 token 不连** — 前置: 无 authKey。步骤: 观察。预期: `getStoredAuthKey` 为空时不建 EventSource。标签: SAFE
S6. **断线不自动重连（已知行为）** — 前置: 中断后端/网络。步骤: 触发 error。预期: `onerror` 关闭连接且不重连；页面转为依赖 5s 轮询兜底刷新概览/异常（但 progress/logs 停更）。标签: SAFE（记录为已知限制）
S7. **重置后日志基线归零** — 前置: 触发过统计重置使 logs 变短（仅观察，不主动执行 DANGER）。步骤: 观察转发。预期: `lastLen` 检测到变短后从 0 重放，不漏行。标签: SAFE

## 子专题 B — 异常账号清单（register-abnormal）

- API: `fetchRegisterAbnormal({q?, page?, page_size?})` → `{items, stats, total, page, page_size}`；`deleteRegisterAbnormal(emails)`；`fetchRegisterAbnormalExportText()`。
- 类型 `RegisterAbnormal = {email, fetch_url, reason, access_token, password, eligible, created_at}`；`RegisterAbnormalStats = {total, no_trial, other}`。
- 本页固定 `page_size:200`、`page` 默认 1、`Table pagination={false}`、`rowKey=email`。

B1. **列表加载** — 前置: 异常 tab。步骤: 打开。预期: 展示四列（邮箱/取件地址/原因/时间），卡标题「注册机异常账号清单（{total}）」，tab badge=total。标签: SAFE
B2. **空态** — 前置: 无异常。步骤: 打开。预期: `Empty`「暂无异常账号」。标签: SAFE
B3. **搜索命中** — 前置: 有异常。步骤: 输关键词。预期: 命中 email/reason/fetch_url（后端）；结果与 badge/total 更新。标签: SAFE
B4. **5s 自动刷新** — 前置: 停在异常 tab（前台）。步骤: 后端新增异常。预期: ≤5s 内列表与 total 自动更新。标签: SAFE
B5. **取件地址/原因省略与 tooltip** — 前置: 长 URL/长原因。步骤: 悬浮。预期: `ellipsis maxWidth:320` 截断 + tooltip 全文；原因红字 `type="danger"`。标签: SAFE
B6. **时间格式化** — 前置: 有 `created_at`。步骤: 看时间列。预期: `new Date(created_at).toLocaleString()`；缺省显示「—」。标签: SAFE
B7. **选择联动** — 见 #29。标签: SAFE
B8. **删除（弹窗+取消）** — 见 #17/#26。执行属 DANGER，测试只到取消。标签: SAFE
B9. **导出** — 见 #27。标签: SAFE
B10. **超 200 条截断（已知缺口）** — 前置: 异常 >200 条。步骤: 观察。预期: 因 `page_size:200` 且无分页，第 200 条之后不显示、无翻页入口（见差异记录）。标签: SAFE

---

## UI 与 api.ts / 后端差异记录（重点）

1. **`RegisterAbnormalStats.no_trial / other` 未呈现**: `fetchRegisterAbnormal` 返回 `stats{total,no_trial,other}`，但本页只用顶层 `total`（badge/标题），`no_trial`（无试用资格数）/`other` 分类**从不显示**。
2. **异常表缺列 `access_token` / `password` / `eligible`**: 类型 `RegisterAbnormal` 含这三字段，UI 只渲染 email/fetch_url/reason/created_at。尤其 **`eligible`（资格号/试用资格检测结果，boolean|null）** 无任何呈现——「资格号检测」在后端有产物但前端不可见。
3. **异常清单分页缺失**: `RegisterAbnormalListParams` 与后端（`page`, `page_size` ≤200）支持分页，UI 硬编码 `page_size:200`、`page` 恒 1、`pagination={false}`；>200 条静默截断，无翻页/页码控件。
4. **RegisterConfig 类型缺后端浏览器引擎字段**: 后端 `_default_config` / `RegisterConfigRequest` 含 `engine`、`headless`、`register_timeout`、`node_bin`、`ip_probe_retries`，而 api.ts `RegisterConfig` **未声明**这些字段，`RegisterConfigCard` 也不暴露——前端无法查看/配置浏览器内核参数与出口 IP 探活重试次数。
5. **stats 多字段未用**: `done`、`elapsed_seconds`、`avg_seconds`、`success_rate`、`current_available`、`started_at/updated_at/finished_at` 在本页均无展示。进度条用 `success/total` 而非 `done/total`；「待注册」卡用邮箱 `unused` 而非后端 `stats.current_available`（后端定义为「正常」账号数），二者语义不同、易混淆。
6. **trial-check 未在本页接线**: `fetchTrialCheckConfig/updateTrialCheckConfig`（`/api/trial-check`）在 api.ts 定义，但注册机页不引用（配置在设置页）；与异常 `eligible` 字段本应联动的「资格检测开关/结果」在本页无入口。
7. **`RegisterProgressItem.status / updated_at` 未显示**: 监控表只用 index/email/step/level，`status`（running/success/fail）与 `updated_at` 未呈现。
8. **搜索占位符与后端不一致**: 输入框提示「搜索邮箱 / 原因」，但后端同时匹配 `fetch_url`（取件地址），提示未涵盖。
9. **数量/并发编辑落库时机隐蔽**: RegisterPage 改「注册数量/并发数」只进 store，须待「启动注册」触发 `toggleRegister → updateRegisterConfig` 才落库；若不启动直接离开，改动丢失（且设置页 `RegisterConfigCard` 才是显式「保存」入口）。
10. **停止确认组件不一致**: RegisterPage 用 `Popconfirm`（内联气泡），RegisterPanel 用 `Modal.confirm`（居中弹窗）——两处「停止注册」交互形态不同，回归时需分别覆盖。
