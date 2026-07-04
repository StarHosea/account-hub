# node_engine 浏览器探查脚本（scripts/）

用于**离线手动**驱动 CloakBrowser 探查 ChatGPT 站点规律、迭代选择器、验证某一步是否成功。
不经过 Python 编排、不依赖邮箱池——验证码由「终端手动输入」或「取件地址自动轮询」提供。

> 正式生产流程走 `node_engine/worker.js`（由 Python 通过 NDJSON 驱动）。
> 这些脚本只是**探查/调试工具**，复用同一套 `flows/openai/register.js`。

## 准备

```bash
cd node_engine
npm install                 # 安装 cloakbrowser / playwright-core（首次会下载 stealth Chromium ~200MB）
# 可选：node scripts/install-binary.js   # 预下载 Chromium
```

代理：Chromium 不支持带认证的 SOCKS5，`--proxy` 请用 `http://user:pass@host:port`。
不给 `--proxy` 则直连（本机若有科学上网可直接跑）。

## 通用参数

| 参数 | 说明 |
|---|---|
| `--email <邮箱>` | 必填 |
| `--mail-url <取件地址>` | HTML 收件页 URL；给了就自动轮询取码，超时回退手动输入。不给则始终手动输入 |
| `--proxy <代理URL>` | `http://user:pass@host:port`（可选） |
| `--seed <指纹种子>` | 10000–99999，同 seed = 同指纹（可选） |
| `--password <登录密码>` | 老账号登录用（可选，避开邮箱验证码限流） |
| `--totp-secret <base32>` | 老账号已开 2FA 时登录用（可选） |
| `--headless` | 无头运行（默认有头；探查建议有头） |
| `--no-2fa` | 只设密码、跳过 2FA |

截图与 UI dump 落在 `node_engine/diag/`（可用环境变量 `REG_DIAG_DIR` 改目录）。

## 脚本

| 脚本 | 用途 |
|---|---|
| `run-one.mjs` | 端到端跑一个新邮箱：注册→设密码→开2FA→取token（邮箱已注册则自动转老账号流程） |
| `run-secure-one.mjs` | 老账号加固：登录→设新密码→开2FA→取token |
| `login-step8.mjs` | 登录后**只跑步骤8**（设密码+开2FA），反复迭代 Step 8 不必重新注册 |
| `recon-settings.mjs` | **只读勘察**：登录→打开设置→dump 密码/2FA 的真实 DOM（探查规律主力工具） |
| `diag-password-form.mjs` | 走到登录密码页，填密码提交并 dump 提交后页面（判断密码错/提交没触发/进2FA） |
| `verify-2fa-login.mjs` | 用 密码+secret 生成 TOTP 真实登录一次，验证 2FA 确实设上且 secret 正确 |

## 示例

```bash
# 手动输码跑一个新号（终端提示时粘贴验证码）
node scripts/run-one.mjs --email a@b.com --proxy http://user:pass@host:7778

# 自动取码 + 固定指纹
node scripts/run-one.mjs --email a@b.com --mail-url 'https://mail.example/api?...' --seed 54321

# 只读勘察设置页（探查密码/2FA DOM 结构）
node scripts/recon-settings.mjs --email a@b.com --mail-url 'https://mail.example/api?...'

# 反复迭代 Step 8
node scripts/login-step8.mjs --email a@b.com --password 'LoginPwd!' --no-2fa

# 验证某账号 2FA 已启用
node scripts/verify-2fa-login.mjs --email a@b.com --totp-secret JBSWY3DPEHPK3PXP --password 'LoginPwd!'
```
