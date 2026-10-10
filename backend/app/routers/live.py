import asyncio
import json
import time
import urllib.parse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core import config, ids

router = APIRouter()
TOOL_RESULTS: dict[str, asyncio.Future] = {}


class Client:
    def __init__(self, cid: str, send):
        self.id = cid
        self.send = send
        self.kind = "window"
        self.name = "window"
        self.agents = False
        self.doc: dict | None = None
        self.seen = time.monotonic()


CLIENTS: dict[str, Client] = {}


def local_origin(origin: str | None) -> bool:
    if not origin:
        return True
    host = urllib.parse.urlparse(origin).hostname or ""
    return host in ("localhost", "127.0.0.1", "::1", "tauri.localhost") or origin.startswith("tauri://")


async def broadcast(message: dict) -> None:
    for c in list(CLIENTS.values()):
        try:
            await c.send(message)
        except Exception:
            CLIENTS.pop(c.id, None)


@router.websocket("/api/live")
async def live(ws: WebSocket) -> None:
    if not local_origin(ws.headers.get("origin")):
        await ws.close(code=4403)
        return
    await ws.accept()
    lock = asyncio.Lock()

    async def send(message: dict) -> None:
        async with lock:
            await ws.send_text(json.dumps(message, separators=(",", ":")))

    client = Client(ids.short("c", 8), send)
    CLIENTS[client.id] = client
    await send({"t": "hello", "client": client.id, "version": config.VERSION})
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict):
                await handle(client, msg)
    except WebSocketDisconnect:
        pass
    finally:
        CLIENTS.pop(client.id, None)


async def handle(client: Client, msg: dict) -> None:
    t = msg.get("t")
    client.seen = time.monotonic()
    if t == "hello":
        client.kind = msg.get("kind") or client.kind
        client.name = msg.get("name") or client.name
        client.agents = bool(msg.get("agents"))
        return
    if t == "ping":
        await client.send({"t": "pong"})
        return
    if t == "doc":
        doc = msg.get("doc")
        client.doc = doc if isinstance(doc, dict) and doc.get("id") else None
        return
    if t == "toolResult":
        fut = TOOL_RESULTS.get(str(msg.get("id")))
        if fut and not fut.done():
            fut.set_result(msg.get("result") or {})
