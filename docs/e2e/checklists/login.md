# E2E 测试清单 — 登录页 (LoginPage)

- 源文件: `web/src/pages/LoginPage.tsx`
- 依赖: `web/src/lib/use-auth-guard.ts` (`useRedirectIfAuthenticated`)、`web/src/store/auth.ts`、`web/src/lib/api.ts` (`login` → `POST /auth/login`)
- 后端: `api/system.py` (`/auth/login` → `require_identity`，返回 `{ok, version, role, subject_id, name}`)
- 路由: 未登录访问受保护页会被 `useAuthGuard` 重定向到 `/login`；已登录访问 `/login` 会被 `useRedirectIfAuthenticated` 重定向到默认路由。
- 安全标签说明: SAFE=纯读/无副作用；REVERSIBLE=有状态变更但可撤销（如写本地会话、登出）；DANGER=不可逆或影响线上运行的操作。**本页无 DANGER 操作。**

关键实现事实（用于断言）:
- 表单唯一字段 `key`（label「密钥」，`mode="password"`，`autoComplete="current-password"`）。
- 提交前 `String(values.key).trim()`；为空 → `Toast.warning("请输入密钥")` 且不发请求。
- 成功: `setStoredAuthSession({key, role, subjectId, name})` → `Toast.success("登录成功")` → `navigate(getDefaultRouteForRole(role), {replace:true})`。
- `getDefaultRouteForRole` **忽略 role，恒返回 `/accounts`**（admin 与 user 落点相同）。
- 失败: `Toast.error(error.message || "登录失败")`，`loading` 复位，停留在登录页。
- `login()` 用 `Authorization: Bearer <key>`、`redirectOnUnauthorized: false`（401 不触发全局跳转，直接抛错给本页处理）。
- 会话持久化在 localforage（`account-hub/auth` 实例，键 `account_hub_auth_key` / `account_hub_auth_session`）。

---

## 1. 加载 / 鉴权守卫 / 首屏 / 无 console 报错

1. **首屏渲染（未登录）** — 前置: 清空 localforage 会话。步骤: 访问 `/login`。预期: 鉴权检查瞬时结束（`isCheckingAuth` false），渲染 Card；标题「🐬 小海豚」、副标题「输入密钥后继续使用账号管理与生产工具。」、密钥输入框、solid primary 全宽「登录」按钮；无 console error/warning。标签: SAFE
2. **鉴权 loading 态** — 前置: 无。步骤: 观察进入 `/login` 瞬间。预期: 校验会话期间显示居中大号 `Spin`（100vh 垂直水平居中），校验完成后被表单替换；不闪烁两次。标签: SAFE
3. **已登录重定向** — 前置: 已存在有效会话（先正常登录一次）。步骤: 手动导航到 `/login`。预期: `useRedirectIfAuthenticated` 立即 `navigate("/accounts", {replace:true})`，不显示登录表单；history 不新增记录（replace）。标签: SAFE
4. **受保护页反向守卫** — 前置: 清空会话。步骤: 直接访问任一受保护路由（如 `/accounts`、`/register`）。预期: `useAuthGuard` 重定向到 `/login`。标签: SAFE
5. **损坏会话自愈** — 前置: 手动写入非法/残缺会话（缺 role 或 key）。步骤: 访问 `/login`。预期: `normalizeSession` 返回 null → `getValidatedAuthSession` 视为未登录 → 停留登录页，旧的孤立 key 被 `clearStoredAuthSession` 清理；无 console error。标签: SAFE

## 2. 数据渲染 & 字段对齐 api.ts 类型

6. **表单字段与类型一致** — 前置: 无。步骤: 检查表单。预期: 仅一个字段 `key`；无用户名/邮箱等多余字段；`placeholder="请输入访问密钥"`。标签: SAFE
7. **登录响应字段消费** — 前置: 有效密钥。步骤: 登录并检查网络响应。预期: `POST /auth/login` 返回 `LoginResponse{ok, version, role, subject_id, name}`；页面仅消费 `role/subject_id/name` 写入会话，`ok`/`version` 未使用（不应因缺 `version` 报错）。标签: REVERSIBLE
8. **会话落盘正确** — 前置: 有效密钥登录。步骤: 登录后查 localforage。预期: `account_hub_auth_key` = 输入密钥（trim 后）；`account_hub_auth_session` = `{key, role, subjectId, name}`；`subjectId` 来自 `subject_id`。标签: REVERSIBLE

