# 诊断对照表

> **用法**：本表只做「索引 + 验证清单」，**不得**把「可能方向」直接当根因写进报告。根因必须来自 brief 字段或 CDP 实机输出。

## 失败信号 → 验证方向（非根因）

| 信号 | 先查 brief 字段 | 可能方向（须单独证实） | 证据不足时补什么 |
|------|-----------------|------------------------|------------------|
| `reason` 含 超时/timeout | logs_tail 末行、manifest 末步、代理耗时 | 代理慢、死等、register_timeout | kill_reason、last_url、last_step |
| `reason` 含 rate/limit/unusual/captcha | visible_ui.hints、URL | 风控 | 风控页 snapshot、response 摘要 |
| `visible_ui.hints` 验证码/无效 | failed_step、pageState、`fetch_url` | 收码慢、旧码、填码 selector、chrome-error | **取件页 `limit` 放大**看历史邮件时间与正文；fillCode note、submit 后 URL |
| `reason` 含验证码/收码/OTP/mail | `fetch_url`、logs_tail 收码相关行 | 邮件未到、旧码、基线时间过滤、取件页解析 | 浏览器打开 `fetch_url` 改 `limit=10`；对照 subject/到达时间 |
| `failed_step` register-02* | visible_ui.buttons | 注册按钮/邮箱兜底文案 | record note：点击尝试列表与命中 |
| `failed_step` register-04* | manifest register-04 note | fillCode、submitCodeForm | selector 命中、填回值校验 |
| `failed_step` step8-* | visible_ui、pageState | 安全页 selector、密码/2FA | step8 各子步 record note |
| register-05* + new_needs_profile + 二次验证码 | isOnCodePage、manifest register-05b | 资料页未提交/二次 OTP 无效 | PROFILE_SUBMIT_TEXTS、assertProfileReady、register-05b record |
| `reason` 资料页生日/年龄未填写 | visible_ui body_preview、008 HTML spinbutton、`register-05-profile-fill-fail` | spinbutton 日/月未补零或读回失败；hidden birthday 空 | fillBirthday spin 读回；mark spinDay/Month/Year；CDP DateField 复测 |
| `reason` 浏览器引擎未返回结果 + final-error-scene note | engine_error、abnormal_reason | Python EOF 未读 error 事件 | `_drain_worker_events`；brief 优先 manifest note |
| `logs_tail` 代理/连接错误 | 错误码原文 | 基础设施 | NDJSON 连接错误详情 |
| 无 failed_step、无存证 | kill_reason | 进程被强杀 | Python 杀进程前写入 |

## 何时必须 CDP（register-cdp-debug）

| 条件 | 要求 |
|------|------|
| 修复涉及 selector / 按钮文案 / humanClickByText | 必须先 snapshot + 手动 click 走通 |
| brief visible_ui 与 reason 对不上 | CDP 复现该步，禁止猜 pageState |
| manifest note 无 selector 命中信息 | 先补 record，再 CDP 确认 DOM |
| 改 auth-state.js classifyState | CDP 抓 URL + snapshot + classify 输入输出 |

## stepId → 代码

| stepId | 区域 |
|--------|------|
| register-01~06 | `node_engine/flows/openai/register.js` |
| register-00-goto-fail-* | `openWithRetry` page.goto 网络/超时失败 |
| register-00-goto-thin-* | `openWithRetry` 页面内容过少 |
| register-02* | 注册入口、emailTexts、邮箱输入 |
| register-04* | fillCode / submitCodeForm |
| register-05* | fillProfile、PROFILE_SUBMIT_TEXTS、register-05b-second-code |
| step8-* | step8_setupPasswordAnd2FA、selectors.js |
| forgot-* | forgotPasswordFlow |
| login-* | loginChatGPT |
| final-error-scene | manifest 倒数第二步才是真卡点 |

## 何时反向改代码（采集优先）

| 情况 | 动作 | 禁止 |
|------|------|------|
| recording_missing / 无 failed_step | 开存证 + 超时前写 last_step；brief 暴露 kill_reason | 猜 DOM 修复 |
| manifest 末步 ≠ failed_step | 抛错前 `record('final-error-scene', { note: err })` | 只改 failed_step 显示 |
| 知卡点不知 DOM | record 加 note：selector 结果、可见按钮快照 | 直接改 selectors |
| pageState 误判 | auth-state reason/evidence + brief 带出 | 未 CDP 就改 classifyState |
| 代理/网络 logs 无细节 | NDJSON 泵落连接错误码 | 归因为「代理问题」无日志 |
| 根因已修 | 补 brief 字段或更新本表 | 跳过 run-one 复测 |
