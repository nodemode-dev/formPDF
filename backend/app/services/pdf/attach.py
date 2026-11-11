import base64
import mimetypes
import re
import time
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject, StreamObject,
                           TextStringObject)

from app.core import config

from . import actions, core, frame

MAX_BYTES = 200 * 1024 * 1024
PIN = 20.0


def _pairs(node, depth: int = 0) -> list[tuple[str, object]]:
    node = node.get_object() if hasattr(node, "get_object") else node
    if node is None or depth > 16:
        return []
    out: list[tuple[str, object]] = []
    names = node.get("/Names")
    if names is not None:
        arr = names.get_object()
        for i in range(0, len(arr) - 1, 2):
            out.append((str(arr[i]), arr[i + 1]))
    for kid in node.get("/Kids") or []:
        out += _pairs(kid, depth + 1)
    return out


def _tree(root) -> list[tuple[str, object]]:
    names = root.get("/Names")
    names = names.get_object() if names is not None else None
    ef = names.get("/EmbeddedFiles") if names is not None else None
    return _pairs(ef) if ef is not None else []


def _stream(spec) -> object | None:
    spec = spec.get_object() if hasattr(spec, "get_object") else spec
    if not isinstance(spec, DictionaryObject):
        return None
    ef = spec.get("/EF")
    ef = ef.get_object() if ef is not None else None
    if ef is None:
        return None
    s = ef.get("/UF") or ef.get("/F")
    return s.get_object() if s is not None else None


def _info(name: str, spec) -> dict:
    spec = spec.get_object() if hasattr(spec, "get_object") else spec
    s = _stream(spec)
    size = None
    if s is not None:
        params = s.get("/Params")
        params = params.get_object() if params is not None else {}
        size = params.get("/Size")
        if size is None:
            try:
                size = len(s.get_data())
            except Exception:
                size = None
    desc = str(spec.get("/Desc", "")) if isinstance(spec, DictionaryObject) else ""
    return {"name": name, "bytes": int(size) if size is not None else None, "description": desc}


def _pins(r) -> list[dict]:
    out = []
    for pi, page in enumerate(r.pages):
        k = 0
        for ref in page.get("/Annots") or []:
            a = ref.get_object()
            if a.get("/Subtype") != "/FileAttachment":
                continue
            fs = a.get("/FS")
            fs = fs.get_object() if fs is not None else DictionaryObject()
            name = str(fs.get("/UF") or fs.get("/F") or "attachment") if isinstance(fs, DictionaryObject) else "attachment"
            item = {"page": pi + 1, "index": k, **_info(name, fs), **(frame.from_pdf(page, a["/Rect"]) if "/Rect" in a else {})}
            if a.get("/Contents"):
                item["description"] = str(a["/Contents"])
            out.append(item)
            k += 1
    return out


def listing(path, passwords: list[str] | None = None) -> dict:
    r = core.reader(path, passwords)
    return {"files": [_info(n, s) for n, s in _tree(r.trailer["/Root"])], "pins": _pins(r)}


def get_file(path, *, name: str | None = None, page: int | None = None, index: int | None = None, passwords: list[str] | None = None) -> tuple[str, bytes]:
    r = core.reader(path, passwords)
    if page:
        for pin in _pins(r):
            if pin["page"] == page and pin["index"] == index:
                ref = [a for a in (r.pages[page - 1].get("/Annots") or []) if a.get_object().get("/Subtype") == "/FileAttachment"][index]
                s = _stream(ref.get_object().get("/FS"))
                if s is None:
                    break
                return pin["name"], s.get_data()
        raise ValueError(f"There is no file pinned as number {index} on page {page}")
    for n, spec in _tree(r.trailer["/Root"]):
        if n == name:
            s = _stream(spec)
            if s is None:
                break
            return n, s.get_data()
    raise ValueError(f"There is no attached file called {name}")


