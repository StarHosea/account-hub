# E2E 测试清单 — CDK管理（Cdks）

- 页面组件: `web/src/pages/CdksPage.tsx`
- 类型/接口: `web/src/lib/api.ts`（CDKs 段，`Cdk` / `CdkCounts` / `CdkType` / `CdkStatus` / `CdkListParams` / `CdkBoundAccount`）
- 后端: `api/cdks.py`、`services/cdk_service.py`（`MAX_IMPORT_ROWS = 2000`、`CDK_TYPES = (UPI, IDEL)`、状态 `available/used/invalid`）
- 相关组件: `web/src/components/MobileFilters.tsx`、`web/src/components/StatCards.tsx`
- 路由: `web/src/App.tsx` → `/cdks`（`AppLayout` 内，需登录）

安全标签说明: **SAFE** = 只读/不改库存；**REVERSIBLE** = 改动可再撤销；**DANGER** = 消耗/改写真实库存，谨慎执行（应在测试数据上做）。

约定: 桌面端渲染 Semi `<Table>`；移动端渲染 `CdkMobileList` 卡片流（`useIsMobile`）。分页 `PAGE_SIZE = 10`。搜索防抖 300ms。**进入页面默认 `statusFilter="available"`**（只看「激活中/可用」CDK）。CDK 展示经 `maskCdk`（长度>12 时 `前6...后4`）脱敏。

---

## 维度 1 · 加载 / 鉴权守卫 / 渲染 / 无 Console 报错

1. **未登录访问守卫** — 前置: 清除鉴权。步骤: 直接打开 `/cdks`。预期: `fetchCdks` 触发后端 `require_admin` 401，`request.ts` 拦截器跳 `${base}/login`；表格不渲染真实数据。安全: SAFE。
2. **已登录首屏加载** — 前置: 有效 admin 登录，库中已有 CDK。步骤: 打开页面。预期: 标题「CDK管理」；`StatCards` 4 张卡；表格列出首页（**默认仅 available**）10 条；`loading` 结束后无骨架。安全: SAFE。
3. **空态渲染** — 前置: CDK 库为空。步骤: 打开页面。预期: 桌面 `empty="暂无 CDK，先导入。"`；移动端卡片「暂无 CDK，先导入。」；4 张统计卡全为 0。安全: SAFE。
4. **加载失败提示** — 前置: 后端 `/api/cdks` 返回 5xx。步骤: 打开页面。预期: `Toast.error`「加载 CDK 失败」或后端 message；不崩溃。安全: SAFE。
5. **无 Console 报错** — 步骤: 首屏 + 翻页 + 开导入弹窗 + 开绑定账号弹窗 + 关闭，全程看 Console。预期: 无 React key 警告、无未捕获异常、无受控组件警告；`STATUS_TAG[s]` 对任意返回状态均有映射（不出现 undefined 取属性报错）。安全: SAFE。
6. **刷新按钮** — 步骤: 点右上「刷新」（`IconRefresh`）。预期: `load()` 重新拉取，按钮 `loading` 短暂出现；数据与统计卡刷新。安全: SAFE。

---

## 维度 2 · 数据字段与类型核对

`Cdk` 类型字段: `cdk / type / status / bound_token / bound_account? / used_at / imported_at / note`。

### 表格列（桌面）

7. **CDK 列（脱敏）** — 前置: 造一个长度>12 的 CDK。预期: 显示 `maskCdk`（`前6...后4`）等宽小字 + `IconCopy` 复制**完整** CDK（非脱敏值，copy 标签「CDK」）。安全: SAFE。
8. **类型列** — 预期: `type` 用 `Tag type="ghost"` 展示 `UPI` / `IDEL`。安全: SAFE。
9. **状态列 badge** — 前置: 造 available/used/invalid 三种。步骤: 观察。预期: `STATUS_TAG` 映射 `available→「激活中」(蓝) / used→「已激活」(绿) / invalid→「无效」(红)`。安全: SAFE。
10. **绑定账号列（穿透）** — 前置: 造 3 类：绑定账号存活 / `bound_token` 但账号已删 / 未绑定。预期: 有 `bound_account.email` → 蓝色链接按钮（点开详情弹窗）；仅 `bound_token` → 灰字「<脱敏token>（账号已删除）」；均无 → 「—」。安全: SAFE。
11. **创建时间列** — 预期: `imported_at` 经 `toLocaleString`；空显示「—」。**注意**: 列名「创建时间」对应字段 `imported_at`（导入时间），非 `used_at`。安全: SAFE。
12. **操作列** — 预期: `fixed:right`，仅删除按钮（`IconDelete` + `Popconfirm`「删除该 CDK？」）。安全: SAFE（分级见维度 4）。
13. **未展示字段（UI 缺口）** — 预期: **注意 discrepancy** — 类型含 `used_at`（消耗时间）与 `note`，后端 `_normalize` 也维护它们，但表格/卡片**无列展示**（`used_at` 只被撤销/消耗逻辑写入，前端不可见）。安全: SAFE。

