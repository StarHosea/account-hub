"""TOTP (Time-based One-Time Password, RFC 6238) 工具。

零依赖实现：标准 HMAC-SHA1、30s 步长、6 位码，兼容 Google Authenticator /
1Password 等主流验证器，也是 OpenAI 验证器 App (TOTP) 所用算法。
"""
from __future__ import annotations

import base64
import hmac
import struct
import time
from hashlib import sha1
from urllib.parse import quote


def _normalize_secret(secret: str) -> bytes:
    """把 base32 secret（可能带空格/小写/缺省 padding）解码为字节。"""
    cleaned = (secret or "").strip().replace(" ", "").upper()
    if not cleaned:
        raise ValueError("TOTP secret 为空")
    cleaned += "=" * (-len(cleaned) % 8)  # base32 需要 8 的倍数长度
    return base64.b32decode(cleaned, casefold=True)


def generate_totp(secret: str, *, at: float | None = None, digits: int = 6, period: int = 30) -> str:
    """根据 base32 secret 计算当前 6 位验证码。

    Args:
        secret: base32 编码的密钥（OpenAI enroll 返回的 ``secret`` 字段）。
        at: 计算时间点的 unix 秒，默认当前时间（仅测试时传入）。
        digits: 验证码位数，默认 6。
        period: 时间步长秒数，默认 30。
    """
    key = _normalize_secret(secret)
    counter = int((time.time() if at is None else at) // period)
    digest = hmac.new(key, struct.pack(">Q", counter), sha1).digest()
    offset = digest[-1] & 0x0F
    code_int = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code_int % (10 ** digits)).zfill(digits)


def build_otpauth_url(secret: str, email: str, *, issuer: str = "OpenAI", digits: int = 6, period: int = 30) -> str:
    """构造 otpauth:// URI，便于导入验证器 App 或生成二维码。"""
    label = quote(f"{issuer}:{email}" if email else issuer)
    secret_clean = (secret or "").strip().replace(" ", "").upper()
    return (
        f"otpauth://totp/{label}"
        f"?secret={secret_clean}&issuer={quote(issuer)}"
        f"&algorithm=SHA1&digits={digits}&period={period}"
    )
