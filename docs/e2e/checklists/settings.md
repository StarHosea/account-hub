# E2E Test Checklist — 设置 (Settings) Page

Route component: `web/src/pages/SettingsPage.tsx` (+ `web/src/components/RegisterConfigCard.tsx`)
API surface: `web/src/lib/api.ts` — Settings / User keys / Upstream proxy / Trial-check sections
Backend cross-ref: `api/system.py`, `services/config.py`, `services/proxy_service.py`, `services/auth_service.py`

## Page structure (as rendered live)

The page renders a single `<Title>设置</Title>` plus **five** Semi `Card`s, each with its own 保存 button in `headerExtraContent`:

1. **基础设置** — `SettingsPage.tsx` (fields: 全局代理, 账号刷新间隔（分钟）, 刷新后自动重登开关) → `GET/POST /api/settings`
2. **注册配置** — `RegisterConfigCard.tsx` (目标注册数量, 并发数, 注册代理, 注册区域, 号一号一 IP, 同 IP 保活时长, 2FA 开关; has a second `保存` **and** a `重置统计` Popconfirm) → `GET/POST /api/register`, `POST /api/register/reset`
3. **邮箱配置** — `RegisterConfigCard.tsx` (邮箱模式 select + CloudMail fields + 收件请求超时/等待验证码超时/轮询间隔) → same `/api/register` save as card 2 (shares `saveRegister`)
4. **Plus 激活凭据** — `SettingsPage.tsx` (CDK API Key password, CDK API 地址) → `GET/POST /api/activation` + `/api/activation/config`
5. **试用资格检测** — `SettingsPage.tsx` (开关, 检测 API Key password, 检测 API 地址) → `GET /api/trial-check`, `POST /api/trial-check`

> Note: cards 2 & 3 are one component (`RegisterConfigCard`) and share ONE 保存 handler (`saveRegister`). The 保存 button visible on card 2 persists BOTH cards' fields; card 3 (邮箱配置) has no button of its own. Both save/reset buttons are `disabled` while `config.enabled` (a register run) is true.

Safety-tag legend: **SAFE** = read-only, no state change · **REVERSIBLE** = writes config, re-editable/undoable · **DANGER** = destructive (stats wiped, no undo).

---

## Dimension 1 — Load / Auth-guard / Render / No console error

1. **Load as admin — page renders all 5 cards.**
   - Precondition: logged in with an **admin** auth key (`/api/settings`, `/api/trial-check`, `/api/proxy` are all `require_admin`).
   - Steps: navigate to 设置; wait for network idle.
   - Expected: Title 设置; all 5 cards present; each card resolves from `<Spin/>` to its fields. `useEffect` fires `loadConfig`, `loadActivationConfig`, `loadRegister(true)`, `fetchTrialCheckConfig` exactly once (guarded by `didLoad` ref — verify no double-fetch in StrictMode).
   - Safety: SAFE

2. **Auth-guard — non-admin / unauthenticated is blocked.**
   - Precondition: logged in with a **user** (non-admin) key, or no valid session.
   - Steps: navigate to 设置.
   - Expected: `require_admin` returns 401/403; request layer should redirect to login (`httpRequest` default `redirectOnUnauthorized`). Page must NOT render admin config values. Confirm the 4 GETs all 401 and none leak config.
   - Safety: SAFE

3. **Spin → content transition per card.**
   - Precondition: throttle network (Slow 3G).
   - Steps: load page; observe each card before its GET resolves.
   - Expected: 基础设置 shows `<Spin/>` until `config` set; Plus 激活凭据 until `activation` set; 试用资格检测 until `trial` set; RegisterConfigCard renders `null` (whole card absent) until `registerConfig` set — verify cards 2 & 3 pop in together.
   - Safety: SAFE

