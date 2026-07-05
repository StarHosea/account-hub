---
name: register-cdp-debug
description: 注册机（node_engine 的 ChatGPT 注册/登录/加固流程）跑不通、卡在某一步、需要人机联调排查时使用。核心方法是用 CDP 连接 cloakbrowser 的 stealth 浏览器交互式驱动、逐步走流程、卡点停住看真实 DOM、当场改 register.js 的 selector/文案再验证。绝不用 chrome-devtools 的裸 Chrome（无 stealth 指纹会被 OpenAI 风控）。触发场景：注册机流程不通 / 注册卡住 / 联调注册 / selector 或文案没点中 / 页面结构变了 / CDP 调试浏览器。
---

# 注册机 CDP 交互式联调

注册机某一步跑不通（按钮点不中、selector 失配、文案变了、页面结构变化）时，用这套方法：用 CDP 连一个**过风控的真实浏览器**，逐步走流程、卡点停住看真实 DOM、当场修、当场验证，把所有卡点一轮扫清后再完整复测。

## 铁律（先记住）

- **必须用 CDP 连 cloakbrowser 的 stealth 浏览器**（`cdp-serve.mjs` 启动的那个）——它有 C++ 层 stealth 指纹，过 OpenAI/Cloudflare 风控，看到的才是真实注册页。
- **绝不用 chrome-devtools MCP 的裸 Chrome**——无 stealth，一连 chatgpt.com 就被风控挑战/降级，看到的 DOM 是假象，白调。

## 机制

- `node_engine/scripts/cdp-serve.mjs`：cloakbrowser 启动 stealth 浏览器 + 暴露 CDP 端口 + 打开站点，**保持存活**（前台常驻，Ctrl-C 关闭）。
- `node_engine/scripts/cdp-drive.mjs`：`connectOverCDP` 连上，执行一条命令后断开——**只断连、不关浏览器**，浏览器状态跨命令保持，可反复调用逐步推进。
- 底层：`cloakbrowser.js` 读到 `CLOAK_CDP_PORT` 时才给浏览器加 `--remote-debugging-port`（生产不设、零影响）。

## 联调流程

### 1) 启动常驻 stealth 浏览器（后台/另一终端）
```bash
cd node_engine
CLOAK_CDP_PORT=9222 node scripts/cdp-serve.mjs [--proxy http://user:pass@host:port] [--url https://chatgpt.com/] [--seed 12345]
```
等日志出现 `CDP endpoint: http://127.0.0.1:9222`。**带 `--proxy`（账号出口代理）最接近生产真实环境**；不带则直连。

### 2) 逐步驱动、看真实 DOM
每条：`CLOAK_CDP_PORT=9222 node scripts/cdp-drive.mjs <cmd>`
```bash
cdp-drive snapshot            # dump 可见 按钮/输入/提示 文案（定位 selector 的首选）
cdp-drive url                 # 当前 URL / 标题
cdp-drive click "免费注册"     # 按可见文案点击（与 humanClickByText 同口径：先全等后包含）
cdp-drive fill "input[type=email]" a@b.com
cdp-drive press "input[name=code]" Enter
cdp-drive text 验证码          # 只打印含关键词的正文行
cdp-drive html 电子邮件        # 打印含关键词的去标签片段（挖某选项的真实文案）
cdp-drive eval "location.href"
cdp-drive shot /tmp/x.png     # 截图
```

### 2.5) 取验证码（走到收码页时，免问人）
收码页需要邮箱验证码时，用 `mailcode.mjs` 从取件页自动提取：
```bash
node scripts/mailcode.mjs '<取件URL>' [--exclude 上次旧码] [--wait 30]
```
- **原理（关键）**：邮件正文在 `<iframe class="body-frame" srcdoc="&lt;...&gt;">` 里，srcdoc 是 **HTML 实体编码**的完整邮件，6 位码在其中是明文。提取步骤：**抽 iframe srcdoc → 实体解码（`&lt;`→`<` 等）→ 去标签 → 语境正则取码**。
- **踩过的坑**：直接对整页去标签，会把 `srcdoc="..."` 整个属性当标签删掉、连码一起丢，所以之前一直取不到。
- 触发新码后用 `--exclude <旧码> --wait 30` 轮询等新码到达、排除上一次的旧码。
- 取到后：`cdp-drive fill "input[name=code]" <码>` → `cdp-drive click "继续"`。

### 3) 卡点修复循环（核心）
卡住时**不要停、浏览器不关**，按这个循环自己往下探，直到走通：
1. **看**：`cdp-drive snapshot` / `html <关键词>` / `text <关键词>`，看卡住这一步的真实按钮/选项/输入/提示。
2. **手动探路**：直接用 cdp-drive 试着把这一步走通——换文案 `click`、换 selector `fill`、必要时 `eval` 直接操作 DOM。**先用手动把路走通**，确认页面前进到下一步（要人给的信息如验证码，问用户）。
3. **反向改脚本**：把手动验证过的正确做法（正确文案 / selector / 操作顺序）写回 `register.js`（`humanClickByText` 的文案数组）或 `selectors.js`。历史真例：`switchTexts` 写"其他方**式**"但页面是"尝试其他方**法**"；2FA 邮箱选项就叫纯"电子邮件"而 `emailTexts` 只有"通过电子邮件"。
4. **复测这一步**：再 `cdp-drive click "<新文案>"` 验证脚本口径也点得中、能前进。
5. 前进到下一步，重复。一步步把整条链路探通，**每个卡点都当场手动走通 + 反向改脚本 + 复测**。
6. 全部卡点走通后，用真实 worker 完整跑一遍（下一节）验证整条链路。

### 4) 全部卡点扫清后完整复测
worker 每次注册现 spawn、读磁盘最新代码，**改完不用重启后端**：
```bash
# Web 面板发起注册；或命令行：
REG_RECORD_DIR=/tmp/rec REG_RECORD_KEEP=all node scripts/run-one.mjs --email <邮箱> --mail-url <取件地址>
```

## register.js 常改的锚点

| 卡点 | 位置 |
|---|---|
| 注册入口点不中 / 弹登录方式弹窗 | `registerChatGPT` 步骤2 的点击文案数组 + `emailTexts` 兜底 |
| 2FA 无密钥转邮箱验证码失败 | `tryLoginMfaEmailFallback` 的 `switchTexts`（切换入口）/ `emailTexts`（邮箱选项） |
| 各类输入框找不到 | `selectors.js`（EMAIL_INPUT / PASSWORD_INPUT / CODE_INPUT / ...） |
| 新老账号/页面状态判错 | `auth-state.js` 的 `classifyState` |
| 验证码填错位/丢字符 | `fillCode`（分格聚焦首格键入 + 读回校验） |

## 辅助：失败留证（事后排查）

worker 跑失败会在 `REG_RECORD_DIR/<邮箱>-<时间戳>/` 留每步 DOM 记录（`recording.html` 时间轴回放，含状态机 pageState）+ `trace.zip`（`npx playwright show-trace trace.zip`）。开关 `REG_RECORD_DIR`（生产建议指向挂载卷如 `data/recordings`）、`REG_RECORD_KEEP=fail|all|none`（默认 fail=成功删失败留）。**联调用 CDP 实时看，事后复盘用这些留证。**

## 收尾
`Ctrl-C` 或 kill cdp-serve 进程即关闭浏览器。
