from __future__ import annotations

import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from services.activation_audit_service import ActivationAuditRecorder

_ctx = threading.local()


def get_recorder() -> "ActivationAuditRecorder | None":
    return getattr(_ctx, "recorder", None)


def set_recorder(recorder: "ActivationAuditRecorder | None") -> None:
    _ctx.recorder = recorder


def clear_recorder() -> None:
    _ctx.recorder = None
