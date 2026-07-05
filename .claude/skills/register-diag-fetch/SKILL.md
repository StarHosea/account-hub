---
name: register-diag-fetch
description: 从 account-hub 服务器拉注册失败诊断给本地 AI 分析。服务器域名 https://hao.shuangdeng.space ，诊断接口无鉴权。触发：服务器注册失败 / 分析注册失败 / 拉诊断 / 异常清单排查 / register diag。
---

# 服务器注册诊断 → 本地 AI

生产服务器：**https://hao.shuangdeng.space**（nginx 反代，诊断 API 无鉴权）

## 最快方式（推荐）

把下面链接直接发给 AI，或让 AI 用 WebFetch/curl 读取：

| 用途 | URL |
|------|-----|
| **最近一条失败（Markdown，最适合 AI）** | `https://hao.shuangdeng.space/api/register/diag/brief.md` |
| 指定邮箱 | `https://hao.shuangdeng.space/api/register/diag/brief.md?email=a%40b.com` |
| JSON 详情 | `https://hao.shuangdeng.space/api/register/diag/brief?email=a%40b.com` |
| 全部异常 + 链接 | `https://hao.shuangdeng.space/api/register/diag/list` |
| 完整诊断包 zip | `https://hao.shuangdeng.space/api/register/diag/artifacts?email=a%40b.com` |

## 本地一键脚本

```bash
# 最近失败 → 打印 Markdown + 复制到剪贴板
python3 scripts/fetch-register-diag.py

# 指定邮箱
python3 scripts/fetch-register-diag.py user@example.com

# 只看链接（复制给 AI fetch）
python3 scripts/fetch-register-diag.py url

# 异常列表
python3 scripts/fetch-register-diag.py list
```

配置在 `scripts/diag.local.env`：`ACCOUNT_HUB_URL=https://hao.shuangdeng.space`

## AI 分析时应关注

1. `failed_step` + `manifest_tail` → 卡在哪一步
2. `visible_ui.buttons` / `hints` → selector 或文案是否变了
3. `pageState` + `state_reason` → 状态机判错还是真卡死
4. `logs_tail` → 超时/代理/验证码等基础设施问题
5. 需要网络时序 → 下 `trace.zip` 用 `npx playwright show-trace`

## 管理后台

注册页 → 异常清单 → 点链接图标可复制该邮箱的诊断 URL。
