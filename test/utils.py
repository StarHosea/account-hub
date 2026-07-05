import json
import sys
import urllib.request
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
BASE_URL = "http://127.0.0.1:8000"

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


def load_auth_key() -> str:
    return json.loads((ROOT_DIR / "config.json").read_text(encoding="utf-8"))["auth-key"]


def post_json(path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {load_auth_key()}"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode())


class InMemoryStorage:
    """满足 StorageBackend 契约的纯内存后端，供单元测试隔离用（不落磁盘、不碰全局单例）。

    覆盖账号 / 鉴权密钥 / 平台配置 / 命名集合 / 状态块全部读写接口，
    以便 MailboxService、CdkService 等直接注入而彼此不串数据。
    """

    def __init__(self, accounts: list[dict] | None = None) -> None:
        self.accounts: list[dict] = list(accounts or [])
        self.auth_keys: list[dict] = []
        self.collections: dict[str, list[dict]] = {}
        self.states: dict[str, dict] = {}

    def load_accounts(self) -> list[dict]:
        return list(self.accounts)

    def save_accounts(self, accounts: list[dict]) -> None:
        self.accounts = list(accounts)

    def load_auth_keys(self) -> list[dict]:
        return list(self.auth_keys)

    def save_auth_keys(self, auth_keys: list[dict]) -> None:
        self.auth_keys = list(auth_keys)

    def load_state(self, key: str) -> dict | None:
        return self.states.get(key)

    def save_state(self, key: str, data: dict) -> None:
        self.states[key] = dict(data)

    def load_collection(self, name: str) -> list[dict] | None:
        items = self.collections.get(name)
        return list(items) if items is not None else None

    def save_collection(self, name: str, items: list[dict]) -> None:
        self.collections[name] = list(items)

    def health_check(self) -> dict:
        return {"ok": True}

    def get_backend_info(self) -> dict:
        return {"type": "memory"}
