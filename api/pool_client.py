from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from api.support import require_pool_client
from services.mailbox_service import mailbox_service
from services.pool_mail_fetch import fetch_verification_code


class EmailClaimRequest(BaseModel):
    browser: str = ""


class EmailClaimResponse(BaseModel):
    email: str
    code_url: str


class VerificationCodeResponse(BaseModel):
    code: str = ""
    error: str = ""


class ReleaseResponse(BaseModel):
    ok: bool = True


def create_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/emails/claim", response_model=EmailClaimResponse)
    async def claim_email(
        body: EmailClaimRequest,
        authorization: str | None = Header(default=None),
        x_api_token: str | None = Header(default=None, alias="X-Api-Token"),
    ):
        require_pool_client(authorization, x_api_token)
        acquired = await run_in_threadpool(mailbox_service.acquire_unused)
        if not acquired:
            raise HTTPException(status_code=409, detail="邮箱池已空，请先在看板导入邮箱。")
        browser = str(body.browser or "").strip()
        if browser:
            email = str(acquired.get("email") or "").strip()
            if email:
                await run_in_threadpool(mailbox_service.append_note, email, f"browser={browser}")
        return EmailClaimResponse(
            email=str(acquired.get("email") or "").strip(),
            code_url=str(acquired.get("fetch_url") or "").strip(),
        )

    @router.get("/api/verification-code", response_model=VerificationCodeResponse)
    async def get_verification_code(
        email: str = Query(...),
        exclude: str | None = Query(default=None),
        attempts: int = Query(default=8, ge=1, le=30),
        interval: float = Query(default=3.0, ge=0.5, le=15.0),
        authorization: str | None = Header(default=None),
        x_api_token: str | None = Header(default=None, alias="X-Api-Token"),
    ):
        require_pool_client(authorization, x_api_token)
        addr = str(email or "").strip().lower()
        if not addr:
            return VerificationCodeResponse(code="", error="缺少邮箱参数。")
        fetch_url = await run_in_threadpool(mailbox_service.get_fetch_url, addr)
        if not fetch_url:
            return VerificationCodeResponse(code="", error=f"未找到邮箱 {addr} 的取码地址。")
        excludes = [part.strip() for part in str(exclude or "").split(",") if part.strip()]
        code, error = await run_in_threadpool(
            fetch_verification_code,
            fetch_url,
            exclude=excludes,
            attempts=attempts,
            interval_s=interval,
        )
        return VerificationCodeResponse(code=code, error=error)

    @router.post("/api/emails/{email}/release", response_model=ReleaseResponse)
    async def release_email(
        email: str,
        authorization: str | None = Header(default=None),
        x_api_token: str | None = Header(default=None, alias="X-Api-Token"),
    ):
        require_pool_client(authorization, x_api_token)
        addr = str(email or "").strip()
        if addr:
            await run_in_threadpool(mailbox_service.release, addr)
        return ReleaseResponse(ok=True)

    return router
