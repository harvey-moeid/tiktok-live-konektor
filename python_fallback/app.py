"""Authenticated HTTP event bridge for the optional TikTokLive Python fallback."""
import asyncio
import contextlib
from collections import deque
import hmac
import os
import re
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel
from TikTokLive import TikTokLiveClient
from TikTokLive.events import (
    ConnectEvent, DisconnectEvent, LiveEndEvent, CommentEvent,
    LikeEvent, GiftEvent, FollowEvent, ShareEvent, JoinEvent, RoomUserSeqEvent,
)

from python_fallback.events import normalize_event

TOKEN = os.environ.get("PYTHON_BRIDGE_TOKEN", "")
if len(TOKEN) < 32:
    raise RuntimeError("PYTHON_BRIDGE_TOKEN must be configured with at least 32 characters")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
USER_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def require_token(authorization: Optional[str] = Header(default=None)):
    bearer = authorization or ""
    provided = bearer[7:] if bearer.startswith("Bearer ") else ""
    if not hmac.compare_digest(provided, TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


class StartRequest(BaseModel):
    username: str


class Bridge:
    def __init__(self):
        self.client = None
        self.task = None
        self.generation = 0
        self.username = ""
        self.room_id = ""
        self.status = "disconnected"
        self.error = None
        self.seq = 0
        self.events = deque(maxlen=2000)
        self.lock = asyncio.Lock()

    def append(self, kind, data, generation):
        if generation != self.generation or self.status != "connected" or data is None:
            return
        self.seq += 1
        self.events.append({"seq": self.seq, "event": kind, "data": data})

    async def stop(self):
        self.generation += 1
        client, task = self.client, self.task
        self.client = self.task = None
        self.status = "disconnected"
        self.error = None
        if client is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(client.disconnect(), timeout=4)
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(task, timeout=2)

    async def start(self, username):
        username = username.removeprefix("@").strip()
        if not USER_RE.fullmatch(username):
            raise HTTPException(status_code=400, detail="Invalid TikTok username")
        async with self.lock:
            await self.stop()
            generation = self.generation
            self.username, self.room_id = username, ""
            self.seq = 0
            self.events.clear()
            self.status, self.error = "connecting", None
            ready = asyncio.get_running_loop().create_future()
            client = TikTokLiveClient(unique_id="@" + username)
            self.client = client

            async def connected(event):
                if generation != self.generation:
                    return
                self.room_id = str(getattr(event, "room_id", None) or client.room_id or "")
                self.status = "connected"
                if not ready.done():
                    ready.set_result(True)

            async def disconnected(_event):
                if generation != self.generation:
                    return
                self.status = "disconnected"
                if not ready.done():
                    ready.set_exception(RuntimeError("TikTok LIVE disconnected before connection"))

            async def ended(event):
                await disconnected(event)

            client.add_listener(ConnectEvent, connected)
            client.add_listener(DisconnectEvent, disconnected)
            client.add_listener(LiveEndEvent, ended)

            for kind, cls in (
                ("chat", CommentEvent), ("like", LikeEvent), ("gift", GiftEvent),
                ("follow", FollowEvent), ("share", ShareEvent), ("member", JoinEvent),
                ("viewer", RoomUserSeqEvent),
            ):
                async def ingest(event, kind=kind):
                    self.append(kind, normalize_event(kind, event), generation)
                client.add_listener(cls, ingest)

            async def run():
                try:
                    await client.connect()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if generation == self.generation:
                        self.status, self.error = "error", str(exc)[:500]
                        if not ready.done():
                            ready.set_exception(RuntimeError(self.error))
                finally:
                    if generation == self.generation:
                        if self.status == "connected":
                            self.status = "disconnected"
                        if not ready.done():
                            ready.set_exception(RuntimeError("TikTok LIVE ended before connection"))

            self.task = asyncio.create_task(run())
            try:
                await asyncio.wait_for(asyncio.shield(ready), timeout=22)
                if self.status != "connected":
                    raise RuntimeError("TikTok LIVE connection closed")
            except (Exception, asyncio.TimeoutError) as exc:
                message = str(exc) or "Python TikTok connection timed out"
                await self.stop()
                raise HTTPException(status_code=502, detail=message[:500]) from exc
            return {"ok": True, "status": "connected", "roomId": self.room_id, "cursor": 0}

    def snapshot(self, after):
        items = [item for item in self.events if item["seq"] > after][:200]
        oldest = self.events[0]["seq"] if self.events else self.seq + 1
        return {"ok": True, "status": self.status, "error": self.error,
                "roomId": self.room_id, "events": items, "latestSeq": self.seq,
                "dropped": after < oldest - 1}


bridge = Bridge()


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/start", dependencies=[Depends(require_token)])
async def start(body: StartRequest):
    return await bridge.start(body.username)


@app.post("/stop", dependencies=[Depends(require_token)])
async def stop():
    async with bridge.lock:
        await bridge.stop()
    return {"ok": True}


@app.get("/events", dependencies=[Depends(require_token)])
async def events(after: int = Query(default=0, ge=0)):
    return bridge.snapshot(after)
