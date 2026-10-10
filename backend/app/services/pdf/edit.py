import datetime
import io
import re
from pathlib import Path

from pypdf import PageObject, PdfReader, PdfWriter, Transformation
from pypdf.constants import UserAccessPermissions as P
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, RectangleObject
from reportlab.pdfgen import canvas as rlcanvas

from . import annot, core

INHERITED = ("/Resources", "/MediaBox", "/CropBox", "/Rotate")
PERMS = {"print": P.PRINT | P.PRINT_TO_REPRESENTATION, "copy": P.EXTRACT, "modify": P.MODIFY, "annotate": P.ADD_OR_MODIFY,
         "fill": P.FILL_FORM_FIELDS, "assemble": P.ASSEMBLE_DOC}
POSITIONS = ("bottom-center", "bottom-right", "bottom-left", "top-center", "top-right", "top-left")
SLOTS = ("left", "center", "right")
APPLY = ("all", "odd", "even")
FACES = {"sans": "Helvetica", "serif": "Times-Roman", "mono": "Courier"}
TOKEN = re.compile(r"<<\s*(page|pages|date|file|bates)\s*>>", re.IGNORECASE)
MIN_CROP = 18.0


def _write(w: PdfWriter, out) -> int:
    with open(out, "wb") as fh:
        w.write(fh)
    return len(w.pages)


def _materialize(page) -> None:
    for key in INHERITED:
        if key in page:
            continue
        node = page.get("/Parent")
        while node is not None:
            node = node.get_object()
            if key in node:
                page[NameObject(key)] = node[key]
                break
            node = node.get("/Parent")


def _idnum(ref) -> int | None:
    return getattr(ref, "idnum", None)


def _dest_page(dest) -> int | None:
    dest = dest.get_object() if hasattr(dest, "get_object") else dest
    if isinstance(dest, DictionaryObject):
        dest = dest.get("/D")
        dest = dest.get_object() if hasattr(dest, "get_object") else dest
    if isinstance(dest, ArrayObject) and dest:
        return _idnum(dest[0])
    return None


def _scrub(w: PdfWriter, removed: set[int]) -> None:
    if not removed:
        return
    root = w._root_object
    seen: set[int] = set()

    def prune(parent) -> int:
        kept = []
        ref = parent.get("/First")
        while ref is not None and _idnum(ref) not in seen:
            seen.add(_idnum(ref))
            item = ref.get_object()
            nxt = item.get("/Next")
            prune(item)
            dead = False
            for key in ("/Dest", "/A"):
                target = item.get(key)
                if target is None:
                    continue
                if key == "/A":
                    a = target.get_object()
                    if a.get("/S") != "/GoTo":
                        continue
                    target = a.get("/D")
                if _dest_page(target) in removed:
                    del item[key]
                    dead = True
            if not dead or "/First" in item:
                kept.append(ref)
            ref = nxt
        for i, ref in enumerate(kept):
            item = ref.get_object()
            for key, other in (("/Prev", kept[i - 1] if i > 0 else None), ("/Next", kept[i + 1] if i + 1 < len(kept) else None)):
                if other is None:
                    if key in item:
                        del item[key]
                else:
                    item[NameObject(key)] = other
        for key in ("/First", "/Last", "/Count"):
            if key in parent:
                del parent[key]
        if kept:
            parent[NameObject("/First")] = kept[0]
            parent[NameObject("/Last")] = kept[-1]
            parent[NameObject("/Count")] = NumberObject(len(kept))
        return len(kept)

    outlines = root.get("/Outlines")
    if outlines is not None and not prune(outlines.get_object()):
        del root["/Outlines"]
    names = root.get("/Names")
    dests = names.get_object().get("/Dests") if names is not None else None
    stack = [dests] if dests is not None else []
    while stack:
        node = stack.pop().get_object()
        arr = node.get("/Names")
        if arr is not None:
            arr = arr.get_object()
            keep = ArrayObject()
            for i in range(0, len(arr) - 1, 2):
                if _dest_page(arr[i + 1]) not in removed:
                    keep.extend([arr[i], arr[i + 1]])
            node[NameObject("/Names")] = keep
        stack.extend(node.get("/Kids") or [])