### 统计卡（`counts` / `CdkCounts`）

14. **4 项计数映射** — 预期: 卡片依次为 可用总数`available`(绿) / CDK 总数`total` / `UPI（可用/已用/无效）`=`by_type.UPI.available / used / invalid` / `IDEL（可用/已用/无效）`=`by_type.IDEL` 三段拼接。安全: SAFE。
15. **counts 口径核对** — 前置: UPI/IDEL 各造若干 available/used/invalid。预期: 后端 `counts()`：`by_type[t][status]` 逐类逐状态计数；顶层 `available = Σ 各类 available`；`total = 全部 CDK 数`（含 used/invalid，故 `total ≥ available`）。安全: SAFE。
16. **counts 为全库口径** — 前置: 库中 >10 条含各状态/类型。步骤: 施加状态/类型筛选或搜索。预期: 统计卡数字**不随筛选变化**（后端注释「全库口径，不随筛选变化」，`counts()` 独立于过滤 items）；仅表格行数变化。安全: SAFE。
17. **无 Tab 组件（口径核对）** — 预期: **注意 discrepancy** — 页面**没有 Semi `Tabs`**；「状态」「类型」均为 `Select` 下拉筛选，统计为 `StatCards` 卡片。若测试计划提到「tab 切换」，实际对应的是**下拉筛选切换**（见维度 3）。安全: SAFE。

---

## 维度 3 · 交互（搜索 / 筛选 / 分页 / 选择 / 弹窗）

