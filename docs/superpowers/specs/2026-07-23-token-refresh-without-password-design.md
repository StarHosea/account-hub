# 刷新 Token：按过期/Cookie 分流，支持无密码邮箱 OTP

日期：2026-07-23  
状态：已确认（方案 B）

## 背景

管理端「刷新 Token」在 Python 预检要求账号必须有 `email` + `password`，否则直接跳过（`reason=无邮箱密码`）。

实际上：

- OpenAI 上部分账号**未设置密码**，登录只需邮箱 + 邮箱验证码（OTP）。
- Node 侧 `loginChatGPT` **已支持**无密码 →「改用验证码」→ `requestCode(purpose=login)` 收码登录。
- 有 `browser_session` 时，可用 session 恢复 + reload 直接读新 AccessToken，不必重新登录。

当前阻塞点是 Python 预检过严，以及 `run_token_refresh` 一律 `fallbackLogin=True`，未按「JWT 是否过期 / 是否有 Cookie」分流。

## 目标

1. 点「刷新 Token」时：
   - **JWT 未过期且有 Cookie** → 只走 session 恢复，reload 后读 AccessToken（不 fallback 登录）。
   - **否则**（已过期、无 Cookie、或 session 失败）→ 走正常登录：有密码用密码，无密码用邮箱 OTP。
2. 取消「无密码一律跳过」；仅在确实无法登录时跳过。
3. 跳过原因与操作日志文案准确反映真实阻塞（邮箱缺失 / 无法收码等）。

## 非目标

- 恢复 `refresh_token` 无头 OAuth 刷新。
- 改写 Node `loginChatGPT` / `sessionRefreshChatGPT` 主状态机（已具备 OTP 能力）。
- 管理端单独「编辑密码」UI（本变更不依赖）。
- 批量自动刷新调度策略大改（仅对齐强制刷新路径；自动刷新预检若同样卡密码，一并放宽到同一规则）。

## 分流规则

对单条账号执行强制刷新时：

```
has_session = browser_session 含可用 cookies
token_fresh = JWT 可解析且未过期（可用现有 _token_expires_in > 0；强制刷新场景「未过期」按 exp>now）

if has_session and token_fresh:
    mode = session_only          # session_refresh, fallbackLogin=false
    if 失败:
        mode = login             # 降级到正常登录（见下）
else:
    mode = login

login:
    需要 email
    有 password → 密码登录（现有失败路径：OTP / 忘记密码重设）
    无 password → 邮箱 OTP（依赖收件地址 / mailbox）
```

「JWT 未过期但无 Cookie」按产品确认：**仍走正常登录**，换新 AccessToken。

## 预检（何时跳过）

允许执行，当且仅当具备邮箱，且满足以下任一：

| 条件 | 说明 |
|------|------|
| 有未过期 JWT + 可用 Cookie | session_only |
| 有 password | 可密码登录 |
| 有可用收件能力 | 无密码时可 OTP：`mailbox_service.get_fetch_url(email)` 非空（账号 `fetch_url` 或邮箱池绑定） |

跳过 reason（替换笼统的「无邮箱密码」）：

- `账号不存在`（保持）
- `无邮箱`
- `无密码且无法收码`（无 password、无收件能力，且不能走 session_only）

有 session 但 JWT 已过期：不跳过，走 login（session 可先试再降级，或直接 login；实现上优先 **先试 session 再 login**，因 Cookie 有时仍有效）。

> 实现备注：产品文案上「未过期 + Cookie → 只刷 AccessToken」；「已过期」即使有 Cookie 也进入 login 路径。可选优化：已过期但有 Cookie 时仍先试 session_only 再降级 login，以减少不必要登录——**推荐实现该优化**，与「session 失败则登录」一致。

## 组件改动

### 1. `services/register/openai_account_ops.py` — `run_token_refresh`

- 去掉「无邮箱或密码立即失败」的硬门槛；改为由调用方保证预检，或在此复用同一可执行性判断。
- 根据分流设置 `mode=session_refresh` + `fallbackLogin`：
  - session_only：`fallbackLogin=False`
  - 需登录：直接 `mode=login`，或 `session_refresh` + `fallbackLogin=True`（当有 Cookie 想先试时）
- 无密码时 `loginPassword` 传空字符串即可（Node 已处理）。

### 2. `services/account_service.py` — `refresh_account_tokens`

- 预检按上文放宽；跳过写操作日志时用新 reason。
- 调用刷新时传入/依赖分流结果；成功后照旧 `_apply_refreshed_tokens`；若返回 `reset_password` 则写回 `password`。

### 3. 自动刷新对齐（小范围）

- `refresh_access_token` 中「无邮箱/无密码则 return 现 token」与强制刷新同一可执行性：无密码但可收码时允许走浏览器登录。

### 4. 测试

- 更新/新增：无密码 + 有 fetch_url → 不跳过，会调用刷新（mock）。
- 无密码 + 无收件 + 无可用 session → 跳过，`reason=无密码且无法收码`。
- 未过期 + 有 Cookie → 走 session_only（`fallbackLogin=False`）。
- 已过期或无 Cookie → 走 login / fallback 登录。

## 验收

1. `tutti-68.napkins@icloud.com` 类账号（password 空、有 fetch_url、token 已失效）：点「刷新 Token」不再报「无邮箱密码」，进入浏览器邮箱 OTP 登录流程。
2. 有 Cookie 且 JWT 未过期：只 session 刷新，不触发密码/OTP 登录。
3. 无邮箱，或无密码且无法收码且不能 session_only：跳过，操作日志 reason 准确。
4. 现有有密码账号刷新行为不回归。

## 风险

- 无密码账号 OTP 失败时，现有 Node 可能走「忘记密码重设」并写回新密码——保持现有行为，本设计不禁止；若后续要禁止强行设密，另开变更。
- 收码依赖邮箱池/fetch_url 可用性；收不到码会表现为刷新失败而非预检跳过。
