from __future__ import annotations

from fastapi import APIRouter, Header, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from api.support import require_admin
from services.phone_service import phone_service


class PhoneImportRequest(BaseModel):
    text: str


class PhoneDeleteRequest(BaseModel):
    phones: list[str]


class PhoneUsedRequest(BaseModel):
    phones: list[str]
    used: bool


class PhoneUseRequest(BaseModel):
    phones: list[str]
    delta: int = 1


def _paginate(seq: list[dict], page: int, page_size: int) -> list[dict]:
    start = (page - 1) * page_size
    return seq[start : start + page_size]


def _payload() -> dict:
    return {"items": phone_service.list_phones(), "counts": phone_service.counts()}


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/phones")
    async def list_phones(
        authorization: str | None = Header(default=None),
        q: str | None = Query(default=None),
        used: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=10, ge=1, le=200),
    ):
        require_admin(authorization)
        items = phone_service.list_phones()
        counts = phone_service.counts()  # 全库口径，不随筛选变化

        if used in ("0", "1", "true", "false"):
            want = used in ("1", "true")
            items = [p for p in items if bool(p.get("used")) == want]

        keyword = (q or "").strip().lower()
        if keyword:
            items = [
                p
                for p in items
                if keyword in str(p.get("phone") or "").lower()
                or keyword in str(p.get("fetch_url") or "").lower()
            ]

        total = len(items)
        return {
            "items": _paginate(items, page, page_size),
            "counts": counts,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @router.post("/api/phones")
    async def import_phones(body: PhoneImportRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        result = phone_service.import_text(body.text)
        return {**_payload(), "result": result}

    @router.delete("/api/phones")
    async def delete_phones(body: PhoneDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        removed = phone_service.delete(body.phones)
        return {**_payload(), "removed": removed}

    @router.patch("/api/phones/used")
    async def set_used(body: PhoneUsedRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        changed = phone_service.mark_used(body.phones, body.used)
        return {**_payload(), "changed": changed}

    @router.post("/api/phones/use")
    async def add_usage(body: PhoneUseRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        changed = phone_service.add_usage(body.phones, body.delta)
        return {**_payload(), "changed": changed}

    @router.get("/api/phones/export")
    async def export_phones(only_unused: bool = Query(default=False), authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return PlainTextResponse(phone_service.export_text(only_unused))

    return router
