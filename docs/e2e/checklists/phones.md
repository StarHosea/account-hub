# E2E 测试清单 — 手机号管理（Phones）

- 页面组件: `web/src/pages/PhonesPage.tsx`
- 类型/接口: `web/src/lib/api.ts`（Phones 段，`Phone` / `PhoneCounts` / `PhoneListParams`，`PHONE_MAX_USES = 3`）
- 后端: `api/phones.py`、`services/phone_service.py`（`MAX_USES = 3`、`COOLDOWN_SECONDS = 3600`、`RESERVE_STALE_SECONDS = 300`）
- 相关组件: `web/src/components/MobileFilters.tsx`、`web/src/components/StatCards.tsx`

安全标签说明: **SAFE** = 只读/不改库存；**REVERSIBLE** = 改动可再撤销；**DANGER** = 消耗/改写真实库存，谨慎执行（应在测试数据上做）。

约定: 桌面端渲染 Semi `<Table>`；移动端渲染 `MobileList` 卡片流（`useIsMobile`）。分页 `PAGE_SIZE = 10`。搜索防抖 300ms（`useDebouncedValue`）。

---

## 维度 1 · 加载 / 鉴权守卫 / 渲染 / 无 Console 报错

1. **未登录访问守卫** — 前置: 清除鉴权（无有效 admin key）。步骤: 直接打开手机号管理路由。预期: `fetchPhones` 触发 `require_admin` 401，`httpRequest` 走 `redirectOnUnauthorized` 跳登录页；页面不渲染表格数据。安全: SAFE。
2. **已登录首屏加载** — 前置: 有效 admin 登录，库中已有手机号。步骤: 打开页面。预期: 顶部标题「手机号管理」；`StatCards` 6 张卡渲染；表格/卡片列出首页 10 条；`loading` 结束后无骨架。安全: SAFE。
3. **空态渲染** — 前置: 手机号库为空。步骤: 打开页面。预期: 桌面表格显示 `empty="暂无手机号，先导入。"`；移动端卡片显示「暂无手机号，先导入。」；6 张统计卡全为 0。安全: SAFE。
4. **加载失败提示** — 前置: 后端 `/api/phones` 返回 5xx。步骤: 打开页面。预期: `Toast.error`「加载手机号失败」或后端 message；不崩溃。安全: SAFE。
5. **无 Console 报错** — 步骤: 首屏加载 + 翻页 + 打开导入弹窗 + 关闭，全程看 DevTools Console。预期: 无 React key 警告、无未捕获异常、无 PropType/受控组件警告。安全: SAFE。
6. **刷新按钮** — 步骤: 点击右上「刷新」（`IconRefresh`）。预期: `load()` 重新拉取，按钮 `loading` 态短暂出现；数据与统计卡刷新。安全: SAFE。

---

## 维度 2 · 数据字段与类型核对

`Phone` 类型字段: `phone / fetch_url / used / used_count / invalid / cooldown_until / reserved_at? / last_used_at / imported_at / note / checkout_at? / checkout_meta? / checkout_records?`。

### 表格列（桌面）

7. **手机号列** — 预期: `phone` 等宽字体展示 + `IconCopy` 复制按钮。安全: SAFE。
8. **接码地址列** — 预期: `fetch_url` 省略号+悬浮 tooltip，含复制与 `IconExternalOpen` 新开链接；空值显示「—」。安全: SAFE。
9. **状态列 badge** — 前置: 造 4 种号（可用 / 冷却中 / 已使用 / 无效）。步骤: 观察 `Tag`。预期: 由 `phoneStatus()` 判定优先级 `invalid(红) > used(灰) > cooldown(琥珀) > 可用(绿)`；冷却态文案为 `cooldownLeft()`，如「冷却 42 分」或「冷却 1 时 05 分」。安全: SAFE。
10. **使用次数列 / max_uses badge** — 前置: 一个 `used_count=2` 的号。预期: 显示 `2/3`（`PHONE_MAX_USES=3`，分母灰色小字）；核对与后端 `MAX_USES=3` 一致。安全: SAFE。
11. **最近使用列** — 预期: `last_used_at` 经 `fmtTime` 本地化；空显示「—」。安全: SAFE。
12. **发货信息列（checkout_meta）** — 前置: 一个已出库并带 meta 的号。预期: 第一行 `customer`（空显「—」），第二行 `wechat / xianyu / plan` 过滤空值后用「 / 」拼接。安全: SAFE。
13. **发货时间列** — 预期: 取 `checkout_at || checkout_meta.checkout_at`，经 `fmtTime`。安全: SAFE。
14. **导入时间列** — 预期: `imported_at` 经 `fmtTime`。安全: SAFE。

### 统计卡（`counts` / `PhoneCounts`）

