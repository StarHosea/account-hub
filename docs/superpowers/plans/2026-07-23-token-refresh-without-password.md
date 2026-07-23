# Token Refresh Without Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「刷新 Token」按 JWT/Cookie 分流；无密码账号可走邮箱 OTP，不再因缺密码直接跳过。

**Architecture:** 在 `AccountService` 增加可执行性预检与跳过 reason；`run_token_refresh` 按 session_only / login 分流（未过期+Cookie 不 fallback；否则登录，无密码传空由 Node OTP）。自动刷新 `refresh_access_token` 预检对齐。

**Tech Stack:** Python, unittest, existing node_engine login/session_refresh

**Spec:** `docs/superpowers/specs/2026-07-23-token-refresh-without-password-design.md`

---

## File map

| File | Role |
|------|------|
| `services/account_service.py` | 预检、跳过 reason、`refresh_account_tokens` / `refresh_access_token` |
| `services/register/openai_account_ops.py` | `run_token_refresh` 分流 |
| `test/test_account_token_rotate_logs.py` | 跳过/允许用例 |
| `test/test_token_refresh_routing.py` | `run_token_refresh` 分流 mock 测试（新建） |

---

### Task 1: 预检与跳过 reason（AccountService）

**Files:**
- Modify: `services/account_service.py`
- Modify: `test/test_account_token_rotate_logs.py`

- [x] **Step 1: 改写失败测试** — 无密码无收件 → reason=`无密码且无法收码`；无密码有 fetch_url → 不跳过（mock rotate）

- [x] **Step 2: 跑测试确认失败**

- [x] **Step 3: 实现** `_token_refresh_skip_reason(account) -> str | None` 与 `refresh_account_tokens` 使用新预检；无邮箱 → `无邮箱`

- [x] **Step 4: 测试通过**

- [x] **Step 5: Commit** `fix(accounts): 刷新 Token 预检支持无密码 OTP`

---

### Task 2: `run_token_refresh` 分流

**Files:**
- Modify: `services/register/openai_account_ops.py`
- Create: `test/test_token_refresh_routing.py`

- [x] **Step 1: 写失败测试**（mock `_drive_worker`）
  - 未过期 + cookies → `session_refresh` 且 `fallbackLogin is False`
  - session_only 失败 + 有收件 → 再调 `login`
  - 无 session → 直接 `login`，密码可为空

- [x] **Step 2: 跑测试确认失败**

- [x] **Step 3: 实现分流**（去掉无密码硬失败）

- [x] **Step 4: 测试通过**

- [x] **Step 5: Commit** `fix(register): token 刷新按 session/login 分流`

---

### Task 3: 对齐 `refresh_access_token` 预检

**Files:**
- Modify: `services/account_service.py`（`refresh_access_token` 约 650–657）
- 可在 `test/test_account_token_rotate_logs.py` 或同文件加短测

- [x] **Step 1–4:** 无密码但可收码时不再直接 return 旧 token（mock `run_browser_login`）

- [x] **Step 5: Commit** `fix(accounts): 自动刷新预检与强制刷新对齐`

---

### Task 4: 验证

- [x] 跑相关 unittest 全绿
- [ ] 重启本地后端（若改动已加载）