def _widgets(pages) -> set[int]:
    found: set[int] = set()
    for page in pages:
        for ref in page.get("/Annots") or []:
            if ref.get_object().get("/Subtype") == "/Widget" and _idnum(ref) is not None:
                found.add(_idnum(ref))
    return found


def _scrub_fields(w: PdfWriter, widgets: set[int]) -> None:
    form = w._root_object.get("/AcroForm")
    if form is None or not widgets:
        return
    form = form.get_object()

    def live(ref) -> bool:
        f = ref.get_object()
        if "/Kids" in f:
            kids = ArrayObject([k for k in f["/Kids"] if live(k)])
            f[NameObject("/Kids")] = kids
            return len(kids) > 0
        return _idnum(ref) not in widgets

    if "/Fields" in form:
        form[NameObject("/Fields")] = ArrayObject([f for f in form["/Fields"] if live(f)])


def _duplicate(w: PdfWriter, page) -> PageObject:
    copy = PageObject(w)
    for key, value in page.items():
        if key not in ("/Annots", "/Parent"):
            copy[NameObject(key)] = value
    w._add_object(copy)
    return copy


def organize(src, out, items: list[dict], resolve, *, passwords: list[str] | None = None) -> int:
    if not items:
        raise ValueError("A document needs at least one page")
    if len(items) > 20000:
        raise ValueError("Too many pages")
    main = core.reader(src, passwords)
    w = PdfWriter(clone_from=main)
    original = [p.indirect_reference for p in w.pages]
    for p in w.pages:
        _materialize(p)
    readers: dict[str, PdfReader] = {}
    used: set[int] = set()
    refs = []
    last = (612.0, 792.0)
    for item in items:
        if item.get("blank"):
            bw = float(item.get("w") or last[0])
            bh = float(item.get("h") or last[1])
            if not (36 <= bw <= 14400 and 36 <= bh <= 14400):
                raise ValueError("A blank page must be between 36 and 14400 points on each side")
            page = w.add_blank_page(bw, bh)
        else:
            src_id = str(item.get("src") or "")
            try:
                n = int(item.get("page"))
            except (TypeError, ValueError):
                raise ValueError("Every page needs a page number") from None
            if src_id in ("", "self"):
                if not 1 <= n <= len(original):
                    raise ValueError(f"Page {n} is out of range (1 to {len(original)})")
                page = original[n - 1].get_object()
            else:
                if src_id not in readers:
                    readers[src_id] = core.reader(resolve(src_id), passwords)
                r = readers[src_id]
                if not 1 <= n <= len(r.pages):
                    raise ValueError(f"Page {n} of the inserted PDF is out of range (1 to {len(r.pages)})")
                page = w.add_page(r.pages[n - 1])
                _materialize(page)
            if _idnum(page.indirect_reference) in used:
                page = _duplicate(w, page)
        rot = int(item.get("rotate") or 0)
        if rot % 90:
            raise ValueError("Rotation must be a multiple of 90 degrees")
        if rot % 360:
            page.rotate(rot % 360)
        ref = page.indirect_reference
        used.add(_idnum(ref))
        refs.append(ref)
        x0, y0, x1, y1 = core.view_box(page)
        last = (x1 - x0, y1 - y0)
    pages_root = w._root_object["/Pages"].get_object()
    for ref in refs:
        ref.get_object()[NameObject("/Parent")] = pages_root.indirect_reference
    pages_root[NameObject("/Kids")] = ArrayObject(refs)
    pages_root[NameObject("/Count")] = NumberObject(len(refs))
    w.flattened_pages = None
    removed = {_idnum(r) for r in original} - used
    _scrub(w, removed)
    _scrub_fields(w, _widgets(r.get_object() for r in original if _idnum(r) in removed))
    try:
        w.compress_identical_objects(remove_identicals=False, remove_orphans=True)
    except Exception:
        pass
    return _write(w, out)


