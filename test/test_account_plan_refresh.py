from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

os.environ.setdefault("ACCOUNT_HUB_AUTH_KEY", "test-auth-key")

from services.account_lifecycle import STAGE_PLUS_ACTIVATED, STAGE_REGISTERED, apply_stage, email_storage_key  # noqa: E402
from services.account_service import AccountService  # noqa: E402
from services.openai_backend_api import OpenAIBackendAPI  # noqa: E402
from test.test_account_export import MemoryStorage  # noqa: E402


class ResolvePlanTypeTests(unittest.TestCase):
    def test_prefers_org_match(self) -> None:
        payload = {
            "accounts": {
                "org-personal": {
                    "account": {"plan_type": "plus", "is_default": True},
                },
                "org-team": {
                    "account": {"plan_type": "team"},
                },
            }
        }
        self.assertEqual(
            OpenAIBackendAPI.resolve_plan_type_from_accounts_check(payload, org_id="org-personal"),
            "plus",
        )

    def test_prefers_default_then_paid(self) -> None:
        payload = {
            "accounts": {
                "a": {"account": {"plan_type": "free"}},
                "b": {"account": {"plan_type": "plus", "is_default": True}},
                "c": {"account": {"plan_type": "pro"}},
            }
        }
        self.assertEqual(OpenAIBackendAPI.resolve_plan_type_from_accounts_check(payload), "plus")

    def test_falls_back_to_paid_when_no_default(self) -> None:
        payload = {
            "accounts": {
                "a": {"account": {"plan_type": "free"}},
                "b": {"account": {"plan_type": "pro"}},
            }
        }
        self.assertEqual(OpenAIBackendAPI.resolve_plan_type_from_accounts_check(payload), "pro")

    def test_uses_subscription_plan_when_plan_type_missing(self) -> None:
        payload = {
            "accounts": {
                "default": {
                    "entitlement": {"subscription_plan": "plus"},
                }
            }
        }
        self.assertEqual(OpenAIBackendAPI.resolve_plan_type_from_accounts_check(payload), "plus")

    def test_skips_deactivated_account(self) -> None:
        payload = {
            "accounts": {
                "a": {"account": {"plan_type": "pro", "is_deactivated": True}},
                "b": {"account": {"plan_type": "free"}},
            }
        }
        self.assertEqual(OpenAIBackendAPI.resolve_plan_type_from_accounts_check(payload), "free")

    def test_skips_disabled_status_and_expired_entitlement(self) -> None:
        now = datetime(2026, 7, 23, 12, 0, 0, tzinfo=timezone.utc)
        payload = {
            "accounts": {
                "expired-plus": {
                    "account": {"plan_type": "plus", "is_default": True},
                    "entitlement": {"expires_at": "2026-01-01T00:00:00+00:00"},
                },
                "disabled-pro": {
                    "account": {"plan_type": "pro", "status": "disabled"},
                },
                "active-free": {
                    "account": {"plan_type": "free"},
                },
            }
        }
        usable = [
            key
            for key, entry in payload["accounts"].items()
            if OpenAIBackendAPI._is_usable_account_entry(entry, now=now)
        ]
        self.assertEqual(usable, ["active-free"])
        self.assertEqual(OpenAIBackendAPI.resolve_plan_type_from_accounts_check(payload), "free")

    def test_expired_org_falls_back_to_default_paid(self) -> None:
        """org 匹配但 entitlement 已过期时，应回退到遍历逻辑。"""
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        future = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        payload = {
            "accounts": {
                "org-expired": {
                    "account": {"plan_type": "team"},
                    "entitlement": {"expires_at": past, "subscription_plan": "team"},
                },
                "personal": {
                    "account": {"plan_type": "plus", "is_default": True},
                    "entitlement": {"expires_at": future},
                },
            }
        }
        self.assertEqual(
            OpenAIBackendAPI.resolve_plan_type_from_accounts_check(payload, org_id="org-expired"),
            "plus",
        )


class PlanCountBucketTests(unittest.TestCase):
    def test_bucket_mapping(self) -> None:
        self.assertEqual(AccountService._plan_count_bucket("free"), "free")
        self.assertEqual(AccountService._plan_count_bucket("Plus"), "plus")
        self.assertEqual(AccountService._plan_count_bucket("pro"), "pro")
        self.assertEqual(AccountService._plan_count_bucket("chatgptpro"), "pro")
        self.assertEqual(AccountService._plan_count_bucket("chatgpt_pro"), "pro")
        self.assertEqual(AccountService._plan_count_bucket("team"), "other")