4. **No console errors / warnings on load.**
   - Precondition: admin, DevTools console open.
   - Steps: hard reload 设置.
   - Expected: zero `error`-level console messages; no unhandled promise rejections (note `fetchTrialCheckConfig().catch(()=>{})` swallows trial errors silently — confirm a failing `/api/trial-check` does NOT crash the page but DOES leave 试用资格检测 stuck on `<Spin/>`; flag as UX gap).
   - Safety: SAFE

5. **Trial-check endpoint failure is silently swallowed.**
   - Precondition: force `/api/trial-check` to 500.
   - Steps: load page.
   - Expected: other 4 cards render normally; 试用资格检测 stays on `<Spin/>` with no toast/error (documented behavior via `.catch(()=>{})`). Record as a discrepancy/UX nit, not a crash.
   - Safety: SAFE

---

## Dimension 2 — Data render & every field vs SettingsConfig / backend

6. **基础设置 全局代理 renders `config.proxy`.**
   - Expected: `Input` value === `config.proxy` (backend `config.get_proxy_settings()` / `SettingsConfig.proxy`). Empty string shows placeholder `留空则不使用代理，例：http://host:port`.
   - Safety: SAFE

7. **账号刷新间隔 renders numeric `refresh_account_interval_minute`.**
   - Expected: `InputNumber` value === `Number(config.refresh_account_interval_minute)` (backend clamps to int, default 5, `min=0` on the control). Verify a stored string ("10") renders as number 10.
   - Safety: SAFE

8. **刷新后自动重登 switch reflects `auto_relogin_after_refresh`.**
   - Expected: `Switch checked` === `!!config.auto_relogin_after_refresh` (backend accepts bool or "1/true/on" strings).
   - Safety: SAFE

9. **SettingsConfig fields NOT rendered — confirm intentional omission.**
   - Expected: `base_url`, `global_system_prompt`, `sensitive_words`, `log_levels`, `auto_remove_invalid_accounts`, `auto_remove_rate_limited_accounts`, `backup`, `image_storage`, `chat_completion_cache` (all present in `SettingsConfig` type / `config.get()`) have **no UI** on this page. Assert they are neither shown nor wiped on save (see case 21). `auto_remove_*` are hardcoded `False` server-side (deprecated) — must not resurface.
   - Safety: SAFE

10. **注册配置 numeric fields vs RegisterConfig.**
    - Expected: 目标注册数量 === `config.total` (min=1); 并发数 === `config.threads` (min=1); 注册代理 === `config.proxy` (register-scoped, distinct from 基础设置 全局代理); 同 IP 保活时长 === `config.ip_duration ?? 120` (min=1, **max=2880**).
    - Safety: SAFE

11. **注册区域 multi-select default.**
    - Expected: value === `config.regions` when non-empty, else falls back to `["US"]`. Option list is exactly 美国 US / 日本 JP / 印度 IN.
    - Safety: SAFE

12. **号一号一 IP + 2FA switches.**
    - Expected: 号一号一 IP `Switch` === `!!config.ipweb_rotate`; 2FA `Switch` === `!!config.enable_2fa`. 同 IP 保活 field is `disabled` when `!config.ipweb_rotate`.
    - Safety: SAFE

13. **邮箱配置 mode + provider fields.**
    - Expected: 邮箱模式 select === `providerType` derived from `config.mail.providers[0].type` (api_mailbox default). When `cloudmail_gen`: renders CloudMail URL/邮箱前缀/管理员邮箱/管理员密码(password)/域名(TextArea)/子域名(TextArea) bound to `provider.*`. When `api_mailbox`: renders tertiary hint text, no fields. 收件请求超时/等待验证码超时/轮询间隔 === `config.mail.request_timeout|wait_timeout|wait_interval` (each min=1).
    - Safety: SAFE

14. **Plus 激活凭据 masked key + base_url.**
    - Expected: CDK API Key is `mode="password"`; label appends `（已配置，可留空不改）` and placeholder `••••••（已配置）` iff `activation.has_api_key`. CDK API 地址 === `activation.base_url`. Raw `api_key` must not be pre-filled when only `has_api_key` is known (backend strips `api_key` from `/api/settings` and returns `has_api_key`).
    - Safety: SAFE

