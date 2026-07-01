from __future__ import annotations

from fastapi import APIRouter, Header
from pydantic import BaseModel

from api.support import require_admin
from services.dispatch_service import dispatch_service
from services.phone_service import phone_service


class AcquireRequest(BaseModel):
    kind: str  # phone | account
    release_id: str | None = None  # 选「下一个」时先释放当前预占


class ActionRequest(BaseModel):
    kind: str  # phone | account
    id: str
    action: str  # checkout | cooldown | invalid | release


def _summary() -> dict:
    return {
        "account_available": dispatch_service.account_available_count(),
        "phone_available": phone_service.counts().get("available", 0),
    }


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/dispatch/summary")
    async def summary(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return _summary()

    @router.post("/api/dispatch/acquire")
    async def acquire(body: AcquireRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        kind = (body.kind or "").strip()
        # 选「下一个」：先释放当前预占的号，避免浪费。
        if body.release_id:
            if kind == "account":
                dispatch_service.release_account(body.release_id)
            elif kind == "phone":
                dispatch_service.release_phone(body.release_id)

        if kind == "account":
            item = dispatch_service.acquire_account()
        elif kind == "phone":
            item = dispatch_service.acquire_phone()
        else:
            item = None
        return {"item": item, "summary": _summary()}

    @router.post("/api/dispatch/action")
    async def action(body: ActionRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        kind = (body.kind or "").strip()
        act = (body.action or "").strip()
        ok = False
        if kind == "account":
            if act == "checkout":
                ok = dispatch_service.checkout_account(body.id)
            elif act == "invalid":
                ok = dispatch_service.invalid_account(body.id)
            elif act == "release":
                dispatch_service.release_account(body.id)
                ok = True
            # account 无冷却概念，cooldown 视为释放
            elif act == "cooldown":
                dispatch_service.release_account(body.id)
                ok = True
        elif kind == "phone":
            if act == "checkout":
                ok = dispatch_service.checkout_phone(body.id)
            elif act == "cooldown":
                ok = dispatch_service.cooldown_phone(body.id)
            elif act == "invalid":
                ok = dispatch_service.invalid_phone(body.id)
            elif act == "release":
                dispatch_service.release_phone(body.id)
                ok = True
        return {"ok": ok, "summary": _summary()}

    return router