15. **6 项计数映射** — 预期: 卡片依次为 总数`total` / 可用`available`(绿) / 冷却中`cooldown`(黄) / 已使用`used`(灰) / 无效`invalid`(红) / 累计次数`total_uses`。安全: SAFE。
16. **counts 为全库口径** — 前置: 库中 >10 条，含各种状态。步骤: 施加搜索或状态筛选。预期: 统计卡数字**不随筛选/搜索变化**（后端 `list_phones` 里 `counts()` 全库计算，注释「全库口径，不随筛选变化」）；仅表格行数变化。安全: SAFE。
17. **available 语义核对** — 前置: 造一个 `reserved_at`（发号预占，未过期）的号。步骤: 看统计。预期: 该号**不计入 available**（`_is_available` 排除 reserved/cooldown/used/invalid/used_count≥3），但也不出现在 cooldown/used/invalid 计数中 → 因此 `total ≠ available+cooldown+used+invalid`（预占是隐藏中间态）。安全: SAFE。
18. **total_uses 累加** — 预期: `total_uses` = 全部号 `used_count` 之和（不是记录数）。安全: SAFE。
19. **checkout_records 存在性（UI 缺口）** — 前置: 一个号多次出库（`checkout_records` 数组>1）。步骤: 检查表格。预期: **注意 discrepancy** — `Phone.checkout_records` 类型已定义、后端 `add_usage`/`checkout` 会追加历史记录，但 `PhonesPage.tsx` 只渲染最新 `checkout_meta`，**历史 checkout_records 无任何 UI 展示**。安全: SAFE。
20. **reserved_at 不可见（UI 缺口）** — 前置: 一个被发号预占（`reserved_at` 未过期）但未出库的号。预期: **注意 discrepancy** — `phoneStatus()` 不识别 reserved，该号在列表中仍显示为绿色「可用」标签，与发号侧「已锁定不可再发」口径不一致。安全: SAFE。

---

## 维度 3 · 交互（搜索 / 筛选 / 分页 / 弹窗）

21. **搜索防抖** — 步骤: 在搜索框快速输入。预期: 300ms 后才发一次 `/api/phones?q=`；输入即 `setPage(1)` 回到首页。安全: SAFE。
22. **搜索多字段命中** — 前置: 造带 `checkout_meta` 的号。步骤: 分别搜 手机号 / 接码地址 / 客户 / 微信 / 闲鱼 / 套餐。预期: 均能命中（后端匹配 phone/fetch_url/customer/wechat/xianyu/plan/note）。**注意**: placeholder 未列出「备注(note)」但后端实际也搜 note。安全: SAFE。
23. **搜索清除** — 步骤: 点搜索框 `showClear` 清除。预期: 恢复全量列表。安全: SAFE。
24. **状态筛选 未使用(0)** — 步骤: 下拉选「未使用」。预期: `used=0` 传参，`setPage(1)`；仅显示 `used=false` 的号（含冷却中的号，因冷却态 `used=false`）。安全: SAFE。
25. **状态筛选 已使用(1)** — 步骤: 选「已使用」。预期: `used=1`，仅 `used=true` 的号。安全: SAFE。
26. **筛选无「冷却/无效」独立项（口径核对）** — 预期: 下拉仅「全部/未使用/已使用」三项；无法单独筛冷却或无效（`PhoneListParams.used` 仅 `"0"|"1"`）。安全: SAFE。
27. **分页翻页** — 前置: >10 条。步骤: 点第 2 页。预期: `page` 变更触发重新拉取；表格 `pagination` 与移动端 `Pagination`（`total>pageSize` 才显示）同步。安全: SAFE。
28. **翻页后选中过滤** — 前置: 选中若干行后翻页。步骤: 观察 `selected`。预期: `load()` 里 `setSelected` 只保留当前页仍存在的 phone（跨页选中会被裁剪）。安全: SAFE（注意此为设计行为，测试勿误判为 bug）。
29. **全选本页 / 单选** — 步骤: 桌面用 `rowSelection`，移动端用「全选本页」Checkbox 与卡片 Checkbox。预期: `allOnPageSelected` 正确联动；选中后出现批量操作条「已选 N 项」。安全: SAFE。
30. **导入弹窗打开+取消** — 步骤: 点「导入」打开 Modal，输入后点取消/遮罩。预期: `maskClosable={false}`，只能按钮关闭；取消不落库；移动端 `fullScreen`。安全: SAFE。
31. **导出下拉展开** — 步骤: 点「导出」`Dropdown`。预期: 展开「全部到剪贴板 / 仅未使用到剪贴板」，有选中时追加「选中 N 个到剪贴板」。安全: SAFE。

---

## 维度 4 · 按钮清单与安全分级（枚举全部）

> 顶部与批量条

