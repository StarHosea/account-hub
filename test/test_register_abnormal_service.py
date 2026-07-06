import importlib
import sys
import types
import unittest


class _SharedStorage:
    def __init__(self) -> None:
        self.collections: dict[str, list[dict]] = {}

    def load_collection(self, name: str):
        items = self.collections.get(name)
        if items is None:
            return None
        return [dict(item) for item in items]

    def save_collection(self, name: str, items):
        self.collections[name] = [dict(item) for item in items or []]


class RegisterAbnormalServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self._storage = _SharedStorage()
        self._orig_config_module = sys.modules.get("services.config")
        self._orig_account_service_module = sys.modules.get("services.account_service")
        fake_config_module = types.ModuleType("services.config")
        fake_config_module.config = types.SimpleNamespace(get_storage_backend=lambda: self._storage)
        sys.modules["services.config"] = fake_config_module
        fake_account_service_module = types.ModuleType("services.account_service")
        fake_account_service_module.account_service = types.SimpleNamespace(
            release_registration=lambda *args, **kwargs: None,
        )
        sys.modules["services.account_service"] = fake_account_service_module
        sys.modules.pop("services.register_abnormal_service", None)
        module = importlib.import_module("services.register_abnormal_service")
        self.RegisterAbnormalService = module.RegisterAbnormalService

    def tearDown(self) -> None:
        sys.modules.pop("services.register_abnormal_service", None)
        if self._orig_config_module is None:
            sys.modules.pop("services.config", None)
        else:
            sys.modules["services.config"] = self._orig_config_module
        if self._orig_account_service_module is None:
            sys.modules.pop("services.account_service", None)
        else:
            sys.modules["services.account_service"] = self._orig_account_service_module

    def test_add_keeps_entries_from_other_service_instance(self) -> None:
        svc1 = self.RegisterAbnormalService(storage=self._storage)
        svc2 = self.RegisterAbnormalService(storage=self._storage)

        svc1.add("first@example.com", fetch_url="https://fetch/1", reason="验证码无效")
        svc2.add("second@example.com", fetch_url="https://fetch/2", reason="验证码无效")

        items = self.RegisterAbnormalService(storage=self._storage).list_items()
        emails = {str(item.get("email") or "") for item in items}
        self.assertEqual(emails, {"first@example.com", "second@example.com"})


if __name__ == "__main__":
    unittest.main()
