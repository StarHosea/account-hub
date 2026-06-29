from __future__ import annotations

from fastapi import APIRouter, Header
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from api.support import require_admin
from services.cdk_service import cdk_service


class CdkImportRequest(BaseModel):
    text: str
    type: str  # UPI | IDEL


class CdkDeleteRequest(BaseModel):
    cdks: list[str]


def _payload() -> dict:
    return {"items": cdk_service.list_cdks(), "counts": cdk_service.counts()}


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/cdks")
    async def list_cdks(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return _payload()

    @router.post("/api/cdks")
    async def import_cdks(body: CdkImportRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        result = cdk_service.import_text(body.text, body.type)
        return {**_payload(), "result": result}

    @router.delete("/api/cdks")
    async def delete_cdks(body: CdkDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        removed = cdk_service.delete(body.cdks)
        return {**_payload(), "removed": removed}

    @router.get("/api/cdks/export")
    async def export_cdks(type: str | None = None, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return PlainTextResponse(cdk_service.export_text(type))

    return router
