from __future__ import annotations

import asyncio
import io
import json
import re
import uuid
import zipfile
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel, Field

from api.support import require_admin
from services.account_service import account_service
from services.mailbox_service import mailbox_service


class AccountCreateRequest(BaseModel):
    tokens: list[str] = Field(default_factory=list)
    accounts: list[dict[str, Any]] = Field(default_factory=list)
    text: str = ""


class AccountDeleteRequest(BaseModel):
    tokens: list[str] = Field(default_factory=list)


class AccountRefreshRequest(BaseModel):
    access_tokens: list[str] = Field(default_factory=list)


class AccountExportRequest(BaseModel):
    access_tokens: list[str] = Field(default_factory=list)
    format: Literal["json", "zip"] = "json"


class AccountUpdateRequest(BaseModel):
    access_token: str = ""
    type: str | None = None
    status: str | None = None
    quota: int | None = None
    proxy: str | None = None


class Account2FARequest(BaseModel):
    access_token: str = ""


class AccountMarkUsedRequest(BaseModel):
    access_tokens: list[str] = Field(default_factory=list)
    used: bool = True
    meta_by_token: dict[str, dict[str, str]] = Field(default_factory=dict)


class AccountCredentialsExportRequest(BaseModel):
    access_tokens: list[str] = Field(default_factory=list)
    only_unused: bool = False
    mark_used: bool = False


def _account_payload_token(item: dict[str, Any]) -> str:
    return str(item.get("access_token") or item.get("accessToken") or "").strip()


def _unique_tokens(tokens: list[str]) -> list[str]:
    return list(dict.fromkeys(str(token or "").strip() for token in tokens if str(token or "").strip()))


def _looks_like_jwt(token: str) -> bool:
    token = str(token or "").strip()
    return token.startswith("eyJ") and token.count(".") == 2


def _paginate(seq: list[Any], page: int, page_size: int) -> list[Any]:
    """按 1-based page 切片；page/page_size 已由 Query 约束为 >=1。"""
    start = (page - 1) * page_size
    return seq[start : start + page_size]


