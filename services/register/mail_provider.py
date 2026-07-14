from __future__ import annotations

import hashlib
import random
import re
import string
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from email import message_from_string, policy
from email.utils import parsedate_to_datetime
from threading import Lock
from typing import Any, Callable, TypeVar

from curl_cffi import requests

from services.account_service import account_service
from services.mailbox_service import mailbox_service

ResultT = TypeVar("ResultT")

API_MAILBOX_TYPE = "api_mailbox"
CLOUDMAIL_TYPE = "cloudmail_gen"
MAILBOX_POOL_EXHAUSTED_MSG = "API 邮箱池没有可用邮箱，请先在「邮箱管理」导入"


class MailboxPoolExhaustedError(RuntimeError):
    """API 邮箱池已无可用邮箱。"""

domain_lock = Lock()
domain_index = 0
cloudmail_token_lock = Lock()
cloudmail_token_cache: dict[str, tuple[str, float]] = {}


def _config(mail_config: dict) -> dict:
    return {
        "request_timeout": float(mail_config.get("request_timeout") or 30),
        "wait_timeout": float(mail_config.get("wait_timeout") or 300),
        "wait_interval": float(mail_config.get("wait_interval") or 2),
        "user_agent": str(mail_config.get("user_agent") or "Mozilla/5.0"),
        # 收件取件地址永不走代理（注册流程的 socks5 代理与收邮件解耦）。
        "proxy": "",
    }


def _parse_received_at(value: Any) -> datetime | None:
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except Exception:
            return None
    text = str(value or "").strip()
    if not text:
        return None
    try:
        date = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
        return date if date.tzinfo else date.replace(tzinfo=timezone.utc)
    except Exception:
        pass
    try:
        date = parsedate_to_datetime(text)
        return date if date.tzinfo else date.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _extract_content(data: dict[str, Any]) -> tuple[str, str]:
    text_content = str(data.get("text_content") or data.get("text") or data.get("body") or data.get("content") or "")
    html_content = str(data.get("html_content") or data.get("html") or data.get("html_body") or data.get("body_html") or "")
    if text_content or html_content:
        return text_content, html_content
    raw = data.get("raw")
    if not isinstance(raw, str) or not raw.strip():
        return "", ""
    try:
        parsed = message_from_string(raw, policy=policy.default)
    except Exception:
        return raw, ""
    plain: list[str] = []
    html: list[str] = []
    for part in parsed.walk() if parsed.is_multipart() else [parsed]:
        if part.get_content_maintype() == "multipart":
            continue
        try:
            payload = part.get_content()
        except Exception:
            payload = ""
        if not payload:
            continue
        if part.get_content_type() == "text/html":
            html.append(str(payload))
        else:
            plain.append(str(payload))
    return "\n".join(plain).strip(), "\n".join(html).strip()


def _extract_code(message: dict[str, Any]) -> str | None:
    content = f"{message.get('subject', '')}\n{message.get('text_content', '')}\n{message.get('html_content', '')}".strip()
    if not content:
        return None
    match = re.search(r"background-color:\s*#F3F3F3[^>]*>[\s\S]*?(\d{6})[\s\S]*?</p>", content, re.I)
    if match:
        return match.group(1)
    match = re.search(r"(?:Verification code|code is|代码为|验证码)[:\s]*(\d{6})", content, re.I)
    if match and match.group(1) != "177010":
        return match.group(1)
    for code in re.findall(r">\s*(\d{6})\s*<|(?<![#&])\b(\d{6})\b", content):
        value = code[0] or code[1]
        if value and value != "177010":
            return value
    return None


# API 取件页（assurivo 等）「时间：YYYY-MM-DD HH:MM:SS」为固定展示时区，与 Python 进程 TZ 无关。
MAILBOX_DISPLAY_TZ = ZoneInfo("Asia/Shanghai")

