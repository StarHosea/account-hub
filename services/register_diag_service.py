from __future__ import annotations

import base64
import io
import json
import re
import shutil
import zipfile
from pathlib import Path
from urllib.parse import quote

from fastapi import Request

from services.config import DATA_DIR, config
from services.register import openai_register
from services.register_abnormal_service import register_abnormal_service


def public_base_url(request: Request | None = None) -> str:
    configured = str(openai_register.config.get("diag_public_url") or "").strip().rstrip("/")
    if configured:
        return configured
    if request is None:
        return ""
    forwarded_proto = str(request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    scheme = forwarded_proto or str(request.url.scheme or "https")
    host = str(request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    if not host:
        return ""
    return f"{scheme}://{host}".rstrip("/")


def _abs_url(path: str, request: Request | None = None) -> str:
    base = public_base_url(request)
    rel = str(path or "").strip()
    if not rel:
        return ""
    if rel.startswith("http://") or rel.startswith("https://"):
        return rel
    if not base:
        return rel
    return f"{base}{rel if rel.startswith('/') else '/' + rel}"


def _diag_urls(email: str, request: Request | None = None) -> dict[str, str]:
    q = quote(str(email or "").strip(), safe="")
    rel = {
        "brief_json": f"/api/register/diag/brief?email={q}",
        "brief_md": f"/api/register/diag/brief.md?email={q}",
        "artifacts": f"/api/register/diag/artifacts?email={q}",
        "recording": f"/api/register/diag/recording?email={q}",
        "screenshot": f"/api/register/diag/screenshot?email={q}",
        "trace": f"/api/register/diag/trace?email={q}",
    }
    # 兼容旧字段名
    rel["brief"] = rel["brief_json"]
    return {key: _abs_url(path, request) for key, path in rel.items()}


def resolve_record_root() -> Path:
    if not bool(openai_register.config.get("record_enabled", True)):
        return Path()
    raw = str(openai_register.config.get("record_dir") or "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else DATA_DIR.parent / path
    return DATA_DIR / "recordings"


def _safe_email_prefix(email: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", str(email or "").strip())[:40]


def _is_under_record_root(path: Path) -> bool:
    root = resolve_record_root()
    if not root.is_dir():
        return False
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _all_recording_dirs(email: str, hint: str = "") -> list[Path]:
    """返回某邮箱的全部诊断存证目录（同邮箱多次注册可能有多个）。"""
    found: dict[str, Path] = {}

    hint_raw = str(hint or "").strip()
    if hint_raw:
        hinted = Path(hint_raw)
        if hinted.is_dir() and _is_under_record_root(hinted):
            found[str(hinted.resolve())] = hinted.resolve()

    root = resolve_record_root()
    if root.is_dir():
        prefix = f"{_safe_email_prefix(email)}-"
        for candidate in root.iterdir():
            if candidate.is_dir() and candidate.name.startswith(prefix):
                found[str(candidate.resolve())] = candidate.resolve()

    return list(found.values())


def find_recording_dir(email: str, hint: str = "") -> Path | None:
    hint_raw = str(hint or "").strip()
    if hint_raw:
        hinted = Path(hint_raw)
        if hinted.is_dir():
            return hinted

    dirs = _all_recording_dirs(email)
    if not dirs:
        return None
    return max(dirs, key=lambda p: p.stat().st_mtime)


def _dir_size(path: Path) -> int:
    total = 0
    for file_path in path.rglob("*"):
        if file_path.is_file():
            try:
                total += file_path.stat().st_size
            except OSError:
                pass
    return total


def delete_recordings_for_emails(
    emails: list[str],
    *,
    hints: dict[str, str] | None = None,
) -> dict[str, int]:
    """删除指定邮箱的全部诊断存证目录，返回删除目录数与释放字节数。"""
    hints = hints or {}
    dirs_removed = 0
    bytes_freed = 0
    seen: set[str] = set()

    for raw_email in emails or []:
        email = str(raw_email or "").strip()
        if not email:
            continue
        hint = (
            hints.get(email)
            or hints.get(email.lower())
            or ""
        )
        for record_dir in _all_recording_dirs(email, hint):
            key = str(record_dir.resolve())
            if key in seen:
                continue
            seen.add(key)
            size = _dir_size(record_dir)
            try:
                shutil.rmtree(record_dir)
            except OSError:
                continue
            dirs_removed += 1
            bytes_freed += size

    return {"dirs_removed": dirs_removed, "bytes_freed": bytes_freed}


def delete_all_recordings() -> dict[str, int]:
    """删除存证目录下的全部诊断现场，返回删除目录数与释放字节数。"""
    root = resolve_record_root()
    dirs_removed = 0
    bytes_freed = 0
    if not root.is_dir():
        return {"dirs_removed": 0, "bytes_freed": 0}
    for entry in list(root.iterdir()):
        if not entry.is_dir() or not _is_under_record_root(entry):
            continue
        size = _dir_size(entry)
        try:
            shutil.rmtree(entry)
        except OSError:
            continue
        dirs_removed += 1
        bytes_freed += size
    return {"dirs_removed": dirs_removed, "bytes_freed": bytes_freed}


def _load_manifest(record_dir: Path) -> list[dict]:
    manifest = record_dir / "manifest.jsonl"
    if not manifest.is_file():
        return []
    rows: list[dict] = []
    for line in manifest.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _read_html(record_dir: Path, filename: str) -> str:
    if not filename:
        return ""
    path = record_dir / filename
    if not path.is_file():
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def _strip_html_text(raw: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw or "")
    return re.sub(r"\s+", " ", text).strip()


def _extract_visible_ui(html: str) -> dict:
    if not html:
        return {"buttons": [], "inputs": [], "hints": [], "title": ""}

    title_m = re.search(r"<title[^>]*>([^<]{1,200})</title>", html, re.I)
    title = re.sub(r"\s+", " ", title_m.group(1)).strip() if title_m else ""

    buttons: list[str] = []
    for pattern in (
        r"<button[^>]*>([\s\S]{0,500}?)</button>",
        r'<(?:a|div|span)[^>]*role=["\']button["\'][^>]*>([\s\S]{0,500}?)</(?:a|div|span)>',
        r'<input[^>]*type=["\'](?:submit|button)["\'][^>]*value=["\']([^"\']{1,120})',
    ):
        for m in re.finditer(pattern, html, re.I):
            text = _strip_html_text(m.group(1))
            if text and text not in buttons:
                buttons.append(text)
            if len(buttons) >= 30:
                break

    inputs: list[str] = []
    for m in re.finditer(r"<input[^>]*>", html, re.I):
        tag = m.group(0)
        name = re.search(r'name=["\']([^"\']+)', tag, re.I)
        typ = re.search(r'type=["\']([^"\']+)', tag, re.I)
        placeholder = re.search(r'placeholder=["\']([^"\']+)', tag, re.I)
        label = placeholder.group(1) if placeholder else (name.group(1) if name else "")
        typ_s = typ.group(1) if typ else "text"
        if label:
            inputs.append(f"{typ_s}:{label}")
        if len(inputs) >= 20:
            break

    stripped = re.sub(r"<(script|style|noscript)[^>]*>[\s\S]*?</\1>", "\n", html, flags=re.I)
    stripped = re.sub(r"<[^>]+>", "\n", stripped)
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in stripped.splitlines()]
    lines = [ln for ln in lines if 2 <= len(ln) <= 160]

    hint_keys = (
        "错误", "失败", "无效", "error", "invalid", "try again", "captcha", "验证",
        "rate", "limit", "blocked", "unusual", "异常", "重试", "无法", "不能",
        "有効な年齢", "年齢", "コードが正しく", "不正確なコード", "valid age",
    )
    hints: list[str] = []
    for ln in lines:
        low = ln.lower()
        if any(k in low or k in ln for k in hint_keys):
            if ln not in hints:
                hints.append(ln)
        if len(hints) >= 20:
            break

    return {
        "title": title,
        "buttons": buttons[:20],
        "inputs": inputs[:15],
        "hints": hints[:15],
        "body_preview": lines[:40],
    }


def _extract_manifest_capture(manifest: list[dict]) -> dict:
    """从 manifest 结构化字段提取诊断采集（authUi / continueHit 等）。"""
    capture: dict = {}
    if not manifest:
        return capture

    by_step = {str(row.get("stepId") or ""): row for row in manifest}
    for step_id, key in (
        ("register-02-pre-continue", "pre_continue"),
        ("register-02-after-continue", "after_continue"),
        ("register-02-post-email", "post_email"),
    ):
        row = by_step.get(step_id)
        if not isinstance(row, dict):
            continue
        capture[key] = {
            "stepId": step_id,
            "note": str(row.get("note") or ""),
            "authSurface": row.get("authSurface"),
            "continueHit": row.get("continueHit"),
            "landing": row.get("landing"),
            "authUi": row.get("authUi") if isinstance(row.get("authUi"), dict) else None,
        }

    # 兼容旧 manifest：从 note 字符串里补 continue/landing
    for row in reversed(manifest):
        note = str(row.get("note") or "")
        if "continue=" in note and "continue_hit" not in capture:
            m = re.search(r"continue=([^\s]+)", note)
            if m:
                capture["continue_hit"] = m.group(1)
        if "landing=" in note and "landing" not in capture:
            m = re.search(r"landing=([^\s]+)", note)
            if m:
                capture["landing"] = m.group(1)
        if row.get("authUi") and "auth_ui" not in capture:
            capture["auth_ui"] = row.get("authUi")
        if row.get("authSurface") and "auth_surface" not in capture:
            capture["auth_surface"] = row.get("authSurface")

    return capture


def _extract_goto_retries(manifest: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for row in manifest:
        step_id = str(row.get("stepId") or "")
        if not step_id.startswith("register-00-goto-"):
            continue
        rows.append({
            "stepId": step_id,
            "note": str(row.get("note") or ""),
            "url": str(row.get("url") or ""),
            "attempt": row.get("attempt"),
            "attempts": row.get("attempts"),
        })
    return rows


def _proxy_from_abnormal(abnormal: dict | None) -> dict:
    if not abnormal:
        return {}
    keys = (
        "proxy_region",
        "proxy_host",
        "proxy_scheme",
        "proxy_sid",
        "exit_ip",
        "proxy_mode",
    )
    return {key: abnormal.get(key) for key in keys if abnormal.get(key) not in (None, "")}


def _register_logs_for_email(email: str, *, limit: int = 80) -> list[dict]:
    try:
        from services.register_service import register_service

        logs = register_service.get().get("logs") or []
    except Exception:
        return []
    needle = str(email or "").strip().lower()
    if not needle:
        return []
    matched = [
        entry for entry in logs
        if needle in str(entry.get("text") or "").lower()
    ]
    return matched[-limit:]


def _abnormal_item(email: str) -> dict | None:
    target = str(email or "").strip().lower()
    if not target:
        return None
    for item in register_abnormal_service.list_items():
        if str(item.get("email") or "").strip().lower() == target:
            return dict(item)
    return None


def build_brief(email: str, request: Request | None = None) -> dict:
    email = str(email or "").strip()
    if not email:
        return {"ok": False, "error": "email 不能为空", "urls": _diag_urls("", request)}

    abnormal = _abnormal_item(email)
    record_dir = find_recording_dir(email, str((abnormal or {}).get("recording_path") or ""))
    manifest = _load_manifest(record_dir) if record_dir else []
    last = manifest[-1] if manifest else {}
    tail = manifest[-5:] if manifest else []

    last_html = _read_html(record_dir, str(last.get("html") or "")) if record_dir else ""
    visible_ui = _extract_visible_ui(last_html)
    manifest_capture = _extract_manifest_capture(manifest)
    goto_retries = _extract_goto_retries(manifest)
    proxy = _proxy_from_abnormal(abnormal)
    if isinstance(manifest_capture.get("auth_ui"), dict):
        auth_ui = manifest_capture["auth_ui"]
        if auth_ui.get("buttons") and not visible_ui.get("buttons"):
            visible_ui["buttons"] = [
                str(btn.get("text") or btn) if isinstance(btn, dict) else str(btn)
                for btn in auth_ui.get("buttons", [])[:20]
            ]
        if auth_ui.get("inputs") and not visible_ui.get("inputs"):
            visible_ui["inputs"] = [
                f"{inp.get('type', 'text')}:{inp.get('label', '')}" if isinstance(inp, dict) else str(inp)
                for inp in auth_ui.get("inputs", [])[:15]
            ]
        visible_ui["auth_surface"] = auth_ui.get("authSurface") or manifest_capture.get("auth_surface")

    screenshot_file = str(last.get("png") or "")
    screenshot_b64 = ""
    if record_dir and screenshot_file:
        shot = record_dir / screenshot_file
        if shot.is_file() and shot.stat().st_size <= 2 * 1024 * 1024:
            try:
                screenshot_b64 = base64.b64encode(shot.read_bytes()).decode("ascii")
            except Exception:
                screenshot_b64 = ""

    failed_step = str(last.get("stepId") or "")
    if failed_step == "final-error-scene" and len(manifest) >= 2:
        failed_step = str(manifest[-2].get("stepId") or failed_step)

    failed_note = str(last.get("note") or "")
    abnormal_reason = str((abnormal or {}).get("reason") or "")
    engine_error = failed_note if str(last.get("stepId") or "") == "final-error-scene" else ""
    reason = abnormal_reason
    generic_reasons = ("浏览器引擎未返回结果", "register_error", "注册失败")
    if engine_error and (
        not reason
        or any(g in reason for g in generic_reasons)
    ):
        reason = engine_error
    elif engine_error and engine_error not in reason:
        reason = f"{reason}（引擎：{engine_error}）" if reason else engine_error

    brief = {
        "ok": True,
        "email": email,
        "reason": reason,
        "engine_error": engine_error or None,
        "abnormal_reason": abnormal_reason or None,
        "fetch_url": str((abnormal or {}).get("fetch_url") or ""),
        "created_at": str((abnormal or {}).get("created_at") or ""),
        "recording_path": str(record_dir) if record_dir else "",
        "recording_steps": len(manifest),
        "failed_step": failed_step,
        "failed_note": failed_note,
        "url": str(last.get("url") or ""),
        "pageState": last.get("pageState"),
        "confidence": last.get("confidence"),
        "accountFacts": last.get("accountFacts"),
        "state_reason": str(last.get("reason") or ""),
        "manifest_tail": tail,
        "manifest_capture": manifest_capture,
        "goto_retries": goto_retries,
        "proxy": proxy,
        "visible_ui": visible_ui,
        "logs_tail": _register_logs_for_email(email),
        "urls": _diag_urls(email, request),
        "artifacts": {
            "has_recording_html": bool(record_dir and (record_dir / "recording.html").is_file()),
            "has_trace_zip": bool(record_dir and (record_dir / "trace.zip").is_file()),
            "has_screenshot": bool(screenshot_b64),
            "manifest_files": [str(row.get("html") or "") for row in tail if row.get("html")],
        },
    }
    if screenshot_b64:
        brief["screenshot_b64"] = screenshot_b64
        brief["screenshot_file"] = screenshot_file
    if not record_dir:
        brief["recording_missing"] = (
            "未找到 DOM 记录目录。"
            "请确认 record_enabled=true 且注册失败后目录未被清理。"
        )
    base = public_base_url(request)
    if base:
        brief["server"] = base
        brief["ai_url"] = _abs_url(f"/api/register/diag/brief.md?email={quote(email, safe='')}", request)
    return brief


def build_brief_markdown(email: str = "", request: Request | None = None) -> str:
    """生成可直接贴给本地 AI 的 Markdown 简报。"""
    target = str(email or "").strip()
    brief = brief_latest(request) if not target else build_brief(target, request)
    urls = brief.get("urls") if isinstance(brief.get("urls"), dict) else _diag_urls(str(brief.get("email") or ""), request)

    if not brief.get("ok"):
        err = str(brief.get("error") or "未知错误")
        lines = [
            "# 注册诊断简报",
            "",
            f"**状态**: 失败 — {err}",
            "",
            "## 快捷链接",
            f"- 最近失败: {_abs_url('/api/register/diag/brief.md', request)}",
            f"- 异常列表: {_abs_url('/api/register/diag/list', request)}",
        ]
        return "\n".join(lines) + "\n"

    ui = brief.get("visible_ui") if isinstance(brief.get("visible_ui"), dict) else {}
    capture = brief.get("manifest_capture") if isinstance(brief.get("manifest_capture"), dict) else {}
    goto_retries = brief.get("goto_retries") if isinstance(brief.get("goto_retries"), list) else []
    proxy = brief.get("proxy") if isinstance(brief.get("proxy"), dict) else {}
    logs = brief.get("logs_tail") if isinstance(brief.get("logs_tail"), list) else []
    tail = brief.get("manifest_tail") if isinstance(brief.get("manifest_tail"), list) else []

    lines = [
        "# 注册诊断简报",
        "",
        f"**邮箱**: `{brief.get('email')}`",
        f"**失败原因**: {brief.get('reason') or '—'}",
        f"**时间**: {brief.get('created_at') or '—'}",
        f"**失败步骤**: `{brief.get('failed_step') or '—'}`",
        f"**步骤说明**: {brief.get('failed_note') or '—'}",
        "",
        "## 页面状态（失败时刻）",
        f"- URL: {brief.get('url') or '—'}",
        f"- pageState: `{brief.get('pageState')}` ({brief.get('confidence')})",
        f"- 状态机说明: {brief.get('state_reason') or '—'}",
        f"- 账号事实: `{json.dumps(brief.get('accountFacts'), ensure_ascii=False) if brief.get('accountFacts') else '—'}`",
        "",
    ]
    if proxy:
        lines.extend([
            "## 代理 / 出口",
            f"- 模式: `{proxy.get('proxy_mode') or '—'}`",
            f"- 地区: `{proxy.get('proxy_region') or '—'}`",
            f"- 主机: `{proxy.get('proxy_host') or '—'}`",
            f"- 协议: `{proxy.get('proxy_scheme') or '—'}`",
            f"- SID: `{proxy.get('proxy_sid') or '—'}`",
            f"- 出口 IP: `{proxy.get('exit_ip') or '—'}`",
            "",
        ])
    lines.extend([
        "## 可见 UI",
        f"- 标题: {ui.get('title') or '—'}",
    ])
    if ui.get("buttons"):
        lines.append(f"- 按钮: {', '.join(f'`{b}`' for b in ui['buttons'][:12])}")
    if ui.get("inputs"):
        lines.append(f"- 输入框: {', '.join(f'`{i}`' for i in ui['inputs'][:8])}")
    if ui.get("hints"):
        lines.append("- 错误/提示:")
        for hint in ui["hints"][:8]:
            lines.append(f"  - {hint}")

    after = capture.get("after_continue") if isinstance(capture.get("after_continue"), dict) else {}
    pre = capture.get("pre_continue") if isinstance(capture.get("pre_continue"), dict) else {}
    post = capture.get("post_email") if isinstance(capture.get("post_email"), dict) else {}
    if pre or after or post:
        lines.extend(["", "## 邮箱提交采集（manifest）", ""])
    if pre:
        lines.append(f"- 点击前 authSurface: `{pre.get('authSurface') or '—'}`")
        pre_ui = pre.get("authUi") if isinstance(pre.get("authUi"), dict) else {}
        pre_btns = [b.get("text") for b in pre_ui.get("buttons", []) if isinstance(b, dict) and b.get("text")]
        if pre_btns:
            lines.append(f"- 点击前按钮: {', '.join(f'`{b}`' for b in pre_btns[:12])}")
    if after:
        lines.append(f"- continueHit: `{after.get('continueHit') or capture.get('continue_hit') or '—'}`")
        after_ui = after.get("authUi") if isinstance(after.get("authUi"), dict) else {}
        after_btns = [b.get("text") for b in after_ui.get("buttons", []) if isinstance(b, dict) and b.get("text")]
        if after_btns:
            lines.append(f"- 点击后按钮: {', '.join(f'`{b}`' for b in after_btns[:12])}")
    if post:
        lines.append(f"- landing: `{post.get('landing') or capture.get('landing') or '—'}`")
        post_ui = post.get("authUi") if isinstance(post.get("authUi"), dict) else {}
        post_btns = [b.get("text") for b in post_ui.get("buttons", []) if isinstance(b, dict) and b.get("text")]
        if post_btns:
            lines.append(f"- 等待后按钮: {', '.join(f'`{b}`' for b in post_btns[:12])}")

    if goto_retries:
        lines.extend(["", "## 打开页面重试（manifest）", ""])
        for row in goto_retries:
            lines.append(
                f"- **{row.get('stepId')}** attempt={row.get('attempt')}/{row.get('attempts') or '—'} "
                f"url={row.get('url') or '—'} note={row.get('note') or ''}"
            )

    if tail:
        lines.extend(["", "## 最后几步（manifest）", ""])
        for row in tail:
            lines.append(
                f"- `{row.get('seq')}` **{row.get('stepId')}** "
                f"state=`{row.get('pageState')}` url={row.get('url') or ''} "
                f"note={row.get('note') or ''}"
            )

    if logs:
        lines.extend(["", "## 注册日志（末 40 行）", "```"])
        for entry in logs[-40:]:
            t = str(entry.get("time") or "")[:19]
            lvl = str(entry.get("level") or "")
            text = str(entry.get("text") or "")
            lines.append(f"{t} [{lvl}] {text}")
        lines.append("```")

    lines.extend([
        "",
        "## 资源链接",
        f"- Markdown 简报: {urls.get('brief_md') or urls.get('brief', '')}",
        f"- JSON 详情: {urls.get('brief_json') or urls.get('brief', '')}",
        f"- 诊断包 zip: {urls.get('artifacts', '')}",
        f"- DOM 回放: {urls.get('recording', '')}",
        f"- 截图: {urls.get('screenshot', '')}",
        f"- Playwright Trace: {urls.get('trace', '')}",
    ])
    if brief.get("recording_missing"):
        lines.extend(["", f"**存证缺失**: {brief['recording_missing']}"])
    if brief.get("fetch_url"):
        lines.append(f"- 邮箱取件: {brief['fetch_url']}")
    return "\n".join(lines) + "\n"


def brief_latest(request: Request | None = None) -> dict:
    items = register_abnormal_service.list_items()
    if not items:
        return {
            "ok": False,
            "error": "异常清单为空",
            "urls": {
                "brief_latest": _abs_url("/api/register/diag/brief.md", request),
                "brief_json": _abs_url("/api/register/diag/brief", request),
                "list": _abs_url("/api/register/diag/list", request),
            },
        }
    latest = items[0]
    brief = build_brief(str(latest.get("email") or ""), request)
    brief["latest"] = True
    return brief


def list_diag_entries(request: Request | None = None) -> dict:
    items = []
    for row in register_abnormal_service.list_items():
        email = str(row.get("email") or "")
        items.append({
            **row,
            "urls": _diag_urls(email, request),
            "has_recording": bool(find_recording_dir(email, str(row.get("recording_path") or ""))),
        })
    return {
        "ok": True,
        "total": len(items),
        "server": public_base_url(request) or None,
        "urls": {
            "brief_latest": _abs_url("/api/register/diag/brief.md", request),
            "brief_json": _abs_url("/api/register/diag/brief", request),
            "list": _abs_url("/api/register/diag/list", request),
        },
        "items": items,
    }


def diag_meta(request: Request | None = None) -> dict:
    root = resolve_record_root()
    dir_count = 0
    size_bytes = 0
    if root.is_dir():
        for entry in root.iterdir():
            if not entry.is_dir():
                continue
            dir_count += 1
            for path in entry.rglob("*"):
                if path.is_file():
                    try:
                        size_bytes += path.stat().st_size
                    except OSError:
                        pass
    cfg = openai_register.config
    base = public_base_url(request)
    return {
        "ok": True,
        "public_url": base,
        "record_enabled": bool(cfg.get("record_enabled", True)),
        "record_keep": str(cfg.get("record_keep") or "fail"),
        "record_resolved_dir": str(root) if str(root) else "",
        "record_dir_count": dir_count,
        "record_size_bytes": size_bytes,
        "urls": {
            "meta": _abs_url("/api/register/diag/meta", request),
            "brief_latest": _abs_url("/api/register/diag/brief.md", request),
            "brief_json": _abs_url("/api/register/diag/brief", request),
            "list": _abs_url("/api/register/diag/list", request),
        },
    }


def recording_html_path(email: str) -> Path | None:
    abnormal = _abnormal_item(email)
    record_dir = find_recording_dir(email, str((abnormal or {}).get("recording_path") or ""))
    if not record_dir:
        return None
    path = record_dir / "recording.html"
    return path if path.is_file() else None


def screenshot_path(email: str) -> Path | None:
    abnormal = _abnormal_item(email)
    record_dir = find_recording_dir(email, str((abnormal or {}).get("recording_path") or ""))
    if not record_dir:
        return None
    manifest = _load_manifest(record_dir)
    if not manifest:
        return None
    png = str(manifest[-1].get("png") or "")
    if not png:
        return None
    path = record_dir / png
    return path if path.is_file() else None


def trace_zip_path(email: str) -> Path | None:
    abnormal = _abnormal_item(email)
    record_dir = find_recording_dir(email, str((abnormal or {}).get("recording_path") or ""))
    if not record_dir:
        return None
    path = record_dir / "trace.zip"
    return path if path.is_file() else None


def artifacts_zip_bytes(email: str) -> tuple[str, bytes]:
    abnormal = _abnormal_item(email)
    record_dir = find_recording_dir(email, str((abnormal or {}).get("recording_path") or ""))
    safe = _safe_email_prefix(email) or "account"
    filename = f"{safe}-diag.zip"

    if not record_dir:
        payload = json.dumps(build_brief(email), ensure_ascii=False, indent=2).encode("utf-8")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("brief.json", payload)
        return filename, buf.getvalue()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        brief = build_brief(email)
        zf.writestr("brief.json", json.dumps(brief, ensure_ascii=False, indent=2))
        for path in record_dir.rglob("*"):
            if not path.is_file():
                continue
            zf.write(path, arcname=str(path.relative_to(record_dir)))
    return filename, buf.getvalue()
