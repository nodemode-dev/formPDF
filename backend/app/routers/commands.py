import json
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.core import config
from app.routers.live import local_origin
from app.services import bridge

router = APIRouter(prefix="/api/commands", tags=["commands"])
_STATE: dict = {"commands": [], "at": 0.0, "loaded": False}


class Mirror(BaseModel):
    commands: list[dict]


class Run(BaseModel):
    params: dict = {}


def _path():
    return config.data_dir() / "commands-catalogue.json"


def catalogue() -> list[dict]:
    if not _STATE["loaded"]:
        _STATE["loaded"] = True
        try:
            saved = json.loads(_path().read_text(encoding="utf-8"))
            _STATE["commands"], _STATE["at"] = saved.get("commands") or [], float(saved.get("at") or 0)
        except (OSError, ValueError):
            pass
    return _STATE["commands"]


def find(cid: str) -> dict | None:
    return next((c for c in catalogue() if c.get("id") == cid), None)


def search(group: str | None = None, text: str | None = None) -> list[dict]:
    g = (group or "").strip().lower()
    words = (text or "").lower().split()
    out = []
    for c in catalogue():
        if g and str(c.get("group", "")).lower() != g:
            continue
        hay = " ".join(str(c.get(k, "")) for k in ("id", "label", "description", "when")).lower()
        if all(w in hay for w in words):
            out.append(c)
    return out


def near(cid: str) -> list[str]:
    words = cid.replace("-", " ").replace("_", " ").replace(".", " ").split()
    scored = sorted(catalogue(), key=lambda c: -sum(w in str(c.get("id", "")) for w in words))
    return [c["id"] for c in scored[:5] if any(w in str(c.get("id", "")) for w in words)]


async def run(cid: str, params: dict) -> dict:
    out = await bridge.window_call("run_command", {"id": cid, "params": params}, 120)
    if out is None:
        return {"ok": False, "error": "The formpdf window is not open, so window commands cannot run. Open formpdf (./formpdf or the desktop app) and try again."}
    data = out.get("structuredContent") or {}
    if out.get("isError"):
        return {"ok": False, "error": (out.get("content") or [{}])[0].get("text", "failed"), **({"result": data} if data else {})}
    return {"ok": True, **data}


def _guard(request: Request) -> None:
    if not local_origin(request.headers.get("origin")):
        raise HTTPException(403, "Only this computer can use formpdf's commands")


@router.post("/catalogue")
def mirror(body: Mirror, request: Request) -> dict:
    _guard(request)
    _STATE["commands"], _STATE["at"], _STATE["loaded"] = body.commands, time.time(), True
    try:
        _path().write_text(json.dumps({"at": _STATE["at"], "commands": body.commands}), encoding="utf-8")
    except OSError:
        pass
    return {"count": len(body.commands)}


@router.get("")
def list_commands(request: Request, group: str | None = None, text: str | None = None) -> dict:
    _guard(request)
    items = search(group, text)
    live = bridge.window_connected()
    hint = "" if catalogue() else "No catalogue yet: open the formpdf window once so it can list its commands."
    return {"commands": items, "count": len(items), "live": live, "updated": _STATE["at"], "hint": hint}


@router.get("/{cid}")
def describe(cid: str, request: Request) -> dict:
    _guard(request)
    c = find(cid)
    if c is None:
        guess = near(cid)
        raise HTTPException(404, f"No command {cid}." + (f" Did you mean {', '.join(guess)}?" if guess else ""))
    return c


@router.post("/{cid}")
async def run_one(cid: str, body: Run, request: Request) -> dict:
    _guard(request)
    return await run(cid, body.params)
