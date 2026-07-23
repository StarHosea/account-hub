import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WebAccountActionsTest(unittest.TestCase):
    def test_activator_requests_only_activating_accounts(self) -> None:
        source = (ROOT / "web/src/pages/ActivatorPage.tsx").read_text(encoding="utf-8")
        self.assertIn('fetchAccounts({ activation: "activating", page_size: 200 })', source)

    def test_activator_activated_card_uses_lifecycle_count(self) -> None:
        """「已激活」卡片必须用 CDK lifecycle，不能绑未同步就为空的 plus_by_type。"""
        source = (ROOT / "web/src/pages/ActivatorPage.tsx").read_text(encoding="utf-8")
        self.assertIn("act?.summary.activated", source)
        self.assertNotIn("act?.summary.plus_by_type", source)

    def test_plus_selection_exposes_batch_dispatch_actions(self) -> None:
        source = (ROOT / "web/src/pages/AccountsPage.tsx").read_text(encoding="utf-8")
        self.assertIn("标记出库", source)
        self.assertIn("撤销出库", source)
        self.assertIn("handleMarkUsed(selectedKeys, true)", source)
        self.assertIn("handleMarkUsed(selectedKeys, false)", source)

    def test_account_selection_exposes_batch_plan_refresh(self) -> None:
        source = (ROOT / "web/src/pages/AccountsPage.tsx").read_text(encoding="utf-8")
        self.assertIn("同步套餐", source)
        self.assertIn("handleRefreshPlan", source)
        self.assertIn("refreshAccountPlans", source)
        self.assertIn("subscription_tier", source)
        self.assertIn('title: "激活"', source)
        self.assertIn('title: "套餐"', source)
        self.assertIn("activationStatusTag", source)
        self.assertIn("planTypeDisplayLabel", source)
        self.assertIn("失效 Token", source)
        self.assertIn("刷新 Token", source)
        # 套餐同步 loading 只落在套餐列，不改「状态」列语义
        self.assertIn("planRefreshing.has(accountKey(a))", source)
        self.assertNotRegex(
            source,
            r"stageTag\(\s*a,\s*refreshing\.has\(accountKey\(a\)\)\s*\|\|\s*planRefreshing",
        )

    def test_plus_accounts_page_shows_dispatch_status_column(self) -> None:
        source = (ROOT / "web/src/pages/AccountsPage.tsx").read_text(encoding="utf-8")
        self.assertIn('title: "出库状态"', source)
        self.assertIn("function renderDispatchStatus", source)
        self.assertIn("showDispatchStatus", source)
        # 列仅在会员页注入（与激活时间列同级门控）
        self.assertRegex(
            source,
            r'planType === "plus"[\s\S]*?title: "出库状态"',
        )

    def test_operation_logs_nav_and_page_wired(self) -> None:
        nav = (ROOT / "web/src/constants/nav.ts").read_text(encoding="utf-8")
        app = (ROOT / "web/src/App.tsx").read_text(encoding="utf-8")
        page = (ROOT / "web/src/pages/LogsPage.tsx").read_text(encoding="utf-8")
        api = (ROOT / "web/src/lib/api.ts").read_text(encoding="utf-8")
        self.assertIn('logs: "操作日志"', nav)
        self.assertIn('itemKey: "/logs"', nav)
        self.assertIn('path="/logs"', app)
        self.assertIn("LogsPage", app)
        self.assertIn("fetchOperationLogs", api)
        self.assertIn("clearOperationLogs", api)
        self.assertIn("一键清空", page)
        self.assertIn("POLL_MS", page)
        self.assertIn("<pre", page)

    def test_token_rotate_toast_includes_skip_reason(self) -> None:
        source = (ROOT / "web/src/pages/AccountsPage.tsx").read_text(encoding="utf-8")
        self.assertIn("errorHints", source)
        self.assertIn("reasonText", source)
        self.assertIn("skip > 0", source)


if __name__ == "__main__":
    unittest.main()
