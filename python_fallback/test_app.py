import os
import asyncio
import secrets
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("PYTHON_BRIDGE_TOKEN", secrets.token_hex(32))
from fastapi.testclient import TestClient
from python_fallback.app import app, bridge, TOKEN, Bridge, ConnectEvent


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

    def test_terminal_snapshot_keeps_all_remaining_batches_and_session_identity(self):
        instance = Bridge()
        instance.status = "connected"
        for i in range(205):
            instance.append("gift", {"repeatCount": 1, "number": i}, instance.generation)
        instance.status = "disconnected"
        first = instance.snapshot(0)
        self.assertEqual(first["status"], "disconnected")
        self.assertEqual(len(first["events"]), 200)
        self.assertEqual(first["latestSeq"], 205)
        self.assertEqual(first["sessionId"], instance.session_id)
        self.assertEqual(len(instance.snapshot(200)["events"]), 5)
        self.assertEqual(instance.snapshot(205)["events"], [])


class BridgeSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_start_changes_session_identity_without_external_connections(self):
        class FakeClient:
            def __init__(self, **_kwargs):
                self.listeners = {}
                self.room_id = "123456789"
                self.ended = asyncio.Event()

            def add_listener(self, kind, callback):
                self.listeners[kind] = callback

            async def connect(self):
                await self.listeners[ConnectEvent](SimpleNamespace(room_id=self.room_id))
                await self.ended.wait()

            async def disconnect(self):
                self.ended.set()

        instance = Bridge()
        with patch("python_fallback.app.TikTokLiveClient", FakeClient):
            try:
                first = await instance.start("broadcaster")
                second = await instance.start("broadcaster")
                self.assertNotEqual(first["sessionId"], second["sessionId"])
                self.assertEqual(second["roomId"], "123456789")
                self.assertEqual(second["status"], "connected")
            finally:
                await instance.stop()