def _name(field) -> str:
    parts = []
    node = field
    while node is not None:
        node = node.get_object()
        if "/T" in node:
            parts.append(str(node["/T"]))
        node = node.get("/Parent")
    return ".".join(reversed(parts))


def _inherit(field, key):
    node = field
    while node is not None:
        node = node.get_object()
        if key in node:
            return node[key]
        node = node.get("/Parent")
    return None


def _plain(v) -> str:
    if v is None:
        return ""
    s = str(v.get_object() if hasattr(v, "get_object") else v)
    return s[1:] if s.startswith("/") else s


def read_fields(path, passwords: list[str] | None = None) -> list[dict]:
    r = core.reader(path, passwords)
    out = []
    for pi, page in enumerate(r.pages):
        x0, y0, x1, y1 = core.view_box(page)
        for ref in page.get("/Annots") or []:
            a = ref.get_object()
            if a.get("/Subtype") != "/Widget":
                continue
            ft = _inherit(a, "/FT")
            ff = int(_inherit(a, "/Ff") or 0)
            if ft == "/Btn":
                kind = "button" if ff & (1 << 16) else "radio" if ff & (1 << 15) else "checkbox"
            elif ft == "/Tx":
                kind = "text"
            elif ft == "/Ch":
                kind = "choice"
            elif ft == "/Sig":
                kind = "signature"
            else:
                continue
            rx0, ry0, rx1, ry1 = (float(v) for v in a.get("/Rect", [0, 0, 0, 0]))
            rx0, rx1 = sorted((rx0, rx1))
            ry0, ry1 = sorted((ry0, ry1))
            item = {"name": _name(a), "type": kind, "page": pi + 1, "x": round(rx0 - x0, 2), "y": round(y1 - ry1, 2),
                    "w": round(rx1 - rx0, 2), "h": round(ry1 - ry0, 2), "value": _plain(_inherit(a, "/V")),
                    "readonly": bool(ff & 1), "required": bool(ff & 2), "multiline": kind == "text" and bool(ff & (1 << 12))}
            if kind in ("checkbox", "radio"):
                normal = (a["/AP"].get_object().get("/N") if "/AP" in a else None) or {}
                normal = normal.get_object() if hasattr(normal, "get_object") else normal
                states = [_plain(k) for k in normal.keys() if str(k) != "/Off"] if isinstance(normal, dict) else []
                item["on"] = states[0] if states else "Yes"
            if kind == "choice":
                opts = []
                for o in _inherit(a, "/Opt") or []:
                    o = o.get_object() if hasattr(o, "get_object") else o
                    opts.append(str(o[0]) if isinstance(o, list) else str(o))
                item["options"] = opts
            maxlen = _inherit(a, "/MaxLen")
            if maxlen is not None:
                item["maxLen"] = int(maxlen)
            tip = _inherit(a, "/TU")
            if tip is not None:
                item["tooltip"] = _plain(tip)
            if kind == "text":
                try:
                    js = str((_inherit(a, "/AA") or {}).get("/F", {}).get_object().get("/JS") or "")
                except Exception:
                    js = ""
                m = re.search(r'AFDate_FormatEx\("([^"]{1,40})"\)', js)
                if m:
                    item["format"] = m.group(1)
            out.append(item)
    return out