15. **试用资格检测 fields vs TrialCheckConfig.**
    - Expected: 开关 === `trial.enabled`; 检测 API Key is a **local** password input (`trialKey` state, always starts empty — value is NEVER pre-populated from server since `api_key` is not returned); label/placeholder show `（已配置，可留空不改）` / `••••••（已配置）` iff `trial.has_api_key`; 检测 API 地址 === `trial.base_url`.
    - Safety: SAFE

---

## Dimension 3 — Interactions (inputs / switches / selects / dialog)

16. **Edit text/number inputs — local state updates, no auto-save.**
    - Steps: change 全局代理, 账号刷新间隔, 注册代理, CDK API 地址, 检测 API 地址.
    - Expected: values update in the controlled inputs; NO network request until the relevant 保存 is clicked. `setRefreshInterval` stores `String(v ?? 0)`; 账号刷新间隔 accepts 0.
    - Safety: SAFE (no save)

17. **Toggle switches (刷新后自动重登, 号一号一 IP, 2FA, 试用开关).**
    - Steps: flip each switch.
    - Expected: visual state flips; toggling 号一号一 IP enables/disables the 同 IP 保活 field live; no save fired.
    - Safety: SAFE (no save)

18. **注册区域 multi-select add/remove.**
    - Steps: add JP + IN, then remove all.
    - Expected: multi-select chips reflect selection; `setRegions` receives array; removing all should keep last committed value until save (verify empty array is allowed pre-save; on next render empties fall back to `["US"]` display).
    - Safety: SAFE (no save)

19. **邮箱模式 select switches provider UI.**
    - Steps: switch api_mailbox → cloudmail_gen → back.
    - Expected: CloudMail field grid appears/disappears; `setProviderType` updates `providers[0].type`; existing provider sub-fields persist across toggles within the session.
    - Safety: SAFE (no save)

20. **Password reveal / masked inputs.**
    - Steps: interact with CDK API Key, 管理员密码, 检测 API Key (all `mode="password"`).
    - Expected: Semi password Inputs render masked with the show/hide eye affordance; toggling reveals typed text; leaving a masked "already-configured" field blank must not overwrite the stored key on save (see cases 24, 26).
    - Safety: SAFE

21. **重置统计 confirm dialog — OPEN then CANCEL.**
    - Precondition: register NOT running (`config.enabled === false`, else button disabled).
    - Steps: click 重置统计; Popconfirm opens (title 确认重置统计？, content 将清空当前注册统计数据); click 取消 / click outside.
    - Expected: NO request sent; `resetRegister` NOT called; stats unchanged.
    - Safety: SAFE (cancel path of a DANGER action)

22. **Disabled-while-running guard.**
    - Precondition: register run active (`config.enabled === true`).
    - Steps: observe 注册配置 保存 + 重置统计 buttons and all register/mail fields.
    - Expected: 保存 and 重置统计 are `disabled`; every register/mail input carries `disabled={running}`. (基础设置 / Plus 激活凭据 / 试用资格检测 saves remain enabled — they are independent of the register run.)
    - Safety: SAFE

---

## Dimension 4 — Actions (saves = REVERSIBLE, reset = DANGER, reads = SAFE)

23. **保存 基础设置.**
    - Steps: change 全局代理 + 账号刷新间隔 + 刷新后自动重登, click 基础设置 保存.
    - Expected: `saveConfig` → `POST /api/settings`; success `Toast.success("基础设置已保存")`; button shows `loading` then resettles; failure path shows `Toast.error(message)`. Backend `config.update()` merges (does NOT drop unrendered keys — see case 9). Re-editable ⇒ REVERSIBLE.
    - Safety: REVERSIBLE