18. **搜索防抖** — 步骤: 搜索框快速输入。预期: 300ms 后才发一次 `/api/cdks?q=`；`onChange` 立即 `setPage(1)`。安全: SAFE。
19. **搜索多字段命中** — 前置: 造 CDK 值含关键词、及绑定账号邮箱含关键词各一。步骤: 分别搜。预期: 均命中（后端先按 `cdk` 粗筛，未命中再解析 `bound_email` 精筛）；placeholder「搜索 CDK / 绑定邮箱」。安全: SAFE。
20. **搜索清除** — 步骤: `showClear` 清除。预期: 恢复当前筛选下的列表。安全: SAFE。
21. **默认状态筛选 = 激活中** — 前置: 库含 available/used/invalid。步骤: 首次进入不操作。预期: 默认 `status=available`，列表只显示「激活中」；下拉初值即「激活中」。安全: SAFE。
22. **状态筛选 已激活(used)** — 步骤: 选「已激活」。预期: `status=used`，`setPage(1)`，仅 used。安全: SAFE。
23. **状态筛选 无效(invalid)** — 步骤: 选「无效」。预期: `status=invalid`，仅 invalid。安全: SAFE。
24. **状态筛选 全部** — 步骤: 选「全部状态」(value="")。预期: 不传 `status`，返回全部状态。安全: SAFE。
25. **类型筛选 UPI/IDEL/全部** — 步骤: 分别选。预期: `type=UPI|IDEL` 或不传（全部类型）；与状态筛选可叠加（后端先按 status 再按 type 过滤）。安全: SAFE。
26. **筛选叠加** — 前置: 造 UPI-used、IDEL-used。步骤: 状态选「已激活」+类型选「UPI」。预期: 仅 UPI 且 used。安全: SAFE。
27. **分页翻页** — 前置: 当前筛选下 >10 条。步骤: 点第 2 页。预期: `page` 变更重新拉取；桌面 `pagination` 与移动 `Pagination`（`total>pageSize` 才显示）同步。安全: SAFE。
28. **翻页后选中过滤** — 前置: 选中若干行后翻页。步骤: 观察 `selected`。预期: `load()` 内 `setSelected` 只保留当前页仍存在的 cdk（跨页选中被裁剪）。安全: SAFE（设计行为）。
29. **全选本页 / 单选** — 步骤: 桌面 `rowSelection`（rowKey=cdk），移动端「全选本页」+ 卡片 Checkbox。预期: `allOnPageSelected` 联动；选中后出现「已选 N 项」批量条（删除选中 + 撤销使用）。安全: SAFE。
30. **批量创建弹窗 打开+取消** — 步骤: 点「批量创建」开 Modal，选默认类型、输入后点取消/遮罩。预期: `maskClosable={false}` 仅按钮关闭；取消不落库；含「默认类型」`Select`（UPI/IDEL）与 TextArea（提示 `CDK-类型` 行内指定）；移动端 `fullScreen`。安全: SAFE。
31. **导出下拉展开** — 步骤: 点「导出」`Dropdown`。预期: 展开「导出全部 / 仅导出 UPI / 仅导出 IDEL」三项；点击各项触发对应导出。安全: SAFE。
32. **绑定账号详情弹窗 打开+关闭** — 前置: 一条绑定存活账号的 CDK。步骤: 点绑定账号链接。预期: Modal「绑定账号信息」`footer=null`，展示 存活/失效 Tag + plus_status Tag + 邮箱/接码地址/密码/2FA 密钥 四行（各含复制按钮，空值「—」不显复制）；点 X/遮罩关闭（`maskClosable={false}`）。安全: SAFE。
33. **绑定账号已删弹窗** — 前置: `bound_token` 存在但账号已删。步骤: （该行为灰字非链接，无法点开）观察列表。预期: 不进入详情弹窗；显示「（账号已删除）」。若 `detail` 恰为无 `bound_account`，弹窗显示「该账号已不存在。」。安全: SAFE。
34. **导入超限/空拦截** — 步骤: 粘贴 >2000 行或空 TextArea 点「批量创建」。预期: 前端 `countImportRows` 超限 → `Toast.warning`「单次最多导入 2000 条…」；空 → 「请粘贴 CDK」；均不发请求。安全: SAFE。

---

## 维度 4 · 按钮清单与安全分级（枚举全部）

> 顶部操作区

35. **刷新** `IconRefresh` — `load()`。安全: **SAFE**。
36. **批量创建**（打开 Modal） `IconUpload` primary — 仅打开弹窗。安全: **SAFE**（打开动作）。
37. **导出 → 导出全部** — `exportCdks()`（无 type），下载 `cdks-all-<ts>.txt`（`CDK-类型` 文本）；Toast「已导出全部 CDK」。安全: **SAFE**。
38. **导出 → 仅导出 UPI** — `exportCdks("UPI")`，下载 `cdks-UPI-<ts>.txt`。安全: **SAFE**。
39. **导出 → 仅导出 IDEL** — `exportCdks("IDEL")`，下载 `cdks-IDEL-<ts>.txt`。安全: **SAFE**。

> 批量创建弹窗内

40. **默认类型 Select（UPI/IDEL）** — 设置 `importType`，行内未指定 `CDK-类型` 时的回退类型。安全: **SAFE**。
41. **批量创建确认（okText「批量创建」）** — `importCdks(text, importType)`，去重新增/更新类型；Toast「导入完成，新增 X 个，更新 Y 个，跳过重复 Z 个」。安全: **REVERSIBLE**（新增 CDK 可再删除；先建后删组合用于回归）。

> 列内 / 卡片内（单条）

42. **复制 CDK** — `copy(cdk,"CDK")` 复制完整值。安全: **SAFE**。
43. **绑定账号链接** — `setDetail(c)` 打开详情弹窗（含账号密码/2FA 的只读展示与复制）。安全: **SAFE**（只读；注意含敏感凭据）。
44. **列内 删除**（`IconDelete` + `Popconfirm`「删除该 CDK？」） — `deleteCdks([cdk])`；Toast「删除 N 个」。安全: **DANGER**（永久移除）。

> 批量操作条（`selected.length>0` 时出现）

