from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from api.support import require_admin
from services.register_abnormal_service import register_abnormal_service
from services.register_diag_service import (
    artifacts_zip_bytes,
    brief_latest,
    build_brief,
    build_brief_markdown,
    delete_recordings_for_emails,
    diag_meta,
    list_diag_entries,
    recording_html_path,
    screenshot_path,
    trace_zip_path,
)
from services.register_service import register_service


class RegisterStartRequest(BaseModel):
    emails: list[str] = []


class RegisterConfigRequest(BaseModel):
    mail: dict | None = None
    proxy: str | None = None
    proxy_mode: str | None = None
    http_proxy: str | None = None
    total: int | None = None
    threads: int | None = None
    enable_2fa: bool | None = None
    regions: list[str] | None = None
    ipweb_rotate: bool | None = None
    ip_duration: int | None = None
    ip_probe_retries: int | None = None
    # 浏览器引擎（CloakBrowser）配置
    headless: bool | None = None
    register_timeout: int | None = None
    node_bin: str | None = None
    static_cache_enabled: bool | None = None
    static_cache_max_age_days: int | None = None
    static_cache_dir: str | None = None
    record_enabled: bool | None = None
    record_dir: str | None = None
    record_keep: str | None = None
    diag_public_url: str | None = None


class RegisterAbnormalDeleteRequest(BaseModel):
    emails: list[str]


def _paginate(seq: list[dict], page: int, page_size: int) -> list[dict]:
    start = (page - 1) * page_size
    return seq[start : start + page_size]


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/register")
    async def get_register_config(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"register": register_service.get()}

    @router.post("/api/register")
    async def update_register_config(body: RegisterConfigRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"register": register_service.update(body.model_dump(exclude_none=True))}

    @router.post("/api/register/start")
    async def start_register(body: RegisterStartRequest | None = None, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        emails = body.emails if body else []
        return {"register": register_service.start(emails)}

    @router.post("/api/register/stop")
    async def stop_register(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"register": register_service.stop()}

    @router.post("/api/register/reset")
    async def reset_register(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"register": register_service.reset()}

    @router.post("/api/register/clear-logs")
    async def clear_register_logs(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"register": register_service.clear_logs()}

    @router.post("/api/register/clear-recordings")
    async def clear_register_recordings(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        result = register_service.clear_recordings()
        return {
            "register": register_service.get(),
            "dirs_removed": result["dirs_removed"],
            "bytes_freed": result["bytes_freed"],
        }

    @router.get("/api/register/events")
    async def register_events(token: str = ""):
        require_admin(f"Bearer {token}")

        async def stream():
            last = ""
            idle = 0.0
            while True:
                payload = json.dumps(register_service.get(), ensure_ascii=False)
                if payload != last:
                    last = payload
                    idle = 0.0
                    yield f"data: {payload}\n\n"
                else:
                    # 空闲时定期发心跳注释行，避免长时间不发数据被反代 idle timeout 掐断连接。
                    idle += 0.5
                    if idle >= 15:
                        idle = 0.0
                        yield ": ping\n\n"
                await asyncio.sleep(0.5)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                # 关闭 nginx 对该响应的缓冲，SSE 才能实时逐条下发。
                "X-Accel-Buffering": "no",
            },
        )

    # ----------------------------- 注册机异常账号清单 ----------------------------- #

    @router.get("/api/register/abnormal")
    async def list_register_abnormal(
        authorization: str | None = Header(default=None),
        q: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=10, ge=1, le=200),
    ):
        require_admin(authorization)
        items = register_abnormal_service.list_items()
        stats = register_abnormal_service.stats()
        keyword = (q or "").strip().lower()
        if keyword:
            items = [
                a
                for a in items
                if keyword in str(a.get("email") or "").lower()
                or keyword in str(a.get("reason") or "").lower()
                or keyword in str(a.get("fetch_url") or "").lower()
            ]
        total = len(items)
        return {
            "items": _paginate(items, page, page_size),
            "stats": stats,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @router.delete("/api/register/abnormal")
    async def delete_register_abnormal(body: RegisterAbnormalDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        emails = [str(email or "").strip() for email in body.emails if str(email or "").strip()]
        recording_hints = {
            email: str((register_abnormal_service.peek(email) or {}).get("recording_path") or "")
            for email in emails
        }
        recordings = delete_recordings_for_emails(emails, hints=recording_hints)
        removed = register_abnormal_service.delete(emails)
        logs_removed = register_service.clear_logs_for_emails(emails)
        return {
            "items": register_abnormal_service.list_items(),
            "stats": register_abnormal_service.stats(),
            "removed": removed,
            "logs_removed": logs_removed,
            "recordings_removed": recordings["dirs_removed"],
            "bytes_freed": recordings["bytes_freed"],
        }

    @router.get("/api/register/abnormal/export")
    async def export_register_abnormal(token: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization or f"Bearer {token}")
        text = register_abnormal_service.export_text()
        text = text + ("\n" if text else "")
        return Response(
            text,
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="register-abnormal.txt"'},
        )

    # ----------------------------- 注册诊断（无鉴权，本地 AI 直链） ----------------------------- #

    @router.get("/api/register/diag/meta")
    async def register_diag_meta(request: Request):
        return diag_meta(request)

    @router.get("/api/register/diag/list")
    async def register_diag_list(request: Request):
        return list_diag_entries(request)

    @router.get("/api/register/diag/brief")
    async def register_diag_brief(request: Request, email: str = Query(default="")):
        target = str(email or "").strip()
        if not target:
            return brief_latest(request)
        return build_brief(target, request)

    @router.get("/api/register/diag/brief.md")
    async def register_diag_brief_md(request: Request, email: str = Query(default="")):
        body = build_brief_markdown(email, request)
        return Response(body, media_type="text/markdown; charset=utf-8")

    @router.get("/api/register/diag/artifacts")
    async def register_diag_artifacts(email: str = Query(...)):
        filename, payload = artifacts_zip_bytes(email)
        return Response(
            payload,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @router.get("/api/register/diag/recording")
    async def register_diag_recording(email: str = Query(...)):
        path = recording_html_path(email)
        if not path:
            return Response("recording.html 不存在", status_code=404, media_type="text/plain; charset=utf-8")
        return FileResponse(path, media_type="text/html; charset=utf-8")

    @router.get("/api/register/diag/screenshot")
    async def register_diag_screenshot(email: str = Query(...)):
        path = screenshot_path(email)
        if not path:
            return Response("截图不存在", status_code=404, media_type="text/plain; charset=utf-8")
        return FileResponse(path, media_type="image/png")

    @router.get("/api/register/diag/trace")
    async def register_diag_trace(email: str = Query(...)):
        path = trace_zip_path(email)
        if not path:
            return Response("trace.zip 不存在", status_code=404, media_type="text/plain; charset=utf-8")
        return FileResponse(
            path,
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="trace.zip"'},
        )

    return router
