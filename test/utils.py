import os
import sys
import urllib.request
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
BASE_URL = "http://127.0.0.1:8000"

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


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
