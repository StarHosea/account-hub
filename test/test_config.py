import os
import tempfile
import unittest
from pathlib import Path


class ConfigLoadingTests(unittest.TestCase):
    def test_load_settings_requires_env_auth_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            base_dir = Path(tmp_dir)
            data_dir = base_dir / "data"
            os_auth_key = "env-auth"

            from services import config as module

            old_base_dir = module.BASE_DIR
            old_data_dir = module.DATA_DIR
            old_env_auth_key = module.os.environ.get("ACCOUNT_HUB_AUTH_KEY")
            try:
                module.BASE_DIR = base_dir
                module.DATA_DIR = data_dir
                module.os.environ["ACCOUNT_HUB_AUTH_KEY"] = os_auth_key

                settings = module._load_settings()

                self.assertEqual(settings.auth_key, os_auth_key)
            finally:
                module.BASE_DIR = old_base_dir
                module.DATA_DIR = old_data_dir
                if old_env_auth_key is None:
                    module.os.environ.pop("ACCOUNT_HUB_AUTH_KEY", None)
                else:
                    module.os.environ["ACCOUNT_HUB_AUTH_KEY"] = old_env_auth_key

    def test_load_settings_rejects_missing_auth_key(self) -> None:
        from services import config as module

        old_env_auth_key = module.os.environ.get("ACCOUNT_HUB_AUTH_KEY")
        try:
            module.os.environ.pop("ACCOUNT_HUB_AUTH_KEY", None)
            with self.assertRaises(ValueError):
                module._load_settings()
        finally:
            if old_env_auth_key is None:
                module.os.environ.pop("ACCOUNT_HUB_AUTH_KEY", None)
            else:
                module.os.environ["ACCOUNT_HUB_AUTH_KEY"] = old_env_auth_key


if __name__ == "__main__":
    unittest.main()
