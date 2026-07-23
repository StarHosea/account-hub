# 操作日志控制台（最简）与 Token 刷新跳过日志补全

日期：2026-07-23  
状态：已确认

## 背景

「刷新 Token」在无密码等预检场景会被跳过，Toast 只显示「跳过 N」，且不写 `operation_logs`，后台无法排查。现有 `log_service` 已持久化账号操作日志，但管理端没有查看入口。

排查需要的是**可读的文本日志流**，不是表格详情页。

## 目标

1. 补全 Token 刷新跳过等缺失的操作日志。
2. 管理端独立菜单「操作日志」：控制台式文本输出，定时拉取并自动滚到底。
3. 支持一键清空全部操作日志。

## 非目标

- 类型/日期筛选、表格、多选删除、详情抽屉。
- 注册机 SSE、激活运行日志、`server.log`。
- WebSocket / SSE 推送（用短轮询即可）。

## 设计

### 1. 补日志（Token 刷新）

在 `refresh_account_tokens` 预检跳过时写入操作日志：

- 摘要：`刷新 Token 跳过`
- detail：`reason`（如「账号不存在」「无邮箱密码」）、`token`（`anonymize_token`）

失败/成功路径保持现有日志。前端 Toast 在跳过/失败时带上原因文案。

### 2. API

- `GET /api/logs?limit=500`（admin）→ `{ items: [{ id, time, type, summary, detail }] }`，时间倒序由 storage 提供；前端展示时可按时间正序渲染（旧→新，便于滚底）。
- `DELETE /api/logs`（admin）
  - 一键清空：`{ clear_all: true }` → 删除全部操作日志，返回 `{ removed: number }`
  - 也可保留按 `ids` 删除以复用现有 `log_service.delete`；页面只暴露「一键清空」。

实现：薄封装 `log_service`；若 storage 尚无 `clear_all`，在 `OperationLogStorage` / `LogService` 增加 `clear()`。

### 3. 前端

- 路由 `/logs`；侧栏「操作日志」（「激活审计」与「系统设置」之间）。
- 主区域：等宽字体文本区。每条一行（或摘要 + 同行 detail 简写），例如：
  - `[2026-07-23 22:24:00] [account] 刷新 Token 跳过  reason=无邮箱密码 token=token:xxxx`
- 打开后每 2–3 秒轮询；按 `id` 去重追加；靠近底部时自动滚到底；用户上翻则暂停自动滚，提供「回到底部」。
- 顶栏：暂停/继续轮询、一键清空（Popconfirm）、可选手动刷新。
- 不做筛选 UI。

### 4. 权限与安全

- 仅 admin。
- detail 中 token 继续脱敏，不落完整 JWT。

## 验收

1. 无密码账号点「刷新 Token」→ 文本区出现「刷新 Token 跳过」及 reason；Toast 可见原因。
2. 侧栏进入「操作日志」，能看到近期操作文本，并随新日志自动滚底。
3. 「一键清空」确认后列表为空，库内 `operation_logs` 清空。
4. 无表格/筛选/注册激活日志合并。

## 实现顺序

1. storage/service：`clear()` + 跳过日志 + `/api/logs` + 测试  
2. 前端：LogsPage 文本控制台 + 导航/路由  
3. 本地重启后端、构建前端，回归一次
