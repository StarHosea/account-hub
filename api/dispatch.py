from __future__ import annotations

from fastapi import APIRouter, Header
from fastapi.concurrency import run_in_threadpool
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
    customer: str | None = None
    wechat: str | None = None
    xianyu: str | None = None
    plan: str | None = None
    note: str | None = None
    dispatch_no: str | None = None
    related_phone: str | None = None
    related_account_token: str | None = None
    pair_checkout: bool = False


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
        ok = False
        message = ""
        meta = dispatch_service.build_dispatch_meta(
            customer=body.customer or "",
            wechat=body.wechat or "",
            xianyu=body.xianyu or "",
            plan=body.plan or "",
            note=body.note or "",
            dispatch_no=body.dispatch_no or "",
            phone=body.related_phone or (body.id if kind == "phone" else ""),
            account_token=body.related_account_token or (body.id if kind == "account" else ""),
        )
        if kind == "account":
            if act == "checkout":
                # 出库含二次远端核验（刷新 token + 拉取信息），放线程池避免阻塞事件循环；核验通过后随出库落发号信息 meta。
                result = await run_in_threadpool(dispatch_service.checkout_account, body.id, meta)
                ok = bool(result.get("ok"))
                message = str(result.get("reason") or "")
                if ok and body.pair_checkout and body.related_phone:
                    dispatch_service.checkout_phone_with_meta(body.related_phone, meta)
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
                ok = dispatch_service.checkout_phone_with_meta(body.id, meta)
                if ok and body.pair_checkout and body.related_account_token:
                    dispatch_service.checkout_account_with_meta(body.related_account_token, meta)
            elif act == "cooldown":
                ok = dispatch_service.cooldown_phone(body.id)
            elif act == "invalid":
                ok = dispatch_service.invalid_phone(body.id)
            elif act == "release":
                dispatch_service.release_phone(body.id)
                ok = True
        return {"ok": ok, "message": message, "summary": _summary()}

    return router