def fill_fields(src, out, values: dict, *, flatten: bool = False, passwords: list[str] | None = None) -> int:
    r = core.reader(src, passwords)
    if "/AcroForm" not in r.trailer["/Root"]:
        raise ValueError("This PDF has no form fields")
    known = {f["name"]: f for f in read_fields(src, passwords)}
    mapped: dict[str, str] = {}
    for name, value in (values or {}).items():
        f = known.get(name)
        if f is None or f["readonly"] or f["type"] in ("button", "signature"):
            continue
        if f["type"] in ("checkbox", "radio"):
            v = str(value or "")
            mapped[name] = "/Off" if v in ("", "Off", "false", "False") else "/" + v.lstrip("/")
        else:
            mapped[name] = str(value if value is not None else "")
    current: dict[str, str] = {}
    for name, f in known.items():
        if f["type"] in ("checkbox", "radio"):
            current[name] = "/" + f["value"] if f["value"] and f["value"] != "Off" else "/Off"
        elif f["type"] not in ("button", "signature"):
            current[name] = f["value"]
    target = {**current, **mapped} if flatten else mapped
    w = PdfWriter(clone_from=r)
    if target:
        w.update_page_form_field_values(None, target, auto_regenerate=True, flatten=flatten)
    for page in w.pages:
        for ref in page.get("/Annots") or []:
            a = ref.get_object()
            node = a if "/T" in a else a.get("/Parent")
            node = node.get_object() if node is not None else None
            v = node.get("/V") if node is not None else None
            if node is not None and _inherit(node, "/FT") == "/Btn" and isinstance(v, str) and str(v).startswith("/"):
                node[NameObject("/V")] = NameObject(str(v))
    if flatten:
        w.remove_annotations(subtypes="/Widget")
        if "/AcroForm" in w._root_object:
            del w._root_object["/AcroForm"]
    return _write(w, out)


def protect(src, out, *, password: str, owner: str | None = None, permissions: dict | None = None, passwords: list[str] | None = None) -> int:
    password = password or ""
    owner = owner or ""
    if not password and not owner:
        raise ValueError("Set a password to open the file, or an owner password to restrict it")
    if len(password) > 127 or len(owner) > 127:
        raise ValueError("Passwords can be at most 127 characters")
    flags = P(0xFFFFFFFC)
    for key, bits in PERMS.items():
        if permissions is not None and permissions.get(key) is False:
            flags &= ~bits
    w = PdfWriter(clone_from=core.reader(src, passwords))
    w.encrypt(user_password=password, owner_password=owner or password, permissions_flag=flags, algorithm="AES-256")
    return _write(w, out)


def unlock(src, out, *, password: str) -> int:
    r = PdfReader(str(src))
    if r.is_encrypted:
        ok = False
        for pw in (password or "", ""):
            try:
                if r.decrypt(pw):
                    ok = True
                    break
            except Exception:
                continue
        if not ok:
            raise ValueError("That password is not right for this PDF")
    return _write(PdfWriter(clone_from=r), out)


