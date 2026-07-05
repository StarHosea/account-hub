---
name: register-diag-fetch
description: 从 account-hub 拉注册失败诊断链接或 Markdown 简报。诊断 API 无鉴权。拿到链接后应用 register-diag-analyze 做分析。触发：拉诊断 / fetch-register-diag / 复制诊断链接 / 异常清单。
---

# 注册诊断拉取

## 直链

| 场景 | URL |
|------|-----|
| 生产最近失败 | `https://hao.shuangdeng.space/api/register/diag/brief.md` |
| 本地最近失败 | `http://127.0.0.1:8000/api/register/diag/brief.md` |
| 指定邮箱 | `.../brief.md?email=a%40b.com` |

配置在 **设置 → 诊断与存证**（不用环境变量）。

## 脚本

```bash
python3 scripts/fetch-register-diag.py --local
python3 scripts/fetch-register-diag.py --remote
python3 scripts/fetch-register-diag.py list
```

## 分析

拉取后使用 **register-diag-analyze** skill 输出修复建议。

