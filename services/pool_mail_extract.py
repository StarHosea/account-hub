"""验证码提取 —— 与 FlowPilot api-pool-mail-provider.js / flowpilot-server 策略一致。"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable

SIX_DIGIT_PATTERN = re.compile(r"\b(\d{6})\b")
ALT_DIGIT_PATTERN = re.compile(r"\b(\d{5,8})\b")
_DIGITS_4_8 = re.compile(r"\d{4,8}")

_PREFERRED_KEYS = (
    "code",
    "verifyCode",
    "verificationCode",
    "otp",
    "verify_code",
    "verification_code",
)
_CONTAINER_KEYS = ("data", "result", "message", "msg", "content", "body")

NO_MAIL_PATTERN = re.compile(
    r"no\s*mail|no\s*message|empty|not\s*found|暂无|没有邮件|无邮件|未收到|等待中|waiting",
    re.IGNORECASE,
)


def _normalize(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _pick_json_code(node: Any, depth: int = 0) -> str:
    if node is None or depth > 4:
        return ""
    if isinstance(node, (str, int, float)) and not isinstance(node, bool):
        match = _DIGITS_4_8.search(str(node))
        return match.group(0) if match else ""
    if isinstance(node, list):
        for item in node:
            found = _pick_json_code(item, depth + 1)
            if found:
                return found
        return ""
    if isinstance(node, dict):
        for key in _PREFERRED_KEYS:
            if node.get(key) is not None:
                match = _DIGITS_4_8.search(str(node[key]))
                if match:
                    return match.group(0)
        for key in _CONTAINER_KEYS:
            if key in node:
                found = _pick_json_code(node[key], depth + 1)
                if found:
                    return found
    return ""


def extract_verification_code(raw_text: Any, exclude: Iterable[str] | None = None) -> str:
    text = raw_text if isinstance(raw_text, str) else str(raw_text if raw_text is not None else "")
    if not text.strip():
        return ""

    excluded = {_normalize(value) for value in (exclude or []) if _normalize(value)}

    parsed: Any = None
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        parsed = None

    if parsed is not None:
        json_code = _pick_json_code(parsed)
        if json_code and len(json_code) == 6 and json_code not in excluded:
            return json_code

    for code in SIX_DIGIT_PATTERN.findall(text):
        if code not in excluded:
            return code

    if parsed is not None:
        json_code = _pick_json_code(parsed)
        if json_code and json_code not in excluded:
            return json_code

    for code in ALT_DIGIT_PATTERN.findall(text):
        if code not in excluded:
            return code

    return ""


def is_no_mail_response(raw_text: Any) -> bool:
    return bool(NO_MAIL_PATTERN.search(str(raw_text or "")))