_TS_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?")
_RFC822_DT_RE = re.compile(
    r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+\w+\s+\d{4}\s+\d{2}:\d{2}:\d{2}(?:\s*(?:\([A-Z]+\)|[+-]\d{4}))?",
    re.I,
)


def _extract_received_at(content: str) -> datetime | None:
    """从收件页 HTML 里解析邮件的真实到达时间（用于相对先后比较）。

    优先取「时间/日期/Date/Received」标签后的 ISO 时间戳；其次取 icloud-api 等页面的
    ``<div class="dt">`` RFC822 时间；再否则取页面里第一个 ISO / RFC822 时间戳。解析失败返回 None。
    """
    text = content or ""
    dt_match = re.search(r'class="dt"[^>]*>([^<]+)<', text, re.I)
    if dt_match:
        parsed = _parse_received_at(dt_match.group(1).strip())
        if parsed is not None:
            return parsed

    match = None
    for label in ("时间", "日期", "Date", "Received", "Time"):
        match = re.search(re.escape(label) + r"[：:\s]*" + _TS_RE.pattern, text)
        if match:
            break
    if match is None:
        match = _TS_RE.search(text)
    if match is not None:
        try:
            year, month, day, hour, minute = (int(match.group(i)) for i in range(1, 6))
            second = int(match.group(6) or 0)
            return datetime(year, month, day, hour, minute, second)
        except Exception:
            pass

    rfc = _RFC822_DT_RE.search(text)
    if rfc:
        return _parse_received_at(rfc.group(0))
    return None


def _to_comparable_mailbox_display(dt: datetime) -> datetime:
    """把任意 datetime 转成取件页展示时区下的朴素时间，便于与 HTML 解析结果比较。"""
    if dt.tzinfo is not None:
        return dt.astimezone(MAILBOX_DISPLAY_TZ).replace(tzinfo=None)
    return dt


def _received_is_fresh(received: datetime | None, after: datetime) -> bool:
    """邮件到达时间是否严格晚于截止线（统一在取件页展示时区下比较）。"""
    if not isinstance(received, datetime):
        return False
    return _to_comparable_mailbox_display(received) > _to_comparable_mailbox_display(after)


def _message_tracking_ref(message: dict[str, Any]) -> str:
    provider = str(message.get("provider") or "").strip()
    mailbox = str(message.get("mailbox") or "").strip()
    message_id = str(message.get("message_id") or "").strip()
    if message_id:
        return f"id:{provider}:{mailbox}:{message_id}"
    received_at = message.get("received_at")
    received_value = received_at.isoformat() if isinstance(received_at, datetime) else str(received_at or "")
    content = "\n".join(str(message.get(key) or "") for key in ("subject", "sender", "text_content", "html_content"))
    digest = hashlib.sha256(content.encode("utf-8", errors="replace")).hexdigest()
    return f"content:{provider}:{mailbox}:{received_value}:{digest}"


def _create_session(conf: dict):
    """创建收件用 HTTP 会话。永不带代理（取件地址不经过注册代理）。"""
    return requests.Session(impersonate="chrome", verify=False)


def _normalize_string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value or "").strip()
    return [text] if text else []


def _random_mailbox_name() -> str:
    return (
        f"{''.join(random.choices(string.ascii_lowercase, k=5))}"
        f"{''.join(random.choices(string.digits, k=random.randint(1, 3)))}"
        f"{''.join(random.choices(string.ascii_lowercase, k=random.randint(1, 3)))}"
    )


def _next_domain(domains: list[str]) -> str:
    global domain_index
    domains = [str(item).strip() for item in domains if str(item).strip()]
    if not domains:
        raise RuntimeError("mail.domain 不能为空")
    if len(domains) == 1:
        return domains[0]
    with domain_lock:
        value = domains[domain_index % len(domains)]
        domain_index = (domain_index + 1) % len(domains)
        return value


