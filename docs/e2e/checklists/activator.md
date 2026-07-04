# E2E Test Checklist — 激活器 (Activator) Page

Route component: `web/src/pages/ActivatorPage.tsx`
API surface: `web/src/lib/api.ts` (Activation + One-click Run sections)
Backend: `api/activation.py`, `api/run.py`, `services/activation_service.py`, `services/run_service.py`

## Safety legend

- **SAFE** — read-only or purely local; no backend mutation, no cost.
- **REVERSIBLE** — mutates backend but can be undone / re-set with no external cost.
- **DANGER** — irreversible and/or costs real money. On this page any action that triggers CDK redemption is DANGER, because a redeemed CDK is consumed against a paid upstream (`services/cdk_redeem_client`). NEVER run DANGER cases against production/real CDKs; use a disposable/mock CDK backend or a staging tenant with throwaway CDKs.

## Preconditions common to all cases

- Admin auth key configured (all endpoints call `require_admin`). A non-admin/anonymous session must be redirected/blocked.
- Backend reachable. Page polls on a timer only while `document.visibilityState === "visible"`:
  - `GET /api/activation` (`fetchActivation`) every 1s
  - `GET /api/accounts?page_size=200` (`fetchAccounts`) every 2s
  - `GET /api/cdks?page_size=1` (`fetchCdks`) every 5s
- `activationConfig` is loaded lazily from the settings store on mount (`loadActivationConfig`) if not already present.

---

## Dimension 1 — Load / Auth-guard / First-render / No console error

### 1.1 First render as admin — SAFE
- Precondition: valid admin key; backend up.
- Steps: Navigate to the 激活器 route. Wait for first poll cycle (~1s).
- Expected: Page title `激活器` renders. Four overview cards render in order: `待激活`, `激活中`, `已激活`, `可用 CDK`. `启动设置` card, `正在激活的账号` card, `详细日志` card all present. No red console errors, no uncaught promise rejections. Network shows 200 for `/api/activation`, `/api/accounts?page_size=200`, `/api/cdks?page_size=1`.

### 1.2 Auth guard — unauthenticated — SAFE
- Precondition: no/invalid auth key.
- Steps: Navigate to the route directly.
- Expected: The three GET calls return 401/403; app redirects to login (per `httpRequest` unauthorized handling). No activation data leaks; no crash.

### 1.3 Backend down / errors swallowed — SAFE
- Precondition: stop backend (or block the 3 GETs).
- Steps: Load the page.
- Expected: All three pollers `.catch(() => {})` silently. UI shows zero-state: overview cards `0`, `可用 CDK` card shows `0` in danger color, `启动设置` header shows warning `以下资源为 0：可激活账号、可用 CDK`, `正在激活的账号` table empty (`当前没有正在激活的账号`), log panel shows `暂无日志`. No unhandled error dialog.

### 1.4 Polling pauses when tab hidden — SAFE
- Precondition: page loaded.
- Steps: Switch to another tab (visibility → hidden) for ~10s, watch network.
- Expected: No new poll requests fire while hidden (guard `if (document.visibilityState !== "visible") return;`). On return to the tab, polling resumes.

### 1.5 Timer cleanup on unmount — SAFE
- Precondition: page loaded.
- Steps: Navigate away to another route.
- Expected: `clearInterval` runs; no further `/api/activation` requests after unmount; no "setState on unmounted component" warnings.

---

## Dimension 2 — Data render & backend type match

### 2.1 Overview cards map to correct backend fields — SAFE
- Precondition: seed accounts with a known mix (some `plus_status=未激活`, some `type=plus`, some in `排队中/激活中`).
- Steps: Observe the four cards vs `GET /api/activation` payload (`activation.summary`).
- Expected:
  - `待激活` = `summary.not_plus_by_type` (NOT `summary.free`).
  - `激活中` = `summary.activating`.
  - `已激活` = `summary.plus_by_type`.
  - `可用 CDK` = `fetchCdks` response `counts.available` (from `/api/cdks`, NOT from activation state).
  - Values equal backend numbers exactly. Types line up with `ActivationSummary` (`free/activated/activating/total/plus_by_type/not_plus_by_type`).

### 2.2 `可用 CDK` danger styling at zero — SAFE
- Precondition: no available CDKs.
- Steps: Observe `可用 CDK` card.
- Expected: value `0` rendered in `--semi-color-danger`. `启动设置` header warning lists `可用 CDK`.