@core.serial
def redact(src, out, areas: list[dict], *, passwords: list[str] | None = None, dpi: int = 200) -> int:
    import pypdfium2 as pdfium
    from PIL import ImageDraw

    r = core.reader(src, passwords)
    w = PdfWriter(clone_from=r)
    n = len(w.pages)
    by_page: dict[int, list[tuple[float, float, float, float]]] = {}
    for a in areas or []:
        try:
            p = int(a["page"])
            box = annot._rect(a)
        except (KeyError, TypeError, ValueError):
            raise ValueError("Each redaction needs a page and a box") from None
        if not 1 <= p <= n:
            raise ValueError(f"Page {p} is out of range (1 to {n})")
        if box[2] >= 0.5 and box[3] >= 0.5:
            by_page.setdefault(p, []).append(box)
    if not by_page:
        raise ValueError("Mark at least one area to redact")
    doc = core.pdfium_doc(src, passwords)
    removed_widgets: set[int] = set()
    try:
        try:
            doc.init_forms()
        except Exception:
            pass
        scale = dpi / 72
        for p, boxes in by_page.items():
            page = w.pages[p - 1]
            x0, y0, x1, y1 = core.view_box(page)
            W, H = x1 - x0, y1 - y0
            rot = core.rotation(page)
            pg = doc[p - 1]
            pil = core.render_pil(pg, scale).convert("RGB")
            pg.close()
            dw, dh = pil.size
            sx, sy = dw / (H if rot % 180 else W), dh / (W if rot % 180 else H)
            draw = ImageDraw.Draw(pil)
            for bx, by, bw, bh in boxes:
                pts = []
                for px, py in ((bx, by), (bx + bw, by + bh)):
                    if rot == 90:
                        px, py = H - py, px
                    elif rot == 180:
                        px, py = W - px, H - py
                    elif rot == 270:
                        px, py = py, W - px
                    pts.append((px, py))
                (ax, ay), (bx2, by2) = pts
                draw.rectangle([min(ax, bx2) * sx - 1, min(ay, by2) * sy - 1, max(ax, bx2) * sx + 1, max(ay, by2) * sy + 1], fill=(0, 0, 0))
            Dw, Dh = (H, W) if rot % 180 else (W, H)
            buf = io.BytesIO()
            c = rlcanvas.Canvas(buf, pagesize=(Dw, Dh))
            img = io.BytesIO()
            pil.save(img, "JPEG", quality=90)
            img.seek(0)
            from reportlab.lib.utils import ImageReader
            c.drawImage(ImageReader(img), 0, 0, Dw, Dh)
            c.showPage()
            c.save()
            fresh = PdfReader(io.BytesIO(buf.getvalue())).pages[0]
            removed_widgets |= _widgets([page])
            for key in ("/Annots", "/CropBox", "/TrimBox", "/BleedBox", "/ArtBox", "/Group", "/Thumb", "/PieceInfo", "/StructParents"):
                if key in page:
                    del page[key]
            page[NameObject("/MediaBox")] = RectangleObject([0, 0, Dw, Dh])
            page[NameObject("/Rotate")] = NumberObject(0)
            page[NameObject("/Resources")] = fresh["/Resources"].get_object().clone(w)
            page.replace_contents(fresh.get_contents())
    finally:
        doc.close()
    _scrub_fields(w, removed_widgets)
    try:
        w.compress_identical_objects(remove_identicals=False, remove_orphans=True)
    except Exception:
        pass
    return _write(w, out)


def metadata(src, out, *, title=None, author=None, subject=None, keywords=None, strip: bool = False, passwords: list[str] | None = None) -> int:
    w = PdfWriter(clone_from=core.reader(src, passwords))
    if "/Metadata" in w._root_object:
        del w._root_object["/Metadata"]
    if strip:
        w.metadata = None
    else:
        current = dict(w.metadata or {})
        for key, value in (("/Title", title), ("/Author", author), ("/Subject", subject), ("/Keywords", keywords)):
            if value is None:
                continue
            value = str(value).strip()[:2000]
            if value:
                current[key] = value
            else:
                current.pop(key, None)
        w.metadata = None
        if current:
            w.add_metadata({k: str(v) for k, v in current.items()})
    return _write(w, out)


def compress(src, out, *, quality: int = 70, passwords: list[str] | None = None) -> dict:
    quality = max(10, min(95, int(quality)))
    limit = 3200 if quality >= 85 else 2400 if quality >= 70 else 1800 if quality >= 50 else 1200
    w = PdfWriter(clone_from=core.reader(src, passwords))
    replaced = 0
    seen: set[int] = set()
    for page in w.pages:
        try:
            images = list(page.images)
        except Exception:
            images = []
        for img in images:
            ref = img.indirect_reference
            if ref is None or ref.idnum in seen:
                continue
            seen.add(ref.idnum)
            try:
                obj = ref.get_object()
                if "/SMask" in obj or "/Mask" in obj or obj.get("/ImageMask"):
                    continue
                pil = img.image
                if pil is None or pil.mode in ("1", "P", "RGBA", "LA") or pil.width * pil.height < 40000:
                    continue
                before = len(obj._data) if hasattr(obj, "_data") else 0
                pil = pil.convert("L" if pil.mode in ("L", "I", "I;16") else "RGB")
                if max(pil.size) > limit:
                    k = limit / max(pil.size)
                    pil = pil.resize((max(1, round(pil.width * k)), max(1, round(pil.height * k))))
                probe = io.BytesIO()
                pil.save(probe, "JPEG", quality=quality, optimize=True)
                if before and probe.tell() >= before * 0.95:
                    continue
                img.replace(pil, quality=quality)
                replaced += 1
            except Exception:
                continue
    for page in w.pages:
        try:
            page.compress_content_streams(level=9)
        except Exception:
            pass
    w.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    pages = _write(w, out)
    return {"pages": pages, "images": replaced, "before": Path(src).stat().st_size, "after": Path(out).stat().st_size}


