# E2E 测试清单 — 出库管理（Dispatch）

- 页面组件: `web/src/pages/DispatchPage.tsx`
- 类型/接口: `web/src/lib/api.ts`（Dispatch 段，`DispatchKind` / `DispatchItem` / `DispatchField` / `DispatchSummary`；`fetchDispatchSummary` / `acquireDispatch` / `dispatchAction` / `dispatchCheckout`）
- 后端: `api/dispatch.py`、`services/dispatch_service.py`、`services/phone_service.py`
- 关键口径: 账号发号来源 = 未出库的 **Plus 套餐**（按真实 `type` 判定）且状态不在 `{异常, 禁用}`；预占 `ACCOUNT_RESERVE_STALE_SECONDS=300s`；手机出库 +1 次并冷却 1h。

安全标签: **SAFE** = 只读/不改库存；**REVERSIBLE** = 可撤销；**DANGER** = 消耗/改写真实库存与远端账号状态。

> 重要: 本页几乎所有非「发号预览」操作都会消耗真实库存或改远端账号，请务必在**测试数据/测试库**上执行 DANGER 用例。

约定: 布局 `maxWidth:720` 居中；`useIsMobile` 控制堆叠与 `fullScreen` Modal。`kind` 默认 `"account"`。`kindLabel` = account→「Plus 账号」/ phone→「手机号」。

---

## 维度 1 · 加载 / 鉴权守卫 / 渲染 / 无 Console 报错

1. **未登录守卫** — 前置: 无有效 admin key。步骤: 打开出库管理。预期: `fetchDispatchSummary` 触发 401 → 跳登录；`refreshSummary` 内 `catch` 静默不弹错但整体走鉴权重定向。安全: SAFE。
2. **首屏加载 summary** — 前置: 有效登录。步骤: 打开页面。预期: 标题「出库管理」；`useEffect` 调 `refreshSummary()`；两个 Radio 显示「Plus 账号发号（剩 N）」「手机发号（剩 M）」；初始 `EMPTY_SUMMARY` 为 0 后被真实值替换。安全: SAFE。
3. **空态卡片** — 前置: 未发号。预期: 下方卡片显示「点击上方『发一个Plus 账号』开始」（跟随 `kindLabel`）。安全: SAFE。
4. **summary 拉取失败静默** — 前置: `/api/dispatch/summary` 5xx。步骤: 点「刷新可用」。预期: `refreshSummary` catch 吞掉错误，不弹 Toast，保留旧值；页面不崩。安全: SAFE。
5. **无 Console 报错** — 步骤: 加载 + 切换类型 + 发号 + 打开出库 Modal + 取消，观察 Console。预期: 无 key 警告、无未捕获异常、无受控组件警告。安全: SAFE。
6. **刷新可用按钮** — 步骤: 点右上「刷新可用」（`IconRefresh`）。预期: `refreshSummary`，两个 Radio 剩余数更新。安全: SAFE。

---

## 维度 2 · 数据字段与类型核对

`DispatchSummary` = `{ account_available, phone_available }`；`DispatchItem` = `{ kind, id, title, fields[], used_count?, max_uses? }`；`DispatchField` = `{ label, value }`。

7. **summary → Radio 剩余数** — 预期: `account_available` 显示在「Plus 账号发号（剩 …）」；`phone_available` 显示在「手机发号（剩 …）」。后端 `account_available` 来自 dispatch_service（Plus 未出库未预占存活数），`phone_available` 来自 `phone_service.counts().available`。安全: SAFE。
8. **账号卡片预览字段** — 前置: 发一个账号。预期: `item.kind="account"`，`title` = 邮箱（无邮箱则 `token[:12]`）；`fields` 仅含**有值**的 邮箱 / 密码 / 2FA 密钥（后端 `_account_card` 过滤空值）。安全: SAFE（发号=预占，见维度 4 分级）。
9. **手机卡片预览字段** — 前置: 发一个手机号。预期: `item.kind="phone"`，`title`=手机号；`fields` 含 手机号 / 接码地址 / 已用次数`x/3`（空值过滤）；带 `used_count`、`max_uses=3`。安全: SAFE。
10. **手机出库提示文案** — 前置: 发出的手机号卡片。预期: 底部「出库后该号使用次数 (used_count+1)/max_uses，并自动冷却 1 小时」，仅在 `kind==="phone" && item.max_uses` 时显示；账号卡片无此行。安全: SAFE。
11. **卡片标签与类型一致** — 预期: 卡片 title 区绿色 `Tag` 显示 `kindLabel`；`item.title` 等宽字体。安全: SAFE。
12. **发号排序口径提示** — 预期: 卡片下方灰字「按{账号=激活时间 / 手机=导入时间}最老优先，发号即锁定，确认出库前其他人不会拿到同一个号」；随 `kind` 切换文案变化。安全: SAFE。
13. **字段整体复制内容** — 步骤: 点「整体复制」。预期: 复制文本为 `fields.map(f => label: value).join("\n")`。安全: SAFE。