def _clean(name: str) -> str:
    base = Path(str(name or "").replace("\\", "/")).name.strip()
    base = re.sub(r"[\x00-\x1f]", "", base)
    if not base:
        raise ValueError("Each attached file needs a name")
    return base[:200]


def _filespec(w: PdfWriter, name: str, data: bytes, desc: str):
    s = DecodedStreamObject()
    s.set_data(data)
    s = s.flate_encode()
    mime = mimetypes.guess_type(name)[0]
    s[NameObject("/Type")] = NameObject("/EmbeddedFile")
    if mime:
        s[NameObject("/Subtype")] = NameObject("/" + mime.replace("/", "#2F"))
    stamp = time.strftime("D:%Y%m%d%H%M%S")
    s[NameObject("/Params")] = DictionaryObject({NameObject("/Size"): NumberObject(len(data)), NameObject("/ModDate"): TextStringObject(stamp)})
    ref = w._add_object(s)
    spec = DictionaryObject({NameObject("/Type"): NameObject("/Filespec"), NameObject("/F"): TextStringObject(name), NameObject("/UF"): TextStringObject(name),
                             NameObject("/EF"): DictionaryObject({NameObject("/F"): ref, NameObject("/UF"): ref})})
    if desc:
        spec[NameObject("/Desc")] = TextStringObject(desc)
    return w._add_object(spec)


def _unique(name: str, taken: set[str]) -> str:
    if name not in taken:
        return name
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    n = 2
    while True:
        cand = f"{stem} ({n}){'.' + ext if ext else ''}"
        if cand not in taken:
            return cand
        n += 1


def _pin_ap(w: PdfWriter, color: tuple[float, float, float]):
    ops = (f"q 1 1 1 rg {color[0]:.3f} {color[1]:.3f} {color[2]:.3f} RG 1 w 0.5 0.5 19 19 re B "
           f"1.4 w 7 5 m 7 14 l 7 16.5 9 18 10.5 18 c 12 18 14 16.5 14 14 c 14 7 l 14 5.2 12.8 4 11.2 4 c 9.6 4 8.4 5.2 8.4 7 c 8.4 13 l S Q")
    ap = DecodedStreamObject()
    ap.set_data(ops.encode())
    ap.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"),
               NameObject("/BBox"): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(PIN), FloatObject(PIN)])})
    return w._add_object(ap)


def _data(item: dict) -> bytes:
    raw = item.get("data")
    if raw is None and item.get("path"):
        p = Path(str(item["path"])).expanduser()
        if not p.is_file():
            raise ValueError(f"{p} does not exist")
        if p.stat().st_size > MAX_BYTES:
            raise ValueError(f"{p.name} is larger than 200 MB")
        return p.read_bytes()
    if not isinstance(raw, str):
        raise ValueError("Each file needs data (base64) or a path")
    data = base64.b64decode(raw.split(",", 1)[1] if raw.startswith("data:") else raw, validate=False)
    if len(data) > MAX_BYTES:
        raise ValueError("Attach files of at most 200 MB")
    return data