def _extract_text_candidates(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        out: list[str] = []
        for key in ("address", "email", "name", "value"):
            if value.get(key):
                out.extend(_extract_text_candidates(value.get(key)))
        return out
    if isinstance(value, list):
        out = []
        for item in value:
            out.extend(_extract_text_candidates(item))
        return out
    return []


def _message_matches_email(data: dict[str, Any], email: str) -> bool:
    target = str(email or "").strip().lower()
    candidates: list[str] = []
    for key in ("to", "mailTo", "receiver", "receivers", "address", "email", "envelope_to"):
        if key in data:
            candidates.extend(_extract_text_candidates(data.get(key)))
    return not target or not candidates or any(target in str(item).strip().lower() for item in candidates if str(item).strip())


class BaseMailProvider:
    name = "unknown"

    def __init__(self, conf: dict, provider_ref: str = ""):
        self.conf = conf
        self.provider_ref = provider_ref

    def create_mailbox(self, username: str | None = None) -> dict[str, Any]:
        raise NotImplementedError

    def fetch_latest_message(self, mailbox: dict[str, Any]) -> dict[str, Any] | None:
        raise NotImplementedError

    def close(self) -> None:
        pass

    def wait_for(self, mailbox: dict[str, Any], on_message: Callable[[dict[str, Any]], ResultT | None]) -> ResultT | None:
        deadline = time.monotonic() + self.conf["wait_timeout"]
        while time.monotonic() < deadline:
            message = self.fetch_latest_message(mailbox)
            if message:
                result = on_message(message)
                if result is not None:
                    return result
            time.sleep(max(0.2, self.conf["wait_interval"]))
        return None

    def peek_received_at(self, mailbox: dict[str, Any]) -> datetime | None:
        """立即读一次信箱里当前最新邮件的到达时间（不等待），用于发码前记录时间基线。"""
        message = self.fetch_latest_message(mailbox)
        return message.get("received_at") if message else None

    def wait_for_code_detail(
        self, mailbox: dict[str, Any], after_received_at: datetime | None = None,
    ) -> dict[str, Any] | None:
        """轮询取验证码及邮件到达时间，最长等待由 conf['wait_timeout'] 限定。

        after_received_at 给定时，只接受「到达时间严格晚于它」的邮件的验证码（即发码之后新到的邮件），
        避免抓到发码前残留在信箱里的旧码。按到达时间判断而非码值——OpenAI 有时会重发相同的码，
        码值相同不代表是旧码。到达时间无法解析时不接受，继续轮询直至超时或出现可判定的新邮件。
        """

        def pick_fresh_message(message: dict[str, Any]) -> dict[str, Any] | None:
            code = _extract_code(message)
            if not code:
                return None
            if isinstance(after_received_at, datetime):
                received = message.get("received_at")
                if not _received_is_fresh(received, after_received_at):
                    return None
            return {"code": code, "received_at": message.get("received_at")}

        return self.wait_for(mailbox, pick_fresh_message)

    def wait_for_code(self, mailbox: dict[str, Any], after_received_at: datetime | None = None) -> str | None:
        detail = self.wait_for_code_detail(mailbox, after_received_at=after_received_at)
        return str(detail.get("code") or "") if detail else None



class ApiMailboxProvider(BaseMailProvider):
    """API 邮箱池 provider：邮箱与取件地址来自 mailbox_service。

    create_mailbox 从池中领取一个未使用邮箱；fetch_latest_message GET 取件地址，
    把返回的 HTML 收件页直接交给 _extract_code 提取验证码（不走代理）。
    """

    name = API_MAILBOX_TYPE

    def __init__(self, entry: dict, conf: dict):
        super().__init__(conf, str(entry.get("provider_ref") or API_MAILBOX_TYPE))
        self._session = None

    @property
    def session(self):
        if self._session is None:
            self._session = _create_session(self.conf)
        return self._session

    def create_mailbox(self, username: str | None = None) -> dict[str, Any]:
        from services.register_service import register_service

        reserved = register_service.pop_reserved_mailbox()
        if reserved:
            address = str(reserved.get("address") or "").strip()
            # 预选路径原先不 acquire，失败时 release 会空操作；这里补占用以统一生命周期。
            if address and not mailbox_service.claim(address):
                raise MailboxPoolExhaustedError(f"预选邮箱不可用：{address}")
            return reserved
        acquired = mailbox_service.acquire_unused()
        if not acquired:
            raise MailboxPoolExhaustedError(MAILBOX_POOL_EXHAUSTED_MSG)
        from services.account_service import account_service

        account_service.reserve_emails_for_register([acquired["email"]])
        return {
            "provider": self.name,
            "provider_ref": self.provider_ref,
            "label": "API邮箱",
            "address": acquired["email"],
            "fetch_url": acquired["fetch_url"],
        }

    def fetch_latest_message(self, mailbox: dict[str, Any]) -> dict[str, Any] | None:
        fetch_url = str(mailbox.get("fetch_url") or "").strip()
        if not fetch_url:
            return None
        try:
            resp = self.session.get(fetch_url, timeout=self.conf["request_timeout"])
        except Exception:
            return None
        html = ""
        try:
            html = str(resp.text or "")
        except Exception:
            html = ""
        if not html.strip():
            return None
        return {
            "provider": self.name,
            "mailbox": str(mailbox.get("address") or ""),
            "subject": "",
            "text_content": "",
            "html_content": html,
            # 解析邮件页里的真实到达时间（用于判断是否为发码后新到的邮件）；解析不到则 None。
            "received_at": _extract_received_at(html),
        }

    def close(self) -> None:
        if self._session is not None:
            try:
                self._session.close()
            except Exception:
                pass
            self._session = None


class CloudMailGenProvider(BaseMailProvider):
    name = CLOUDMAIL_TYPE

    def __init__(self, entry: dict, conf: dict):
        super().__init__(conf, str(entry.get("provider_ref") or ""))
        self.api_base = str(entry.get("api_base") or "").rstrip("/")
        self.admin_email = str(entry.get("admin_email") or "").strip()
        self.admin_password = str(entry.get("admin_password") or "").strip()
        self.domain = _normalize_string_list(entry.get("domain"))
        self.subdomain = _normalize_string_list(entry.get("subdomain"))
        self.email_prefix = str(entry.get("email_prefix") or "").strip()
        self.session = _create_session(conf)

    def _request(self, method, path, headers=None, params=None, payload=None, expected=(200,)):
        resp = self.session.request(
            method.upper(),
            f"{self.api_base}{path}",
            headers={"Content-Type": "application/json", "User-Agent": self.conf["user_agent"], **(headers or {})},
            params=params,
            json=payload,
            timeout=self.conf["request_timeout"],
            verify=False,
        )
        if resp.status_code not in expected:
            raise RuntimeError(f"CloudMailGen 请求失败: {method} {path}, HTTP {resp.status_code}, body={resp.text[:300]}")
        return {} if resp.status_code == 204 else resp.json()

    def _cache_key(self) -> str:
        return f"{self.api_base}|{self.admin_email}"

    def _get_token(self) -> str:
        if not self.admin_email or not self.admin_password:
            raise RuntimeError("CloudMailGen 缺少 admin_email 或 admin_password")
        cache_key = self._cache_key()
        now = time.time()
        with cloudmail_token_lock:
            cached = cloudmail_token_cache.get(cache_key)
            if cached and now < cached[1] - 300:
                return cached[0]
        data = self._request("POST", "/api/public/genToken", payload={"email": self.admin_email, "password": self.admin_password})
        token = ""
        if isinstance(data, dict) and data.get("code") == 200:
            token = str((data.get("data") or {}).get("token") or "").strip()
        if not token:
            raise RuntimeError(f"CloudMailGen genToken 返回异常: {data}")
        with cloudmail_token_lock:
            cloudmail_token_cache[cache_key] = (token, now + 24 * 3600)
        return token

    def _resolve_address(self, username: str | None = None) -> str:
        domain = _next_domain(self.domain)
        if self.subdomain:
            domain = f"{random.choice(self.subdomain)}.{domain}"
        if username:
            local_part = username
        elif self.email_prefix:
            local_part = f"{self.email_prefix}_{''.join(random.choices(string.ascii_lowercase + string.digits, k=6))}"
        else:
            local_part = _random_mailbox_name()
        return f"{local_part}@{domain}"

    def create_mailbox(self, username: str | None = None) -> dict[str, Any]:
        if not self.domain:
            raise RuntimeError("CloudMailGen 需要至少配置一个 domain")
        address = self._resolve_address(username)
        return {"provider": self.name, "provider_ref": self.provider_ref, "label": "CloudMail", "address": address}

    def fetch_latest_message(self, mailbox: dict[str, Any]) -> dict[str, Any] | None:
        address = str(mailbox.get("address") or "").strip()
        if not address:
            raise RuntimeError("CloudMailGen 缺少 address")
        token = self._get_token()
        data = self._request("POST", "/api/public/emailList", headers={"Authorization": token},
                             payload={"toEmail": address, "size": 20, "timeSort": "desc"})
        items = (data.get("data") or []) if isinstance(data, dict) and data.get("code") == 200 else []
        messages = [item for item in items if isinstance(item, dict) and _message_matches_email(item, address)]
        if not messages:
            return None
        item = messages[0]
        text_content, html_content = _extract_content(item)
        return {
            "provider": self.name,
            "mailbox": address,
            "message_id": str(item.get("id") or item.get("_id") or item.get("messageId") or ""),
            "subject": str(item.get("subject") or ""),
            "sender": str(item.get("from") or item.get("sender") or ""),
            "text_content": text_content,
            "html_content": html_content,
            "received_at": _parse_received_at(
                item.get("createdAt") or item.get("created_at") or item.get("receivedAt") or item.get("date") or item.get("timestamp")
            ),
            "to": item.get("to") or item.get("toEmail") or item.get("mailTo"),
            "raw": item,
        }

    def close(self) -> None:
        try:
            self.session.close()
        except Exception:
            pass


# ----------------------------- 工厂与对外 API ----------------------------- #


def _entries(mail_config: dict) -> list[dict]:
    result: list[dict] = []
    providers = mail_config.get("providers") if isinstance(mail_config, dict) else None
    for idx, item in enumerate(providers or [], start=1):
        if not isinstance(item, dict):
            continue
        if item.get("enable") is False:
            continue
        t = str(item.get("type") or API_MAILBOX_TYPE)
        label = item.get("label") or ("CloudMail" if t == CLOUDMAIL_TYPE else "API邮箱")
        result.append({**item, "type": t, "provider_ref": f"{t}#{idx}", "label": label})
    if not result:
        # 默认 API 邮箱池模式：邮箱来自 mailbox_service，无需在 register.json 配置 provider。
        result.append({"type": API_MAILBOX_TYPE, "enable": True, "provider_ref": f"{API_MAILBOX_TYPE}#1", "label": "API邮箱"})
    return result


def _build_provider(entry: dict, mail_config: dict) -> BaseMailProvider:
    conf = _config(mail_config)
    if entry["type"] == API_MAILBOX_TYPE:
        return ApiMailboxProvider(entry, conf)
    if entry["type"] == CLOUDMAIL_TYPE:
        return CloudMailGenProvider(entry, conf)
    raise RuntimeError(f"不支持的 mail.provider: {entry['type']}")


def _create_provider(mail_config: dict, provider: str = "", provider_ref: str = "") -> BaseMailProvider:
    entries = _entries(mail_config)
    entry = next((dict(item) for item in entries if provider_ref and item["provider_ref"] == provider_ref), None)
    entry = entry or next((dict(item) for item in entries if provider and item["type"] == provider), None)
    entry = entry or dict(entries[0])
    return _build_provider(entry, mail_config)


def is_api_pool_exhausted(mail_config: dict) -> bool:
    """主邮箱源为 API 池且当前无可用地址时返回 True（CloudMail 按需生成，恒为 False）。"""
    entries = _entries(mail_config)
    primary = entries[0] if entries else {"type": API_MAILBOX_TYPE}
    if primary.get("type") != API_MAILBOX_TYPE:
        return False
    return not any(mailbox_service._is_available(m) for m in mailbox_service.list_mailboxes())


def create_mailbox(mail_config: dict, username: str | None = None) -> dict:
    provider = _create_provider(mail_config)
    try:
        return provider.create_mailbox(username)
    finally:
        provider.close()


def wait_for_code(mail_config: dict, mailbox: dict, after_received_at: datetime | None = None) -> str | None:
    provider = _create_provider(mail_config, str(mailbox.get("provider") or ""), str(mailbox.get("provider_ref") or ""))
    try:
        return provider.wait_for_code(mailbox, after_received_at=after_received_at)
    finally:
        provider.close()


def wait_for_code_detail(
    mail_config: dict, mailbox: dict, after_received_at: datetime | None = None,
) -> dict[str, Any] | None:
    provider = _create_provider(mail_config, str(mailbox.get("provider") or ""), str(mailbox.get("provider_ref") or ""))
    try:
        return provider.wait_for_code_detail(mailbox, after_received_at=after_received_at)
    finally:
        provider.close()


def peek_received_at(mail_config: dict, mailbox: dict) -> datetime | None:
    """立即读一次信箱当前最新邮件的到达时间（不等待），失败/无则返回 None。"""
    provider = _create_provider(mail_config, str(mailbox.get("provider") or ""), str(mailbox.get("provider_ref") or ""))
    try:
        return provider.peek_received_at(mailbox)
    except Exception:
        return None
    finally:
        provider.close()


# 环境类失败释放后的冷却秒数（Cloudflare/网络/验证码超时等，与邮箱本身无关，稍后可重试）。
_RELEASE_COOLDOWN_SECONDS = 120


def mark_mailbox_result(mailbox: dict, *, success: bool, error: Exception | str | None = None) -> None:
    """注册流程结束后更新邮箱池状态（仅 API 邮箱池）：
    - 仅当注册成功且拿到 access_token（已入免费号池）时：绑定账号并标 used（已注册）；
    - 其余一律回到待注册（带短暂冷却），禁止「未入号池却标已注册」。

    CloudMail 为按需生成地址、非池化，无需回写状态。
    """
    if str(mailbox.get("provider") or "") != API_MAILBOX_TYPE:
        return
    address = str(mailbox.get("address") or "").strip()
    if not address:
        return
    token = str(mailbox.get("access_token") or "").strip()
    if success and token:
        mailbox_service.bind_account(address, token)
        reg_payload: dict = {"access_token": token}
        for field in ("password", "totp_secret", "otpauth_url"):
            val = str(mailbox.get(field) or "").strip()
            if val:
                reg_payload[field] = val
        account_service.complete_registration(address, reg_payload)
        return

    # 未入免费号池：强制待注册（含 email_exists / 半完成 token / 空 success）
    mailbox_service.release_for_retry(address, cooldown_seconds=_RELEASE_COOLDOWN_SECONDS)
    account_service.release_registration(
        address, error=str(error or ""), remove_placeholder=True,
    )


def release_mailbox(mailbox: dict) -> None:
    """把占用的 API 邮箱释放回未使用（流程主动放弃且未消费验证码时）。"""
    if str(mailbox.get("provider") or "") != API_MAILBOX_TYPE:
        return
    address = str(mailbox.get("address") or "").strip()
    mailbox_service.release(address)
    if address:
        account_service.release_registration(address)