### 2.3 Progress bar reflects stats — SAFE
- Precondition: an activation batch previously ran (stats has `total>0`, `done>0`).
- Steps: Observe the Progress under 启动设置.
- Expected: percent = `round(stats.done / stats.total * 100)`, clamped 0–100. Stroke turns success-green only while `activation.running === true`. Progress `key` resets on new `stats.job_id`. Matches `ActivationStats` (`total/done/success/fail/running/job_id`).

### 2.4 "正在激活" table content — SAFE
- Precondition: some accounts with `plus_status` in `排队中`/`激活中`.
- Steps: Observe the `正在激活的账号` table.
- Expected: Only accounts filtered to `排队中`/`激活中` appear (client filter on `fetchAccounts` items). Columns: `邮箱` (empty shows `—`), `激活进度`. `激活进度` renders a colored `Tag` per status (未激活 grey / 排队中 blue / 激活中 orange / 已激活 green / 激活失败 red), a spinner while in-progress, attempts `UPI x / IDEL y` when present, `plus_last_message` (ellipsis+tooltip), and masked CDK `CDK ab…yz`.

### 2.5 Over-200 in-progress note — SAFE
- Precondition: `summary.activating` greater than the number of in-progress rows fetched (list capped at `page_size=200`).
- Steps: Observe table header note.
- Expected: `另有 N 个进行中账号未在列表显示（列表上限 200）。` where N = `activatingCount - activatingAccounts.length`.

### 2.6 Log panel render — SAFE
- Precondition: activation has produced logs (`activation.logs`).
- Steps: Observe 详细日志 panel.
- Expected: Each line shows localized time + text, colored by level (red/green/yellow map to danger/success/warning; others default). Auto-scrolls to bottom on new lines. Empty → `暂无日志`. Matches `ActivationLog` (`time/text/level`).

### 2.7 Config field render — SAFE
- Precondition: config loaded.
- Steps: Observe 启动设置 inputs.
- Expected: `并发数` = `activationConfig.concurrency` (default 3), `激活数量（0=不限）` = `activationConfig.target` (default 0), `注册成功后自动激活` switch = `activationConfig.auto_activate_after_register`. Matches `ActivationConfig`.

### 2.8 DISCREPANCY — One-click Run data never rendered — SAFE (documentation check)
- Note: `api.ts` exports `fetchRun/startRun/stopRun` and types `RunState/RunStats` with fields `stats`, `summary`, `cdk` (`CdkCounts`), `mailbox_available`, `logs`. **None are imported or rendered by `ActivatorPage.tsx`.** There is NO one-click-run UI on this page — no `target/registered/activated/failed/phase`, no `cdk.by_type`, no `mailbox_available` control. Verify no test asserts these on this page; they belong to a different page/screen (or are currently unwired).

### 2.9 DISCREPANCY — config fields present in type but absent from this UI — SAFE
- Note: `ActivationConfig` also carries `base_url`, `api_key`, `has_api_key`, `poll_interval`, `poll_timeout`, `max_attempts_per_type`. This page exposes ONLY `concurrency`, `target`, `auto_activate_after_register`. The others are edited elsewhere (Settings). Backend `summary()` also returns `needs_review`, which is not in the `ActivationSummary` TS type and not shown here.

---

## Dimension 3 — Interactions (form inputs, tabs, dialogs, log panel)

### 3.1 并发数 input bounds — SAFE
- Precondition: activation not running.
- Steps: Set `并发数` to 0, then 11, then 5.
- Expected: clamped to min 1 / max 10; value 5 accepted. Change writes to store (`setActivationConfigField("concurrency", …)`) but is NOT persisted until 保存设置.

### 3.2 激活数量 input — SAFE
- Precondition: not running.
- Steps: Set `激活数量` to a negative → clamps to min 0; set to 25.
- Expected: min 0 enforced; `0=不限` semantics documented in label. Store updated, not yet saved.

### 3.3 自动激活 switch toggle — SAFE
- Precondition: not running.
- Steps: Toggle `注册成功后自动激活` on/off.
- Expected: `setActivationAutoActivate` updates store; visual toggles; not persisted until 保存设置.

### 3.4 Inputs disabled while running — SAFE
- Precondition: activation running (`activation.running === true`).
- Steps: Observe 并发数 / 激活数量 / 自动激活 switch / 保存设置 button.
- Expected: all four are `disabled` while running.

