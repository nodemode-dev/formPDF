import base64
import io
import zlib

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, ContentStream, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject, StreamObject

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
            # shadings name their colour space themselves, directly or through a shading pattern
            shades = [_o(sh) for _n, sh in (_o(obj.get("/Shading")) or {}).items()]
            shades += [_o(_o(p).get("/Shading")) for _n, p in (_o(obj.get("/Pattern")) or {}).items() if isinstance(_o(p), DictionaryObject)]
            spaces += [sh.get("/ColorSpace") for sh in shades if isinstance(sh, DictionaryObject) and sh.get("/ColorSpace") is not None]
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


def _zero(n: int, idx: list[int]) -> str:
    """PostScript calculator code that sets the given stack entries (0 the deepest of n) to 0 and keeps the others in place."""
    return " ".join(f"{n - i} -1 roll pop 0 {n - i} 1 roll" for i in idx)


def _calc(doc, body: str, n_in: int, n_out: int):
    """A PostScript calculator function (type 4) over [0 1] inputs and outputs, as an indirect stream."""
    fn = DecodedStreamObject()
    fn[NameObject("/FunctionType")] = NumberObject(4)
    fn[NameObject("/Domain")] = ArrayObject(FloatObject(v) for v in [0, 1] * n_in)
    fn[NameObject("/Range")] = ArrayObject(FloatObject(v) for v in [0, 1] * n_out)
    fn.set_data(("{ " + body + " }").encode("ascii"))
    return doc._add_object(fn)


# The colours of the inputs to CMYK, as calculator code: gray is all black; RGB uses the same rule as fills (k is one minus
# the largest component, and each ink is how far its component falls short of that largest one).
_TO_CMYK = {
    "gray": "1 exch sub 0 0 0 4 -1 roll",
    "rgb": "3 copy 2 copy lt {exch} if pop 2 copy lt {exch} if pop dup 0.0001 le "
           "{ pop pop pop pop 0 0 0 1 } "
           "{ 4 1 roll 3 index exch sub 3 index div exch 3 index exch sub 3 index div 3 -1 roll 3 index exch sub 3 index div "
           "3 1 roll exch 4 -1 roll 1 exch sub } ifelse",
    "cmyk": "",
}


def _masked(doc, fn, n: int, hidden: list[int]):
    """A tint transform that reads the hidden inputs as 0 and the others as given, or None when that cannot be built.
    One input: a stitching function whose Encode sends every value to the start of the original's domain. Sampled:
    Encode [0 0] pins a hidden input to its first sample. Calculator: the program zeroes those inputs first."""
    f = _o(fn)
    if not isinstance(f, DictionaryObject):
        return None
    kind = int(_o(f.get("/FunctionType", -1)))
    dom = [float(_o(v)) for v in _o(f.get("/Domain")) or [0, 1] * n]
    if n == 1:
        return DictionaryObject({NameObject("/FunctionType"): NumberObject(3), NameObject("/Domain"): ArrayObject([FloatObject(0), FloatObject(1)]),
                                 NameObject("/Functions"): ArrayObject([fn]), NameObject("/Bounds"): ArrayObject(),
                                 NameObject("/Encode"): ArrayObject([FloatObject(dom[0]), FloatObject(dom[0])])})
    if kind == 0 and isinstance(f, StreamObject):
        size = [int(_o(v)) for v in _o(f.get("/Size")) or []]
        enc = [float(_o(v)) for v in _o(f.get("/Encode")) or []] or [x for s in size for x in (0, s - 1)]
        for i in hidden:
            enc[2 * i:2 * i + 2] = [0.0, 0.0]
        new = StreamObject()
        for k, v in f.items():
            new[NameObject(k)] = v
        new[NameObject("/Encode")] = ArrayObject(FloatObject(v) for v in enc)
        new._data = f._data
        return doc._add_object(new)
    if kind == 4 and isinstance(f, StreamObject):
        code = f.get_data().decode("latin-1").strip()
        if not code.startswith("{"):
            return None
        new = DecodedStreamObject()
        for k, v in f.items():
            if k not in ("/Filter", "/DecodeParms", "/Length"):
                new[NameObject(k)] = v
        new.set_data(("{ " + _zero(n, hidden) + " " + code[1:]).encode("latin-1"))
        return doc._add_object(new)
    return None


def _shading(sh, res, doc, hide: set, process: bool, seen: set) -> None:
    """Hidden inks taken out of a shading of any type (axial, radial, function-based, triangle and patch meshes) by
    wrapping its colour space rather than its colours, which may sit in functions of any kind or in mesh vertex data.
    A spot space keeps its inks with a tint transform that reads the hidden ones as 0; a gray, RGB or CMYK space becomes
    a DeviceN over the same components whose transform turns them into CMYK without the hidden process inks."""
    sh = _o(sh)
    if not isinstance(sh, DictionaryObject) or id(sh) in seen:
        return
    seen.add(id(sh))
    cs = sh.get("/ColorSpace")
    table = _o(res.get("/ColorSpace")) if isinstance(res, DictionaryObject) else None
    arr = _o(table.get(str(cs))) if isinstance(cs, NameObject) and isinstance(table, DictionaryObject) and str(cs) in table else _o(cs)
    spots = _names(arr)
    if spots:
        hidden = [i for i, name in enumerate(spots) if name in hide]
        if not hidden or len(arr) < 4:
            return
        tint = _masked(doc, arr[3], len(spots), hidden)
        if tint is not None:
            sh[NameObject("/ColorSpace")] = ArrayObject([arr[0], arr[1], arr[2], tint] + list(arr[4:]))
        return
    kind = colour.space_kind(cs, res)
    if not process or kind not in _TO_CMYK:
        return
    n = {"gray": 1, "rgb": 3, "cmyk": 4}[kind]
    out = [i for i, name in enumerate(PROCESS) if name in hide]
    body = (_TO_CMYK[kind] + " " + _zero(4, out)).strip()
    sh[NameObject("/ColorSpace")] = ArrayObject([NameObject("/DeviceN"), ArrayObject(NameObject(f"/FsIn{i + 1}") for i in range(n)),
                                                 NameObject("/DeviceCMYK"), _calc(doc, body, n, 4)])


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
                _shading(p.get("/Shading"), res, doc, hide, process, seen)
        for _n, sh in (_o(res.get("/Shading")) or {}).items():
            _shading(sh, res, doc, hide, process, seen)
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
