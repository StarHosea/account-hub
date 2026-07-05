from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.support import require_admin
from services.activation_service import activation_service
from services.config import config


class ActivationStartRequest(BaseModel):
    tokens: list[str] | None = None
    emails: list[str] | None = None
    limit: int | None = None
    concurrency: int | None = None


class ActivationAuditDeleteRequest(BaseModel):
    emails: list[str] | None = None
    access_tokens: list[str] | None = None
    delete_accounts: bool = False


class ActivationConfigRequest(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    concurrency: int | None = None
    poll_interval: float | None = None
    poll_timeout: float | None = None
    max_attempts_per_type: int | None = None
    auto_activate_after_register: bool | None = None
    # 激活数量（本轮目标激活数）：作为 start 的 limit 缺省值，持久化到 cdk_activation.target。
    target: int | None = None


def _safe_config() -> dict:
    cfg = config.cdk_activation
    return {**cfg, "api_key": "", "has_api_key": bool(cfg["api_key"])}


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/activation")
    async def get_activation(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"activation": activation_service.get(), "config": _safe_config()}

    @router.post("/api/activation/config")
    async def update_activation_config(body: ActivationConfigRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        config.update_cdk_activation(body.model_dump(exclude_none=True))
        return {"config": _safe_config()}

    @router.post("/api/activation/start")
    async def start_activation(body: ActivationStartRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {
            "activation": activation_service.start(body.tokens, body.limit, body.emails, body.concurrency),
            "config": _safe_config(),
        }

    @router.post("/api/activation/stop")
    async def stop_activation(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"activation": activation_service.stop(), "config": _safe_config()}

    @router.post("/api/activation/clear-logs")
    async def clear_activation_logs(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"activation": activation_service.clear_logs(), "config": _safe_config()}

    @router.get("/api/activation/events")
    async def activation_events(token: str = ""):
        require_admin(f"Bearer {token}")

        async def stream():
            last = ""
            while True:
                payload = json.dumps({"activation": activation_service.get(), "config": _safe_config()}, ensure_ascii=False)
                if payload != last:
                    last = payload
                    yield f"data: {payload}\n\n"
                await asyncio.sleep(0.5)

        return StreamingResponse(stream(), media_type="text/event-stream")

    @router.get("/api/activation/audit")
    async def list_activation_audit(
        authorization: str | None = Header(default=None),
        q: str = "",
        outcome: str = "",
        abnormal_only: bool = False,
        page: int = 1,
        page_size: int = 50,
    ):
        require_admin(authorization)
        from services.activation_audit_service import activation_audit_service

        return {
            **activation_audit_service.list_items(
                q=q or None,
                outcome=outcome or None,
                abnormal_only=abnormal_only,
                page=page,
                page_size=page_size,
            ),
            "stats": activation_audit_service.stats(),
        }

    @router.get("/api/activation/audit/{audit_id}")
    async def get_activation_audit(audit_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        from services.activation_audit_service import activation_audit_service

        item = activation_audit_service.get(audit_id)
        if not item:
            raise HTTPException(status_code=404, detail={"error": "审计记录不存在"})
        return {"item": item}

    @router.get("/api/activation/audit/by-account/latest")
    async def get_latest_activation_audit(
        authorization: str | None = Header(default=None),
        access_token: str = "",
        email: str = "",
    ):
        require_admin(authorization)
        from services.activation_audit_service import activation_audit_service

        item = activation_audit_service.latest_for_account(access_token=access_token, email=email)
        if not item:
            raise HTTPException(status_code=404, detail={"error": "未找到该账号的激活审计记录"})
        return {"item": item}

    @router.delete("/api/activation/audit")
    async def delete_activation_audit(
        body: ActivationAuditDeleteRequest,
        authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        from services.account_service import account_service
        from services.activation_audit_service import activation_audit_service

        emails = [str(e).strip() for e in (body.emails or []) if str(e).strip()]
        tokens = [str(t).strip() for t in (body.access_tokens or []) if str(t).strip()]
        removed = 0
        if emails:
            removed += activation_audit_service.delete_by_emails(emails)
        if tokens:
            removed += activation_audit_service.delete_by_access_tokens(tokens)
        accounts_removed = 0
        if body.delete_accounts and tokens:
            accounts_removed = int(account_service.delete_accounts(tokens).get("removed") or 0)
        return {"removed": removed, "accounts_removed": accounts_removed}

    return router
