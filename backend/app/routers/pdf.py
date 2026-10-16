import asyncio
import json
import shutil
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from app.core import config
from app.services import pdf as pdfsvc
from app.services.pdf import actions, docs

router = APIRouter()
IMMUTABLE = {"Cache-Control": "private, max-age=31536000, immutable"}
HEAVY = asyncio.Semaphore(1)


def _path(doc_id: str) -> Path:
    try:
        return docs.path_of(doc_id)
    except KeyError:
        raise HTTPException(404, "That PDF is no longer in the library") from None


def _pw(doc_id: str) -> list[str]:
    prot = docs.meta(doc_id).get("protect") or {}
    return [p for p in (prot.get("owner"), prot.get("password")) if p]


async def _run(fn, *args, **kw):
    from pypdf.errors import PdfReadError, PdfStreamError

    try:
        return await asyncio.to_thread(fn, *args, **kw)
    except HTTPException:
        raise
    except pdfsvc.Locked as e:
        raise HTTPException(409, str(e)) from None
    except docs.NotFound:
        raise HTTPException(404, "That PDF is no longer in the library") from None
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    except (PdfReadError, PdfStreamError) as e:
        raise HTTPException(422, f"This file could not be read as a PDF: {e}") from None
    except OSError as e:
        raise HTTPException(500, f"The file could not be written: {e.strerror or e}") from None
    except Exception as e:
        raise HTTPException(500, f"The PDF operation failed: {e}") from None


def _reprotect(src_id: str, new_id: str) -> None:
    prot = docs.meta(src_id).get("protect")
    if not prot:
        return
    out = docs.path_of(new_id)
    from pypdf import PdfReader

    with Path(out).open("rb") as fh:
        locked = PdfReader(fh).is_encrypted
    if locked:
        docs.update_meta(new_id, protect=prot)
        return
    tmp = out.with_suffix(".enc.tmp")
    pdfsvc.protect(out, tmp, password=prot.get("password", ""), owner=prot.get("owner"), permissions=prot.get("permissions"))
    tmp.replace(out)
    docs.update_meta(new_id, protect=prot)


async def _derive(doc_id: str, fn, *args, protect: bool = True, **kw) -> dict:
    src = _path(doc_id)
    new_id, out = docs.derive(doc_id)
    try:
        result = await _run(fn, src, out, *args, **kw)
        if protect:
            await _run(_reprotect, doc_id, new_id)
    except BaseException:
        docs.discard(new_id)
        raise
    resp = {"id": new_id, "pages": result["pages"] if isinstance(result, dict) else result, "bytes": out.stat().st_size}
    if isinstance(result, dict):
        resp.update({k: v for k, v in result.items() if k != "pages"})
    return resp


async def _opened(doc_id: str) -> dict:
    info = await _run(pdfsvc.info, _path(doc_id), _pw(doc_id))
    m = docs.meta(doc_id)
    entry = docs.remember(doc_id, info.get("pages", 0))
    return {"id": doc_id, "name": m.get("name"), "pages": info.get("pages", 0), "info": info, "key": entry["key"], "path": m.get("path")}


def _is_pdf(data: bytes) -> bool:
    return b"%PDF-" in data[:1024]


@router.post("/pdf/open")
async def open_upload(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if len(data) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"{file.filename} is larger than 1 GB")
    if not _is_pdf(data):
        raise HTTPException(415, f"{file.filename or 'That file'} is not a PDF")
    doc_id = await asyncio.to_thread(docs.put_bytes, data, file.filename or "document.pdf")
    return await _opened(doc_id)


@router.post("/pdf/open-path")
async def open_path(body: dict) -> dict:
    raw = str(body.get("path") or "").strip()
    if not raw:
        raise HTTPException(400, "Give the path of a PDF")
    path = Path(raw).expanduser()
    if not path.is_file():
        raise HTTPException(404, f"{path} does not exist")
    with open(path, "rb") as fh:
        head = fh.read(1024)
    if not _is_pdf(head):
        raise HTTPException(415, f"{path.name} is not a PDF")
    doc_id = await asyncio.to_thread(docs.put_path, path, path.name, str(path))
    return await _opened(doc_id)


@router.get("/pdf/recent")
def recent() -> dict:
    return {"items": docs.recent()}


