---
name: register-diag
description: account-hub 注册失败诊断：拉取诊断链接/brief、分析失败现场、定位代码、出修复建议。禁止靠猜；证据不足或排查结束后反向改代码/本 Skill 增强采集。触发：诊断链接、brief.md、fetch-register-diag、异常清单、注册失败分析、优化成功率。
---

# 注册诊断

拉取 → 分析 → 修复建议 → **闭环增强采集**（四步一体，不分 fetch/analyze）。

## 铁律

- **只凭证据**：判断必须对应 brief / manifest_tail / visible_ui / logs_tail / failed_step；无证据标「假设」，不当根因。
- **标置信度**：已证实 / 高 / 低 / 无法判断。低或无法判断时**不得**给具体 selector/文案修复，只列验证项或采集增强。
- **矛盾停猜**：pageState↔URL、failed_step↔manifest 末步不一致 → 说明矛盾，CDP 实机或加采集。
- **每轮闭环**：问「下次同类失败 brief 够不够？」——不够就改代码或 `references/tables.md` / 本 Skill。

## 工作流

```
1. 取链 → 2. 拉 brief.md + brief JSON → 3. 分类 → 4. 定位代码 → 5. 报告 → 6. 闭环
```

步骤 6 不可跳过：根因已证实且 brief 已覆盖 → 写「无需增强」；否则给出具体改动。

### 1) 取链

| 输入 | 拼法 |
|------|------|
| 完整 URL | 直接用 |
| 邮箱 | `{base}/api/register/diag/brief.md?email={urlencode}` |
| 最近失败 | `{base}/api/register/diag/brief.md` |
| 无 base | 先试本地 meta，不通再生产 |

base：本地 `http://127.0.0.1:8000`；生产以设置「诊断对外地址」为准（常见 `https://hao.shuangdeng.space`）。API **无鉴权**。

```bash
python3 scripts/fetch-register-diag.py --local --no-copy
python3 scripts/fetch-register-diag.py --remote --no-copy
python3 scripts/fetch-register-diag.py list --local
```

### 2) 拉取

```bash
curl -fsSL '{base}/api/register/diag/brief.md?email=...'
curl -fsSL '{base}/api/register/diag/brief?email=...'    # JSON，结构更全
```

- `recording_missing` → 只能看 reason/logs，提示重跑失败；闭环里加存证。
- 需网络时序 → `.../api/register/diag/trace?email=...`

### 3–4) 分类与定位

读 [references/tables.md](references/tables.md)：失败信号分类、stepId→代码锚点、何时反向改代码。

状态机 `auth-state.js` · 选择器 `selectors.js` · 主线 `register.js` · brief 聚合 `register_diag_service.py`

### 5) 报告

按 [references/report-template.md](references/report-template.md) 输出。

### 6) 闭环（采集增强）

信息不足或刚修完一类问题时，优先改：

| 层 | 文件 | 加什么 |
|----|------|--------|
| Node | `register.js` | 卡点 `recorder.record(stepId, { note, ... })`：文案/等待/catch |
| 记录器 | `dom-recorder.js` | extraMeta：selector 命中、重试、网络摘要 |
| 状态机 | `auth-state.js` | reason/evidence 补 DOM 信号 |
| Python | `openai_register.py` | 超时杀进程前 last URL/step/stderr |
| Brief | `register_diag_service.py` | build_brief 暴露新字段 |

新信号、stepId、分类行 → 写回 `references/tables.md` 或本 Skill，与代码同轮提交。

## 修复约束

- 最小改动：先 `selectors.js` 文案/单点 selector
- 文案失配：对照 `visible_ui.buttons` 改 `humanClickByText`
- DOM 不确定：读 **register-cdp-debug**，CDP 实机后再改 `register.js`
