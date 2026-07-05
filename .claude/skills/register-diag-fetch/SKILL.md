---
name: register-diag-fetch
description: 从 account-hub 服务器或本地拉注册失败诊断给 AI 分析。诊断 API 无鉴权；地址在「设置→诊断与存证」配置。触发：注册失败分析 / 拉诊断 / fetch-register-diag / 异常清单排查。
---

# 注册诊断 → 本地 AI

## 配置位置（不用环境变量）

在管理后台 **设置 → 注册配置 → 诊断与存证**：

| 设置项 | 建议值 |
|--------|--------|
| 开启失败存证 | 开 |
| 存证策略 | **仅保留失败（成功自动删）** |
| 诊断对外地址 | 生产：`https://hao.shuangdeng.space`；本地留空 |

## 给 AI 的直链（复制即用）

**生产最近一条失败：**
```
https://hao.shuangdeng.space/api/register/diag/brief.md
```

**指定邮箱：**
```
https://hao.shuangdeng.space/api/register/diag/brief.md?email=a%40b.com
```

**本地最近一条失败：**
```
http://127.0.0.1:8000/api/register/diag/brief.md
```

## 本地一键脚本

```bash
python3 scripts/fetch-register-diag.py           # 自动：先本地后远程
python3 scripts/fetch-register-diag.py --local   # 只拉本地
python3 scripts/fetch-register-diag.py --remote  # 只拉生产
python3 scripts/fetch-register-diag.py list
python3 scripts/fetch-register-diag.py url
```

Mac 下自动复制 Markdown 到剪贴板。

## AI 分析关注点

1. `failed_step` + `manifest_tail` — 卡在哪一步
2. `visible_ui` — 按钮/提示是否改版
3. `pageState` — 状态机是否判错
4. `logs_tail` — 代理/验证码/超时
5. 需网络时序 → `/api/register/diag/trace?email=...`