def _upright(c, W: float, H: float, rot: int) -> tuple[float, float]:
    if rot == 90:
        c.transform(0, 1, -1, 0, W, 0)
        return H, W
    if rot == 180:
        c.transform(-1, 0, 0, -1, W, H)
        return W, H
    if rot == 270:
        c.transform(0, -1, 1, 0, 0, H)
        return H, W
    return W, H


def _stamp_pages(src, out, paint, pages=None, passwords: list[str] | None = None) -> int:
    w = PdfWriter(clone_from=core.reader(src, passwords))
    n = len(w.pages)
    idx = core.parse_pages(pages, n)
    buf = io.BytesIO()
    c = rlcanvas.Canvas(buf)
    geo = []
    for k, i in enumerate(idx):
        page = w.pages[i - 1]
        x0, y0, x1, y1 = core.view_box(page)
        c.setPageSize((x1 - x0, y1 - y0))
        c.saveState()
        Dw, Dh = _upright(c, x1 - x0, y1 - y0, core.rotation(page))
        paint(c, Dw, Dh, k, i, n, len(idx))
        c.restoreState()
        c.showPage()
        geo.append((x0, y0))
    c.save()
    ov = PdfReader(io.BytesIO(buf.getvalue()))
    for k, i in enumerate(idx):
        w.pages[i - 1].merge_transformed_page(ov.pages[k], Transformation().translate(*geo[k]))
    return _write(w, out)


def page_numbers(src, out, *, position: str = "bottom-center", start: int = 1, fmt: str = "{n}", size: float = 10, color: str = "#333333",
                 margin: float = 28, pages=None, passwords: list[str] | None = None) -> int:
    if position not in POSITIONS:
        raise ValueError(f"Position must be one of {', '.join(POSITIONS)}")
    fmt = str(fmt or "{n}")[:80]
    if "{n}" not in fmt:
        raise ValueError("The format needs {n} where the number goes")
    vert, horiz = position.split("-")
    band = {horiz: fmt.replace("{n}", "<<page>>").replace("{total}", "<<pages>>").replace("{page}", "<<page>>")}
    return header_footer(src, out, header=band if vert == "top" else None, footer=band if vert == "bottom" else None,
                         size=max(5.0, min(48.0, float(size))), color=color, margins=max(4.0, min(144.0, float(margin))), pages=pages,
                         start=start, passwords=passwords)


def watermark(src, out, *, text: str, opacity: float = 0.15, angle: float = 45, size: float = 64, color: str = "#888888", pages=None,
              passwords: list[str] | None = None) -> int:
    text = str(text or "").strip()[:200]
    if not text:
        raise ValueError("Type the watermark text")
    opacity = max(0.02, min(1.0, float(opacity)))
    size = max(6.0, min(400.0, float(size)))
    rgb = annot.rgb(color, "#888888")
    font = annot.font_for(text, bold=True)

    def paint(c, Dw, Dh, k, i, n, count):
        c.setFillColorRGB(*rgb)
        c.setFillAlpha(opacity)
        c.translate(Dw / 2, Dh / 2)
        c.rotate(float(angle))
        c.setFont(font, size)
        c.drawCentredString(0, -size * 0.35, text)

    return _stamp_pages(src, out, paint, pages, passwords)


def _number(v, lo: float, hi: float, default: float, what: str) -> float:
    if v is None or v == "":
        return default
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a number") from None
    if f != f:
        raise ValueError(f"{what} must be a number")
    return max(lo, min(hi, f))


def _whole(v, default: int, what: str) -> int:
    if v is None or v == "":
        return default
    try:
        return int(float(v))
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a whole number") from None