@router.post("/pdf/recent/forget")
def forget(body: dict) -> dict:
    docs.forget(str(body.get("key") or ""))
    return {"ok": True}


@router.get("/pdf/actions")
def action_list() -> dict:
    return {"actions": actions.catalogue()}


MEDIA = {".html": "text/html; charset=utf-8", ".rtf": "application/rtf", ".csv": "text/csv; charset=utf-8", ".zip": "application/zip",
         ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
         ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


@router.get("/pdf/{doc_id}/items/under")
async def items_under(doc_id: str, page: int, id: str = "", picture: int = -1, paragraph: str = "", scale: float = 2.0) -> Response:
    from app.services.pdf import items

    target = {"id": id} if id else {"picture": picture} if picture >= 0 else {"paragraph": paragraph} if paragraph else {}
    data = await _run(items.render_without, _path(doc_id), page, target, scale, _pw(doc_id))
    return Response(data, media_type="image/png", headers=IMMUTABLE)


@router.get("/pdf/{doc_id}/attachment")
async def attachment(doc_id: str, name: str = "", page: int = 0, index: int = 0) -> Response:
    from app.services.pdf import attach

    fname, data = await _run(lambda: attach.get_file(_path(doc_id), name=name or None, page=page or None, index=index, passwords=_pw(doc_id)))
    safe = fname.replace('"', "'").encode("latin-1", "replace").decode("latin-1")
    return Response(data, media_type="application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{safe}"'})


@router.post("/pdf/{doc_id}/act/{name}")
async def act(doc_id: str, name: str, body: dict) -> Response:
    a = actions.get(name)
    if a is None or a.run is None:
        raise HTTPException(404, f"There is no action {name}")
    pages, pw = body.get("pages") or None, _pw(doc_id)
    if a.kind == "change":
        res = await _derive(doc_id, a.run, args=body, pages=pages, passwords=pw)
        return Response(json.dumps(res), media_type="application/json")
    if a.kind == "read":
        src = _path(doc_id)
        if src.stat().st_size >= pdfsvc.core.LAZY_BYTES:
            async with HEAVY:
                text, data = await _run(a.run, src, args=body, pages=pages, passwords=pw)
        else:
            text, data = await _run(a.run, src, args=body, pages=pages, passwords=pw)
        return Response(json.dumps({"text": text, **(data or {})}, default=str), media_type="application/json")
    tmp = docs.root() / f".act-{docs.new_id()}{a.ext}"
    try:
        got = await _run(a.run, _path(doc_id), tmp, args=body, pages=pages, passwords=pw)
        data = await asyncio.to_thread(tmp.read_bytes)
    finally:
        tmp.unlink(missing_ok=True)
    stem = Path(docs.meta(doc_id).get("name") or doc_id).stem
    fname = ((got or {}).get("filename") if isinstance(got, dict) else None) or stem + a.ext
    safe = fname.replace('"', "'").encode("latin-1", "replace").decode("latin-1")
    return Response(data, media_type=MEDIA.get(a.ext, "application/octet-stream"),
                    headers={"Content-Disposition": f"attachment; filename=\"{safe}\"; filename*=UTF-8''{quote(fname)}"})


@router.post("/pdf/merge")
async def merge(body: dict) -> dict:
    ids = [str(i) for i in (body.get("ids") or [])]
    if len(ids) < 2:
        raise HTTPException(400, "Choose at least two PDFs to merge")
    paths = [_path(i) for i in ids]
    new_id, out = docs.derive(ids[0])
    try:
        result = await _run(pdfsvc.merge, paths, out, [p for i in ids for p in _pw(i)])
    except BaseException:
        docs.discard(new_id)
        raise
    return {"id": new_id, "pages": result["pages"], "bytes": out.stat().st_size}


@router.post("/pdf/write")
async def write_file(file: UploadFile = File(...), name: str = Form(...), path: str = Form("")) -> dict:
    data = await file.read()
    safe = Path(str(name).replace("\\", "/")).name.strip()
    if not safe or safe.startswith("."):
        raise HTTPException(400, "Give the file a name")
    dest = Path(path).expanduser() if path.strip() else config.exports_dir() / safe
    if dest.is_dir():
        dest = dest / safe

    def save() -> int:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return len(data)

    size = await _run(save)
    return {"path": str(dest), "bytes": size}


@router.get("/pdf/{doc_id}/file")
def get_file(doc_id: str, download: int = 0):
    path = _path(doc_id)
    name = docs.meta(doc_id).get("name") or f"{doc_id}.pdf"
    return FileResponse(path, media_type="application/pdf", filename=name, content_disposition_type="attachment" if download else "inline",
                        headers=IMMUTABLE)


@router.get("/pdf/{doc_id}/info")
async def get_info(doc_id: str) -> dict:
    out = await _run(pdfsvc.info, _path(doc_id), _pw(doc_id))
    m = docs.meta(doc_id)
    out.update(id=doc_id, name=m.get("name"), key=m.get("root") or doc_id, path=m.get("path"), protected=bool(m.get("protect")),
               savePath=m.get("saved") or str(config.exports_dir() / (m.get("name") or f"{doc_id}.pdf")))
    return out


@router.get("/pdf/{doc_id}/text")
async def get_text(doc_id: str, pages: str | None = None) -> dict:
    return {"pages": await _run(pdfsvc.extract_text, _path(doc_id), pages, _pw(doc_id))}


@router.get("/pdf/{doc_id}/images")
async def get_images(doc_id: str, pages: str | None = None) -> dict:
    items = await _run(pdfsvc.extract_images, _path(doc_id), pages, _pw(doc_id), name=docs.meta(doc_id).get("name"))
    for it in items:
        it["url"] = f"/api/media/{it['id']}"
    return {"images": items}


@router.get("/pdf/{doc_id}/tables")
async def get_tables(doc_id: str, pages: str | None = None) -> dict:
    return {"tables": await _run(pdfsvc.extract_tables, _path(doc_id), pages, _pw(doc_id))}


@router.get("/pdf/{doc_id}/tables.xlsx")
async def get_tables_xlsx(doc_id: str, pages: str | None = None):
    tables = await _run(pdfsvc.extract_tables, _path(doc_id), pages, _pw(doc_id))
    data = await _run(pdfsvc.tables_xlsx, tables)
    stem = Path(docs.meta(doc_id).get("name") or doc_id).stem
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{stem}-tables.xlsx"'})


@router.get("/pdf/{doc_id}/fields")
async def get_fields(doc_id: str) -> dict:
    return {"fields": await _run(pdfsvc.read_fields, _path(doc_id), _pw(doc_id))}


@router.post("/pdf/{doc_id}/fields")
async def set_fields(doc_id: str, body: dict) -> dict:
    values = body.get("values") or {}
    if not isinstance(values, dict):
        raise HTTPException(400, "values must map field names to values")
    return await _derive(doc_id, pdfsvc.fill_fields, values, flatten=bool(body.get("flatten")), passwords=_pw(doc_id))


@router.post("/pdf/{doc_id}/annotate")
async def annotate(doc_id: str, body: dict) -> dict:
    items = body.get("annotations")
    if not isinstance(items, list):
        raise HTTPException(400, "annotations must be a list")
    author = str(body.get("author") or config.read_settings().get("author") or "")
    return await _derive(doc_id, pdfsvc.annotate, items, flatten=bool(body.get("flatten")), passwords=_pw(doc_id), author=author)


@router.post("/pdf/{doc_id}/organize")
async def organize(doc_id: str, body: dict) -> dict:
    items = body.get("pages")
    if not isinstance(items, list):
        raise HTTPException(400, "pages must be a list")
    norm = [{**i, "src": "self" if str(i.get("src") or "") in ("", doc_id) else i.get("src")} for i in items if isinstance(i, dict)]
    return await _derive(doc_id, pdfsvc.organize, norm, docs.path_of, passwords=[*_pw(doc_id), *(p for i in norm if docs.valid(str(i.get("src"))) for p in _pw(str(i["src"])))])


@router.post("/pdf/{doc_id}/split")
async def split(doc_id: str, body: dict) -> dict:
    ranges = [str(r).strip() for r in (body.get("ranges") or []) if str(r).strip()]
    if not ranges:
        raise HTTPException(400, "Give at least one page range, for example 1-3")
    src = _path(doc_id)
    tmp = docs.root() / f".split-{docs.new_id()}"
    stem = Path(docs.meta(doc_id).get("name") or "document.pdf").stem
    try:
        paths = await _run(pdfsvc.split, src, ranges, tmp, _pw(doc_id))
        parts = []
        for spec, p in zip(ranges, paths):
            new_id = docs.adopt(Path(p), f"{stem} pages {spec}.pdf", doc_id)
            await _run(_reprotect, doc_id, new_id)
            parts.append({"id": new_id, "range": spec, "name": docs.meta(new_id)["name"], "pages": await _run(pdfsvc.page_count, docs.path_of(new_id), _pw(new_id))})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"ids": [p["id"] for p in parts], "parts": parts}


@router.post("/pdf/{doc_id}/protect")
async def protect(doc_id: str, body: dict) -> dict:
    password, owner = str(body.get("password") or ""), str(body.get("owner") or "")
    perms = body.get("permissions") if isinstance(body.get("permissions"), dict) else None
    resp = await _derive(doc_id, pdfsvc.protect, protect=False, password=password, owner=owner or None, permissions=perms, passwords=_pw(doc_id))
    docs.update_meta(resp["id"], protect={"password": password, "owner": owner, "permissions": perms})
    return resp


@router.post("/pdf/{doc_id}/unlock")
async def unlock(doc_id: str, body: dict) -> dict:
    password = str(body.get("password") or "")
    known = _pw(doc_id)
    return await _derive(doc_id, pdfsvc.unlock, protect=False, password=password or (known[0] if known else ""))


@router.post("/pdf/{doc_id}/redact")
async def redact(doc_id: str, body: dict) -> dict:
    areas = body.get("areas")
    if not isinstance(areas, list):
        raise HTTPException(400, "areas must be a list")
    mode = "raster" if body.get("mode") == "raster" else "content"
    res = await _derive(doc_id, pdfsvc.redact, areas, passwords=_pw(doc_id), mode=mode, color=str(body.get("color") or "#000000"),
                        overlay=str(body.get("overlay") or "")[:120])
    # Kept with the new version so the log survives a restart, without the removed words: a copy of them on disk would undo the point.
    kept = [{"page": e.get("page"), "kind": e.get("kind"), "box": e.get("box"), "chars": len(str(e.get("text") or ""))} for e in res.get("log") or []]
    await asyncio.to_thread(docs.keep_redaction, res["id"], {"before": doc_id, "entries": kept, "more": int(res.get("logMore") or 0)})
    return res


@router.get("/pdf/{doc_id}/redaction-log")
async def redaction_log(doc_id: str) -> dict:
    _path(doc_id)
    return await asyncio.to_thread(docs.redaction, doc_id) or {"before": "", "entries": [], "more": 0, "none": True}


@router.post("/pdf/{doc_id}/metadata")
async def set_metadata(doc_id: str, body: dict) -> dict:
    fields = {k: body.get(k) for k in ("title", "author", "subject", "keywords")}
    return await _derive(doc_id, pdfsvc.metadata, strip=bool(body.get("strip")), passwords=_pw(doc_id), **fields)


@router.post("/pdf/{doc_id}/compress")
async def compress(doc_id: str, body: dict) -> dict:
    try:
        quality = int(body.get("quality") or 70)
    except (TypeError, ValueError):
        raise HTTPException(400, "quality must be a number from 10 to 95") from None
    return await _derive(doc_id, pdfsvc.compress, quality=quality, passwords=_pw(doc_id))


@router.post("/pdf/{doc_id}/page-numbers")
async def page_numbers(doc_id: str, body: dict) -> dict:
    try:
        start = int(body.get("start") or 1)
        size = float(body.get("size") or 10)
    except (TypeError, ValueError):
        raise HTTPException(400, "start and size must be numbers") from None
    return await _derive(doc_id, pdfsvc.page_numbers, position=str(body.get("position") or "bottom-center"), start=start,
                         fmt=str(body.get("format") or "{n}"), size=size, color=str(body.get("color") or "#333333"), pages=body.get("pages") or None,
                         passwords=_pw(doc_id))


@router.post("/pdf/{doc_id}/watermark")
async def watermark(doc_id: str, body: dict) -> dict:
    try:
        opacity, angle, size = float(body.get("opacity", 0.15)), float(body.get("angle", 45)), float(body.get("size", 64))
    except (TypeError, ValueError):
        raise HTTPException(400, "opacity, angle and size must be numbers") from None
    return await _derive(doc_id, pdfsvc.watermark, text=str(body.get("text") or ""), opacity=opacity, angle=angle, size=size,
                         color=str(body.get("color") or "#888888"), pages=body.get("pages") or None, passwords=_pw(doc_id))


@router.post("/pdf/{doc_id}/header-footer")
async def header_footer(doc_id: str, body: dict) -> dict:
    name = docs.meta(doc_id).get("name")
    return await _derive(doc_id, pdfsvc.header_footer, header=body.get("header"), footer=body.get("footer"), size=body.get("size"),
                         color=str(body.get("color") or "#333333"), font=str(body.get("font") or "sans"), margins=body.get("margins"),
                         pages=body.get("pages") or None, start=body.get("start"), apply=str(body.get("apply") or "all"),
                         bates=body.get("bates") or None, date=body.get("date") or None, file=name, passwords=_pw(doc_id))


@router.post("/pdf/{doc_id}/crop")
async def crop(doc_id: str, body: dict) -> dict:
    box, margins = body.get("box"), body.get("margins")
    if box is not None and not isinstance(box, dict):
        raise HTTPException(400, "box must be {x, y, w, h} in points from the top left of the page")
    if margins is not None and not isinstance(margins, (dict, int, float)):
        raise HTTPException(400, "margins must be {l, t, r, b} in points")
    return await _derive(doc_id, pdfsvc.crop, box=box, margins=margins, auto=bool(body.get("auto")), pad=body.get("pad"),
                         pages=body.get("pages") or None, passwords=_pw(doc_id))


@router.post("/pdf/{doc_id}/find")
async def find(doc_id: str, body: dict) -> dict:
    preset = body.get("preset") or None
    return await _run(pdfsvc.find, _path(doc_id), None if preset else str(body.get("query") or ""), regex=bool(body.get("regex")),
                      preset=preset, case_sensitive=bool(body.get("caseSensitive")), whole_word=bool(body.get("wholeWord")),
                      pages=body.get("pages") or None, passwords=_pw(doc_id))


@router.get("/pdf/{doc_id}/comments")
async def get_comments(doc_id: str) -> dict:
    return {"comments": await _run(pdfsvc.comments, _path(doc_id), _pw(doc_id))}


@router.get("/pdf/{doc_id}/render/{page}")
async def render(doc_id: str, page: int, scale: float = 2.0, fmt: str = "png"):
    jpg = fmt == "jpg"
    data = await _run(pdfsvc.render_png, _path(doc_id), page, scale, _pw(doc_id), "jpg" if jpg else "png")
    return Response(data, media_type="image/jpeg" if jpg else "image/png", headers=IMMUTABLE)


@router.get("/pdf/{doc_id}/pages.zip")
async def pages_zip(doc_id: str, scale: float = 2.0, pages: str | None = None):
    data = await _run(pdfsvc.pages_zip, _path(doc_id), scale, pages, _pw(doc_id))
    stem = Path(docs.meta(doc_id).get("name") or doc_id).stem
    return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{stem}-pages.zip"'})


@router.get("/pdf/{doc_id}/pptx")
async def to_pptx(doc_id: str, pages: str | None = None, text: int = 1, dpi: float = 150):
    src = _path(doc_id)
    tmp = docs.root() / f".pptx-{docs.new_id()}.pptx"
    try:
        got = await _run(pdfsvc.to_pptx, src, tmp, pages=pages, passwords=_pw(doc_id), dpi=max(72.0, min(300.0, dpi)), text=bool(text))
        data = await asyncio.to_thread(tmp.read_bytes)
    finally:
        tmp.unlink(missing_ok=True)
    stem = Path(docs.meta(doc_id).get("name") or doc_id).stem
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    headers={"Content-Disposition": f'attachment; filename="{stem}.pptx"', "X-Slides": str(got["slides"]),
                             "X-Text-Boxes": str(got["textboxes"])})


