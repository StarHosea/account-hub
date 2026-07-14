# 会员账号列表出库状态列设计

## 目标

会员账号列表能直观看到每条账号的出库状态与出库时间，无需只靠筛选项判断。

## 范围

- 仅会员账号页（`AccountsPage` 且 `planType === "plus"`）。
- 桌面表格与移动端卡片都展示。
- 免费账号页、出库筛选、批量标记出库/撤销出库、发号流程均不改动。
- 不新增后端接口或持久化字段。

## 数据

沿用账号列表已返回的：

- `account.dispatch.dispatched`：是否已出库
- `account.dispatch.dispatched_at`：出库时间（可为空）

读取方式与现有出库筛选一致（`filter_accounts` 使用 `dispatch.dispatched`）。

## 展示

### 桌面表格

在「状态」列之后增加「出库状态」列（仅会员页注入，与「激活时间」列同属 plus 专有列）：

- **已出库**：`Tag` color=`blue` type=`light` 文案「已出库」，其下用 `Text type="tertiary" size="small"` 显示 `formatDateTime(dispatched_at)`；若时间为空则只显示 Tag
- **未出库**：`Tag` color=`grey` type=`light` 文案「未出库」，不显示时间

Tag 风格与现有 `stageTag` 一致。

### 移动端卡片

在状态 Tag 旁增加同样的出库状态 Tag；已出库且存在 `dispatched_at` 时，在信息区补一行「出库 {formatDateTime(dispatched_at)}」。

### 不做

- 不展示客户/微信/备注等出库 meta
- 不改筛选文案与批量出库逻辑
- 不对旧字段 `used` / `checkout_at` 单独做兼容映射（由现有 `enrich` / `mark_used` 统一到 `dispatch`）

## 改动落点

- 主要：`web/src/pages/AccountsPage.tsx`
- 可选验证：在现有前端静态断言测试中增加「出库状态」相关断言（风格对齐 `test/test_web_account_actions.py`）

## 验证

- 会员页列表可见「出库状态」列；免费页不可见
- 已出库账号显示 Tag + 时间（有时间时）；未出库显示「未出库」
- 移动端卡片同样可见
- 标记出库 / 撤销出库后刷新列表，列内容随之更新
- 前端生产构建通过（按需）
