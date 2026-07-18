import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WebAccountActionsTest(unittest.TestCase):
    def test_activator_requests_only_activating_accounts(self) -> None:
        source = (ROOT / "web/src/pages/ActivatorPage.tsx").read_text(encoding="utf-8")
        self.assertIn('fetchAccounts({ activation: "activating", page_size: 200 })', source)

    def test_plus_selection_exposes_batch_dispatch_actions(self) -> None:
        source = (ROOT / "web/src/pages/AccountsPage.tsx").read_text(encoding="utf-8")
        self.assertIn("标记出库", source)
        self.assertIn("撤销出库", source)
        self.assertIn("handleMarkUsed(selectedKeys, true)", source)
        self.assertIn("handleMarkUsed(selectedKeys, false)", source)

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


if __name__ == "__main__":
    unittest.main()