---

## 维度 3 · 交互（发号 → 预览 → 下一个 / 弹窗）

14. **发号 acquire→preview** — 前置: 有可用库存。步骤: 点「发一个{kindLabel}」（`IconSend`，block，`loading=busy&&!item`）。预期: `acquireDispatch(kind)` 返回 `item` 渲染卡片，`summary` 更新；按钮文案变「重新发一个」。安全: **DANGER 边界**（发号会**预占**库存，占用 300s；虽不消耗但会短时锁定真实号）。
15. **无可用发号** — 前置: 对应 kind 库存为 0。步骤: 观察发号按钮。预期: `disabled = availableOf(kind)<=0 && !item`；若强行（有旧 item 时按钮仍可点）返回 `item=null` 并 Toast.warning「暂无可发的 Plus 账号」/「暂无可发的手机号（可能都在冷却/已用尽）」。安全: SAFE。
16. **「不可用，下一个」** — 前置: 已有发出的 item。步骤: 点「不可用，下一个」（`IconRefresh`）→ `next()` = `acquire(item.id)`。预期: 先 `release_id` 释放当前预占再取下一个；**不消耗当前号**（仅释放，不 +1/不冷却）。安全: **REVERSIBLE**（释放+换号，原号回到可用池）。
17. **切换发号类型释放旧预占** — 前置: account 已发出 item。步骤: 切到「手机发号」Radio。预期: `switchKind` 先 `dispatchAction(kind,item.id,"release")` 释放账号预占，`setItem(null)`，刷新 summary；释放失败弹「释放当前号失败」。安全: **REVERSIBLE**。
18. **重新发一个** — 前置: 已有 item。步骤: 再点主发号按钮。预期: `acquire(item.id)` 释放当前并取新号（同 kind）。安全: **REVERSIBLE**。
19. **出库 Modal 打开+取消** — 步骤: 点「出库」打开 Modal，点取消/遮罩。预期: `openCheckout` 清空表单、按 kind 预填 `relatedPhone`/`relatedAccountToken`；取消不提交、item 保留；移动端 `fullScreen`。安全: SAFE。
20. **成套出库勾选联动** — 步骤: Modal 勾「成套发货」。预期: 标题变「成套出库」；`kind==="account"` 显示「关联手机号」输入，`kind==="phone"` 显示「关联成品号 access_token」输入。安全: SAFE。
21. **账号出库核验未通过保留卡片** — 前置: 账号发出后其远端已非 Plus/失效。步骤: 填表点「确认出库」。预期: `dispatchCheckout` 返回 `ok=false`，`Toast.error(message)`（如「核验未通过：账号非 Plus（当前套餐 …）」），关闭 Modal 但**保留 item**（未 `setItem(null)`），等管理员点「不可用，下一个」。安全: **DANGER**（触发远端 `fetch_remote_info` 刷新 token，含真实网络副作用）。
22. **复制单字段** — 步骤: 点卡片内任一字段或其复制按钮。预期: `copy(f.value, f.label)`。安全: SAFE。

---

## 维度 4 · 按钮清单与安全分级（枚举全部）

