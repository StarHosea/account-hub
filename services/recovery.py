from __future__ import annotations

"""资源占用的对账恢复 + 运行期后台回收（reaper）。

后台任务线程都是 daemon 线程，进程退出时被直接杀死、不走优雅收尾，可能留下：
- 账号卡在「排队中/激活中」（持久化，且默认激活只选「未激活」→ 永久卡死）
- 邮箱 in_use=True 残留（否则靠 1 小时超时才回收，太慢）
- 手机号 reserved_at 预占残留
- CDK 进行中占用（纯内存 _reserved，进程存活期间卡死无超时回收）

两条防线：
1) startup_recover()：进程启动时（api/app.py lifespan，先于任务续跑）无条件清所有中间态——
   启动时无并发任务，清全部安全。
2) start_resource_reaper()：进程存活期间的后台线程，每 REAPER_INTERVAL_SECONDS 秒按「占用龄」
   只回收超过阈值的僵尸占用，不误伤正在进行的任务。阈值取单账号封顶时长（register_timeout+
   看门狗 60s）的 REAP_AGE_MULTIPLIER 倍，足以区分「死任务/活任务」；账号激活每推进一步都会
   刷新 plus_updated_at，等于持续续租，故进行中的激活不会被回收。
"""

import os
import threading

from services.account_service import account_service
from services.cdk_service import cdk_service
from services.mailbox_service import mailbox_service
from services.phone_service import phone_service

# reaper 扫描间隔（秒）；可用环境变量 REAP_INTERVAL_SECONDS 覆盖（仅测试用）
REAPER_INTERVAL_SECONDS = 60
# 回收阈值 = 单账号封顶时长的倍数；register_timeout+看门狗 60s 封顶，取 2x 足够区分死/活
REAP_AGE_MULTIPLIER = 2
# 阈值下限（秒）：即便 register_timeout 配得很小，也不低于此值，避免误杀慢任务
_MIN_REAP_AGE_SECONDS = 600.0
# register_timeout 取不到时的兜底基准（秒）
_DEFAULT_REGISTER_TIMEOUT = 300.0


def _env_float(name: str) -> float | None:
    """读取环境变量为正浮点数；未设/非法返回 None。仅用于本地测试快速调参。"""
    raw = os.environ.get(name)
    if not raw or not raw.strip():
        return None
    try:
        v = float(raw)
        return v if v > 0 else None
    except Exception:
        return None


def _reaper_interval() -> float:
    return _env_float("REAP_INTERVAL_SECONDS") or float(REAPER_INTERVAL_SECONDS)


def _register_timeout() -> float:
    """读取当前注册单账号超时配置（reaper 阈值随用户配置动态调整，不写死）。"""
    try:
        from services.register_service import register_service
        return float(register_service.get().get("register_timeout") or _DEFAULT_REGISTER_TIMEOUT)
    except Exception:
        return _DEFAULT_REGISTER_TIMEOUT


def _reap_max_age() -> float:
    """reaper 单轮使用的回收阈值：max(倍数×注册超时, 下限)，另计入看门狗 60s。

    可用环境变量 REAP_MAX_AGE_SECONDS 直接覆盖（仅测试用，绕过下限，方便几秒内验证回收）。
    """
    override = _env_float("REAP_MAX_AGE_SECONDS")
    if override is not None:
        return override
    return max(REAP_AGE_MULTIPLIER * (_register_timeout() + 60.0), _MIN_REAP_AGE_SECONDS)


def reap_expired(max_age: float | None) -> dict:
    """按龄回收四类资源的僵尸占用。

    max_age 为 None/<=0：清全部（启动对账语义）；>0：只清占用龄超过 max_age 秒的项。
    各 reconcile 内部都在对应 service 的锁内操作，单进程下与正常任务并发安全。返回各项计数。
    """
    activations = account_service.reconcile_stuck_activations(max_age)
    mailboxes = mailbox_service.reconcile_in_use(max_age)
    phones = phone_service.reconcile_reserved(max_age)
    cdks = cdk_service.reconcile_reserved(max_age)
    result = {"activations": activations, "mailboxes": mailboxes, "phones": phones, "cdks": cdks}
    if any(result.values()):
        print(f"[reap] max_age={max_age} -> {result}")
    return result


def startup_recover() -> dict:
    """进程启动时的对账清理：无条件清所有中间态。幂等，可安全重复调用。"""
    return reap_expired(None)


def start_resource_reaper(stop_event) -> threading.Thread:
    """启动后台 daemon 线程，周期性按龄回收僵尸占用。返回线程对象供 lifespan 停止。"""
    def _loop():
        while not stop_event.wait(_reaper_interval()):
            try:
                reap_expired(_reap_max_age())
            except Exception as exc:  # noqa: BLE001
                print(f"[reap] cycle failed: {exc}")

    thread = threading.Thread(target=_loop, daemon=True, name="resource-reaper")
    thread.start()
    return thread
