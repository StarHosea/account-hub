from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.support import require_admin
from services.run_service import run_service


class RunStartRequest(BaseModel):
    target: int | None = None
    auto_replenish: bool | None = None


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/run")
    async def get_run(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return run_service.get()

    @router.post("/api/run/start")
    async def start_run(body: RunStartRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return run_service.start(body.target, body.auto_replenish)

    @router.post("/api/run/stop")
    async def stop_run(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return run_service.stop()

    @router.get("/api/run/events")
    async def run_events(token: str = ""):
        require_admin(f"Bearer {token}")

        async def stream():
            last = ""
            while True:
                payload = json.dumps(run_service.get(), ensure_ascii=False)
                if payload != last:
                    last = payload
                    yield f"data: {payload}\n\n"
                await asyncio.sleep(0.5)

        return StreamingResponse(stream(), media_type="text/event-stream")

    return router
