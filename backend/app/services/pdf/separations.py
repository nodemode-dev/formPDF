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
    return f"{4 + len(spots)} inks: the four process inks{', ' + ', '.join(spots) if spots else ''}.", {"process": list(PROCESS), "spots": spots, "rgb": rgb}


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


def _func_out(fn, convert) -> bool:
    """Applies convert to the output colours of an exponential function (C0, C1) or a stitching of them; False when the
    function is sampled or PostScript, whose outputs cannot be changed this way."""
    fn = _o(fn)
    if not isinstance(fn, DictionaryObject):
        return False
    kind = int(_o(fn.get("/FunctionType", -1)))
    if kind == 2:
        n = len(_o(fn.get("/C0")) or [0.0]) if fn.get("/C0") is not None else len(_o(fn.get("/C1")) or [1.0])
        c0 = [float(_o(v)) for v in _o(fn.get("/C0")) or [0.0] * n]
        c1 = [float(_o(v)) for v in _o(fn.get("/C1")) or [1.0] * n]
        a, b = convert(c0), convert(c1)
        if a is None or b is None:
            return False
        fn[NameObject("/C0")] = ArrayObject(FloatObject(round(x, 4)) for x in a)
        fn[NameObject("/C1")] = ArrayObject(FloatObject(round(x, 4)) for x in b)
        if fn.get("/Range") is not None:
            fn[NameObject("/Range")] = ArrayObject(FloatObject(v) for v in [0, 1] * len(a))
        return True
    if kind == 3:
        return all(_func_out(f, convert) for f in _o(fn.get("/Functions")) or [])
    return False


def _shading(sh, res, hide: set, process: bool, seen: set) -> None:
    """Hidden inks taken out of an axial or radial shading's colours: process inks by turning its colours into CMYK, spot
    inks by zeroing their tint. Mesh shadings and sampled functions are left as drawn."""
    sh = _o(sh)
    if not isinstance(sh, DictionaryObject) or id(sh) in seen or sh.get("/Function") is None:
        return
    seen.add(id(sh))
    cs = sh.get("/ColorSpace")
    spots = _names(cs)
    fns = _o(sh["/Function"])
    fns = list(fns) if isinstance(fns, ArrayObject) else [fns]
    if spots:
        if len(fns) != 1:
            return
        _func_out(fns[0], lambda v: [0.0 if n in hide else x for n, x in zip(spots, v)] if len(v) == len(spots) else None)
        return
    kind = colour.space_kind(cs, res)
    if process and kind in ("gray", "rgb", "cmyk") and len(fns) == 1:
        def to_cmyk(v):
            c = _cmyk(kind, v)
            return None if c is None else [0.0 if PROCESS[i] in hide else x for i, x in enumerate(c)]
        if _func_out(fns[0], to_cmyk):
            sh[NameObject("/ColorSpace")] = NameObject("/DeviceCMYK")
            sh.pop("/Background", None)