32. **刷新** `IconRefresh` — 重新加载。安全: **SAFE**。
33. **导出 → 全部到剪贴板** — `fetchPhonesExportText(false)`，复制 `手机号----接码地址` 文本。安全: **SAFE**。
34. **导出 → 仅未使用到剪贴板** — `fetchPhonesExportText(true)`。安全: **SAFE**。
35. **导出 → 选中 N 个到剪贴板** — 内存拼装 `p.fetch_url ? phone----url : phone`。安全: **SAFE**。
36. **批量条 · 导出到剪贴板** — `exportSelectedToClipboard`。安全: **SAFE**。
37. **导入（Modal 确认「导入」）** — `importPhones(text)`，新增/更新去重号；Toast「导入完成，新增 X 更新 Y」。安全: **REVERSIBLE**（新增的号可再删除；先导入后删的组合用于回归）。
38. **列内 复制手机号 / 复制接码地址 / 新开接码链接** — `copy` / `window.open`。安全: **SAFE**。
39. **列内 次数+1**（`IconPlus`，显示 `used_count/3`） — `addPhoneUsage([phone],1)`；`p.used` 时按钮 disabled。安全: **DANGER**（消耗真实使用次数，累计到 3 会自动置「已使用」，改写库存）。
40. **列内 标记已用/未用**（`IconTick`/`IconClose`） — `setPhonesUsed([phone], !used)`；标记「未用」会**清零 used_count + 解除冷却/无效 + 清 checkout_meta**（后端 `mark_used` 分支）。安全: **DANGER**（改写状态，尤其标记未用会抹掉出库记录字段）。
41. **列内 删除**（`IconDelete` + `Popconfirm`「删除该手机号？」） — `deletePhones([phone])`。安全: **DANGER**（永久移除）。
42. **批量 次数+1** — `addPhoneUsage(selected,1)`。安全: **DANGER**。
43. **批量 标记已用** — `setPhonesUsed(selected,true)`。安全: **DANGER**。
44. **批量 标记未用** — `setPhonesUsed(selected,false)`。安全: **DANGER**（批量清零+清出库信息）。
45. **批量 删除选中**（`Popconfirm`「删除选中的 N 个？」） — `deletePhones(selected)`。安全: **DANGER**。

> 每个 DANGER 用例的通用预期: 二次确认/disabled 生效；成功 Toast 文案正确；`load(true)` 静默刷新；统计卡随之更新。

46. **达上限自动置已使用（DANGER 边界）** — 前置: `used_count=2` 的号。步骤: 「次数+1」。预期: 变 `3/3`，状态 badge 变「已使用」，`used=true`，之后「次数+1」按钮 disabled。安全: **DANGER**。

---

## 维度 5 · 响应式（桌面 + 移动）

47. **桌面表格布局** — 前置: 宽视口。预期: `<Table>` `tableLayout=fixed`、`scroll={{x:1000}}` 横向滚动，操作列 `fixed:right`。安全: SAFE。
48. **移动卡片流切换** — 前置: 窄视口（`useIsMobile` 命中）。预期: 改为 `MobileList` 卡片；标题 heading 4；顶部操作按钮换行占满。安全: SAFE。
49. **移动筛选抽屉** — 步骤: 点「搜索 / 筛选（N）」。预期: `MobileFilters` 从右侧 `SideSheet`(82%) 划出；`activeCount = (有搜索词?1:0)+(有状态筛选?1:0)` 正确显示；含「查看结果」关闭按钮。安全: SAFE。
50. **移动卡片操作区** — 预期: 每卡「次数 x/3」「标记已用/未用」「删除(Popconfirm)」大按钮；`checkout_meta` 存在时显示发货两行；分页仅在 `total>pageSize` 出现且居中。安全: SAFE（点击按钮本身按维度 4 分级）。
51. **移动导入弹窗全屏** — 预期: 导入 Modal `fullScreen`，TextArea `rows=12`。安全: SAFE。

---

## 维度 6 · 主题（明/暗）与 i18n

52. **暗色主题** — 步骤: 切换 dark。预期: `StatCards` 用 `var(--semi-color-*)` 语义色（success/warning/tertiary/danger）在暗色下对比正常；`Tag` 各状态色可辨；等宽手机号可读。安全: SAFE。
53. **明色主题** — 预期: 同上，边框/选中态 `--semi-color-primary` 正常。安全: SAFE。
54. **中文文案一致性** — 预期: 所有标签为固定中文（「手机号管理」「导入」「导出」「可用」「冷却中」「已使用」「无效」「累计次数」等）；无 i18n key 泄漏、无未翻译英文（图标除外）。安全: SAFE。
55. **动态文案** — 预期: 冷却剩余「冷却 N 分 / N 时 N 分」、导入结果「新增 X 更新 Y」、次数 `n/3`、「已选 N 项」渲染正确无占位符残留。安全: SAFE。

---

## 已知 UI ↔ api.ts / 后端 差异汇总

- `Phone.checkout_records`（历史出库记录）后端会写入，但页面仅展示最新 `checkout_meta`，历史无 UI（见 #19）。
- `Phone.reserved_at`（发号预占）不参与 `phoneStatus`，预占中的号仍显示「可用」（见 #20）。
- 搜索 placeholder 未提「备注/note」，后端实际也按 note 匹配（见 #22）。
- 统计卡为**全库口径**，不随筛选变化（见 #16）；`total` 不等于各状态计数之和，因预占是隐藏态（见 #17）。
- 状态筛选仅 `used=0/1`（`PhoneListParams.used`），无法单独筛「冷却中/无效」；冷却态归入「未使用」（见 #24/#26）。