@router.get("/pdf/{doc_id}/sheet")
async def sheet(doc_id: str, pages: str | None = None, width: int = 1600):
    data, _ = await _run(pdfsvc.contact_sheet, _path(doc_id), pages, _pw(doc_id), max(400, min(3200, width)))
    return Response(data, media_type="image/png")


@router.get("/pdf/{doc_id}/reflow")
async def reflow(doc_id: str, pages: str | None = None) -> dict:
    return await _run(pdfsvc.reflow, _path(doc_id), pages, _pw(doc_id))


@router.get("/pdf/{doc_id}/docx")
async def to_docx(doc_id: str, pages: str | None = None):
    src = _path(doc_id)
    tmp = docs.root() / f".docx-{docs.new_id()}.docx"
    try:
        await _run(pdfsvc.to_docx, src, tmp, pages=pages, passwords=_pw(doc_id))
        data = await asyncio.to_thread(tmp.read_bytes)
    finally:
        tmp.unlink(missing_ok=True)
    stem = Path(docs.meta(doc_id).get("name") or doc_id).stem
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"Content-Disposition": f'attachment; filename="{stem}.docx"'})


@router.post("/pdf/create")
async def create(files: list[UploadFile] = File(...), page: str = Form("fit"), margin: float = Form(0), orientation: str = Form("auto"),
                 name: str = Form("")) -> dict:
    items: list[tuple[str, bytes]] = []
    total = 0
    for k, f in enumerate(files):
        data = await f.read()
        total += len(data)
        if total > config.MAX_UPLOAD_BYTES:
            raise HTTPException(413, "The files add up to more than 1 GB")
        items.append((f.filename or f"file{k + 1}", data))
    if not items:
        raise HTTPException(400, "Add at least one PDF, picture or Office file")
    title = Path(name.strip() or items[0][0]).stem or "Combined"
    doc_id, out = docs.target(f"{title}.pdf")
    try:
        await _run(pdfsvc.from_files, items, out, page=page, margin=margin, orientation=orientation, title=title)
    except BaseException:
        docs.discard(doc_id)
        raise
    return await _opened(doc_id)