45. **删除选中**（`Popconfirm`「删除选中的 N 个？」） — `deleteCdks(selected)`。安全: **DANGER**（批量永久移除）。
46. **撤销使用**（`Popconfirm` 含警告文案，`okType=danger`、okText「确认撤销」） — `revokeCdkUse(selected)`；后端把选中 CDK 从 `used/invalid` **复位为 `available` 并清 `bound_token`+`used_at`**，使其可被重新领用；Toast「已撤销 N 个 CDK 的使用状态」。安全: **DANGER**（改写使用状态+解绑账号；仅程序误标时人工纠正）。

> DANGER 通用预期: 二次确认生效；撤销弹窗需显示危险提示内容「把 CDK 从『已用/无效』复位为『可用』…」；成功 Toast 正确；`load(true)` 静默刷新；统计卡随之更新。

---

## 维度 5 · 响应式（桌面 + 移动）

47. **桌面表格布局** — 前置: 宽视口。预期: `<Table>` `tableLayout=fixed`、`scroll={{x:990}}` 横向滚动，操作列 `fixed:right`；标题 heading 3。安全: SAFE。
48. **移动卡片流切换** — 前置: 窄视口（`useIsMobile`）。预期: 改为 `CdkMobileList` 卡片；标题 heading 4；顶部按钮换行；筛选控件宽度 100%。安全: SAFE。
49. **移动筛选抽屉** — 步骤: 点「搜索 / 筛选（N）」。预期: `MobileFilters` 右侧 `SideSheet`(82%)；`activeCount = (有搜索词?1:0)+(有状态?1:0)+(有类型?1:0)`；**注意**: 因默认 `status=available`，初次进入角标即显示「（1）」（含默认状态筛选）。安全: SAFE。
50. **移动卡片结构** — 预期: 顶行 勾选+脱敏CDK(点击复制)+类型 Tag+状态 Tag；绑定行 链接/「账号已删除」/「—」；底部 创建时间 + 复制 + 删除(Popconfirm)；选中卡边框变 primary。安全: SAFE（按钮分级见维度 4）。
51. **移动分页** — 预期: `Pagination` 仅在 `total>pageSize` 出现且居中。安全: SAFE。
52. **移动弹窗全屏** — 预期: 批量创建 Modal 与 绑定账号详情 Modal 均 `fullScreen`。安全: SAFE。

---

## 维度 6 · 主题（明/暗）与 i18n

53. **暗色主题** — 步骤: 切换 dark。预期: `StatCards` 语义色对比正常；状态 Tag（蓝/绿/红 light）与类型 Tag(ghost) 可辨；等宽脱敏 CDK 可读；绑定链接 `--semi-color-primary` 正常。安全: SAFE。
54. **明色主题** — 预期: 同上；选中卡边框/链接色正常。安全: SAFE。
55. **中文文案一致性** — 预期: 全部固定中文（「CDK管理」「批量创建」「导出」「刷新」「激活中/已激活/无效」「撤销使用」「绑定账号信息」「存活/失效」等）；无 i18n key 泄漏、无未翻译英文（`UPI/IDEL` 为类型标识、图标除外）。安全: SAFE。
56. **动态文案** — 预期: 「导入完成，新增 X 个…」「删除 N 个」「已撤销 N 个 CDK 的使用状态」「已选 N 项」「UPI（可用/已用/无效）N / N / N」渲染正确，无占位符残留。安全: SAFE。

---

## 已知 UI ↔ api.ts / 后端 差异汇总

- 页面**无 Tabs**：状态/类型均为 `Select` 下拉筛选；「tab 切换」实为下拉切换（见 #17）。
- 进入页面**默认 `status=available`**（只看可用），移动筛选角标初次即「（1）」；需手动选「全部状态」才看全量（见 #21/#49）。
- `Cdk.used_at` / `note` 后端维护但页面**无 UI 展示**（见 #13）。
- 列名「创建时间」实际绑定 `imported_at`（导入时间），非消耗时间 `used_at`（见 #11）。
- 统计卡为**全库口径**，不随筛选/搜索变化；`total ≥ available`（含 used/invalid）（见 #15/#16）。
- CDK 列表脱敏显示 `maskCdk`，但复制/导出为**完整值**；绑定账号详情弹窗明文展示密码与 2FA 密钥（凭据敏感面，测试环境注意）（见 #7/#32/#43）。
- `revokeCdkUse`（撤销使用）为**危险纠错入口**：把 used/invalid 复位 available 并解绑账号，不校验服务端真实可用性（见 #46）。
