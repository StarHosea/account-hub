---
name: register-diag
description: account-hub 注册失败诊断：拉取诊断链接/brief、分析失败现场、定位代码、出修复建议。禁止靠猜；证据不足只补日志/加采集或 CDP 验证，不得给修复方案；需 CDP 验证时必须实机跑通。触发：诊断链接、brief.md、fetch-register-diag、异常清单、注册失败分析、优化成功率。
---

# 注册诊断

拉取 → 分析 → **证据判定** → 闭环增强采集 / CDP 验证 → 修复（仅已证实）。

## 铁律（违反即失败）

1. **禁止猜测**：不得用「可能是」「大概」「通常」「典型原因」当根因；不得凭 stepId 分类表直接下结论。
2. **证据链闭环**：每条判断必须引用 brief 具体字段 + 值/行号；引不出 → 标「无法判断」，**不得**给 selector/文案/逻辑修复。
3. **置信度门槛**：
   - **已证实**：brief 证据 +（若涉及 DOM/selector）CDP 复现并记录 snapshot/click 结果。
   - **高**：brief 多字段一致且无矛盾；仍无 DOM 证据时**不得**给具体 selector 修复。
   - **低 / 无法判断**：只输出「诊断缺口 + 补采集方案 + 验证步骤」，**禁止**修复建议。
4. **矛盾即停**：pageState↔URL、failed_step↔manifest 末步、visible_ui↔reason 不一致 → 停止推断，走 CDP 或补采集。
5. **CDP 不是可选项**：凡涉及「按钮/文案/selector/页面状态/DOM 结构」的根因或修复，**必须先**按 **register-cdp-debug** 实机验证；未跑 CDP 前不得提交代码修复。
6. **日志看不出原因 → 补日志**：brief 缺关键信号时，本轮首要产出是**具体采集增强**（文件+字段+触发点），不是改业务逻辑碰运气。
7. **每轮闭环**：问「下次同类失败 brief 够不够？」——不够就改代码或 `references/tables.md` / 本 Skill。

## 禁止输出的内容

- 「建议尝试改 xxx selector」但 brief 无 DOM 证据且未 CDP 验证
- 把 `references/tables.md` 分类表的「可能方向」直接写成根因
- 多个并列猜测（「可能是 A 或 B 或 C」）——只允许列**待验证假设**，且每条附验证方法
- 无 brief 仍给修复 diff

## 工作流

```
1. 取链 → 2. 拉 brief → 3. 证据审计（够不够？）→ 4. 分支
   ├─ 证据足 + DOM 无关 → 5a. 报告（高/已证实）→ 6. 闭环
   ├─ 证据足 + DOM 相关 → 5b. CDP 验证 → 5a → 6
   └─ 证据不足 → 5c. 只出采集增强 + 验证清单 → 6（禁止修复）
```

步骤 6 不可跳过。

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

- `recording_missing` → **不得**推断 DOM 根因；闭环里加存证 + 超时前 last_step。
- 需网络时序 → `.../api/register/diag/trace?email=...`

### 3) 证据审计（必做，在分类之前）

逐项检查 brief 是否**能回答**「卡在哪一步、当时页面上有什么、脚本做了什么」：

| 问题 | 所需字段 | 缺失时的动作 |
|------|----------|--------------|
| 卡在哪步？ | `failed_step` + manifest 末 2～3 步 | 补 `final-error-scene` record；brief 暴露 kill_reason |
| 当时可见 UI？ | `visible_ui.buttons/hints` | record 加可见按钮快照 note |
| selector 命中否？ | manifest step 的 note/extraMeta | dom-recorder 加 selector 结果 |
| 状态机为何如此？ | `pageState` + auth-state evidence | auth-state 补 reason/evidence |
| 网络/代理？ | logs_tail 连接错误码 | NDJSON 泵落详细错误 |
| 进程怎么死的？ | kill_reason / last_url / stderr | Python 超时杀进程前写入 |

**任一项答不上且与根因相关 → 本轮禁止修复，只做采集增强。**

### 4) 分类与定位（仅作索引，不作根因）

读 [references/tables.md](references/tables.md) 的 stepId→代码锚点；**分类表的「可能方向」仅供列验证项，不得当根因**。

状态机 `auth-state.js` · 选择器 `selectors.js` · 主线 `register.js` · brief 聚合 `register_diag_service.py`

### 5) CDP 验证（DOM/selector/文案/状态机相关时强制）

读 **register-cdp-debug**，**必须亲自执行**：

```bash
cd node_engine
CLOAK_CDP_PORT=9222 node scripts/cdp-serve.mjs [--proxy ...] [--url https://chatgpt.com/]
CLOAK_CDP_PORT=9222 node scripts/cdp-drive.mjs snapshot
# ... 复现 failed_step 对应操作，记录输出
```

验证产出写入报告「CDP 验证」节：命令、snapshot 关键行、click/fill 是否成功、修复前后对比。

**未写入 CDP 验证结果 → 不得输出「修复建议」中的代码改动。**

### 6) 报告

按 [references/report-template.md](references/report-template.md) 输出。置信度非「已证实」时，「修复建议」节只能有验证项和采集增强。

### 7) 闭环（采集增强）

信息不足或刚修完一类问题时，优先改：

| 层 | 文件 | 加什么 |
|----|------|--------|
| Node | `register.js` | 卡点 `recorder.record(stepId, { note, ... })`：文案/等待/catch/selector 结果 |
| 记录器 | `dom-recorder.js` | extraMeta：selector 命中、重试、可见按钮、网络摘要 |
| 状态机 | `auth-state.js` | reason/evidence 补 DOM 信号 |
| Python | `openai_register.py` | 超时杀进程前 last URL/step/stderr/kill_reason |
| Brief | `register_diag_service.py` | build_brief 暴露新字段 |

新信号、stepId、分类行 → 写回 `references/tables.md` 或本 Skill，与代码同轮提交。

## 修复约束（仅「已证实」且 CDP 已验证时适用）

- 最小改动：先 `selectors.js` 文案/单点 selector
- 文案失配：brief `visible_ui.buttons` **与** CDP snapshot 双重确认后改 `humanClickByText`
- 改完必须：`run-one.mjs` 或 Web 面板完整重跑，用新 brief 确认字段覆盖