24. **保存 注册配置 (covers 邮箱配置 too).**
    - Steps: change 目标注册数量 + 注册区域 + 邮箱模式 + a mail timeout, click 注册配置 保存.
    - Expected: `saveRegister` → `POST /api/register` with the merged RegisterConfig incl. mail providers; `Toast.success("注册配置已保存")`. Confirm card-3 (邮箱配置) edits persist even though that card has no button.
    - Safety: REVERSIBLE

25. **保存 Plus 激活凭据.**
    - Steps: set CDK API 地址; (a) leave key blank when `has_api_key` → stored key must survive; (b) type a new key → key updates.
    - Expected: `saveActivation` persists via activation config endpoint; `Toast.success("激活凭据已保存")`; blank masked key does not clear existing secret.
    - Safety: REVERSIBLE

26. **保存 试用资格检测.**
    - Steps: toggle 开关, set 检测 API 地址, (a) leave key blank, (b) type new key; click 保存.
    - Expected: `updateTrialCheckConfig({enabled, base_url, ...(trialKey? {api_key}:{})})` → `POST /api/trial-check`; response updates `trial`, `trialKey` cleared to ""; `Toast.success("试用资格检测配置已保存")`. Blank key ⇒ `api_key` omitted from body ⇒ backend keeps existing (`exclude_none` + only-set-keys). Backend never echoes the key back (only `has_api_key`).
    - Safety: REVERSIBLE

27. **Save failure surfaces a toast, no partial UI corruption.**
    - Steps: force each save endpoint to 400/500; click each 保存.
    - Expected: `Toast.error` with server message or "保存失败"; `saving*` flag resets in `finally`; inputs retain edited values (nothing lost).
    - Safety: REVERSIBLE (attempt)

28. **重置统计 — CONFIRM (destructive).**
    - Precondition: register not running; note current 注册统计 (success/fail/done).
    - Steps: click 重置统计 → 确认.
    - Expected: `resetRegister` → `POST /api/register/reset`; stats zeroed; NO undo. This is the only destructive action on the page.
    - Safety: **DANGER**

29. **Config reads on mount.**
    - Expected: the four GETs (`/api/settings`, `/api/activation`, `/api/register`, `/api/trial-check`) are read-only, mutate no server state, and are idempotent.
    - Safety: SAFE

---

## Dimension 5 — Responsive (desktop + mobile)

30. **Desktop layout.**
    - Precondition: viewport ≥ 1024px. Container `maxWidth: 880`.
    - Expected: cards stack vertically centered/left within 880px; RegisterConfigCard grids use `repeat(auto-fit, minmax(200px|220px, 1fr))` → multiple columns; 账号刷新间隔 InputNumber width 200px (non-mobile branch of `isMobile`).
    - Safety: SAFE

31. **Mobile layout.**
    - Precondition: viewport ≤ 480px (drives `useIsMobile()`).
    - Expected: 账号刷新间隔 InputNumber `width: "100%"`; register/mail grids collapse to single column; multi-select, password inputs, and Popconfirm remain usable; no horizontal scroll / overflow; save buttons in card headers stay reachable.
    - Safety: SAFE

32. **Tablet / intermediate reflow.**
    - Steps: sweep 481–1024px.
    - Expected: `auto-fit` grids reflow 1→2→3 columns without clipping labels or truncating InputNumber steppers.
    - Safety: SAFE

---

## Dimension 6 — Theme (light/dark) + i18n

33. **Light theme.**
    - Expected: Semi light tokens; card headers, tertiary hint `Text type="tertiary"`, masked inputs, switches all legible; adequate contrast.
    - Safety: SAFE

34. **Dark theme.**
    - Steps: toggle `body[theme-mode="dark"]`.
    - Expected: cards, InputNumber, Select dropdown panels, Popconfirm popover, Toast all adopt dark tokens; no hardcoded light-only colors; placeholders and disabled (running) fields still distinguishable.
    - Safety: SAFE