class RefreshAccountPlansTests(unittest.TestCase):
    EMAIL = "plan@example.com"
    TOKEN = "eyJhbGciOiJIUzI1NiJ9.plan.token"

    def setUp(self) -> None:
        self.storage = MemoryStorage()
        self.service = AccountService(self.storage)
        self.service._accounts[email_storage_key(self.EMAIL)] = self.service._normalize_account(
            apply_stage(
                {
                    "email": self.EMAIL,
                    "access_token": self.TOKEN,
                    "type": "free",
                    "plan": "free",
                },
                STAGE_REGISTERED,
            )
        )
        self._orig_delay = AccountService._PLAN_REFRESH_SUBMIT_DELAY_SECONDS
        AccountService._PLAN_REFRESH_SUBMIT_DELAY_SECONDS = 0

    def tearDown(self) -> None:
        AccountService._PLAN_REFRESH_SUBMIT_DELAY_SECONDS = self._orig_delay

    def test_fetch_remote_plan_clears_error_before_sync(self) -> None:
        self.service.update_account(
            self.TOKEN,
            {
                "last_refresh_error": "previous sync failed",
                "last_refresh_error_at": "2026-01-01T00:00:00+00:00",
            },
            quiet=True,
        )
        seen: dict[str, str | None] = {}

        def _get_plan_type(self_api=None):
            account = self.service.get_account(self.TOKEN) or {}
            seen["error_during_call"] = account.get("last_refresh_error")
            seen["last_error_during_call"] = account.get("last_error")
            return {"subscription_tier": "plus"}

        with patch(
            "services.openai_backend_api.OpenAIBackendAPI.get_plan_type",
            side_effect=_get_plan_type,
            autospec=False,
        ):
            updated = self.service.fetch_remote_plan(self.TOKEN)

        self.assertIsNone(seen.get("error_during_call"))
        self.assertIsNone(seen.get("last_error_during_call"))
        assert updated is not None
        self.assertIsNone(updated.get("last_refresh_error"))
        self.assertIsNone(updated.get("last_error"))

    def test_fetch_remote_plan_clears_error_even_when_sync_fails(self) -> None:
        self.service.update_account(
            self.TOKEN,
            {
                "last_refresh_error": "stale error",
                "last_refresh_error_at": "2026-01-01T00:00:00+00:00",
            },
            quiet=True,
        )
        with patch(
            "services.openai_backend_api.OpenAIBackendAPI.get_plan_type",
            side_effect=RuntimeError("network boom"),
        ):
            with self.assertRaises(RuntimeError):
                self.service.fetch_remote_plan(self.TOKEN)

        account = self.service.get_account(self.TOKEN) or {}
        self.assertIsNone(account.get("last_refresh_error"))
        self.assertIsNone(account.get("last_error"))

    def test_fetch_remote_plan_updates_subscription_tier_only(self) -> None:
        with patch("services.openai_backend_api.OpenAIBackendAPI.get_plan_type", return_value={"subscription_tier": "plus"}):
            updated = self.service.fetch_remote_plan(self.TOKEN)

        self.assertIsNotNone(updated)
        assert updated is not None
        self.assertEqual(updated.get("subscription_tier"), "plus")
        self.assertIsNotNone(updated.get("subscription_tier_at"))
        self.assertEqual(updated.get("plan"), "free")
        self.assertEqual(updated.get("plus_status"), "未激活")

    def test_fetch_remote_plan_does_not_change_activation_state(self) -> None:
        activated_email = "activated@example.com"
        activated_token = "eyJhbGciOiJIUzI1NiJ9.activated.token"
        self.service._accounts[email_storage_key(activated_email)] = self.service._normalize_account(
            apply_stage(
                {
                    "email": activated_email,
                    "access_token": activated_token,
                    "plan": "plus",
                    "plus_status": "已激活",
                    "plus_activated_at": "2026-01-01T00:00:00+00:00",
                },
                STAGE_PLUS_ACTIVATED,
            )
        )
        with patch(
            "services.openai_backend_api.OpenAIBackendAPI.get_plan_type",
            return_value={"subscription_tier": "free"},
        ):
            updated = self.service.fetch_remote_plan(activated_token)

        assert updated is not None
        self.assertEqual(updated.get("subscription_tier"), "free")
        self.assertEqual(updated.get("plan"), "plus")
        self.assertEqual(updated.get("stage"), STAGE_PLUS_ACTIVATED)
        self.assertEqual(updated.get("plus_status"), "已激活")
        self.assertTrue(updated.get("is_activated"))

    def test_refresh_account_plans_tracks_progress_counts(self) -> None:
        progress_id = "plan-progress-1"

        def _fake_fetch(token: str, event: str = "fetch_remote_plan"):
            return self.service.update_account(
                token,
                {"subscription_tier": "plus", "subscription_tier_at": self.service._now()},
                quiet=True,
            )

        with patch.object(self.service, "fetch_remote_plan", side_effect=_fake_fetch):
            result = self.service.refresh_account_plans([self.TOKEN], progress_id)

        self.assertEqual(result["refreshed"], 1)
        progress = self.service.get_plan_refresh_progress(progress_id)
        self.assertIsNotNone(progress)
        assert progress is not None
        self.assertTrue(progress["done"])
        self.assertEqual(progress["processed"], 1)
        self.assertEqual(progress["plan_counts"]["plus"], 1)

    def test_refresh_account_plans_counts_errors(self) -> None:
        progress_id = "plan-progress-err"

        with patch.object(self.service, "fetch_remote_plan", side_effect=RuntimeError("boom")):
            result = self.service.refresh_account_plans([self.TOKEN], progress_id)

        self.assertEqual(result["refreshed"], 0)
        self.assertEqual(len(result["errors"]), 1)
        progress = self.service.get_plan_refresh_progress(progress_id)
        assert progress is not None
        self.assertEqual(progress["plan_counts"]["error"], 1)

    def test_refresh_account_plans_counts_invalid_tokens(self) -> None:
        from services.openai_backend_api import InvalidAccessTokenError

        progress_id = "plan-progress-invalid"
        with patch.object(
            self.service,
            "fetch_remote_plan",
            side_effect=InvalidAccessTokenError("token invalidated (/backend-api/accounts/check)"),
        ):
            result = self.service.refresh_account_plans([self.TOKEN], progress_id)

        self.assertEqual(result["refreshed"], 0)
        self.assertEqual(result["errors"][0].get("code"), "invalid_token")
        progress = self.service.get_plan_refresh_progress(progress_id)
        assert progress is not None
        self.assertEqual(progress["plan_counts"]["invalid"], 1)
        self.assertEqual(progress["plan_counts"]["error"], 0)

    def test_plan_refresh_uses_lower_concurrency_than_full_refresh(self) -> None:
        self.assertLessEqual(AccountService._PLAN_REFRESH_MAX_WORKERS, 5)
        self.assertGreater(self._orig_delay, 0)


if __name__ == "__main__":
    unittest.main()
