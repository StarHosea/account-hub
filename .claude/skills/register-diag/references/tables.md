# 诊断对照表

## 失败分类

| 信号 | 类型 | 典型原因 |
|------|------|----------|
| `reason` 含 超时/timeout | 超时 | 代理慢、死等、register_timeout 太短 |
| `reason` 含 rate/limit/unusual/captcha | 风控 | IP/指纹/频率 |
| `visible_ui.hints` 验证码/无效 | 验证码 | 收码慢、填码 selector、chrome-error 误判 |
| `failed_step` register-02* | 入口/邮箱 | 注册按钮文案、邮箱兜底 |
| `failed_step` register-04* | 验证码 | fillCode、submitCodeForm |
| `failed_step` step8-* | 加固 | 安全页 selector、密码/2FA |
| `pageState` 与 `url` 矛盾 | 状态机 | auth-state.js 误判 |
| `logs_tail` 代理/连接错误 | 基础设施 | ipweb 探活、代理不可用 |
| 无 failed_step、无存证 | 信息不足 | Python 超时杀进程 |

## stepId → 代码

| stepId | 区域 |
|--------|------|
| register-01~06 | `node_engine/flows/openai/register.js` |
| register-00-goto-fail-* | `openWithRetry` page.goto 网络/超时失败 |
| register-00-goto-thin-* | `openWithRetry` 页面内容过少 |
| register-02* | 注册入口、emailTexts、邮箱输入 |
| register-04* | fillCode / submitCodeForm |
| step8-* | step8_setupPasswordAnd2FA、selectors.js |
| forgot-* | forgotPasswordFlow |
| login-* | loginChatGPT |
| final-error-scene | manifest 倒数第二步才是真卡点 |

## 何时反向改代码

| 情况 | 动作 |
|------|------|
| recording_missing / 无 failed_step | 开存证 + 超时前写 last_step；brief 暴露 kill_reason |
| manifest 末步 ≠ failed_step | 抛错前 `record('final-error-scene', { note: err })` |
| 知卡点不知 DOM | record 加 note：selector 结果、可见按钮快照 |
| pageState 误判 | auth-state reason/evidence + brief 带出 |
| 代理/网络 logs 无细节 | NDJSON 泵落连接错误码 |
| 根因已修仍难定 | 补 brief 字段或更新本表 |
