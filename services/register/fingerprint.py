"""注册指纹 / 地区 / 代理工具（纯函数，仅依赖标准库，便于单测）。

提供三类能力：
1. 地区（REGIONS）与浏览器档案（PROFILES）表，以及把两者组合出的 Identity。
2. 由 Identity 生成自洽的请求头（common / navigate）。
3. ipweb 动态住宅代理的解析与「号一号一 IP」改写（换国家段 + 全新 SID）。

设计要点：
- 语言 / 时区来自「地区」，浏览器 UA / 平台 / 分辨率来自「档案」，两者解耦后组合，
  保证 header 与 sentinel 设备参数（语言、时区、分辨率、并发数）互相一致。
- 所有 build_* 默认参数复刻旧常量，未传 identity 时行为与改造前一致（向后兼容）。
"""
from __future__ import annotations

import random
import string
from dataclasses import dataclass
from urllib.parse import urlsplit

# auth.openai.com 作为注册流程多数 JSON 请求的 origin（与旧 common_headers 保持一致）
_AUTH_ORIGIN = "https://auth.openai.com"

# curl_cffi 0.15.0 实测支持的 impersonate token；PROFILES 只允许用这些且与 UA 主版本对齐
SUPPORTED_IMPERSONATE = {
    "chrome124", "chrome131", "chrome136", "chrome142", "chrome145", "chrome146",
}


# ──────────────────────────── 数据表 ────────────────────────────
@dataclass(frozen=True)
class Region:
    code: str                 # 内部地区码，也用于账号展示，如 "US"
    ipweb_country: str        # ipweb username 国家段，如 "US"/"JP"/"IN"
    accept_language: str      # Accept-Language 头
    oai_language: str         # oai-language 头（如 enroll 用）
    sentinel_language: str    # sentinel _get_config 语言字段
    # 时区池：每项 (gmt_offset, tz_label)，用于 sentinel 的 Date 字符串，二者成对自洽
    tz_pool: tuple[tuple[str, str], ...]
    first_names: tuple[str, ...]
    last_names: tuple[str, ...]


@dataclass(frozen=True)
class Profile:
    key: str
    impersonate: str          # 必须 ∈ SUPPORTED_IMPERSONATE，且与 UA 主版本一致
    user_agent: str
    sec_ch_ua: str
    sec_ch_ua_full_version_list: str
    sec_ch_ua_mobile: str
    platform: str             # '"Windows"' / '"macOS"'
    platform_version: str     # '"10.0.0"' / '"15.0.0"' / '"14.6.1"'
    arch: str                 # '"x86_64"' / '"arm"'
    bitness: str              # '"64"'
    model: str                # '""'
    screen: str               # "1920x1080"
    hardware_concurrency: int # 定值，跨整个任务保持一致


_US_FIRST = (
    "James", "Robert", "John", "Michael", "David", "William", "Richard", "Joseph",
    "Thomas", "Charles", "Daniel", "Matthew", "Mary", "Patricia", "Jennifer",
    "Linda", "Elizabeth", "Barbara", "Susan", "Jessica", "Emma", "Olivia", "Ava",
    "Sophia", "Isabella", "Mia", "Andrew", "Joshua", "Kevin", "Brian", "Ethan",
)
_US_LAST = (
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
    "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White",
    "Harris", "Clark", "Lewis", "Walker", "Hall", "Young", "King", "Wright",
)
_JP_FIRST = (
    "Haruto", "Yuto", "Sota", "Yuki", "Hayato", "Haruki", "Ryusei", "Kaito",
    "Sora", "Riku", "Yuma", "Takumi", "Ren", "Hiroto", "Daiki", "Yui", "Aoi",
    "Hina", "Sakura", "Mei", "Yuna", "Riko", "Akari", "Honoka", "Mio", "Saki",
    "Kanon", "Misaki", "Nanami", "Rin", "Kenta",
)
_JP_LAST = (
    "Sato", "Suzuki", "Takahashi", "Tanaka", "Watanabe", "Ito", "Yamamoto",
    "Nakamura", "Kobayashi", "Kato", "Yoshida", "Yamada", "Sasaki", "Yamaguchi",
    "Matsumoto", "Inoue", "Kimura", "Hayashi", "Shimizu", "Saito", "Yamazaki",
    "Mori", "Abe", "Ikeda", "Hashimoto", "Ishikawa", "Maeda", "Fujita", "Ogawa",
    "Goto", "Okada",
)
_IN_FIRST = (
    "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Reyansh", "Krishna", "Ishaan",
    "Rohan", "Rahul", "Karan", "Amit", "Rajesh", "Suresh", "Vikram", "Ananya",
    "Diya", "Saanvi", "Aadhya", "Priya", "Pooja", "Neha", "Riya", "Kavya",
    "Anjali", "Shreya", "Sneha", "Nisha", "Meera", "Aditi", "Sanjay",
)
_IN_LAST = (
    "Sharma", "Verma", "Gupta", "Singh", "Kumar", "Patel", "Shah", "Mehta",
    "Reddy", "Rao", "Nair", "Iyer", "Menon", "Chopra", "Kapoor", "Malhotra",
    "Agarwal", "Bansal", "Joshi", "Desai", "Pillai", "Naidu", "Bhat", "Chauhan",
    "Yadav", "Mishra", "Pandey", "Das", "Ghosh", "Banerjee", "Nanda",
)