def _sides(v, default: float) -> dict[str, float]:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        v = {k: v for k in ("top", "bottom", "left", "right")}
    v = v if isinstance(v, dict) else {}
    short = {"top": "t", "bottom": "b", "left": "l", "right": "r"}
    return {k: _number(v.get(k, v.get(s)), 0, 2000, default, f"The {k} margin") for k, s in short.items()}


def _band(v, what: str) -> dict[str, str]:
    if v is None or v == "":
        return {}
    if isinstance(v, str):
        v = {"center": v}
    if not isinstance(v, dict):
        raise ValueError(f"The {what} takes left, center and right text")
    out = {}
    for key in SLOTS:
        raw = v.get(key)
        if raw is None and key == "center":
            raw = v.get("centre")
        text = str(raw or "").replace("\r\n", "\n").replace("\r", "\n")[:500]
        if text.strip():
            out[key] = text
    return out


def _face(text: str, family: str) -> str:
    try:
        text.encode("cp1252")
        return family
    except UnicodeEncodeError:
        return annot.text_font()


def header_footer(src, out, *, header=None, footer=None, size: float = 10, color: str = "#333333", font: str = "sans", margins=None,
                  pages=None, start: int = 1, apply: str = "all", bates: dict | None = None, date: str | None = None, file: str | None = None,
                  passwords: list[str] | None = None) -> int:
    head, foot = _band(header, "header"), _band(footer, "footer")
    apply = str(apply or "all").lower()
    if apply not in APPLY:
        raise ValueError("apply must be all, odd or even")
    family = FACES.get(str(font or "sans").lower())
    if family is None:
        raise ValueError(f"font must be one of {', '.join(FACES)}")
    numbering = None
    if bates:
        if not isinstance(bates, dict):
            raise ValueError("Bates numbering takes a prefix, a start number and a digit count")
        b_start = _whole(bates.get("start"), 1, "The Bates start number")
        if not 0 <= b_start < 10 ** 15:
            raise ValueError("The Bates start number must be between 0 and 999999999999999")
        numbering = (str(bates.get("prefix") or "")[:60], b_start, max(1, min(15, _whole(bates.get("digits"), 6, "The Bates digit count"))),
                     str(bates.get("suffix") or "")[:60])
        if not any(m.group(1).lower() == "bates" for band in (head, foot) for s in band.values() for m in TOKEN.finditer(s)):
            foot["right"] = f"{foot['right']}  <<bates>>" if foot.get("right") else "<<bates>>"
    if not head and not foot:
        raise ValueError("Type the header or footer text")
    size = _number(size, 4, 96, 10, "The font size")
    side = _sides(margins, 36)
    start = _whole(start, 1, "The start number")
    rgb = annot.rgb(color, "#333333")
    n = len(core.reader(src, passwords).pages)
    rng = core.parse_pages(pages, n)
    pos = {p: k for k, p in enumerate(rng)}
    idx = [p for p in rng if apply == "all" or (p % 2 == 1) == (apply == "odd")]
    if not idx:
        raise ValueError(f"There are no {apply} pages in that range")
    seq = {p: k for k, p in enumerate(idx)}
    today = str(date).strip()[:60] if date and str(date).strip() else datetime.date.today().isoformat()
    name = str(file or Path(src).name)[:200]

    def fill(text: str, i: int) -> str:
        def sub(m) -> str:
            key = m.group(1).lower()
            if key == "page":
                return str(start + pos[i])
            if key == "pages":
                return str(start + len(rng) - 1)
            if key == "date":
                return today
            if key == "file":
                return name
            if numbering is None:
                return ""
            prefix, first, digits, suffix = numbering
            return f"{prefix}{first + seq[i]:0{digits}d}{suffix}"
        return TOKEN.sub(sub, text)

    asc, desc, lead = size * 0.74, size * 0.22, size * 1.2

    def paint(c, Dw, Dh, k, i, total, count):
        c.setFillColorRGB(*rgb)
        for band, top in ((head, True), (foot, False)):
            for slot, raw in band.items():
                lines = fill(raw, i).split("\n")
                for li, line in enumerate(lines):
                    if not line.strip():
                        continue
                    c.setFont(_face(line, family), size)
                    y = Dh - side["top"] - asc - li * lead if top else side["bottom"] + desc + (len(lines) - 1 - li) * lead
                    if slot == "left":
                        c.drawString(side["left"], y, line)
                    elif slot == "right":
                        c.drawRightString(Dw - side["right"], y, line)
                    else:
                        c.drawCentredString(Dw / 2, y, line)

    return _stamp_pages(src, out, paint, idx, passwords)


