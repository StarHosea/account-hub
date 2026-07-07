"""FlowPilot 插件池客户端：账号上传与请求体判别。"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from services.account_lifecycle import STAGE_REGISTERED, apply_stage
from services.account_service import account_service
from services.mailbox_service import mailbox_service


def _clean(value: object = "") -> str:
    return str(value or "").strip()


def is_flowpilot_pool_upload(body: dict[str, Any]) -> bool:
    """判别 FlowPilot 扁平上传请求，避免与管理端批量导入混淆。"""
    if not isinstance(body, dict):
        return False
    email = _clean(body.get("email"))
    if not email:
        return False
    if body.get("accounts") or body.get("tokens") or _clean(body.get("text")):
        return False
    register_status = _clean(body.get("register_status"))
    access_token = _clean(body.get("access_token") or body.get("accessToken"))
    if register_status or access_token:
        return True
    return False


def build_flowpilot_account_payload(body: dict[str, Any]) -> dict[str, Any]:
    email = _clean(body.get("email")).lower()
    password = _clean(body.get("password"))
    access_token = _clean(body.get("access_token") or body.get("accessToken"))
    totp_secret = _clean(body.get("totp_secret") or body.get("totpMfaSecret"))
    refresh_cookie = _clean(body.get("refresh_cookie") or body.get("refreshCredential"))
    source_browser = _clean(body.get("source_browser"))
    register_status = _clean(body.get("register_status")) or "success"

    if not email:
        raise HTTPException(status_code=400, detail="缺少邮箱")
    if register_status == "success" and not access_token:
        raise HTTPException(status_code=400, detail="注册成功上传缺少 access_token")

    note_parts: list[str] = []
    if source_browser:
        note_parts.append(f"browser={source_browser}")
    if refresh_cookie:
        note_parts.append("refresh_cookie=present")

    payload = apply_stage(
        {
            "email": email,
            "password": password,
            "access_token": access_token,
            "totp_secret": totp_secret or None,
            "source_type": "flowpilot",
            "created_at": datetime.now(timezone.utc).isoformat(),
            **({"note": "; ".join(note_parts)} if note_parts else {}),
        },
        STAGE_REGISTERED,
    )
    return payload


def upload_flowpilot_account(body: dict[str, Any]) -> dict[str, Any]:
    payload = build_flowpilot_account_payload(body)
    email = str(payload.get("email") or "").strip()
    access_token = str(payload.get("access_token") or "").strip()
    result = account_service.add_account_items([payload])
    if email and access_token:
        mailbox_service.bind_account(email, access_token)
    return {
        "ok": True,
        "added": int(result.get("added") or 0),
        "skipped": int(result.get("skipped") or 0),
    }