REGIONS: dict[str, Region] = {
    "US": Region(
        code="US", ipweb_country="US",
        accept_language="en-US,en;q=0.9", oai_language="en-US", sentinel_language="en-US",
        tz_pool=(
            ("GMT-0500", "Eastern Standard Time"),
            ("GMT-0600", "Central Standard Time"),
            ("GMT-0700", "Mountain Standard Time"),
            ("GMT-0800", "Pacific Standard Time"),
        ),
        first_names=_US_FIRST, last_names=_US_LAST,
    ),
    "JP": Region(
        code="JP", ipweb_country="JP",
        accept_language="ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7", oai_language="ja-JP", sentinel_language="ja-JP",
        tz_pool=(("GMT+0900", "Japan Standard Time"),),
        first_names=_JP_FIRST, last_names=_JP_LAST,
    ),
    "IN": Region(
        code="IN", ipweb_country="IN",
        accept_language="en-IN,en;q=0.9,hi;q=0.8", oai_language="en-IN", sentinel_language="en-IN",
        tz_pool=(("GMT+0530", "India Standard Time"),),
        first_names=_IN_FIRST, last_names=_IN_LAST,
    ),
}

PROFILES: tuple[Profile, ...] = (
    Profile(
        key="win10_chrome145", impersonate="chrome145",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        sec_ch_ua='"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
        sec_ch_ua_full_version_list='"Chromium";v="145.0.0.0", "Not:A-Brand";v="99.0.0.0", '
                                    '"Google Chrome";v="145.0.0.0"',
        sec_ch_ua_mobile="?0", platform='"Windows"', platform_version='"10.0.0"',
        arch='"x86_64"', bitness='"64"', model='""', screen="1920x1080", hardware_concurrency=16,
    ),
    Profile(
        key="win11_chrome146", impersonate="chrome146",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        sec_ch_ua='"Google Chrome";v="146", "Not?A_Brand";v="8", "Chromium";v="146"',
        sec_ch_ua_full_version_list='"Chromium";v="146.0.0.0", "Not:A-Brand";v="99.0.0.0", '
                                    '"Google Chrome";v="146.0.0.0"',
        sec_ch_ua_mobile="?0", platform='"Windows"', platform_version='"15.0.0"',
        arch='"x86_64"', bitness='"64"', model='""', screen="2560x1440", hardware_concurrency=12,
    ),
    Profile(
        key="mac_chrome142", impersonate="chrome142",
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        sec_ch_ua='"Google Chrome";v="142", "Not?A_Brand";v="8", "Chromium";v="142"',
        sec_ch_ua_full_version_list='"Chromium";v="142.0.0.0", "Not:A-Brand";v="99.0.0.0", '
                                    '"Google Chrome";v="142.0.0.0"',
        sec_ch_ua_mobile="?0", platform='"macOS"', platform_version='"14.6.1"',
        arch='"arm"', bitness='"64"', model='""', screen="1512x982", hardware_concurrency=10,
    ),
)

