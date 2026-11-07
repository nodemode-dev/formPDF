import asyncio
import os
import subprocess
import sys

from fastapi import APIRouter, HTTPException, Request, Response

from app.core import config
from app.routers import mcp
from app.routers.live import local_origin
from app.services import formext_host as fx
from app.services import pdf as pdfsvc
from app.services.pdf import docs

router = APIRouter(tags=["extensions"])
PRODUCT = "formpdf"
APP = "formpdf"
FILES = "/api/extensions/files"
KEPT_OUT = {"merge", "protect", "unlock"}
_STATE: dict = {"stamp": None, "list": []}


def _resolve() -> list[fx.Extension]:
    _STATE["stamp"] = fx.stamp(PRODUCT)
    _STATE["list"] = fx.resolve(PRODUCT, config.VERSION, APP)
    return _STATE["list"]


def _current() -> list[fx.Extension]:
    return _STATE["list"] if _STATE["stamp"] == fx.stamp(PRODUCT) else _resolve()


def _guard(request: Request) -> None:
    if not local_origin(request.headers.get("origin")):
        raise HTTPException(403, "formpdf answers this computer's own window only")


def _source(doc_id: str) -> mcp.Source:
    try:
        path = docs.path_of(doc_id)
    except docs.NotFound:
        raise HTTPException(404, "That PDF is no longer open in formpdf") from None
    m = docs.meta(doc_id)
    return mcp.Source(path, doc_id=doc_id, key=m.get("root") or doc_id, name=m.get("name"))


def _text(out: dict) -> str:
    return " ".join(p.get("text", "") for p in out.get("content") or [] if p.get("type") == "text")


@router.get("/api/extensions")
def extension_list() -> dict:
    found = _resolve()
    return {"product": PRODUCT, "app": APP, "appVersion": config.VERSION, "api": fx.API, "root": str(fx.portal_root()),
            "stamp": list(_STATE["stamp"]), "extensions": [e.public(FILES) for e in found]}


@router.api_route(FILES + "/{ext_id}/{version}/{rel:path}", methods=["GET", "HEAD"])
def extension_file(ext_id: str, version: str, rel: str) -> Response:
    found = fx.file_for(_current(), ext_id, version, rel) or fx.file_for(_resolve(), ext_id, version, rel)
    if found is None:
        return Response(status_code=404, headers=fx.headers_for("text/plain", ""))
    path, ctype = found
    try:
        data = path.read_bytes()
    except OSError:
        return Response(status_code=404, headers=fx.headers_for("text/plain", ""))
    return Response(data, media_type=ctype, headers=fx.headers_for(ctype, ""))


@router.post("/api/extensions/manage")
def extension_manage(request: Request) -> dict:
    _guard(request)
    url = f"formai://extensions?product={PRODUCT}"
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif os.name == "nt":
            os.startfile(url)
        else:
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        raise HTTPException(409, "FormPortal is not installed on this computer, or nothing opens formai:// links") from None
    return {"opened": url}


@router.post("/api/extensions/apply")
async def extension_apply(body: dict, request: Request) -> dict:
    _guard(request)
    ops = body.get("ops")
    if not isinstance(ops, list) or not ops or any(not isinstance(o, dict) or not isinstance(o.get("command"), str) for o in ops):
        raise HTTPException(400, "ops must be a list of { command, args }")
    agent = mcp.Agent("formext", str(body.get("by") or "Extension")[:80])
    current = str(body.get("doc") or "")
    results = []
    for op in ops:
        command, args = op["command"], op.get("args") if isinstance(op.get("args"), dict) else {}
        if command not in mcp.CHANGE_ACTIONS or command in KEPT_OUT:
            raise HTTPException(400, f"{command} is not a formpdf change an extension can make")
        src = _source(current)
        try:
            out = await mcp._change(agent, src, command, dict(args), mcp._pages(args.get("pages")), land=False)
        except mcp.ToolError as exc:
            raise HTTPException(400, f"{command}: {exc}") from None
        except pdfsvc.Locked as exc:
            raise HTTPException(400, f"{command}: {exc}") from None
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(400, f"{command}: bad arguments ({exc})") from None
        if "content" in out:
            if out.get("isError"):
                raise HTTPException(400, _text(out))
            results.append({"command": command, "detail": _text(out)})
            continue
        current = out["id"]
        results.append({"command": command, "detail": out["detail"]})
    pages = await asyncio.to_thread(pdfsvc.page_count, docs.path_of(current), mcp.routes._pw(current))
    return {"applied": len(results), "results": results, "id": current, "pages": pages}


@router.post("/api/extensions/read")
async def extension_read(body: dict, request: Request) -> dict:
    _guard(request)
    action = str(body.get("action") or "")
    args = body.get("args") if isinstance(body.get("args"), dict) else {}
    if action not in mcp.READ_ACTIONS:
        raise HTTPException(400, f"{action} is not a formpdf read action")
    try:
        out = await mcp._read(_source(str(body.get("doc") or "")), action, dict(args), mcp._pages(args.get("pages")))
    except mcp.ToolError as exc:
        raise HTTPException(400, f"{action}: {exc}") from None
    except pdfsvc.Locked as exc:
        raise HTTPException(400, f"{action}: {exc}") from None
    if out.get("isError"):
        raise HTTPException(400, _text(out))
    return {"text": _text(out), "data": out.get("structuredContent")}
