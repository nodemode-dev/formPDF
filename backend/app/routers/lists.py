import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.services import lists, plugins

router = APIRouter()


@router.get("/lists")
async def get_lists() -> dict:
    return {"lists": await asyncio.to_thread(lists.all_lists)}


@router.post("/lists")
async def save_list(body: dict) -> dict:
    try:
        return await asyncio.to_thread(lists.save, body.get("name"), body.get("steps"), body.get("description") or "", body.get("id"))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@router.delete("/lists/{ident}")
async def delete_list(ident: str) -> dict:
    try:
        await asyncio.to_thread(lists.delete, ident)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return {"ok": True}


@router.get("/plugins")
async def get_plugins() -> dict:
    return {"plugins": await asyncio.to_thread(plugins.discover), "folder": str(plugins.plugins_dir())}


@router.post("/plugins/{pid}")
async def set_plugin(pid: str, body: dict) -> dict:
    try:
        return await asyncio.to_thread(plugins.allow, pid, bool(body.get("allowed")))
    except ValueError as e:
        raise HTTPException(404, str(e)) from None


@router.get("/plugins/{pid}/window.js")
async def plugin_window(pid: str) -> FileResponse:
    path = await asyncio.to_thread(plugins.window_file, pid)
    if path is None:
        raise HTTPException(404, "That plug-in has no window part, or it is not turned on")
    return FileResponse(path, media_type="text/javascript", headers={"Cache-Control": "no-store"})