### 3.5 Stop confirm dialog (Popconfirm) — open + cancel — SAFE
- Precondition: activation running (so the 停止 button is shown).
- Steps: Click `停止`; the Popconfirm appears (title `确认停止激活？`, content `将中断正在进行的激活流程`). Click Cancel / click outside.
- Expected: Popconfirm dismisses, NO `/api/activation/stop` call fired, activation continues. (No `Tabs` or modal `Dialog` components exist on this page — this Popconfirm is the only confirm surface.)

### 3.6 Log panel auto-scroll — SAFE
- Precondition: running activation streaming logs.
- Steps: Watch the log panel as new lines arrive.
- Expected: panel stays pinned to bottom (`scrollTop = scrollHeight` on `logs.length` change). Manual scroll-up then new line re-pins to bottom (current behavior).

### 3.7 Clear-logs button enable/disable — SAFE
- Precondition: (a) no logs, (b) has logs.
- Steps: Observe 清空日志 button in 详细日志 header.
- Expected: disabled when `!act?.logs?.length`; enabled when logs exist.

---

## Dimension 4 — Actions (every button, tagged)

Enumerate every actionable control on the page:

### 4.1 保存设置 (Save config) — REVERSIBLE
- Precondition: not running; change some config field.
- Steps: Click `保存设置`.
- Expected: button shows `loading` (`isSavingActivationConfig`); store calls `saveActivationConfig` → `POST /api/activation/config` (`updateActivationConfig`) with `{concurrency, target, auto_activate_after_register}`. On success the persisted config reflects new values (re-load page confirms). Reversible: re-save old values. No CDK cost.
- Note: `updateActivationConfig` is invoked indirectly via the settings store, not imported by the component.

### 4.2 启动激活 (Start activation) — DANGER (redeems REAL CDK — costs money)
- Precondition: `summary.free > 0` AND `可用 CDK > 0`; not running. USE STAGING/MOCK CDK ONLY.
- Steps: Click `启动激活`.
- Expected: button `loading`; `POST /api/activation/start` (`startActivation([], limit)`) with `limit = target>0 ? target : freeCount`. Toast success `已开始激活未激活账号（本轮上限 N 个）`. Backend spins the activation thread and begins redeeming CDKs against upstream → real consumption. UI flips 启动激活 → 停止, progress stroke turns green.
- Safety: This is the money-spending path. Do NOT execute against real CDKs.

### 4.3 启动激活 guard — no free accounts — SAFE
- Precondition: `summary.free === 0`.
- Steps: Click `启动激活`.
- Expected: Toast warning `可激活账号为 0（没有未激活账号）`; NO `/api/activation/start` call; nothing redeemed.

### 4.4 启动激活 guard — no CDK — SAFE
- Precondition: `summary.free > 0` but `可用 CDK === 0`.
- Steps: Click `启动激活`.
- Expected: Toast warning `可用 CDK 为 0，无法激活，请先在「CDK 管理」导入`; NO start call.

### 4.5 停止 (Stop) — confirm → confirm — REVERSIBLE / SAFE
- Precondition: activation running.
- Steps: Click `停止`, then confirm the Popconfirm.
- Expected: `POST /api/activation/stop` (`stopActivation`); Toast `已请求停止激活`. Backend sets stop event, `job_running=false`; in-flight task finishes gracefully. UI flips back to 启动激活. Not a data-destroying action; can restart afterward. (In-flight CDK already submitted may still be consumed upstream — stop does not refund.)

### 4.6 清空日志 (Clear logs) — SAFE
- Precondition: logs present.
- Steps: Click `清空日志`.
- Expected: `POST /api/activation/clear-logs` (`clearActivationLogs`); Toast `已清空激活日志`. Backend clears `_logs` only, KEEPS stats (progress bar & counts unchanged). Log panel shows `暂无日志`.

### 4.7 Error toasts on action failure — SAFE
- Precondition: force start/stop/clear to reject (e.g., 500).
- Steps: Trigger each action.
- Expected: `Toast.error` shows the error message (`启动激活失败` / `停止激活失败` / `清空激活日志失败` fallback), `activationBusy` resets in `finally`, UI not stuck in loading.