23. **刷新可用** `IconRefresh` — `refreshSummary`。安全: **SAFE**。
24. **Radio · Plus 账号发号 / 手机发号** — `switchKind`（含释放旧预占）。安全: **REVERSIBLE**（切换会 release 当前号）。
25. **发一个{kindLabel} / 重新发一个** `IconSend` — `acquireDispatch`。安全: **DANGER 边界**（预占真实库存，锁定 300s；重新发会先释放旧号——REVERSIBLE 部分）。
26. **整体复制 / 单字段复制** `IconCopy` — 剪贴板。安全: **SAFE**。
27. **出库** `IconTickCircle` — 打开 Modal → `submitCheckout` → `dispatchCheckout(kind,id,payload)`。账号侧先远端二次核验通过才 `mark_used`；手机侧 `checkout` **+1 次并冷却 1h**，满 3 置已使用；成套则连带 checkout 关联号。安全: **DANGER**（消耗真实库存/改远端账号已出库标记）。
28. **冷却** `IconClock`（仅 `kind==="phone"` 显示） — `dispatchAction(phone,id,"cooldown")` → 手机置冷却 1h、解预占，不 +1。安全: **DANGER**（改真实号状态，冷却期内不可再发）。
29. **无效** `IconClose`（`Popconfirm`「确认标记无效？…不可撤销」） — `dispatchAction(kind,id,"invalid")`。账号→置「禁用」并解预占；手机→`set_invalid` 永久不再发号。安全: **DANGER**（不可撤销，改写库存/远端状态）。
30. **不可用，下一个** `IconRefresh` — `next()`=release+acquire。安全: **REVERSIBLE**。
31. **确认出库（Modal onOk）** — `submitCheckout`。安全: **DANGER**（同 #27）。
32. **取消（Modal onCancel）** — 关闭不提交。安全: **SAFE**。
33. **成套出库连带核对（DANGER 组合）** — 前置: account 出库勾成套 + 填关联手机号。步骤: 确认出库。预期: 账号核验通过后 `checkout_phone_with_meta(related_phone)` 连带把关联手机号一并出库（+1/冷却）；Toast「已完成成套出库」。安全: **DANGER**（一次消耗两类库存）。

> 每个 DANGER 用例通用预期: 有 loading/Popconfirm 保护；成功后 `setItem(null)` 回到空态、`summary` 刷新、Toast 文案正确（「已出库」「已置冷却」「已标记无效」「已完成成套出库」）。

---

## 维度 5 · 响应式（桌面 + 移动）

34. **桌面布局** — 前置: 宽视口。预期: 容器 720 居中；标题与「刷新可用」同一行；Radio 非全宽；出库 Modal 常规尺寸。安全: SAFE。
35. **移动布局堆叠** — 前置: 窄视口。预期: 标题 heading 4 与按钮纵向堆叠占满；Radio `width:100%` 且每项 `flex:1` 居中平分；出库 Modal `fullScreen`。安全: SAFE。
36. **卡片操作按钮换行** — 前置: 移动端发出 item。预期: 出库/冷却/无效/下一个按钮 `flex:1 minWidth:96` 自动换行，拇指可点。安全: SAFE。

---

## 维度 6 · 主题（明/暗）与 i18n

37. **暗色主题** — 步骤: 切 dark。预期: 卡片、绿色 `Tag`、primary 发号按钮、danger「无效」按钮在暗色下对比正常；等宽字段可读。安全: SAFE。
38. **明色主题** — 预期: 同上于亮色正常。安全: SAFE。
39. **中文文案一致性** — 预期: 「出库管理」「刷新可用」「Plus 账号发号」「手机发号」「发一个…」「重新发一个」「整体复制」「出库」「冷却」「无效」「不可用，下一个」「记录出库信息」「成套出库」「确认出库」等均为固定中文；无 i18n key 泄漏。安全: SAFE。
40. **动态文案与占位符** — 预期: Radio 剩余数、`kindLabel` 插值、Modal 各 `placeholder`（客户名/微信号/闲鱼号/套餐/备注/关联…选填）、手机出库次数提示 `(used_count+1)/max_uses` 渲染无残留占位符。安全: SAFE。

---

## 已知 UI ↔ api.ts / 后端 差异汇总

- `dispatchCheckout` 的 `dispatchNo` 参数在页面从不传入，出库单号由后端 `build_dispatch_meta` 自动生成（`dispatch-<hash>`）——前端无输入框。
- `DispatchAction` 类型含 `"checkout"`，但页面用独立的 `dispatchCheckout()` 走 checkout 分支，`dispatchAction()` 仅用于 cooldown/invalid/release。
- 账号 `kind` 无「冷却」按钮（仅 phone 显示）；后端对账号 `cooldown` 动作实际等同 `release`（`api/dispatch.py` 注释「account 无冷却概念」）——UI 已正确隐藏，测试勿对账号触发冷却。
- 发号成功但库存变化依赖 `res.summary` 回填；`account_available`/`phone_available` 为发号那一刻快照，长时间停留后其他人可能已改动，需以「刷新可用」为准。
- 账号出库为**远端有副作用**操作（`fetch_remote_info` 刷新 token 可能轮换 access_token），非纯本地状态变更，DANGER 用例需联网环境。
