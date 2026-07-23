# 操作日志控制台 Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** 补全 Token 刷新跳过日志；管理端「操作日志」为轮询自动滚动的文本控制台，支持一键清空。

**Architecture:** 复用 `log_service` + `operation_logs`；`GET/DELETE /api/logs`（支持 `clear_all`）；前端等宽文本区短轮询追加。

**Tech Stack:** FastAPI, log_service, React + Semi UI

---

### Task 1: Token 刷新跳过日志 + Toast 原因

- [x] 后端跳过写日志
- [x] Toast 展示跳过/失败原因

### Task 2: logs API 支持一键清空

- [x] `LogService.clear()` / storage `clear()`
- [x] `DELETE /api/logs` 支持 `{ clear_all: true }`
- [x] 测试通过

### Task 3: 前端控制台页

- [x] 文本控制台 + 2.5s 轮询 + 自动滚底
- [x] 暂停/继续、一键清空、回到底部
- [x] 去掉表格/筛选/多选

### Task 4: 本地验证

- [x] unittest
- [x] 重启后端、`npm run build`