def _download_timestamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def _safe_export_name(value: str, fallback: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-._")
    return (clean or fallback)[:80]


def _account_zip_bytes(items: list[dict[str, str]]) -> bytes:
    buf = io.BytesIO()
    used_names: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        for index, item in enumerate(items, start=1):
            raw_name = item.get("email") or item.get("account_id") or f"account-{index:03d}"
            base_name = _safe_export_name(raw_name, f"account-{index:03d}")
            name = base_name
            suffix = 2
            while name in used_names:
                name = f"{base_name}-{suffix}"
                suffix += 1
            used_names.add(name)
            archive.writestr(
                f"{name}.json",
                json.dumps(item, ensure_ascii=False, indent=2) + "\n",
            )
    return buf.getvalue()


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/accounts")
    async def get_accounts(
        authorization: str | None = Header(default=None),
        q: str | None = Query(default=None),
        status: str | None = Query(default=None),
        plus: str | None = Query(default=None),
        used: bool | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=10, ge=1, le=200),
    ):
        require_admin(authorization)
        items = account_service.list_accounts()
        for item in items:
            item["mail_link"] = mailbox_service.get_fetch_url(str(item.get("email") or "")) or None

        # 全库统计（过滤前），始终反映整库口径。
        summary = {
            "total": len(items),
            "alive": sum(1 for a in items if a.get("status") in ("正常", "限流")),
            "dead": sum(1 for a in items if a.get("status") in ("异常", "禁用")),
            "activated": sum(1 for a in items if a.get("plus_status") == "已激活"),
            "unused": sum(1 for a in items if not a.get("used")),
        }

        # 过滤
        keyword = (q or "").strip().lower()
        if keyword:
            items = [
                a
                for a in items
                if keyword in str(a.get("email") or "").lower()
                or keyword in str(a.get("password") or "").lower()
            ]
        if status == "alive":
            items = [a for a in items if a.get("status") in ("正常", "限流")]
        elif status == "dead":
            items = [a for a in items if a.get("status") in ("异常", "禁用")]
        if plus == "activated":
            items = [a for a in items if a.get("plus_status") == "已激活"]
        elif plus == "inactive":
            items = [a for a in items if a.get("plus_status") != "已激活"]
        if used is not None:
            items = [a for a in items if bool(a.get("used")) == used]

        total = len(items)
        return {
            "items": _paginate(items, page, page_size),
            "summary": summary,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @router.post("/api/accounts")
    async def create_accounts(body: AccountCreateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        parsed_accounts, parsed_tokens = account_service.parse_import_blob(body.text)
        account_payloads = [item for item in body.accounts if isinstance(item, dict)] + parsed_accounts
        payload_tokens = [_account_payload_token(item) for item in account_payloads]
        tokens = _unique_tokens([*body.tokens, *parsed_tokens, *payload_tokens])
        if not tokens:
            raise HTTPException(status_code=400, detail={"error": "未识别到可导入的账号信息"})
        if account_payloads:
            result = account_service.add_account_items(account_payloads)
            payload_token_set = set(_unique_tokens(payload_tokens))
            extra_tokens = [token for token in tokens if token not in payload_token_set]
            if extra_tokens:
                extra_result = account_service.add_accounts(extra_tokens)
                result["added"] = int(result.get("added") or 0) + int(extra_result.get("added") or 0)
                result["skipped"] = int(result.get("skipped") or 0) + int(extra_result.get("skipped") or 0)
        else:
            result = account_service.add_accounts(tokens)
        # 导入后在后台异步校验，避免大量账号（尤其走代理时）阻塞导入请求造成前端长时间转圈。
        progress_id = str(uuid.uuid4())

        async def _do_refresh():
            try:
                await run_in_threadpool(account_service.refresh_accounts, tokens, progress_id, False)
            except Exception as e:
                account_service.finish_refresh_progress(progress_id, error=str(e))

        asyncio.create_task(_do_refresh())
        return {
            **result,
            "refresh_progress_id": progress_id,
            "items": result.get("items", []),
        }

    @router.delete("/api/accounts")
    async def delete_accounts(body: AccountDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        tokens = [str(token or "").strip() for token in body.tokens if str(token or "").strip()]
        if not tokens:
            raise HTTPException(status_code=400, detail={"error": "tokens is required"})
        return account_service.delete_accounts(tokens)

    @router.post("/api/accounts/refresh")
    async def refresh_accounts(body: AccountRefreshRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        access_tokens = [str(token or "").strip() for token in body.access_tokens if str(token or "").strip()]
        if not access_tokens:
            access_tokens = account_service.list_tokens()
        if not access_tokens:
            raise HTTPException(status_code=400, detail={"error": "access_tokens is required"})

        progress_id = str(uuid.uuid4())

        async def _do_refresh():
            try:
                await run_in_threadpool(account_service.refresh_accounts, access_tokens, progress_id, False)
            except Exception as e:
                account_service.finish_refresh_progress(progress_id, error=str(e))

        asyncio.create_task(_do_refresh())

        return {"progress_id": progress_id}

    @router.get("/api/accounts/refresh/progress/{progress_id}")
    async def get_refresh_progress(progress_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        progress = account_service.get_refresh_progress(progress_id)
        if progress is None:
            raise HTTPException(status_code=404, detail={"error": "progress not found"})
        return progress

    @router.post("/api/accounts/re-login")
    async def re_login_accounts(body: AccountRefreshRequest, authorization: str | None = Header(default=None)):
        """对选中账号执行密码重新登录流程（密码登录→验证码登录→刷新token）。"""
        require_admin(authorization)
        access_tokens = [str(token or "").strip() for token in body.access_tokens if str(token or "").strip()]
        if not access_tokens:
            raise HTTPException(status_code=400, detail={"error": "access_tokens is required"})

        progress_id = str(uuid.uuid4())

        async def _do_relogin():
            try:
                await run_in_threadpool(account_service.re_login_accounts, access_tokens, progress_id)
            except Exception as e:
                account_service.finish_relogin_progress(progress_id, error=str(e))

        asyncio.create_task(_do_relogin())

        return {"progress_id": progress_id}

    @router.get("/api/accounts/re-login/progress/{progress_id}")
    async def get_relogin_progress(progress_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        progress = account_service.get_relogin_progress(progress_id)
        if progress is None:
            raise HTTPException(status_code=404, detail={"error": "progress not found"})
        return progress

    @router.post("/api/accounts/export")
    async def export_accounts(body: AccountExportRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        access_tokens = _unique_tokens(body.access_tokens)
        items = account_service.build_export_items(access_tokens)
        if not items:
            raise HTTPException(
                status_code=400,
                detail={"error": "没有可导出的完整账号，需要同时有 access_token、refresh_token 和 id_token"},
            )

        timestamp = _download_timestamp()
        if body.format == "zip":
            content = _account_zip_bytes(items)
            return Response(
                content,
                media_type="application/zip",
                headers={"Content-Disposition": f'attachment; filename="codex-accounts-{timestamp}.zip"'},
            )

        payload: dict[str, str] | list[dict[str, str]] = items[0] if len(items) == 1 else items
        return Response(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="codex-accounts-{timestamp}.json"'},
        )

    @router.post("/api/accounts/export-credentials")
    async def export_credentials(body: AccountCredentialsExportRequest, authorization: str | None = Header(default=None)):
        """导出账号凭据：每行 `邮箱----接码地址----密码----2FA密钥`。接码地址取自绑定邮箱的 fetch_url。"""
        require_admin(authorization)
        tokens = _unique_tokens(body.access_tokens)
        accounts = account_service.list_accounts()
        if tokens:
            wanted = {account_service.resolve_access_token(t) for t in tokens}
            accounts = [a for a in accounts if str(a.get("access_token") or "") in wanted]
        if body.only_unused:
            accounts = [a for a in accounts if not a.get("used")]
        lines: list[str] = []
        exported_tokens: list[str] = []
        for acc in accounts:
            email = str(acc.get("email") or "").strip()
            fetch_url = (mailbox_service.get_fetch_url(email) or "") if email else ""
            password = str(acc.get("password") or "").strip()
            totp = str(acc.get("totp_secret") or "").strip()
            lines.append("----".join([email, fetch_url, password, totp]))
            exported_tokens.append(str(acc.get("access_token") or ""))
        if body.mark_used and exported_tokens:
            account_service.mark_used(exported_tokens, True)
        text = "\n".join(lines) + ("\n" if lines else "")
        timestamp = _download_timestamp()
        return Response(
            text,
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="accounts-credentials-{timestamp}.txt"'},
        )

    @router.post("/api/accounts/mark-used")
    async def mark_accounts_used(body: AccountMarkUsedRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        tokens = _unique_tokens(body.access_tokens)
        if not tokens:
            raise HTTPException(status_code=400, detail={"error": "access_tokens is required"})
        return account_service.mark_used(tokens, bool(body.used), body.meta_by_token)

    @router.post("/api/accounts/update")
    async def update_account(body: AccountUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        access_token = str(body.access_token or "").strip()
        if not access_token:
            raise HTTPException(status_code=400, detail={"error": "access_token is required"})
        updates = {key: value for key, value in {"type": body.type, "status": body.status, "quota": body.quota, "proxy": body.proxy}.items() if value is not None}
        if not updates:
            raise HTTPException(status_code=400, detail={"error": "还没有检测到改动，请修改后再保存"})
        account = account_service.update_account(access_token, updates)
        if account is None:
            raise HTTPException(status_code=404, detail={"error": "account not found"})
        return {"item": account, "items": account_service.list_accounts()}

    @router.post("/api/accounts/2fa/enable")
    async def enable_account_2fa(body: Account2FARequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        access_token = str(body.access_token or "").strip()
        if not access_token:
            raise HTTPException(status_code=400, detail={"error": "access_token is required"})
        progress_id = account_service.start_2fa_task("enable", access_token)
        return {"progress_id": progress_id}

    @router.post("/api/accounts/2fa/disable")
    async def disable_account_2fa(body: Account2FARequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        access_token = str(body.access_token or "").strip()
        if not access_token:
            raise HTTPException(status_code=400, detail={"error": "access_token is required"})
        progress_id = account_service.start_2fa_task("disable", access_token)
        return {"progress_id": progress_id}

    @router.get("/api/accounts/2fa/progress/{progress_id}")
    async def get_2fa_progress(progress_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        progress = account_service.get_2fa_progress(progress_id)
        if progress is None:
            raise HTTPException(status_code=404, detail={"error": "progress not found"})
        return progress

    return router
