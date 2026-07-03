from __future__ import annotations

"""进程启动时的对账恢复：清理硬杀（SIGKILL / 容器重启）残留的中间态。

后台任务线程都是 daemon 线程，进程退出时被直接杀死、不走优雅收尾，可能留下：
- 账号卡在「排队中/激活中」（持久化，且默认激活只选「未激活」→ 永久卡死）
- 邮箱 in_use=True 残留（靠 1 小时超时才回收，太慢）
- 手机号 reserved_at 预占残留

本模块在 api/app.py 的 lifespan 里、**先于**任务续跑执行，把这些中间态复位成可重跑的干净态。
CDK 的「进行中」占用是纯内存态（cdk_service._reserved），重启即自愈，无需对账。
"""

from services.account_service import account_service
from services.mailbox_service import mailbox_service
from services.phone_service import phone_service


def startup_recover() -> dict:
    """对账清理并返回各项计数。幂等：可安全重复调用。"""
    activations = account_service.reconcile_stuck_activations()
    mailboxes = mailbox_service.reconcile_in_use()
    phones = phone_service.reconcile_reserved()
    print(f"[recover] activations reset={activations}, mailboxes freed={mailboxes}, phones released={phones}")
    return {"activations": activations, "mailboxes": mailboxes, "phones": phones}