### 4.8 Action inventory completeness — SAFE (doc check)
- The full button set on this page: **保存设置** (REVERSIBLE), **启动激活** (DANGER), **停止** (REVERSIBLE, behind Popconfirm), **清空日志** (SAFE). Inputs: `并发数`, `激活数量`, `注册成功后自动激活` (all local-until-saved). There is NO CDK-import, NO revoke, NO one-click-run button here (those live on other pages). Confirm no test expects a `startRun`/`stopRun` control on this page.

---

## Dimension 5 — Responsive (desktop + mobile)

### 5.1 Desktop layout — SAFE
- Precondition: viewport ≥ ~1024px.
- Steps: Observe layout (`useIsMobile()` false).
- Expected: Title uses `heading=3`. Overview grid is 4 columns (`repeat(4, minmax(0,200px))`). 启动设置 controls sit inline via `Space wrap align="end"`. Container max-width 1080.

### 5.2 Mobile layout — SAFE
- Precondition: viewport narrow (mobile breakpoint true).
- Steps: Observe layout.
- Expected: Title uses `heading=4`. Overview grid collapses to 2 columns (`repeat(2, 1fr)`). Config controls wrap onto multiple lines (no horizontal overflow). Buttons remain tappable; Popconfirm anchors correctly.

### 5.3 Table + log scroll on small screens — SAFE
- Precondition: mobile viewport; several in-progress accounts and many logs.
- Steps: Scroll the 正在激活 table (`scroll={{ y: 300 }}`) and log panel (fixed height 260).
- Expected: internal vertical scroll works; page itself does not overflow horizontally; masked CDK / message ellipsis do not break layout.

---

## Dimension 6 — Theme (light/dark) + i18n

### 6.1 Light theme — SAFE
- Steps: Set light mode; observe.
- Expected: All colors resolve via Semi CSS vars (`--semi-color-*`). Danger `可用 CDK=0` legible; log level colors visible; tags readable.

### 6.2 Dark theme — SAFE
- Steps: Toggle dark mode (`body[theme-mode="dark"]`); observe.
- Expected: Log panel background (`--semi-color-fill-0`), text, danger/success/warning colors adapt automatically; no hard-coded light-only colors except intentional `monospace` CDK text (uses inherited color). No unreadable contrast.

### 6.3 Theme switch while running — SAFE
- Precondition: activation running with green progress + streaming logs.
- Steps: Toggle theme.
- Expected: progress green stroke and log colors re-resolve; no flicker/crash; polling uninterrupted.

### 6.4 i18n / copy audit — SAFE
- Note: All user-facing strings are hard-coded Simplified Chinese (labels 激活器/待激活/激活中/已激活/可用 CDK/启动设置/并发数/激活数量（0=不限）/注册成功后自动激活/保存设置/启动激活/停止/正在激活的账号/详细日志/清空日志; toasts; empties 暂无日志/当前没有正在激活的账号; status tags 未激活/排队中/激活中/已激活/激活失败). There is no i18n framework wiring on this page.
- Expected: Verify every string above appears correctly (no mojibake) in both themes and both viewports. Times are localized via `toLocaleTimeString()` (locale-dependent) — check they render sensibly.

---

## Cross-cutting discrepancy summary (UI vs api.ts)

1. **One-click Run entirely unwired here**: `fetchRun`, `startRun`, `stopRun`, `RunState`, `RunStats` (fields `target/registered/activated/failed/phase/job_id`), `RunState.cdk` (`CdkCounts`), `RunState.mailbox_available` are exported by `api.ts` but NOT used by `ActivatorPage.tsx`. No one-click UI, no CDK-by-type breakdown, no mailbox_available display on this page.
2. **`updateActivationConfig` not imported by the component** — config save is delegated to the settings store (`saveActivationConfig`), which is the actual caller of `POST /api/activation/config`.
3. **`ActivationConfig` fields not exposed here**: `base_url`, `api_key`, `has_api_key`, `poll_interval`, `poll_timeout`, `max_attempts_per_type` (edited on Settings, not Activator).
4. **`可用 CDK` sourced from `/api/cdks`**, not from `activation` state — an independent poll (`fetchCdks`, every 5s) using `counts.available`.
5. **`待激活` card uses `summary.not_plus_by_type`** (真实档位口径), while the start-guard uses `summary.free` (`plus_status` 口径). These can differ; a tester must not assume the card value equals the number the guard checks.
6. **Backend `summary.needs_review`** is returned by `services/activation_service.summary()` but is absent from the `ActivationSummary` TS type and not displayed.