_PROFILE_BY_KEY = {p.key: p for p in PROFILES}


# ──────────────────────────── Identity ────────────────────────────
@dataclass(frozen=True)
class Identity:
    region: Region
    profile: Profile
    gmt_offset: str
    tz_label: str

    @property
    def accept_language(self) -> str:
        return self.region.accept_language

    @property
    def oai_language(self) -> str:
        return self.region.oai_language

    @property
    def sentinel_language(self) -> str:
        return self.region.sentinel_language

    @property
    def browser_locale(self) -> str:
        """CloakBrowser context locale（Accept-Language 首项，如 en-US / ja-JP）。"""
        return browser_locale_for_region(self.region.code)

    @property
    def impersonate(self) -> str:
        return self.profile.impersonate

    @property
    def user_agent(self) -> str:
        return self.profile.user_agent

    @property
    def sec_ch_ua(self) -> str:
        return self.profile.sec_ch_ua

    @property
    def screen(self) -> str:
        return self.profile.screen

    @property
    def hardware_concurrency(self) -> int:
        return self.profile.hardware_concurrency


def build_identity(
    region: str | None = None,
    enabled_regions: list[str] | None = None,
    profile_key: str | None = None,
) -> Identity:
    """组合一个自洽的注册身份。

    地区解析优先级：显式 region > 随机于 enabled_regions > "US"；非法值回退 "US"。
    档案：profile_key 指定，否则随机。时区从地区池随机取一项（offset 与 label 成对）。
    """
    code = region
    if not code:
        pool = [r for r in (enabled_regions or []) if r in REGIONS]
        code = random.choice(pool) if pool else "US"
    reg = REGIONS.get(str(code), REGIONS["US"])
    prof = _PROFILE_BY_KEY.get(str(profile_key)) if profile_key else random.choice(PROFILES)
    if prof is None:
        prof = random.choice(PROFILES)
    gmt_offset, tz_label = random.choice(reg.tz_pool)
    return Identity(region=reg, profile=prof, gmt_offset=gmt_offset, tz_label=tz_label)


def browser_locale_for_region(code: str | None) -> str:
    """按地区码返回浏览器 locale；未知地区回退 US。"""
    reg = REGIONS.get(str(code or "").upper(), REGIONS["US"])
    return (reg.accept_language.split(",")[0] or "en-US").strip()


def random_name(identity: Identity | None = None) -> tuple[str, str]:
    """按地区取一个 (first, last)；无 identity 时回退默认（US）库。"""
    reg = identity.region if identity else REGIONS["US"]
    return random.choice(reg.first_names), random.choice(reg.last_names)


# ──────────────────────────── 请求头构造 ────────────────────────────
def common_headers_for(identity: Identity) -> dict[str, str]:
    """复刻旧 common_headers，UA / sec-ch-ua* / accept-language 取自 identity。"""
    p = identity.profile
    return {
        "accept": "application/json",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": identity.accept_language,
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "content-type": "application/json",
        "dnt": "1",
        "origin": _AUTH_ORIGIN,
        "priority": "u=1, i",
        "sec-gpc": "1",
        "sec-ch-ua": p.sec_ch_ua,
        "sec-ch-ua-arch": p.arch,
        "sec-ch-ua-bitness": p.bitness,
        "sec-ch-ua-full-version-list": p.sec_ch_ua_full_version_list,
        "sec-ch-ua-mobile": p.sec_ch_ua_mobile,
        "sec-ch-ua-model": p.model,
        "sec-ch-ua-platform": p.platform,
        "sec-ch-ua-platform-version": p.platform_version,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": p.user_agent,
    }