def _inline(operands, res, doc, idx: int, hide: set, process: bool):
    """An inline picture, turned into a picture XObject so it can lose its hidden inks like any other; None when it cannot be read."""
    settings, data = operands.get("settings") if isinstance(operands, dict) else None, operands.get("data") if isinstance(operands, dict) else None
    if not isinstance(settings, dict) or data is None or not isinstance(res, DictionaryObject):
        return None
    full = {"/W": "/Width", "/H": "/Height", "/CS": "/ColorSpace", "/BPC": "/BitsPerComponent", "/F": "/Filter", "/DP": "/DecodeParms",
            "/D": "/Decode", "/IM": "/ImageMask", "/I": "/Interpolate"}
    names = {"/G": "/DeviceGray", "/RGB": "/DeviceRGB", "/CMYK": "/DeviceCMYK", "/AHx": "/ASCIIHexDecode", "/A85": "/ASCII85Decode",
             "/LZW": "/LZWDecode", "/Fl": "/FlateDecode", "/RL": "/RunLengthDecode", "/CCF": "/CCITTFaxDecode", "/DCT": "/DCTDecode"}
    xo = StreamObject()
    xo[NameObject("/Type")], xo[NameObject("/Subtype")] = NameObject("/XObject"), NameObject("/Image")
    for k, v in settings.items():
        key = full.get(str(k), str(k))
        v = NameObject(names[str(v)]) if isinstance(v, NameObject) and str(v) in names else v
        if isinstance(v, ArrayObject):
            v = ArrayObject(NameObject(names[str(x)]) if isinstance(x, NameObject) and str(x) in names else x for x in v)
        xo[NameObject(key)] = v
    xo._data = data
    filters = xo.get("/Filter")
    filters = [str(f) for f in filters] if isinstance(filters, ArrayObject) else [str(filters)] if filters is not None else []
    if filters and all(f in ("/ASCIIHexDecode", "/ASCII85Decode", "/FlateDecode", "/LZWDecode", "/RunLengthDecode") for f in filters):
        # Undo the general filters here: the picture decoder reads a chain such as ASCII85 then Flate wrongly.
        from pypdf.filters import decode_stream_data
        try:
            xo._data = decode_stream_data(xo)
        except Exception:
            return None
        for k in ("/Filter", "/DecodeParms"):
            xo.pop(k, None)
    if isinstance(xo.get("/ColorSpace"), NameObject) and str(xo["/ColorSpace"]) not in names.values():
        named = _o((_o(res.get("/ColorSpace")) or {}).get(str(xo["/ColorSpace"])))
        if named is not None:
            xo[NameObject("/ColorSpace")] = named
    _image(xo, res, hide, process)
    xobjects = _o(res.get("/XObject"))
    if not isinstance(xobjects, DictionaryObject):
        xobjects = DictionaryObject()
        res[NameObject("/XObject")] = xobjects
    name = NameObject(f"/FsInline{idx}")
    xobjects[name] = doc._add_object(xo)  # a stream must be an indirect object to be written
    return name


def _rewrite(st: StreamObject, res, doc, hide: set, process: bool, seen: set) -> None:
    if id(st) in seen:
        return
    seen.add(id(st))
    res = _o(res)
    table = _o(res.get("/ColorSpace")) if isinstance(res, DictionaryObject) else None
    if isinstance(res, DictionaryObject):
        for _n, pat in (_o(res.get("/Pattern")) or {}).items():
            p = _o(pat)
            if isinstance(p, StreamObject) and int(_o(p.get("/PatternType", 1))) == 1:
                _rewrite(p, p.get("/Resources") or res, doc, hide, process, seen)
            elif isinstance(p, DictionaryObject) and int(_o(p.get("/PatternType", 0))) == 2:
                _shading(p.get("/Shading"), res, hide, process, seen)
        for _n, sh in (_o(res.get("/Shading")) or {}).items():
            _shading(sh, res, hide, process, seen)
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
        if op == b"INLINE IMAGE":
            name = _inline(operands, res, doc, len(out), hide, process)
            if name is not None:
                out.append(([name], b"Do"))
                continue
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
    say = f"Page {n} without {', '.join(sorted(hide))}." if hide else f"Page {n} with every ink."
    return say, {"page": n, "hide": sorted(hide), "png": _png(buf.getvalue(), scale)}


actions.register(actions.Action("inks", "read", "List the inks a PDF prints with", words=("separations", "inks", "plates", "spot colours", "output preview"), run=inks))
actions.register(actions.Action("separation_preview", "read", "Preview a page with some inks turned off", words=("separations", "output preview", "plates", "hide ink", "spot colour preview"),
                                fields=(actions.Field("page", "Page", "number", 1), actions.Field("hide", "Inks to hide", "text", "", hint="Cyan, Magenta, Yellow, Black or a spot colour name, separated by commas"),
                                        actions.Field("scale", "Scale", "number", 1.5)), run=preview))
