from __future__ import annotations

from fastapi import APIRouter, Header, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from api.support import require_admin
from services.account_service import account_service
from services.cdk_service import cdk_service
from services.mailbox_service import mailbox_service


class CdkImportRequest(BaseModel):
    text: str
    type: str  # UPI | IDEL


class CdkDeleteRequest(BaseModel):
    cdks: list[str]


def _bound_email(token: str | None) -> str:
    """仅解析绑定账号的邮箱，用于 q 搜索匹配（账号已删返回空串）。"""
    if not token:
        return ""
    account = account_service.get_account(token)
    if not account:
        return ""
    return str(account.get("email") or "").strip()


def _bound_account(token: str | None) -> dict | None:
    """把 CDK 的 bound_token 解析成绑定账号的可展示信息（含接码地址）。账号已删则返回 None。"""
    if not token:
        return None
    account = account_service.get_account(token)
    if not account:
        return None
    email = str(account.get("email") or "").strip()
    return {
        "email": email or None,
        "password": account.get("password") or None,
        "totp_secret": account.get("totp_secret") or None,
        "otpauth_url": account.get("otpauth_url") or None,
        "fetch_url": (mailbox_service.get_fetch_url(email) or None) if email else None,
        "status": account.get("status") or None,
        "plus_status": account.get("plus_status") or None,
        "source_type": account.get("source_type") or None,
        "created_at": account.get("created_at") or None,
    }


def _paginate(seq: list[dict], page: int, page_size: int) -> list[dict]:
    start = (page - 1) * page_size
    return seq[start : start + page_size]


def _payload() -> dict:
    items = cdk_service.list_cdks()
    for item in items:
        item["bound_account"] = _bound_account(item.get("bound_token"))
    return {"items": items, "counts": cdk_service.counts()}


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/cdks")
    async def list_cdks(
        authorization: str | None = Header(default=None),
        q: str | None = Query(default=None),
        status: str | None = Query(default=None),
        type: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=10, ge=1, le=200),
    ):
        require_admin(authorization)
        items = cdk_service.list_cdks()
        counts = cdk_service.counts()  # 全库口径，不随筛选变化

        if status in ("available", "used", "invalid"):
            items = [c for c in items if c.get("status") == status]
        if type in ("UPI", "IDEL"):
            items = [c for c in items if c.get("type") == type]

        keyword = (q or "").strip().lower()
        if keyword:
            # 先按 cdk 粗筛；未命中的再解析绑定邮箱精筛，避免对全量做账号解析。
            items = [
                c
                for c in items
                if keyword in str(c.get("cdk") or "").lower()
                or keyword in _bound_email(c.get("bound_token")).lower()
            ]

        total = len(items)
        paged = _paginate(items, page, page_size)
        for item in paged:  # 仅对当前页解析展示用绑定账号信息
            item["bound_account"] = _bound_account(item.get("bound_token"))
        return {
            "items": paged,
            "counts": counts,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

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
