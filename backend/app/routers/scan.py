import asyncio
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.routers.pdf import _derive, _opened, _pw, _run
from app.services import scan as scansvc
from app.services.pdf import core, docs, ocr
from app.services.pdf import create as createsvc

router = APIRouter()
LOCK = asyncio.Lock()


def _device(body: dict) -> str:
    if body.get("address"):
        try:
            return "escl:" + scansvc.escl_base(str(body["address"]))
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
    dev = str(body.get("device") or "")
    if not dev:
        raise HTTPException(400, "Pick a scanner, or give a network scanner's address")
    return dev


@router.get("/scan/devices")
async def devices() -> dict:
    return {"devices": await asyncio.to_thread(scansvc.devices)}


@router.post("/scan/capabilities")
async def capabilities(body: dict) -> dict:
    dev = _device(body)
    return {"device": dev, **await _run(scansvc.capabilities, dev)}


def _pages_pdf(pages: list[tuple[str, bytes]], out: Path, title: str) -> dict:
    return createsvc.from_files(pages, out, page="fit", title=title)


@router.post("/scan/run")
async def run(body: dict) -> dict:
    dev = _device(body)
    if LOCK.locked():
        raise HTTPException(409, "A scan is already running")
    async with LOCK:
        pages = await _run(scansvc.scan, dev, source=str(body.get("source") or "glass"), dpi=int(body.get("dpi") or 300),
                           color=body.get("color", True) is not False)
    title = str(body.get("name") or "Scan").strip() or "Scan"
    want_ocr = bool(body.get("ocr")) and ocr.status()["available"]
    into = str(body.get("into") or "")
    if into:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "scan.pdf"
            await _run(_pages_pdf, pages, raw, title)
            if want_ocr:
                done = Path(tmp) / "scan_ocr.pdf"
                await _run(ocr.run, raw, done, args={"skip_text": False})
                raw = done
            res = await _derive(into, lambda src, out: core.merge([src, raw], out, passwords=_pw(into)))
        res["scanned"] = len(pages)
        return res
    doc_id, out = docs.target(f"{title}.pdf")
    try:
        await _run(_pages_pdf, pages, out, title)
    except BaseException:
        docs.discard(doc_id)
        raise
    if want_ocr:
        res = await _derive(doc_id, ocr.run, args={"skip_text": False})
        doc_id = res["id"]
    opened = await _opened(doc_id)
    opened["scanned"] = len(pages)
    return opened
