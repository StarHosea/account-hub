from __future__ import annotations

from contextlib import asynccontextmanager
from threading import Event

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse

from api import accounts, activation, cdks, dispatch, mailboxes, phones, register, run, system
from api.errors import install_exception_handlers
from api.support import resolve_web_asset, start_limited_account_watcher
from services.config import config


def create_app() -> FastAPI:
    app_version = config.app_version

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        try:
            yield
        finally:
            stop_event.set()
            thread.join(timeout=1)

    app = FastAPI(title="chatgpt2api", version=app_version, lifespan=lifespan)
    install_exception_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(accounts.create_router())
    app.include_router(register.create_router())
    app.include_router(mailboxes.create_router())
    app.include_router(cdks.create_router())
    app.include_router(phones.create_router())
    app.include_router(dispatch.create_router())
    app.include_router(activation.create_router())
    app.include_router(run.create_router())
    app.include_router(system.create_router(app_version))

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_web(full_path: str):
        # 管理 UI 仅在私密路径（config.admin_path）下可达，其余路径一律 404 隐藏。
        # 静态资源（js/css/图标等真实文件，非 index.html）按需放行，让页面能加载。
        admin_seg = config.admin_path.strip("/")
        clean = full_path.strip("/")
        is_admin_route = clean == admin_seg or clean.startswith(admin_seg + "/")

        if is_admin_route:
            index = resolve_web_asset("")
            if index is None:
                raise HTTPException(status_code=404, detail="Not Found")
            try:
                html = index.read_text(encoding="utf-8").replace("%%ADMIN_BASE%%", config.admin_path)
            except Exception:
                return FileResponse(index)
            return HTMLResponse(html)

        asset = resolve_web_asset(full_path)
        if asset is not None and asset.name != "index.html":
            return FileResponse(asset)
        raise HTTPException(status_code=404, detail="Not Found")

    return app