def _unrotate(m: tuple[float, float, float, float], rot: int) -> tuple[float, float, float, float]:
    left, top, right, bottom = m
    if rot == 90:
        return top, right, bottom, left
    if rot == 180:
        return right, bottom, left, top
    if rot == 270:
        return bottom, left, top, right
    return left, top, right, bottom


@core.serial
def _content_margins(src, idx: list[int], passwords: list[str] | None, pad: float) -> dict[int, tuple[float, float, float, float] | None]:
    doc = core.pdfium_doc(src, passwords)
    out: dict[int, tuple[float, float, float, float] | None] = {}
    try:
        for i in idx:
            pg = doc[i - 1]
            w, h = pg.get_size()
            pil = core.render_pil(pg, max(0.1, min(1.5, 900 / max(w, h, 1)))).convert("L")
            pg.close()
            bb = pil.point(lambda v: 255 if v < 242 else 0).getbbox()
            if not bb:
                out[i] = None
                continue
            dw, dh = pil.size
            kx, ky = w / dw, h / dh
            out[i] = (max(0.0, bb[0] * kx - pad), max(0.0, bb[1] * ky - pad), max(0.0, (dw - bb[2]) * kx - pad), max(0.0, (dh - bb[3]) * ky - pad))
    finally:
        doc.close()
    return out


def crop(src, out, *, box=None, margins=None, auto: bool = False, pad: float = 4, pages=None, passwords: list[str] | None = None) -> dict:
    if sum((box is not None, margins is not None, bool(auto))) != 1:
        raise ValueError("Give one of a box, margins or auto")
    if box is not None:
        try:
            bx, by, bw, bh = annot._rect(box)
        except (KeyError, TypeError, ValueError, IndexError):
            raise ValueError("The crop box needs x, y, w and h in points") from None
    side = _sides(margins, 0) if margins is not None else None
    w = PdfWriter(clone_from=core.reader(src, passwords))
    idx = core.parse_pages(pages, len(w.pages))
    found = _content_margins(src, idx, passwords, _number(pad, 0, 144, 4, "The padding")) if auto else {}
    cropped = 0
    for i in idx:
        page = w.pages[i - 1]
        _materialize(page)
        x0, y0, x1, y1 = core.view_box(page)
        if box is not None:
            nx0, ny0, nx1, ny1 = x0 + bx, y1 - by - bh, x0 + bx + bw, y1 - by
        else:
            m = found.get(i) if auto else (side["left"], side["top"], side["right"], side["bottom"])
            if m is None:
                continue
            left, top, right, bottom = _unrotate(m, core.rotation(page))
            nx0, ny0, nx1, ny1 = x0 + left, y0 + bottom, x1 - right, y1 - top
        nx0, ny0, nx1, ny1 = max(nx0, x0), max(ny0, y0), min(nx1, x1), min(ny1, y1)
        if nx1 - nx0 < MIN_CROP or ny1 - ny0 < MIN_CROP:
            raise ValueError(f"That crop leaves page {i} smaller than {MIN_CROP:g} points on a side")
        if max(abs(nx0 - x0), abs(ny0 - y0), abs(nx1 - x1), abs(ny1 - y1)) < 0.01:
            continue
        page[NameObject("/CropBox")] = RectangleObject([round(v, 3) for v in (nx0, ny0, nx1, ny1)])
        cropped += 1
    if not cropped:
        raise ValueError("Nothing to crop: the pages already end there" if not auto else "These pages have no white margins to remove")
    return {"pages": _write(w, out), "cropped": cropped}
