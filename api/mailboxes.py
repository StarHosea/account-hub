from __future__ import annotations

from fastapi import APIRouter, Header
from pydantic import BaseModel

from api.support import require_admin
from services.mailbox_service import mailbox_service


class MailboxImportRequest(BaseModel):
    text: str


class MailboxDeleteRequest(BaseModel):
    emails: list[str]


class MailboxMarkRequest(BaseModel):
    emails: list[str]
    used: bool = True


def _payload() -> dict:
    return {"items": mailbox_service.list_mailboxes(), "stats": mailbox_service.stats()}


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/mailboxes")
    async def list_mailboxes(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return _payload()

    @router.post("/api/mailboxes")
    async def import_mailboxes(body: MailboxImportRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        result = mailbox_service.import_text(body.text)
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

    return router
