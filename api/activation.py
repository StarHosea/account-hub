from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.support import require_admin
from services.activation_service import activation_service
from services.config import config


class ActivationStartRequest(BaseModel):
    tokens: list[str] | None = None
    limit: int | None = None


class ActivationConfigRequest(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    concurrency: int | None = None
    poll_interval: float | None = None
    poll_timeout: float | None = None
    max_attempts_per_type: int | None = None
    auto_activate_after_register: bool | None = None
    # 激活数量（本轮目标激活数）：作为 start 的 limit 缺省值，持久化到 cdk_activation.target。
    target: int | None = None


def _safe_config() -> dict:
    cfg = config.cdk_activation
    return {**cfg, "api_key": "", "has_api_key": bool(cfg["api_key"])}


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/activation")
    async def get_activation(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"activation": activation_service.get(), "config": _safe_config()}

    @router.post("/api/activation/config")
    async def update_activation_config(body: ActivationConfigRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        config.update_cdk_activation(body.model_dump(exclude_none=True))
        return {"config": _safe_config()}

    @router.post("/api/activation/start")
    async def start_activation(body: ActivationStartRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"activation": activation_service.start(body.tokens, body.limit), "config": _safe_config()}

    @router.post("/api/activation/stop")
    async def stop_activation(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"activation": activation_service.stop(), "config": _safe_config()}

    @router.post("/api/activation/clear-logs")
    async def clear_activation_logs(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"activation": activation_service.clear_logs(), "config": _safe_config()}

    @router.get("/api/activation/events")
    async def activation_events(token: str = ""):
        require_admin(f"Bearer {token}")

        async def stream():
            last = ""
            while True:
                payload = json.dumps({"activation": activation_service.get(), "config": _safe_config()}, ensure_ascii=False)
                if payload != last:
                    last = payload
                    yield f"data: {payload}\n\n"
                await asyncio.sleep(0.5)

        return StreamingResponse(stream(), media_type="text/event-stream")

    return router
