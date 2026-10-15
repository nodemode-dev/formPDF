import asyncio
import json

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.routers.live import local_origin
from app.services import chat, claude_code, events, terminal
from app.services.claude_code import AgentError

router = APIRouter(tags=["agent-dock"])


class OpenTerm(BaseModel):
    cwd: str | None = None
    cols: int | None = None
    rows: int | None = None
    title: str | None = None


class TermWrite(BaseModel):
    data: str


class OpenClaude(BaseModel):
    prompt: str | None = None
    cols: int | None = None
    rows: int | None = None
    fresh: bool = False
    resume: str | None = None


class ChatSend(BaseModel):
    text: str
    context: str = ""
    note: str = ""


class ChatAdopt(BaseModel):
    session: str = ""


def _guard(request: Request) -> None:
    if not local_origin(request.headers.get("origin")):
        raise HTTPException(403, "Only formpdf's own window can use the agent dock")


def _session(sid: str) -> terminal.Session:
    try:
        return terminal.get(sid)
    except KeyError:
        raise HTTPException(404, f"No terminal {sid}; GET /api/terminals lists them") from None


def _agent(fn, *args, **kw):
    try:
        return fn(*args, **kw)
    except AgentError as e:
        raise HTTPException(e.status, str(e)) from None


@router.get("/api/terminals")
def list_terminals(request: Request) -> dict:
    _guard(request)
    items = [s.describe() for s in terminal.SESSIONS.values()]
    return {"terminals": items, "count": len(items)}


@router.post("/api/terminals")
def open_terminal(body: OpenTerm, request: Request) -> dict:
    _guard(request)
    try:
        return terminal.open_session(body.cwd, body.cols or 100, body.rows or 30, body.title).describe()
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from None


@router.post("/api/terminals/{sid}/write")
def write_terminal(sid: str, body: TermWrite, request: Request) -> dict:
    _guard(request)
    s = _session(sid)
    if not s.alive:
        raise HTTPException(409, f"Terminal {sid} has exited; restart it or open a new one")
    terminal.write(sid, body.data)
    return {"written": len(body.data)}


@router.get("/api/terminals/{sid}/read")
def read_terminal(sid: str, request: Request, chars: int = 4000) -> dict:
    _guard(request)
    s = _session(sid)
    return {"id": sid, "alive": s.alive, "text": s.plain(chars)}


@router.post("/api/terminals/{sid}/restart")
def restart_terminal(sid: str, request: Request) -> dict:
    _guard(request)
    _session(sid)
    return terminal.restart(sid).describe()


@router.post("/api/terminals/{sid}/close")
def close_terminal(sid: str, request: Request) -> dict:
    _guard(request)
    terminal.close(sid)
    return {"closed": sid}


@router.websocket("/api/terminal/{sid}")
async def attach(ws: WebSocket, sid: str) -> None:
    if not local_origin(ws.headers.get("origin")):
        await ws.close(code=4403)
        return
    await ws.accept()
    try:
        session = terminal.get(sid)
    except KeyError:
        await ws.close(code=4404)
        return
    q: asyncio.Queue = asyncio.Queue()
    session.subscribers.add(q)

    async def outbound() -> None:
        backlog = session.scrollback()
        if backlog:
            await ws.send_text(backlog)
        if not session.alive:
            await ws.send_text(json.dumps({"type": "exit"}))
        while True:
            text = await q.get()
            await ws.send_text(json.dumps({"type": "exit"}) if text is None else text)

    sender = asyncio.create_task(outbound())
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if msg.get("type") == "input" and session.alive:
                terminal.write(sid, str(msg.get("data", "")))
            elif msg.get("type") == "resize":
                terminal.resize(sid, int(msg.get("cols", 80)), int(msg.get("rows", 24)))
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        session.subscribers.discard(q)


@router.get("/api/claude/status")
def claude_status(request: Request) -> dict:
    _guard(request)
    return _agent(claude_code.status)


@router.post("/api/claude/open")
def claude_open(body: OpenClaude, request: Request) -> dict:
    _guard(request)
    return _agent(claude_code.open_tab, body.prompt, body.cols, body.rows, body.fresh, body.resume)


@router.get("/api/chat/state")
def chat_state(request: Request) -> dict:
    _guard(request)
    return chat.state()


@router.post("/api/chat/send")
def chat_send(body: ChatSend, request: Request) -> dict:
    _guard(request)
    return _agent(chat.send, body.text, body.context, body.note)


@router.post("/api/chat/cancel")
def chat_cancel(request: Request) -> dict:
    _guard(request)
    return chat.cancel()


@router.post("/api/chat/reset")
def chat_reset(request: Request) -> dict:
    _guard(request)
    return chat.reset()


@router.get("/api/chat/sessions")
def chat_sessions(request: Request) -> dict:
    _guard(request)
    return _agent(chat.sessions)


@router.post("/api/chat/adopt")
def chat_adopt(body: ChatAdopt, request: Request) -> dict:
    _guard(request)
    return _agent(chat.adopt, body.session)


@router.get("/api/chat/image/{name}")
def chat_image(name: str, request: Request) -> FileResponse:
    _guard(request)
    path = chat.image_path(name)
    if path is None:
        raise HTTPException(404, "No such picture")
    return FileResponse(path)


@router.get("/api/events")
async def stream(request: Request) -> StreamingResponse:
    _guard(request)
    queue = events.subscribe()

    async def gen():
        try:
            yield f"retry: 1500\ndata: {json.dumps({'type': 'hello'})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"data: {message}\n\n"
        finally:
            events.unsubscribe(queue)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
