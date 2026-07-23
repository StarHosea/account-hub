from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from api.support import require_admin
from services.log_service import log_service


class LogsDeleteRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)
    clear_all: bool = False


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/logs")
    async def list_logs(
        authorization: str | None = Header(default=None),
        type: str | None = Query(default=None),
        start_date: str | None = Query(default=None),
        end_date: str | None = Query(default=None),
        limit: int = Query(default=500, ge=1, le=1000),
    ):
        require_admin(authorization)
        items = log_service.list(
            type=str(type or "").strip(),
            start_date=str(start_date or "").strip(),
            end_date=str(end_date or "").strip(),
            limit=limit,
        )
        return {"items": items}

    @router.delete("/api/logs")
    async def delete_logs(body: LogsDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        if body.clear_all:
            return log_service.clear()
        ids = [str(item or "").strip() for item in body.ids if str(item or "").strip()]
        if not ids:
            raise HTTPException(status_code=400, detail={"error": "ids is required or clear_all=true"})
        return log_service.delete(ids)

    return router