def navigate_headers_for(identity: Identity) -> dict[str, str]:
    """复刻旧 navigate_headers，UA / sec-ch-ua* / accept-language 取自 identity。"""
    p = identity.profile
    return {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": identity.accept_language,
        "cache-control": "max-age=0",
        "connection": "keep-alive",
        "dnt": "1",
        "sec-gpc": "1",
        "sec-ch-ua": p.sec_ch_ua,
        "sec-ch-ua-arch": p.arch,
        "sec-ch-ua-bitness": p.bitness,
        "sec-ch-ua-full-version-list": p.sec_ch_ua_full_version_list,
        "sec-ch-ua-mobile": p.sec_ch_ua_mobile,
        "sec-ch-ua-model": p.model,
        "sec-ch-ua-platform": p.platform,
        "sec-ch-ua-platform-version": p.platform_version,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "user-agent": p.user_agent,
    }


# ──────────────────────────── 代理工具 ────────────────────────────
_SID_ALPHABET = string.ascii_letters + string.digits


@dataclass(frozen=True)
class ParsedProxy:
    scheme: str
    host: str
    port: str
    user: str
    password: str

    def to_url(self) -> str:
        auth = f"{self.user}:{self.password}@" if self.user else ""
        return f"{self.scheme}://{auth}{self.host}:{self.port}"


def _fresh_sid(n: int = 8) -> str:
    n = n if n and n > 0 else 8
    return "".join(random.choice(_SID_ALPHABET) for _ in range(n))


def parse_proxy(raw: str, default_scheme: str = "socks5h") -> ParsedProxy | None:
    """解析三种代理写法并归一化。

    支持：
      - URL：scheme://user:pass@host:port（也兼容无 auth）
      - ipweb 原生：host:port:user:pass
      - ipweb 变体：user:pass:host:port
    无法解析返回 None。无 scheme 时用 default_scheme（socks5h，DNS 经代理防泄漏）。
    """
    raw = (raw or "").strip()
    if not raw:
        return None
    if "://" in raw:
        try:
            parts = urlsplit(raw)
            host = parts.hostname or ""
            if not host:
                return None
            port = str(parts.port or "")
            return ParsedProxy(parts.scheme or default_scheme, host, port,
                               parts.username or "", parts.password or "")
        except Exception:
            return None
    segs = raw.split(":")
    if len(segs) != 4:
        return None
    # host 含点、username 含下划线无点 → 据此判断布局
    if "." in segs[0]:
        host, port, user, pwd = segs
    elif "." in segs[2]:
        user, pwd, host, port = segs
    else:
        host, port, user, pwd = segs
    if not host or not port.isdigit():
        return None
    return ParsedProxy(default_scheme, host, port, user, pwd)


def normalize_proxy(raw: str, default_scheme: str = "socks5h") -> str:
    """把任意支持的写法归一化为可直接交给 curl_cffi 的 URL；不可解析则原样返回。"""
    parsed = parse_proxy(raw, default_scheme)
    return parsed.to_url() if parsed else (raw or "").strip()


def rotate_ipweb_proxy(
    raw: str, region_country: str, *, new_sid: str | None = None, duration: int | None = None
) -> tuple[str, str | None]:
    """ipweb「号一号一 IP」改写：换国家段 + 全新 SID（清空 state/city，可覆盖 duration）。

    仅当 host 以 ipweb.cc 结尾且 username 形如 B_<id>_<country>_<state>_<city>_<dur>_<SID>
    （>=7 段且首段为 "B"）时改写；否则原样返回 (归一化URL, None) 表示未改写。

    duration: 传入则覆盖时长段（分钟），用于延长同 IP 粘性；None 时保留模板原值。

    Returns: (proxy_url, sid 或 None)
    """
    parsed = parse_proxy(raw)
    if parsed is None:
        return (raw or "").strip(), None
    if not parsed.host.endswith("ipweb.cc"):
        return parsed.to_url(), None
    segs = parsed.user.split("_")
    if len(segs) < 7 or segs[0] != "B":
        return parsed.to_url(), None
    sid = new_sid or _fresh_sid(len(segs[-1]))
    segs[2] = (region_country or segs[2]).upper()
    segs[3] = ""   # state 清空（换国家后旧州码失效）
    segs[4] = ""   # city 清空
    if duration is not None and int(duration) > 0:
        segs[5] = str(int(duration))
    segs[-1] = sid
    rotated = ParsedProxy(parsed.scheme, parsed.host, parsed.port, "_".join(segs), parsed.password)
    return rotated.to_url(), sid
