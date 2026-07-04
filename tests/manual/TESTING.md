# 资源回收加固 · 本地测试手册

覆盖两个场景:**激活 + CDK 回收**、**注册 + 邮箱回收**;验证三道防线:
① 优雅关闭释放 ② 后台 reaper 按龄回收(不重启) ③ 启动对账。

> 单进程单实例假设。所有测试数据带 `TEST-`/`test-` 标记,`seed clean` 一键清除,不动真实数据。

---

## 0. 准备

三个终端(后端 / mock / 操作),都在项目根目录。

```bash
# 备份真实数据(保险,可选)
cp data/mailboxes.json data/cdks.json data/accounts.json /tmp/

# 注入测试数据
.venv/bin/python tests/manual/seed_test_data.py inject
.venv/bin/python tests/manual/seed_test_data.py status   # 确认注入
```

注入内容:
- 邮箱:3 个可用 `test-fresh-0x`;1 个**陈旧占用** `test-stale-inuse`(in_use_at 1 小时前);1 个**新占用** `test-fresh-inuse`(刚刚)。
- CDK:`TEST-OK/PEND/BAD/FAIL/STUCK-*`(available),配合 mock 切换结果。
- 账号:2 个 `激活中` 僵尸号,`test-token-stuck-old`(1 小时前)、`test-token-stuck-fresh`(刚刚)。

**mock 已就位**:`data/settings.json` 的 `cdk_activation.base_url=http://127.0.0.1:8899`、`api_key=mock-key`。

---

## 1. 启动 mock 激活服务(终端 2)

```bash
.venv/bin/python tests/manual/mock_activation_server.py --pending 2
```
按 CDK 前缀返回:`OK`→成功 / `PEND`→轮询 2 次后成功 / `BAD`→not_found / `FAIL`→失败 / `STUCK`→永远 pending。

---

## 2. 场景 A:激活链路 + CDK 回收

### A1. happy path(激活成功、CDK 消耗)
后端正常起(终端 1):
```bash
.venv/bin/python main.py
```
用 UI 或 API 对某个正常账号发起激活(选 UPI)。预期:
- mock 收到 submit(终端 2 有日志);
- 该账号 `plus_status` → 已激活;`TEST-OK-UPI-0001` 状态 → `used`;
- 激活日志显示成功。

### A2. CDK 无效换码
对激活用 `TEST-BAD-*`:预期 mock 返回 not_found → 引擎 `mark_invalid`(CDK 变 `invalid`)→ 自动换下一个 CDK,不计失败次数。

### A3. ⭐ CDK 僵尸占用被 reaper 回收(核心)
CDK 预占是**内存态**,要在运行时制造。用 `TEST-STUCK-*` 让激活卡在 pending 持有 CDK,再靠 reaper 回收。

**为便于观察,用快阈值重启后端**(终端 1):
```bash
# Ctrl+C 停掉后端,改用快阈值重启:reaper 每 5s 扫,占用超 15s 即回收
REAP_INTERVAL_SECONDS=5 REAP_MAX_AGE_SECONDS=15 .venv/bin/python main.py
```
- 对账号用 `TEST-STUCK-UPI-0001` 发起激活 → 激活线程提交后进入轮询(mock 永远 pending),此刻该 CDK 处于「进行中」预占。
- 观察后端日志:约 15~20s 后出现 `[reap] ... 'cdks': 1`,该 CDK 预占被回收(可被其他账号再次领取)。
- 对照:改前(`dict` 无 `.discard`)`release/consume` 一调用即崩溃;改后 reaper 能按龄清理内存预占。

> 生产默认阈值 720s(不设 env)。上面 env 仅为快速演示。

---

## 3. 场景 B:注册链路 + 邮箱回收

> ⚠️ 真实注册要跑 node 引擎 + 浏览器 + 真实邮箱 API,mock 无法覆盖。故这里**不真跑注册**,而是直接验证「邮箱占用 → 中断 → 回收」的三条路径(worker 领邮箱走的就是 `mailbox_service.acquire_unused`,占用语义完全一致)。