## 3. 交互（输入 / 提交路径）

9. **空密钥拦截** — 前置: 无。步骤: 密钥留空点「登录」。预期: `Toast.warning("请输入密钥")`；不发起网络请求；按钮不进入 loading。标签: SAFE
10. **纯空格密钥拦截** — 前置: 无。步骤: 输入若干空格点登录。预期: trim 后为空 → 同上 warning，不发请求。标签: SAFE
11. **回车提交** — 前置: 输入任意密钥。步骤: 输入框内按 Enter。预期: 触发 `Form onSubmit`（等同点按钮）。标签: SAFE/REVERSIBLE（取决于密钥有效性）
12. **密码可见性/自动填充** — 前置: 无。步骤: 检查输入框类型。预期: `mode="password"` 掩码显示；`autoComplete="current-password"` 允许浏览器/密码管理器填充。标签: SAFE
13. **提交中禁用/loading** — 前置: 有效或无效密钥。步骤: 点登录观察按钮。预期: 请求进行中按钮 `loading`（转圈），完成后复位；不能重复并发提交。标签: SAFE

## 4. 动作按钮枚举（含安全标签）

> 本页仅一个可点击动作。

14. **[登录] 提交按钮 — 有效密钥** — 前置: 已知有效密钥。步骤: 输入 → 点击/回车。预期: 成功流程（写会话 → success toast → 跳 `/accounts`）。标签: **REVERSIBLE**（登录态可通过登出/清会话撤销；无线上破坏性副作用）
15. **[登录] 提交按钮 — 无效密钥** — 前置: 错误密钥。步骤: 提交。预期: 401 经 `redirectOnUnauthorized:false` 直接抛错 → `Toast.error(错误信息 || "登录失败")`；停留登录页；无会话写入。标签: SAFE
16. **[登录] 网络异常** — 前置: 断网 / 后端不可达。步骤: 提交。预期: `Toast.error`（异常 message）；loading 复位；不写会话。标签: SAFE

## 5. 响应式（桌面 + 移动）

17. **桌面布局** — 前置: 宽视口。步骤: 打开 `/login`。预期: Card 固定宽 380、`bodyStyle padding:28`，页面垂直水平居中，背景 `--semi-color-bg-0`。标签: SAFE
18. **移动布局** — 前置: 窄视口（约 375px）。步骤: 打开 `/login`。预期: 外层 `padding:16` 生效，Card 不溢出视口、不产生横向滚动；按钮全宽 `block` 可点。标签: SAFE
19. **超窄/横屏** — 前置: 320px 宽或横屏。步骤: 打开。预期: 内容仍居中、可读、无遮挡；`minHeight:100vh` 保持。标签: SAFE

## 6. 主题（明/暗）+ i18n

20. **明暗主题** — 前置: 分别切换 light/dark。步骤: 观察登录页。预期: 背景/文字/输入框/按钮均走 `--semi-color-*` 变量，暗色下对比度正常，无硬编码白底；副标题 `type="tertiary"` 两主题均可读。标签: SAFE
21. **文案与 i18n** — 前置: 无。步骤: 检查全部可见文案。预期: 均为中文硬编码（「🐬 小海豚」「密钥」「请输入访问密钥」「登录」「登录成功」「登录失败」「请输入密钥」）；项目无多语言切换，无缺失 key/占位符残留。标签: SAFE

---

## UI 与 api.ts / 后端差异记录

- **`getDefaultRouteForRole` 忽略角色**: 参数 `_role` 未使用，admin 与 user 登录后都落 `/accounts`；`AuthRole` 类型区分 admin/user 但登录落点不区分。若产品需按角色分流，此处为已知缺口。
- **`LoginResponse.version` / `ok` 未被前端消费**: 登录页只用 `role/subject_id/name`；后端返回的 `version`（应用版本）在登录路径上被丢弃。
- **无登出入口**: 登录写会话属 REVERSIBLE，但本页不含登出；撤销登录态需在其他页面或手动清 localforage（测试收尾请手动清理 `account_hub_auth_key` / `account_hub_auth_session`）。
- **401 处理分叉**: `login()` 显式 `redirectOnUnauthorized:false`，与其他 API 的全局 401 跳转行为不同；密钥错误只弹 Toast 不跳转，符合预期但需专门断言。
