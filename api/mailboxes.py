from __future__ import annotations

from fastapi import APIRouter, Header, Query
from fastapi.responses import Response
from pydantic import BaseModel

from api.support import require_admin
from services.account_service import account_service
from services.mailbox_service import mailbox_service


class MailboxImportRequest(BaseModel):
    text: str


class MailboxDeleteRequest(BaseModel):
    emails: list[str]


class MailboxMarkRequest(BaseModel):
    emails: list[str]
    used: bool = True


def _paginate(seq: list[dict], page: int, page_size: int) -> list[dict]:
    start = (page - 1) * page_size
    return seq[start : start + page_size]


def _payload() -> dict:
    return {"items": mailbox_service.list_mailboxes(), "stats": mailbox_service.stats()}


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/mailboxes")
    async def list_mailboxes(
        authorization: str | None = Header(default=None),
        q: str | None = Query(default=None),
        status: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=10, ge=1, le=200),
    ):
        require_admin(authorization)
        items = mailbox_service.list_mailboxes()
        stats = mailbox_service.stats()  # 全库口径，不随筛选变化

        keyword = (q or "").strip().lower()
        if keyword:
            items = [
                m
                for m in items
                if keyword in str(m.get("email") or "").lower()
                or keyword in str(m.get("fetch_url") or "").lower()
            ]
        if status == "in_use":
            items = [m for m in items if m.get("in_use") and not m.get("used")]
        elif status == "used":
            items = [m for m in items if m.get("used")]
        elif status == "unused":
            items = [m for m in items if mailbox_service.is_available_email(str(m.get("email") or ""))]

        total = len(items)
        return {
            "items": _paginate(items, page, page_size),
            "stats": stats,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @router.post("/api/mailboxes")
    async def import_mailboxes(body: MailboxImportRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        result = mailbox_service.import_text(body.text)
        from services.mailbox_service import parse_mailbox_lines
        for entry in parse_mailbox_lines(body.text):
            account_service.upsert_mailbox_record(entry["email"], entry["fetch_url"])
        return {**_payload(), "result": result}

    @router.delete("/api/mailboxes")
    async def delete_mailboxes(body: MailboxDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        removed = mailbox_service.delete(body.emails)
        return {**_payload(), "removed": removed}

    @router.post("/api/mailboxes/mark")
    async def mark_mailboxes(body: MailboxMarkRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        changed = mailbox_service.mark_used(body.emails, body.used)
        return {**_payload(), "changed": changed}

    @router.get("/api/mailboxes/export")
    async def export_mailboxes(
        only_unused: bool = Query(default=False),
        token: str = "",
        authorization: str | None = Header(default=None),
    ):
        """导出邮箱池：每行 `邮箱---收件地址`。"""
        require_admin(authorization or f"Bearer {token}")
        text = mailbox_service.export_text(only_unused=only_unused)
        text = text + ("\n" if text else "")
        return Response(
            text,
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="mailboxes.txt"'},
        )

    return router