35. **i18n / copy.**
    - Expected: all labels are zh-CN literals baked into JSX (设置, 基础设置, 全局代理, 账号刷新间隔（分钟）, 注册配置, 重置统计, 确认重置统计？, 邮箱配置, 邮箱模式, Plus 激活凭据, 试用资格检测, 保存, Toasts). There is NO i18n framework here — assert copy is correct/consistent and note that language is not switchable (any locale toggle elsewhere will not affect this page).
    - Safety: SAFE

36. **a11y nit — InputNumber `aria-valuemax="0"` on unbounded fields.**
    - Steps: inspect ARIA on 账号刷新间隔 (min=0), 目标注册数量 (min=1), 并发数 (min=1), 收件请求超时 / 等待验证码超时 / 轮询间隔 (min=1).
    - Expected (observed defect): these fields specify only `min` and no `max`, and Semi emits `aria-valuemax="0"` — invalid because valuemax < valuemin. Contrast with 同 IP 保活时长 which sets `max={2880}` and reports a correct `aria-valuemax="2880"`. Flag as accessibility bug: unbounded InputNumbers should omit `aria-valuemax` or set a sane upper bound.
    - Safety: SAFE

---

## UI ↔ api.ts Discrepancy Summary

| # | Discrepancy | Evidence |
|---|---|---|
| D1 | **No user-key management UI.** `fetchUserKeys` / `createUserKey` / `updateUserKey` / `deleteUserKey` (`/api/auth/users`, backed by `auth_service.py`, `UserKey` type) exist in `api.ts` but NO component on the 设置 page (or anywhere reached from it) creates/lists/enables/deletes user keys. Admins cannot manage sub-user keys from the UI. | `api.ts:905-927`; `auth_service.py`; `SettingsPage.tsx` (absent) |
| D2 | **No upstream-proxy panel or test button.** `fetchProxy` / `updateProxy` / `testProxy` (`/api/proxy`, `/api/proxy/test`; `ProxySettings{enabled,url}`, `ProxyTestResult`) and backend `services.proxy_service.test_proxy` exist, but the page exposes NO enabled/url toggle and NO "测试代理" button. The only proxy input (基础设置 全局代理) writes `config.proxy` via `POST /api/settings` — a DIFFERENT mechanism from the `/api/proxy` ProxySettings object. Two proxy concepts, only one wired to UI, and the connectivity test is unreachable. | `api.ts:1020-1050`; `system.py` `/api/proxy/test` (require_admin); `SettingsPage.tsx:118-120` |
| D3 | **Unbounded InputNumber a11y defect.** 账号刷新间隔, 目标注册数量, 并发数, 收件请求超时, 等待验证码超时, 轮询间隔 declare only `min` → Semi renders `aria-valuemax="0"` (invalid vs `min≥1`/`min=0`). Only 同 IP 保活时长 (`max={2880}`) is correct. | `SettingsPage.tsx:122-127`; `RegisterConfigCard.tsx:65,69,103-110,182` |
| D4 | **邮箱配置 card has no own save button.** Cards 2 (注册配置) and 3 (邮箱配置) are one `RegisterConfigCard` sharing a single `saveRegister`; the visible 保存 lives on card 2. A tester expecting a per-card save on 邮箱配置 will find none — its edits persist only via the 注册配置 保存. | `RegisterConfigCard.tsx:44-186` |
| D5 | **试用资格检测 GET failure is swallowed silently.** `fetchTrialCheckConfig().catch(()=>{})` — a failing `/api/trial-check` leaves the card stuck on `<Spin/>` with no toast/retry, unlike the other three cards. | `SettingsPage.tsx:50-52` |
| D6 (minor) | **Register config shares proxy naming with base settings.** 基础设置 全局代理 (`config.proxy` / outbound `proxy_service.build_session_kwargs`) and 注册代理 (`registerConfig.proxy`) are distinct backend fields but both labelled around "代理" — verify a save to one does not clobber the other. | `config.py:536`; `RegisterConfigCard.tsx:72-74` |
