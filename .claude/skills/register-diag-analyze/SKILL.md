---
name: register-diag-analyze
description: 根据 account-hub 注册诊断链接（brief.md / brief JSON）拉取失败现场并输出可落地的修复建议。用于用户粘贴诊断 URL、要求分析注册失败、优化注册成功率、解读异常清单诊断链接。配合 register-cdp-debug 做 selector/文案验证。
---

# 注册诊断链接分析

用户给出诊断链接（或邮箱）时，**先拉取再分析**，输出可执行的修复建议，而不是泛泛猜测。

## 链接格式

| 类型 | URL 模式 |
|------|----------|
| Markdown 简报（首选） | `{base}/api/register/diag/brief.md` 或 `...?email=a%40b.com` |
| JSON 结构化 | 把 `brief.md` 换成 `brief`（同 query） |
| 异常列表 | `{base}/api/register/diag/list` |
| 元信息 | `{base}/api/register/diag/meta` |

常用 base：
- 本地：`http://127.0.0.1:8000`
- 生产：`https://hao.shuangdeng.space`（以设置里「诊断对外地址」为准）

无鉴权，直接 `curl` / WebFetch。

## 工作流（必须按序）

```
1. 取链 → 2. 拉 brief.md + brief JSON → 3. 分类 → 4. 定位代码 → 5. 出修复建议
```

### 1) 取链

用户可能给：
- 完整 URL → 直接用
- 仅邮箱 → 拼 `{base}/api/register/diag/brief.md?email={urlencode(email)}`
- 「最近失败」→ `{base}/api/register/diag/brief.md`
- 无 base → 先试本地 `http://127.0.0.1:8000/api/register/diag/meta`，不通再试生产

本地一键（仓库根目录）：

```bash
python3 scripts/fetch-register-diag.py --local --no-copy    # 本地最近失败
python3 scripts/fetch-register-diag.py --remote --no-copy   # 生产最近失败
python3 scripts/fetch-register-diag.py list --local         # 本地异常列表
```

### 2) 拉取

```bash
# Markdown（人读 + AI 主分析）
curl -fsSL 'http://127.0.0.1:8000/api/register/diag/brief.md?email=a%40b.com'

# JSON（manifest_tail / visible_ui / logs_tail 结构更完整）
curl -fsSL 'http://127.0.0.1:8000/api/register/diag/brief?email=a%40b.com'
```

若 JSON 含 `recording_missing`：说明无 DOM 存证（旧失败或存证关），分析只能依赖 `reason` + `logs_tail`，需提示用户**重新跑一轮失败**后再分析。

有存证且需网络时序：附加拉 `.../api/register/diag/trace?email=...`（Playwright trace，人本地 `npx playwright show-trace`）。

### 3) 失败分类（先归类再下结论）

| 信号 | 类型 | 典型原因 |
|------|------|----------|
| `reason` 含 `超时` / `timeout` | 超时 | 代理慢、某步死等、register_timeout 太短 |
| `reason` 含 `rate` / `limit` / `unusual` / `captcha` | 风控 | IP/指纹/频率；查代理与一号一 IP |
| `visible_ui.hints` 验证码/无效 | 验证码 | 收码慢、填码 selector、chrome-error 误判 |
| `failed_step` 在 register-02* | 入口/邮箱 | 注册按钮文案、使用邮箱兜底 |
| `failed_step` register-04* | 验证码 | fillCode、submitCodeForm |
| `failed_step` step8-* | 加固 | 安全页 selector、密码/2FA 开关 |
| `pageState` 与 `url` 矛盾 | 状态机 | `auth-state.js` 误判 |
| `logs_tail` 代理/连接错误 | 基础设施 | ipweb 探活、代理不可用 |
| 无 `failed_step`、无存证 | 信息不足 | Python 层超时杀进程，需新失败样本 |

### 4) stepId → 代码锚点

| stepId 前缀 | 文件 / 区域 |
|-------------|-------------|
| `register-01` ~ `register-06` | `node_engine/flows/openai/register.js` 注册主线 |
| `register-02*` | 点注册入口、`emailTexts`、邮箱输入 |
| `register-04*` | `fillCode` / `submitCodeForm` |
| `step8-*` | `step8_setupPasswordAnd2FA`、`selectors.js` |
| `forgot-*` | `forgotPasswordFlow` |
| `login-*` | `loginChatGPT` |
| `final-error-scene` | 看 manifest 倒数第二步才是真卡点 |

状态机：`node_engine/flows/openai/auth-state.js`  
选择器：`node_engine/flows/openai/selectors.js`

### 5) 输出报告（固定结构）

分析完必须按此模板回复：

```markdown
## 诊断摘要
- 邮箱 / 时间 / 失败原因（一句话）
- 卡点步骤：`failed_step` + 最后 URL
- 分类：<超时|风控|selector|验证码|代理|状态机|其他>
- 存证：<有/无>（recording_steps）

## 证据
- 关键 visible_ui（按钮/提示）
- manifest 末 2～3 步变化
- logs_tail 关键行（如有）

## 根因判断
<1～3 句，对应证据>

## 修复建议（按优先级）
1. **立刻可做**：<改 selector/文案/超时/配置，指向具体文件>
2. **需验证**：<用 register-cdp-debug 在真实页面试的操作>
3. **基础设施**：<代理/IP/邮箱，若非代码问题>

## 下一步
- [ ] 改代码 / 改设置 / CDP 联调 / 重跑失败样本
```

## 修复时的约束

- **最小改动**：优先改 `selectors.js` 文案数组或单点 selector，不大重构
- **文案失配**：对照 `visible_ui.buttons`，改 `humanClickByText` 的文案列表
- **不确定 DOM**：读 **register-cdp-debug** skill，CDP 实机验证后再改 `register.js`
- **成功率验证**：修完后看注册面板成功率，或针对同一步重跑单账号

## 与 fetch skill 的分工

- **register-diag-fetch**：只负责拿到链接/拉简报
- **本 skill**：拿到内容后的分类、定位、修复建议（用户贴链接分析时用这个）