@router.get("/pdf/{doc_id}/hidden")
async def hidden(doc_id: str) -> dict:
    return {"items": await _run(pdfsvc.scan_hidden, _path(doc_id), _pw(doc_id))}


@router.post("/pdf/{doc_id}/sanitize")
async def sanitize(doc_id: str, body: dict) -> dict:
    remove = body.get("remove")
    if not isinstance(remove, list):
        raise HTTPException(400, "remove must list what to remove")
    return await _derive(doc_id, pdfsvc.sanitize, remove=[str(r) for r in remove], passwords=_pw(doc_id))


@router.post("/pdf/{doc_id}/form")
async def prepare_form(doc_id: str, body: dict) -> dict:
    create, rename, delete = body.get("create") or [], body.get("rename") or {}, body.get("delete") or []
    if not isinstance(create, list) or not isinstance(rename, dict) or not isinstance(delete, list):
        raise HTTPException(400, "create is a list of fields, rename maps old names to new ones and delete lists names")
    return await _derive(doc_id, pdfsvc.prepare_form, create=create, rename=rename, delete=delete, passwords=_pw(doc_id))


@router.post("/pdf/{doc_id}/compare")
async def compare(doc_id: str, body: dict) -> dict:
    other = str(body.get("other") or "")
    return await _run(pdfsvc.compare, _path(doc_id), _path(other), passwords=_pw(doc_id), other_passwords=_pw(other),
                      other_is_newer=bool(body.get("otherIsNewer")), pictures=bool(body.get("pictures")))


@router.post("/pdf/{doc_id}/save")
async def save(doc_id: str, body: dict) -> dict:
    src = _path(doc_id)
    raw = str(body.get("path") or "").strip()
    m = docs.meta(doc_id)
    dest = Path(raw).expanduser() if raw else config.exports_dir() / (m.get("name") or f"{doc_id}.pdf")
    if dest.is_dir():
        dest = dest / (m.get("name") or f"{doc_id}.pdf")
    if dest.suffix.lower() != ".pdf":
        dest = dest.with_name(dest.name + ".pdf")
    if not dest.is_absolute():
        raise HTTPException(400, "Give a full path, for example ~/Documents/report.pdf")

    def copy() -> int:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.tmp")
        shutil.copyfile(src, tmp)
        tmp.replace(dest)
        return dest.stat().st_size

    size = await _run(copy)
    docs.update_meta(doc_id, saved=str(dest))
    return {"path": str(dest), "bytes": size}