### B1. ⭐ reaper 按龄回收陈旧占用(不重启)
seed 已注入 `test-stale-inuse`(占用 1 小时前)与 `test-fresh-inuse`(刚占用)。用**默认阈值**起后端即可(720s):陈旧的 3600s>720s 会被首个 60s 周期回收,新占用不动。

```bash
.venv/bin/python main.py         # 默认阈值
```
- ≤60s 后日志出现 `[reap] ... 'mailboxes': 1`;
- 查:`test-stale-inuse` → `in_use=false`(已释放);`test-fresh-inuse` → 仍 `in_use=true`(未误伤)。
```bash
.venv/bin/python tests/manual/seed_test_data.py status
```

### B2. 模拟「注册中途硬杀」后 reaper 回收(不重启)
用快阈值起后端,再用脚本模拟 worker 领了邮箱就"死了":
```bash
REAP_INTERVAL_SECONDS=5 REAP_MAX_AGE_SECONDS=10 .venv/bin/python main.py
```
另开终端占用一个 fresh 邮箱(模拟 worker 领取后进程/线程消失,不释放):
```bash
.venv/bin/python - <<'PY'
from services.mailbox_service import mailbox_service
m = mailbox_service.acquire_unused()
print("占用了", m)   # in_use=true, in_use_at=now
PY
```
> 注意:该子进程退出后,占用已落盘到 `mailboxes.json`,后端进程仍在跑。观察后端:约 10~15s 后 `[reap] ... 'mailboxes': 1`,该邮箱被按龄回收。**这正是原来做不到、必须等 1 小时或重启的场景。**

---

## 4. 场景 C:三道防线专项

### C1. 优雅关闭释放(防线①)
默认阈值起后端 → 用脚本占用一个 fresh 邮箱(同 B2)→ 对后端进程发 **SIGTERM**(`kill <pid>`)或 Ctrl+C。
- 观察后端 shutdown 日志:`request_stop()` + `[reap]` 收尾;
- 重启后端前先看 `mailboxes.json`:该邮箱应已 `in_use=false`(优雅关闭已释放,无需等 reaper)。
- 关键:`enabled/running` **未被翻动**——若注册任务原本 enabled,重启仍会自动续跑。

### C2. 启动对账(防线③)
制造"进程没走优雅关闭"的残留:seed 注入后**直接改数据**或用 `kill -9`。最简单:重新 `seed inject`(带陈旧 + 新占用),然后起后端。
- 启动日志出现对账结果(`reconcile`);
- `test-stale-inuse`、`test-token-stuck-old`/`test-token-stuck-fresh` 等**全部**被复位(启动对账 `max_age=None` 清全部,启动时无并发任务,清全部安全);
- 账号 `激活中` → `未激活`,邮箱 `in_use=false`。

---

## 5. 清理

```bash
# 停后端、停 mock
.venv/bin/python tests/manual/seed_test_data.py clean   # 清除所有 TEST- 数据
.venv/bin/python tests/manual/seed_test_data.py status  # 应全部为 0
```

---

## 附:环境变量(仅测试)

| 变量 | 作用 | 生产 |
|---|---|---|
| `REAP_INTERVAL_SECONDS` | reaper 扫描间隔(秒) | 不设 → 60 |
| `REAP_MAX_AGE_SECONDS` | 回收阈值(秒),绕过 720s/600s 下限 | 不设 → `2×(register_timeout+60)`,≥600 |

不设任何 env = 生产默认行为,零影响。

## 附:预期回收字段速查

| 资源 | 占用标记 | 回收后 |
|---|---|---|
| 邮箱 | `in_use=true, in_use_at` | `in_use=false, in_use_at=null` |
| 手机 | `reserved_at` | `reserved_at=null` |
| 账号 | `plus_status=激活中/排队中` | `plus_status=未激活` |
| CDK | 内存 `_reserved[cdk]=ts` | 从 `_reserved` 移除(status 仍 available) |
