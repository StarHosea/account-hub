---
name: register-cdp-debug
description: 注册机（node_engine 的 ChatGPT 注册/登录/加固流程）DOM/selector/文案/状态机问题排查。必须用 CDP 连 cloakbrowser stealth 浏览器实机验证，记录 snapshot/操作结果作为证据；验证通过后才可改 register.js/selectors.js。禁止未验证就猜修复。触发：注册卡住、selector 失配、register-diag 要求 CDP、页面结构变化、联调注册。
---

# 注册机 CDP 交互式联调

**用途**：把「猜测」变成「可引用的实机证据」。凡 DOM/selector/文案/页面状态相关结论，**必须**在本 Skill 流程里跑通并记录输出，否则不得改代码。

## 铁律

1. **必须用 CDP 连 cloakbrowser stealth 浏览器**（`cdp-serve.mjs`）——有 C++ stealth 指纹，过 OpenAI/Cloudflare 风控。
2. **绝不用 chrome-devtools MCP 的裸 Chrome**——无 stealth，DOM 是假象，结论无效。
3. **Agent 必须亲自跑命令**——不能「建议用户 CDP 验证」就结束；读 Skill 后立刻启动/连接 cdp-serve，执行 snapshot/click/fill，把输出贴进诊断报告。
4. **先证据后改码**：`snapshot` / `html` / `text` 确认真实文案与结构 → 手动 click/fill 走通 → 写回脚本 → 同会话复测 click → 最后 `run-one.mjs` 全链路。
5. **验证失败要如实写**：点不中、selector 找不到、页面未到预期步骤——记录命令与输出，**不得**换猜另一个 selector 而不说明前一次失败。
6. **禁止**：凭 brief 臆测页面文案；未 snapshot 就改 `humanClickByText` 数组；把「理论上应该」当验证通过。

## 机制

- `node_engine/scripts/cdp-serve.mjs`：cloakbrowser 启动 stealth 浏览器 + CDP 端口 + 打开站点，**保持存活**。
- `node_engine/scripts/cdp-drive.mjs`：`connectOverCDP` 执行单条命令后断开，浏览器状态保持。
- 底层：`cloakbrowser.js` 读到 `CLOAK_CDP_PORT` 时才加 `--remote-debugging-port`。

## 联调流程

### 0) 明确验证目标（来自 brief，不得凭空设）

从 `failed_step` + `visible_ui` + manifest note 写出**一条**可检验陈述，例如：

- 「在 register-02 步，页面上存在按钮 X，当前脚本文案 Y 点不中」
- 「fillCode 时 input[name=code] 不存在，实际为分格输入」

陈述引不出 brief 字段 → 先回 register-diag 补采集，不要开 CDP 瞎探。

### 1) 启动常驻 stealth 浏览器

```bash
cd node_engine
CLOAK_CDP_PORT=9222 node scripts/cdp-serve.mjs [--proxy http://user:pass@host:port] [--url https://chatgpt.com/] [--seed 12345]
```

等 `CDP endpoint: http://127.0.0.1:9222`。**带 `--proxy` 最接近生产**。

若 cdp-serve 已在跑（另一终端），直接第 2 步。

### 2) 逐步驱动、采集证据

每条：`CLOAK_CDP_PORT=9222 node scripts/cdp-drive.mjs <cmd>`

```bash
cdp-drive snapshot            # 首选：可见 按钮/输入/提示
cdp-drive url                 # URL / 标题
cdp-drive click "免费注册"     # 与 humanClickByText 同口径
cdp-drive fill "input[type=email]" a@b.com
cdp-drive press "input[name=code]" Enter
cdp-drive text 验证码
cdp-drive html 电子邮件
cdp-drive eval "location.href"
cdp-drive shot /tmp/x.png
```

**每条命令的输出都是证据**——诊断报告须引用 snapshot 中的实际按钮文案、selector 是否存在。

### 2.5) 取验证码（收码页）

```bash
node scripts/mailcode.mjs '<取件URL>' [--exclude 上次旧码] [--wait 30]
```

取到后：`cdp-drive fill "input[name=code]" <码>` → `cdp-drive click "继续"`。

### 3) 卡点修复循环（证据 → 改码 → 复测）

1. **看**：`snapshot` / `html <关键词>` / `text <关键词>` — 记录真实 DOM。
2. **手动探路**：用 cdp-drive 把该步走通；失败记录命令+输出，换法再试，直到前进。
3. **反向改脚本**：仅把**手动已验证**的文案/selector/顺序写回 `register.js` 或 `selectors.js`。
4. **同会话复测**：再用 cdp-drive 按脚本口径操作，确认能前进。
5. 下一步重复；全链路卡点扫清后做第 4 节完整复测。

### 4) 完整复测（改码后必做）

```bash
REG_RECORD_DIR=/tmp/rec REG_RECORD_KEEP=all node scripts/run-one.mjs --email <邮箱> --mail-url <取件地址>
```

用新 brief 确认 `failed_step` 前进、新 record note 有预期字段。

## 验证记录模板（写入 register-diag 报告）

```markdown
## CDP 验证
- 目标陈述：（来自 brief 的一条可检验句）
- 环境：cdp-serve [--proxy] / seed / URL
- snapshot 关键行：（粘贴按钮/输入/提示）
- 操作：（命令序列 + 成功/失败）
- 结论：已证实 / 未证实 — （若未证实，不得改代码）
- 改码：（仅已证实时：文件+改动摘要）
- run-one 复测：（邮箱 / 新 failed_step 或成功）
```

## register.js 常改锚点

| 卡点 | 位置 |
|---|---|
| 注册入口 | `registerChatGPT` 步骤2 文案 + `emailTexts` |
| 2FA 转邮箱 | `tryLoginMfaEmailFallback` 的 `switchTexts` / `emailTexts` |
| 输入框 | `selectors.js` |
| 页面状态 | `auth-state.js` `classifyState` |
| 验证码 | `fillCode` / `submitCodeForm` |
| chrome-error 误判 | `submitCodeForm({code})` + `recoverFromChromeError` |

## 辅助：失败留证

worker 失败留 `REG_RECORD_DIR/<邮箱>-<时间戳>/`（`recording.html` + `trace.zip`）。**联调用 CDP 实时证据；事后复盘用留证。**

## 收尾

`Ctrl-C` 或 kill cdp-serve。浏览器关不影响已记录的验证结论。