def change(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    r = core.reader(src, passwords)
    w = PdfWriter(clone_from=r)
    n = len(w.pages)
    root = w._root_object
    current = _tree(root)
    remove = {str(x) for x in args.get("remove") or []}
    missing = remove - {nm for nm, _ in current}
    if missing:
        raise ValueError(f"There is no attached file called {sorted(missing)[0]}")
    kept = [(nm, spec) for nm, spec in current if nm not in remove]
    taken = {nm for nm, _ in kept}
    added = pinned = 0
    for item in args.get("add") or []:
        if not isinstance(item, dict):
            continue
        name = _clean(item.get("name") or (Path(str(item.get("path") or "")).name))
        data = _data(item)
        desc = str(item.get("description") or "")[:500]
        if item.get("page"):
            p = int(item["page"])
            if not 1 <= p <= n:
                raise ValueError(f"Page {p} is out of range (1 to {n})")
            x, y = float(item.get("x") or 36), float(item.get("y") or 36)
            page = w.pages[p - 1]
            rect = frame.to_pdf(page, x, y, PIN, PIN)
            annot = DictionaryObject({
                NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/FileAttachment"),
                NameObject("/Rect"): ArrayObject([FloatObject(v) for v in rect]), NameObject("/FS"): _filespec(w, name, data, desc),
                NameObject("/Contents"): TextStringObject(desc or name), NameObject("/Name"): NameObject("/Paperclip"),
                NameObject("/F"): NumberObject(4), NameObject("/C"): ArrayObject([FloatObject(0.15), FloatObject(0.39), FloatObject(0.92)]),
                NameObject("/T"): TextStringObject(str(args.get("author") or "")),
                NameObject("/AP"): DictionaryObject({NameObject("/N"): _pin_ap(w, (0.15, 0.39, 0.92))})})
            ref = w._add_object(annot)
            if "/Annots" in page:
                page["/Annots"].get_object().append(ref)
            else:
                page[NameObject("/Annots")] = ArrayObject([ref])
            pinned += 1
            continue
        name = _unique(name, taken)
        taken.add(name)
        kept.append((name, _filespec(w, name, data, desc)))
        added += 1
    unpin = {(int(x["page"]), int(x["index"])) for x in args.get("unpin") or [] if isinstance(x, dict)}
    unpinned = 0
    for pi, page in enumerate(w.pages):
        if not unpin or "/Annots" not in page:
            continue
        keep, k = ArrayObject(), 0
        for ref in page["/Annots"].get_object():
            if ref.get_object().get("/Subtype") == "/FileAttachment":
                if (pi + 1, k) in unpin:
                    unpinned += 1
                    k += 1
                    continue
                k += 1
            keep.append(ref)
        page[NameObject("/Annots")] = keep
    if not (added or pinned or remove or unpinned):
        raise ValueError("Choose files to attach, or attachments to remove")
    if added or remove:
        names = root.get("/Names")
        names = names.get_object() if names is not None else None
        if names is None:
            names = DictionaryObject()
            root[NameObject("/Names")] = w._add_object(names)
        if kept:
            arr = ArrayObject()
            for nm, spec in sorted(kept, key=lambda x: x[0]):
                arr += [TextStringObject(nm), spec]
            names[NameObject("/EmbeddedFiles")] = DictionaryObject({NameObject("/Names"): arr})
        elif "/EmbeddedFiles" in names:
            del names["/EmbeddedFiles"]
    with open(out, "wb") as f:
        w.write(f)
    return {"pages": n, "added": added + pinned, "deleted": len(remove) + unpinned}


def read(path, *, args: dict, pages=None, passwords: list[str] | None = None):
    got = listing(path, passwords)
    if args.get("save"):
        name, data = get_file(path, name=str(args["save"]), passwords=passwords)
        safe = _clean(name)
        if safe in (".", ".."):
            raise ValueError(f"The attached file name {name} cannot be saved as a file")
        dest = Path(str(args["out"])).expanduser() if args.get("out") else config.exports_dir() / safe
        if dest.is_dir():
            dest = dest / safe
        dest.write_bytes(data)
        return f"Saved {name} to {dest} ({len(data)} bytes).", {"path": str(dest), **got}
    lines = [f"{f['name']} · {f['bytes'] if f['bytes'] is not None else '?'} bytes{' · ' + f['description'] if f['description'] else ''}" for f in got["files"]]
    lines += [f"p{p['page']} pin #{p['index']} · {p['name']}{' · ' + p['description'] if p.get('description') else ''}" for p in got["pins"]]
    return ("\n".join(lines) or "No attached files."), got


actions.register(actions.Action("attachments", "read", "List attached files", words=("attachments", "embedded files", "portfolio"), run=read))
actions.register(actions.Action("edit_attachments", "change", "Attach or remove files", "attached", ("attach", "attach file", "embed file", "paperclip"),
                                run=change))
