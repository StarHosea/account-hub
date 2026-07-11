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


if __name__ == "__main__":
    unittest.main()
