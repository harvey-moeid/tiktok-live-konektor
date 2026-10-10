import os
import secrets
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("PYTHON_BRIDGE_TOKEN", secrets.token_hex(32))
from fastapi.testclient import TestClient
from python_fallback.app import app, bridge, TOKEN


class BridgeHttpTests(unittest.TestCase):
    def test_health_and_authenticated_event_snapshot(self):
        with TestClient(app) as client:
            self.assertEqual(client.get("/health").json(), {"ok": True})
            self.assertEqual(client.get("/events").status_code, 401)
            response = client.get("/events", headers={"Authorization": "Bearer " + TOKEN})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()["ok"])

    def test_invalid_username_does_not_connect_to_tiktok(self):
        with TestClient(app) as client:
            response = client.post("/start", json={"username": "../invalid"},
                                   headers={"Authorization": "Bearer " + TOKEN})
            self.assertEqual(response.status_code, 400)

    def test_shutdown_closes_bridge(self):
        with patch.object(bridge, "stop", new_callable=AsyncMock) as stop:
            with TestClient(app) as client:
                self.assertEqual(client.get("/health").status_code, 200)
            stop.assert_awaited_once()
