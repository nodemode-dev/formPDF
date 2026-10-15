import base64
import io
import zlib

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, ContentStream, DictionaryObject, FloatObject, NameObject, NumberObject, StreamObject

from . import actions, colour, core, pdfa
from .preflight import _nums

PROCESS = ("Cyan", "Magenta", "Yellow", "Black")
SKIP = {"All", "None"}


def _o(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _names(cs) -> list[str]:
    cs = _o(cs)
    if not isinstance(cs, ArrayObject) or not cs:
        return []
    fam = str(_o(cs[0]))
    if fam == "/Separation" and len(cs) > 1:
        return [str(_o(cs[1]))[1:]]
    if fam == "/DeviceN" and len(cs) > 1:
        return [str(_o(n))[1:] for n in _o(cs[1])]
    return []


def inks(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    doc = core.reader(path, passwords)
    spots: list[str] = []
    rgb = False
    for kind, _pi, obj in pdfa.walk(doc):
        spaces = []
        if kind == "res":
            spaces = [cs for _n, cs in (_o(obj.get("/ColorSpace")) or {}).items()]
        elif kind == "xobject" and obj.get("/ColorSpace") is not None:
            spaces = [obj.get("/ColorSpace")]
        for cs in spaces:
            for n in _names(cs):
                if n not in SKIP and n not in PROCESS and n not in spots:
                    spots.append(n)
            if colour.space_kind(cs, None) == "rgb":
                rgb = True
    return {"process": list(PROCESS), "spots": spots, "rgb": rgb, "say": f"{4 + len(spots)} inks: the four process inks{', ' + ', '.join(spots) if spots else ''}."}


def _cmyk(kind: str, v: list[float]) -> list[float] | None:
    if kind == "gray" and len(v) == 1:
        return [0.0, 0.0, 0.0, 1.0 - v[0]]
    if kind == "rgb" and len(v) == 3:
        k = 1.0 - max(v)
        if k >= 0.999:
            return [0.0, 0.0, 0.0, 1.0]
        return [(1 - v[0] - k) / (1 - k), (1 - v[1] - k) / (1 - k), (1 - v[2] - k) / (1 - k), k]
    if kind == "cmyk" and len(v) == 4:
        return list(v)
    return None


def _rewrite(st: StreamObject, res, doc, hide: set, process: bool, seen: set) -> None:
    if id(st) in seen:
        return
    seen.add(id(st))
    res = _o(res)
    table = _o(res.get("/ColorSpace")) if isinstance(res, DictionaryObject) else None
    try:
        cs_ = ContentStream(st, doc)
    except Exception:
        return
    state = {"f": ("gray", []), "s": ("gray", [])}
    stack = []
    out = []
    for operands, op in cs_.operations:
        if op == b"q":
            stack.append(dict(state))
        elif op == b"Q" and stack:
            state = stack.pop()
        if op in (b"g", b"rg", b"k", b"G", b"RG", b"K") and process:
            kind = {b"g": "gray", b"rg": "rgb", b"k": "cmyk"}[op.lower()]
            c = _cmyk(kind, _nums(operands))
            if c is not None:
                c = [0.0 if PROCESS[i] in hide else x for i, x in enumerate(c)]
                out.append(([FloatObject(round(x, 4)) for x in c], b"k" if op.islower() else b"K"))
                continue
        if op in (b"cs", b"CS") and operands:
            side = "f" if op == b"cs" else "s"
            cs = operands[0]
            named = _o(table.get(str(cs))) if isinstance(cs, NameObject) and isinstance(table, DictionaryObject) and str(cs) in table else cs
            kind = colour.space_kind(cs, res)
            spots = _names(named)
            state[side] = ("sep", spots) if spots else (kind or "other", [])
            if process and kind in ("gray", "rgb", "cmyk"):
                out.append(([NameObject("/DeviceCMYK")], op))
                continue
        if op in (b"sc", b"scn", b"SC", b"SCN"):
            side = "f" if op in (b"sc", b"scn") else "s"
            kind, spots = state[side]
            vals = _nums(operands)
            if kind == "sep" and vals and len(vals) == len(spots):
                vals = [0.0 if n in hide else v for n, v in zip(spots, vals)]
                out.append(([FloatObject(v) for v in vals], op))
                continue
            if process and kind in ("gray", "rgb", "cmyk") and vals:
                c = _cmyk(kind, vals)
                if c is not None:
                    c = [0.0 if PROCESS[i] in hide else x for i, x in enumerate(c)]
                    out.append(([FloatObject(round(x, 4)) for x in c], op))
                    continue
        if op == b"Do" and operands and isinstance(res, DictionaryObject):
            xo = _o((_o(res.get("/XObject")) or {}).get(str(operands[0])))
            if isinstance(xo, StreamObject) and xo.get("/Subtype") == "/Form":
                _rewrite(xo, xo.get("/Resources") or res, doc, hide, process, seen)
            elif isinstance(xo, StreamObject) and xo.get("/Subtype") == "/Image" and id(xo) not in seen:
                seen.add(id(xo))
                _image(xo, res, hide, process)
        out.append((operands, op))
    cs_.operations = out
    data = cs_.get_data()
    if isinstance(st, ContentStream):
        st.set_data(data)
        return
    for k in ("/DecodeParms", "/Filter"):
        if k in st:
            del st[k]
    st._data = data


def _image(xo: StreamObject, res, hide: set, process: bool) -> None:
    if xo.get("/ImageMask"):
        return
    from PIL import Image

    spots = _names(xo.get("/ColorSpace"))
    try:
        pil = xo.decode_as_image()
    except Exception:
        return
    if spots:
        if not all(n in hide for n in spots):
            return
        rgb = Image.new("L", pil.size, 255)
    elif process:
        bands = list(pil.convert("CMYK").split())
        dec = [float(_o(v)) for v in _o(xo.get("/Decode")) or []]
        if pil.mode == "CMYK" and len(dec) == 8:
            bands = [b.point(lambda v: 255 - v) if dec[2 * i] > dec[2 * i + 1] else b for i, b in enumerate(bands)]
        for i, name in enumerate(PROCESS):
            if name in hide:
                bands[i] = bands[i].point(lambda _v: 0)
        rgb = Image.merge("CMYK", bands).convert("RGB")
    else:
        return
    for k in ("/DecodeParms", "/Decode", "/Filter"):
        if k in xo:
            del xo[k]
    xo[NameObject("/ColorSpace")] = NameObject("/DeviceRGB" if rgb.mode == "RGB" else "/DeviceGray")
    xo[NameObject("/BitsPerComponent")] = NumberObject(8)
    xo[NameObject("/Width")], xo[NameObject("/Height")] = NumberObject(rgb.width), NumberObject(rgb.height)
    xo[NameObject("/Filter")] = NameObject("/FlateDecode")
    xo._data = zlib.compress(rgb.tobytes())


@core.serial
def _png(data: bytes, scale: float) -> str:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    try:
        img = core.render_pil(pdf[0], scale)
    finally:
        pdf.close()
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=False)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def preview(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    a = args or {}
    doc = core.reader(path, passwords)
    n = int(a.get("page") or 1)
    if not 1 <= n <= len(doc.pages):
        raise ValueError(f"page {n} is outside 1 to {len(doc.pages)}")
    raw = a.get("hide") or []
    hide = {s.strip() for s in (raw.split(",") if isinstance(raw, str) else raw) if str(s).strip()}
    scale = max(0.25, min(4.0, float(a.get("scale") or 1.5)))
    w = PdfWriter()
    page = w.add_page(doc.pages[n - 1])
    if hide:
        process = any(p in hide for p in PROCESS)
        contents = page.get_contents()
        if contents is not None:
            _rewrite(contents, page.get("/Resources"), w, hide, process, set())
            page.replace_contents(contents)
    buf = io.BytesIO()
    w.write(buf)
    return {"page": n, "hide": sorted(hide), "png": _png(buf.getvalue(), scale)}


actions.register(actions.Action("inks", "read", "List the inks a PDF prints with", words=("separations", "inks", "plates", "spot colours", "output preview"), run=inks))
actions.register(actions.Action("separation_preview", "read", "Preview a page with some inks turned off", words=("separations", "output preview", "plates", "hide ink", "spot colour preview"),
                                fields=(actions.Field("page", "Page", "number", 1), actions.Field("hide", "Inks to hide", "text", "", hint="Cyan, Magenta, Yellow, Black or a spot colour name, separated by commas"),
                                        actions.Field("scale", "Scale", "number", 1.5)), run=preview))
