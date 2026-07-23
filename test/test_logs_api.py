from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.logs import create_router


class LogsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        app.include_router(create_router())
        self.client = TestClient(app)

    def test_list_logs_requires_admin(self) -> None:
        resp = self.client.get("/api/logs")
        self.assertEqual(resp.status_code, 401)

    def test_list_logs_returns_items(self) -> None:
        fake = [{"id": "1", "time": "2026-07-23 10:00:00", "type": "account", "summary": "刷新 Token 跳过", "detail": {"reason": "无密码且无法收码"}}]
        with patch("api.logs.require_admin", return_value={"role": "admin"}), patch(
            "api.logs.log_service.list", return_value=fake
        ) as list_mock:
            resp = self.client.get("/api/logs", headers={"Authorization": "Bearer x"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["items"], fake)
        list_mock.assert_called_once()

    def test_delete_logs_requires_ids(self) -> None:
        with patch("api.logs.require_admin", return_value={"role": "admin"}):
            resp = self.client.request(
                "DELETE",
                "/api/logs",
                headers={"Authorization": "Bearer x"},
                json={"ids": []},
            )
        self.assertEqual(resp.status_code, 400)

    def test_delete_logs_ok(self) -> None:
        with patch("api.logs.require_admin", return_value={"role": "admin"}), patch(
            "api.logs.log_service.delete", return_value={"removed": 2}
        ) as delete_mock:
            resp = self.client.request(
                "DELETE",
                "/api/logs",
                headers={"Authorization": "Bearer x"},
                json={"ids": ["a", "b"]},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["removed"], 2)
        delete_mock.assert_called_once_with(["a", "b"])

    def test_clear_all_logs(self) -> None:
        with patch("api.logs.require_admin", return_value={"role": "admin"}), patch(
            "api.logs.log_service.clear", return_value={"removed": 5}
        ) as clear_mock:
            resp = self.client.request(
                "DELETE",
                "/api/logs",
                headers={"Authorization": "Bearer x"},
                json={"clear_all": True},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["removed"], 5)
        clear_mock.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
