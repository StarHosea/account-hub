import os
import sys
import urllib.request
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
BASE_URL = "http://127.0.0.1:8000"

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


class InMemoryStorage:
    """轻量内存存储，供单元测试注入 MailboxService / AccountService。"""

    def __init__(self) -> None:
        self.accounts: list[dict[str, Any]] = []
        self.auth_keys: list[dict[str, Any]] = []
        self.collections: dict[str, list[dict[str, Any]]] = {}
        self.states: dict[str, dict[str, Any]] = {}

    def load_accounts(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self.accounts]

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        self.accounts = [dict(item) for item in accounts or []]

    def load_auth_keys(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self.auth_keys]

    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        self.auth_keys = [dict(item) for item in auth_keys or []]

    def load_collection(self, name: str) -> list[dict[str, Any]] | None:
        items = self.collections.get(name)
        if items is None:
            return None
        return [dict(item) for item in items]

    def save_collection(self, name: str, items: list[dict[str, Any]]) -> None:
        self.collections[name] = [dict(item) for item in items or []]

    def load_state(self, key: str) -> dict[str, Any] | None:
        state = self.states.get(key)
        return dict(state) if isinstance(state, dict) else None

    def save_state(self, key: str, data: dict[str, Any]) -> None:
        self.states[key] = dict(data or {})

    def health_check(self) -> dict[str, Any]:
        return {"ok": True}

    def get_backend_info(self) -> dict[str, Any]:
        return {"type": "memory"}


def load_auth_key() -> str:
    key = os.getenv("ACCOUNT_HUB_AUTH_KEY", "").strip()
    if not key:
        raise RuntimeError("ACCOUNT_HUB_AUTH_KEY is required for integration tests")
    return key


def post_json(path: str, payload: dict) -> dict:
    import json

    request = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {load_auth_key()}"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode())
