# 操作日志页面与 Token 刷新跳过日志补全

日期：2026-07-23  
状态：已确认

## 背景

账号页「刷新 Token」在账号无密码时会被预检跳过，Toast 只显示「跳过 N」，且不写入 `operation_logs`。后台因此看不到跳过原因。现有 `log_service` / `operation_logs` 已持久化账号操作日志，但管理端没有独立查看入口，也缺少对应 HTTP API。

## 目标

1. 补全 Token 刷新跳过/失败相关的操作日志，使后台可追溯。
2. 管理端新增独立菜单「操作日志」，查看并管理 `operation_logs`。
3. 范围限定为现有账号操作日志（`LOG_TYPE_ACCOUNT` / `LOG_TYPE_CALL`），不含注册机 SSE、激活运行日志、`server.log`。

## 非目标

- 不合并注册/激活实时日志流。
- 不做自动轮询刷新。
- 不重构为新的统一审计层；继续复用 `log_service` + `OperationLogStorage`。

## 设计

### 1. 补日志（Token 刷新）

在 `AccountService.refresh_account_tokens` 的 `_rotate_one` 预检路径中：

| 情况 | 现有行为 | 新行为 |
|------|----------|--------|
| 账号不存在 | 计入跳过，写入 progress errors，无操作日志 | 额外 `log_service.add(LOG_TYPE_ACCOUNT, "刷新 Token 跳过", {reason, token})` |
| 无邮箱或密码 | 同上 | 同上，`reason` 为「无邮箱密码」等明确文案 |
| 刷新失败 | 已有「刷新 Token 失败」日志 | 保持不变 |
| 刷新成功（已变化/未变化） | 已有成功日志 | 保持不变 |

前端 Toast：当存在 `result.errors` 或跳过/失败计数时，拼接首条（或汇总）错误原因，避免只显示「跳过 1」。

### 2. API

新增管理端接口（`require_admin`）：

- `GET /api/logs`
  - Query：`type`（可选）、`start_date`、`end_date`、`limit`（默认 200，上限与现有 storage 一致或明确封顶如 1000）
  - 响应：`{ items: OperationLog[] }`
  - 字段：`id`, `time`, `type`, `summary`, `detail`
- `DELETE /api/logs`
  - Body：`{ ids: string[] }`
  - 响应：`{ removed: number }`

实现：薄封装 `log_service.list` / `log_service.delete`，可放在 `api/system.py` 或新建 `api/logs.py` 并挂到 app router。

### 3. 前端页面

- 路由：`/logs`
- 侧栏菜单文案：`操作日志`（四字对齐现有 `NAV_LABELS`）
- 位置：放在「激活审计」与「系统设置」之间
- 页面能力：
  - 表格：时间、类型、摘要、详情（detail JSON 可读展示，可折叠或等宽文本）
  - 筛选：类型（全部 / account / call）、开始日期、结束日期
  - 多选删除（确认后调用 DELETE）
  - 手动刷新按钮（无自动轮询）
- 样式与交互对齐现有管理页（Semi Table + 顶栏筛选）

### 4. 数据与权限

- 数据源：PostgreSQL `operation_logs`（现有表，不改 schema）
- 权限：仅 admin；与其他管理 API 一致
- 日志 detail 中 token 继续使用 `anonymize_token`，不落完整 JWT

## 验收标准

1. 对无密码账号点击「刷新 Token」后，操作日志出现「刷新 Token 跳过」及 reason；Toast 能看到跳过原因。
2. 侧栏可进入「操作日志」，列表按时间倒序展示近期记录。
3. 按类型、日期筛选生效；选中删除后列表更新，`removed` 正确。
4. 未引入注册/激活日志合并或自动轮询。

## 实现顺序建议

1. 后端：补 Token 刷新跳过日志 + `/api/logs` API + 单测
2. 前端：API client、LogsPage、导航/路由
3. 本地：重启后端、构建 `web_dist`，用无密码账号回归一次刷新 Token
