import base64
import io
import json
import math
import re
import uuid
import zlib
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ContentStream, DecodedStreamObject, DictionaryObject, FloatObject, IndirectObject, NameObject,
                           NumberObject, StreamObject, TextStringObject)

from . import actions, anchors, annot, core, fontkit
from .content import interp
from .content.fonts import FontInfo

KEY = NameObject("/FormpdfItem")
WRAP = NameObject("/FormpdfWrap")
PREFIX = "/FpI_"
MAX_ITEMS = 400
MAX_TEXT = 20_000
MAX_IMAGE = 60 * 1024 * 1024
ALIGNS = ("left", "center", "right", "justify")
LISTS = ("none", "bullet", "number")
IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
ORIG = "#orig"
ORIG_RES = NameObject("/FpO")
ORIENT = {1: lambda u, v: (u, v), 2: lambda u, v: (1 - u, v), 3: lambda u, v: (1 - u, 1 - v), 4: lambda u, v: (u, 1 - v),
          5: lambda u, v: (v, u), 6: lambda u, v: (1 - v, u), 7: lambda u, v: (1 - v, 1 - u), 8: lambda u, v: (v, 1 - u)}


def _f(v, default: float, lo: float, hi: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return default if not math.isfinite(x) else max(lo, min(hi, x))


def _inv(m) -> tuple:
    a, b, c, d, e, f = m
    det = a * d - b * c
    if abs(det) < 1e-12:
        raise ValueError("A picture with no area cannot be edited")
    return (d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)


def _num(v: float) -> str:
    s = f"{v:.5f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _mat(m) -> str:
    return " ".join(_num(v) for v in m)


def _color(v, default: str = "#111111") -> str:
    s = str(v or "").strip()
    return s.upper() if re.fullmatch(r"#[0-9a-fA-F]{6}", s) else default


def _rgb(hexc: str) -> tuple[float, float, float]:
    return tuple(int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5))


def placement(page, it: dict) -> tuple:
    vx0, _, _, vy1 = core.view_box(page)
    w, h = it["w"], it["h"]
    cx, cy = vx0 + it["x"] + w / 2, vy1 - it["y"] - h / 2
    phi = -math.radians(it.get("rot", 0.0))
    cs, sn = math.cos(phi), math.sin(phi)
    m = (1.0, 0.0, 0.0, 1.0, -w / 2, -h / 2)
    m = interp.mult(m, (-1.0 if it.get("flipH") else 1.0, 0.0, 0.0, -1.0 if it.get("flipV") else 1.0, 0.0, 0.0))
    m = interp.mult(m, (cs, sn, -sn, cs, 0.0, 0.0))
    return interp.mult(m, (1.0, 0.0, 0.0, 1.0, cx, cy))


def _geometry(page, ctm) -> dict:
    a, b, c, d, _, _ = ctm
    w, h = math.hypot(a, b), math.hypot(c, d)
    cx, cy = interp.apply(ctm, 0.5, 0.5)
    vx0, _, _, vy1 = core.view_box(page)
    rot = -math.degrees(math.atan2(b, a))
    rot = (rot + 180) % 360 - 180
    return {"x": round(cx - w / 2 - vx0, 3), "y": round(vy1 - cy - h / 2, 3), "w": round(w, 3), "h": round(h, 3),
            "rot": round(rot, 3), "flipH": False, "flipV": (a * d - b * c) < 0}


def _resources(page) -> tuple[DictionaryObject, DictionaryObject]:
    old = page.get("/Resources")
    res = DictionaryObject(old.get_object()) if old is not None else DictionaryObject()
    xo_old = res.get("/XObject")
    xo = DictionaryObject(xo_old.get_object()) if xo_old is not None else DictionaryObject()
    res[NameObject("/XObject")] = xo
    page[NameObject("/Resources")] = res
    return res, xo


def _entries(w: PdfWriter, page) -> ArrayObject:
    raw = page.raw_get("/Contents") if "/Contents" in page else None
    if raw is None:
        refs = []
    else:
        obj = raw.get_object()
        refs = list(obj) if isinstance(obj, ArrayObject) else [raw]
    out = ArrayObject()
    for r in refs:
        out.append(r if isinstance(r, IndirectObject) else w._add_object(r.get_object()))
    page[NameObject("/Contents")] = out
    return out


def _kind(ref) -> tuple[str, dict | str | None]:
    obj = ref.get_object()
    if KEY in obj:
        try:
            return "item", json.loads(str(obj[KEY]))
        except ValueError:
            return "base", None
    if WRAP in obj:
        return "wrap", str(obj[WRAP])
    return "base", None


def _marker(w: PdfWriter, which: str):
    s = DecodedStreamObject()
    s.set_data(b"q\n" if which == "begin" else b"\nQ\n")
    s[WRAP] = TextStringObject(which)
    return w._add_object(s)


def _ensure_wrap(w: PdfWriter, arr: ArrayObject) -> None:
    kinds = [_kind(r) for r in arr]
    if any(k == "wrap" for k, _ in kinds):
        return
    base = [i for i, (k, _) in enumerate(kinds) if k == "base"]
    if not base:
        arr.insert(0, _marker(w, "end"))
        arr.insert(0, _marker(w, "begin"))
        return
    arr.insert(base[-1] + 1, _marker(w, "end"))
    arr.insert(base[0], _marker(w, "begin"))


def _wrap_bounds(arr) -> tuple[int, int]:
    begin = end = -1
    for i, r in enumerate(arr):
        k, v = _kind(r)
        if k == "wrap" and v == "begin" and begin < 0:
            begin = i
        elif k == "wrap" and v == "end":
            end = i
    return begin, end


def _item_stream(w: PdfWriter, page, it: dict):
    m = placement(page, it)
    if it.get("ctx"):
        m = interp.mult(m, _inv(tuple(it["ctx"])))
    s = DecodedStreamObject()
    s.set_data(f"q {_mat(m)} cm {PREFIX}{it['id']} Do Q\n".encode())
    s[KEY] = TextStringObject(json.dumps(_public(it, keep_ctx=True), separators=(",", ":"), ensure_ascii=False))
    return w._add_object(s)


def _public(it: dict, keep_ctx: bool = False) -> dict:
    keys = ["v", "id", "kind", "page", "x", "y", "w", "h", "rot", "flipH", "flipV"]
    if it["kind"] == "text":
        keys += ["font", "paras", "auto", "fit", "thread", "seq", "overflow", "grow", "grown"]
    else:
        keys += ["crop", "iw", "ih", "orient", "format"]
    if keep_ctx:
        keys.append("ctx")
    return {k: it[k] for k in keys if k in it and it[k] is not None}


def _layout_runs(para: dict, font: dict) -> list[list[dict]]:
    words: list[list[dict]] = []
    cur: list[dict] = []
    for r in para.get("runs") or []:
        style = {k: bool(r.get(k)) for k in ("b", "i", "u", "s", "sup", "sub")}
        style["color"] = _color(r.get("color"), font["color"])
        for piece in re.findall(r"\S+|\s+", str(r.get("t") or "")):
            if piece.isspace():
                if cur:
                    words.append(cur)
                    cur = []
                words.append([{"t": " ", **style, "space": True}])
            else:
                cur.append({"t": piece, **style})
    if cur:
        words.append(cur)
    return words


def _orig_style(it: dict) -> tuple | None:
    o = it["font"].get("orig")
    return (bool(o.get("b")), bool(o.get("i"))) if isinstance(o, dict) and it.get("_fi") is not None else None


def _piece_font(p: dict, family: str, fi=None, ob=None) -> tuple[str, float]:
    k = 0.65 if (p["sup"] or p["sub"]) else 1.0
    if fi is not None and ob == (p["b"], p["i"]) and fi.encode(p["t"]) is not None:
        return ORIG, k
    _, name = fontkit.pick(p["t"], family, p["b"], p["i"])
    return name, k


def _piece_width(p: dict, name: str, size: float, fi=None) -> float:
    from reportlab.pdfbase import pdfmetrics

    if name == ORIG:
        return sum(fi.width(c) for c, _ in fi.codes(fi.encode(p["t"]) or b"")) * size
    return pdfmetrics.stringWidth(p["t"], name, size)


def _width(word: list[dict], family: str, size: float, fi=None, ob=None) -> float:
    total = 0.0
    for p in word:
        name, k = _piece_font(p, family, fi, ob)
        total += _piece_width(p, name, size * k, fi)
    return total


def layout(it: dict) -> tuple[list[dict], float]:
    font = it["font"]
    size, lh, family = font["size"], font["lineHeight"], font["family"]
    W = max(4.0, it["w"])
    lines: list[dict] = []
    counters: dict[int, int] = {}
    line_h = size * lh
    fi, ob = it.get("_fi"), _orig_style(it)
    for pi, para in enumerate(it["paras"]):
        kind = para.get("list", "none")
        level = int(para.get("level", 0))
        cont = bool(para.get("cont"))
        if kind != "number" and not cont:
            counters = {k: v for k, v in counters.items() if k < level} if kind == "bullet" else {}
        elif not cont:
            counters = {k: v for k, v in counters.items() if k <= level}
            counters[level] = int(para["start"]) if para.get("start") else counters.get(level, 0) + 1
        indent = level * size * 1.5
        marker = None
        if kind == "bullet":
            marker = "•" if level % 2 == 0 else "–"
        elif kind == "number":
            marker = f"{counters.get(level, 1)}."
        hung = marker is not None
        if cont:
            marker = None
        left = indent + (size * float(para.get("hang", 1.6)) if hung else 0.0)
        avail = max(size, W - left)
        words = _layout_runs(para, font)
        rows: list[list[list[dict]]] = [[]]
        widths: list[float] = [0.0]
        starts: list[int | None] = [0]
        for wi, word in enumerate(words):
            ww = _width(word, family, size, fi, ob)
            is_space = word[0].get("space")
            if is_space and not rows[-1]:
                continue
            if not is_space and rows[-1] and widths[-1] + ww > avail + 0.01:
                while rows[-1] and rows[-1][-1][0].get("space"):
                    widths[-1] -= _width(rows[-1].pop(), family, size, fi, ob)
                rows.append([])
                widths.append(0.0)
                starts.append(wi)
            if not is_space and ww > avail and not rows[-1]:
                chunk: list[dict] = []
                for p in word:
                    for ch in p["t"]:
                        q = {**p, "t": ch}
                        cw = _width([q], family, size, fi, ob)
                        if chunk and _width(chunk, family, size, fi, ob) + cw > avail:
                            rows[-1].append(chunk)
                            widths[-1] = _width(chunk, family, size, fi, ob)
                            rows.append([])
                            widths.append(0.0)
                            starts.append(None)
                            chunk = []
                        chunk.append(q)
                if chunk:
                    rows[-1].append(chunk)
                    widths[-1] += _width(chunk, family, size, fi, ob)
                continue
            rows[-1].append(word)
            widths[-1] += ww
        while rows[-1] and rows[-1][-1][0].get("space"):
            widths[-1] -= _width(rows[-1].pop(), family, size, fi, ob)
        align =para.get("align", "left")
        for n, (row, wd) in enumerate(zip(rows, widths)):
            last = n == len(rows) - 1 and not para.get("split")
            gaps = sum(1 for wdx in row if wdx[0].get("space"))
            extra = 0.0
            x = left
            if align == "center":
                x = left + (avail - wd) / 2
            elif align == "right":
                x = left + avail - wd
            elif align == "justify" and not last and gaps:
                extra = max(0.0, avail - wd) / gaps
            lines.append({"y": len(lines) * line_h, "x": x, "words": row, "extra": extra, "marker": marker if n == 0 else None,
                          "mx": indent, "pi": pi, "wi": starts[n]})
    return lines, max(line_h, len(lines) * line_h)


def _runs_of(words: list[list[dict]]) -> list[dict]:
    runs: list[dict] = []
    for word in words:
        for p in word:
            style = {k: True for k in ("b", "i", "u", "s", "sup", "sub") if p.get(k)}
            style["color"] = p["color"]
            if runs and {k: v for k, v in runs[-1].items() if k != "t"} == style:
                runs[-1]["t"] += p["t"]
            else:
                runs.append({"t": p["t"], **style})
    return runs or [{"t": ""}]


def split_story(font: dict, paras: list[dict], frames: list[tuple[float, float]]) -> tuple[list[list[dict]], bool]:
    line_h = font["size"] * font["lineHeight"]
    rest = list(paras)
    shares: list[list[dict]] = []
    for fw, fh in frames:
        if not rest:
            shares.append([])
            continue
        lines, _ = layout({"font": font, "paras": rest, "w": fw})
        room = int((fh + 0.01) // line_h)
        if len(lines) <= room:
            shares.append(rest)
            rest = []
            continue
        cut = room
        while cut > 0 and (lines[cut]["wi"] is None or (lines[cut]["wi"] == 0 and lines[cut]["pi"] == 0)):
            cut -= 1
        if cut <= 0:
            shares.append([])
            continue
        pi, wi = lines[cut]["pi"], lines[cut]["wi"]
        para = rest[pi]
        words = _layout_runs(para, font)
        tail = words[wi:]
        while tail and tail[0][0].get("space"):
            tail = tail[1:]
        head = rest[:pi] + ([{**para, "runs": _runs_of(words[:wi]), "split": True}] if wi > 0 else [])
        shares.append(head)
        rest = ([{**{k: v for k, v in para.items() if k != "split"}, "runs": _runs_of(tail), "cont": wi > 0 or bool(para.get("cont"))}] if tail else []) + rest[pi + 1:]
    return shares, bool(rest)


def _ascent(family: str) -> tuple[float, float]:
    from reportlab.pdfbase import pdfmetrics

    face = getattr(pdfmetrics.getFont(fontkit.font_name(family)), "face", None)
    asc = getattr(face, "ascent", 800) / 1000 if face is not None else 0.8
    desc = abs(getattr(face, "descent", -200)) / 1000 if face is not None else 0.2
    return asc, desc


def baseline(it: dict) -> float:
    font = it["font"]
    size, lh = font["size"], font["lineHeight"]
    fi = it.get("_fi") if _orig_style(it) is not None else None
    asc, desc = (fi.ascent, -fi.descent) if fi is not None else _ascent(font["family"])
    return (size * lh - (asc + desc) * size) / 2 + asc * size


def _text_form(w: PdfWriter, it: dict):
    from reportlab.pdfgen import canvas as rlcanvas

    lines, height = layout(it)
    if it.get("auto", True):
        it["h"] = round(height, 3)
    H = max(1.0, it["h"])
    font = it["font"]
    size, family = font["size"], font["family"]
    fi, ob = it.get("_fi"), _orig_style(it)
    base = baseline(it)
    raw: list[str] = []
    buf = io.BytesIO()
    c = rlcanvas.Canvas(buf, pagesize=(max(1.0, it["w"]), H))
    for ln in lines:
        y = H - (ln["y"] + base)
        if ln["marker"]:
            c.setFillColorRGB(*_rgb(font["color"]))
            name = fontkit.pick(ln["marker"], family)[1]
            c.setFont(name, size)
            c.drawString(ln["mx"], y, ln["marker"])
        x = ln["x"]
        for word in ln["words"]:
            if word[0].get("space"):
                x += _width(word, family, size, fi, ob) + ln["extra"]
                continue
            for p in word:
                name, k = _piece_font(p, family, fi, ob)
                sz = size * k
                rise = size * 0.33 if p["sup"] else -size * 0.12 if p["sub"] else 0.0
                pw = _piece_width(p, name, sz, fi)
                col = _rgb(p["color"])
                if name == ORIG:
                    raw.append(f"BT {ORIG_RES} {_num(sz)} Tf {_num(col[0])} {_num(col[1])} {_num(col[2])} rg 1 0 0 1 {_num(x)} {_num(y + rise)} Tm "
                               f"<{fi.encode(p['t']).hex()}> Tj ET")
                else:
                    c.setFillColorRGB(*col)
                    c.setFont(name, sz)
                    c.drawString(x, y + rise, p["t"])
                if p["u"] or p["s"]:
                    c.setStrokeColorRGB(*col)
                    c.setLineWidth(max(0.4, sz * 0.06))
                    if p["u"]:
                        c.line(x, y + rise - sz * 0.12, x + pw, y + rise - sz * 0.12)
                    if p["s"]:
                        c.line(x, y + rise + sz * 0.28, x + pw, y + rise + sz * 0.28)
                x += pw
    c.showPage()
    c.save()
    page = PdfReader(io.BytesIO(buf.getvalue())).pages[0]
    form = annot._form(w, page, [0, 0, max(1.0, it["w"]), H])
    alpha = font.get("opacity", 1.0)
    if raw or alpha < 0.999:
        obj = form.get_object()
        head = b"/FpA gs\n" if alpha < 0.999 else b""
        obj.set_data(head + obj.get_data() + (("\nq " + " ".join(raw) + " Q\n") if raw else "").encode())
        res = obj.get("/Resources")
        res = DictionaryObject(res.get_object()) if res is not None else DictionaryObject()
        if raw:
            fonts = res.get("/Font")
            fonts = DictionaryObject(fonts.get_object()) if fonts is not None else DictionaryObject()
            fonts[ORIG_RES] = it["_oref"]
            res[NameObject("/Font")] = fonts
        if head:
            gs = res.get("/ExtGState")
            gs = DictionaryObject(gs.get_object()) if gs is not None else DictionaryObject()
            gs[NameObject("/FpA")] = DictionaryObject({NameObject("/Type"): NameObject("/ExtGState"), NameObject("/ca"): FloatObject(alpha),
                                                       NameObject("/CA"): FloatObject(alpha)})
            res[NameObject("/ExtGState")] = gs
        obj[NameObject("/Resources")] = res
    return form


def _orient_matrix(o: int) -> tuple:
    fn = ORIENT.get(o, ORIENT[1])

    def disp(a: float, b: float) -> tuple[float, float]:
        u2, v2 = fn(a, 1 - b)
        return u2, 1 - v2

    ox, oy = disp(0, 0)
    ax, ay = disp(1, 0)
    bx, by = disp(0, 1)
    return (ax - ox, ay - oy, bx - ox, by - oy, ox, oy)


def _picture_form(w: PdfWriter, it: dict, image_ref):
    l, t, r, b = (it["crop"].get(k, 0.0) for k in ("l", "t", "r", "b"))
    fw, fh = max(0.01, 1 - l - r), max(0.01, 1 - t - b)
    W, H = it["w"] / fw, it["h"] / fh
    ops = f"q {_mat((W, 0, 0, H, -l * W, -b * H))} cm {_mat(_orient_matrix(int(it.get('orient', 1))))} cm /Im Do Q\n"
    s = DecodedStreamObject()
    s.set_data(ops.encode())
    s[NameObject("/Type")] = NameObject("/XObject")
    s[NameObject("/Subtype")] = NameObject("/Form")
    s[NameObject("/BBox")] = ArrayObject([FloatObject(0), FloatObject(0), FloatObject(round(it["w"], 4)), FloatObject(round(it["h"], 4))])
    s[NameObject("/Resources")] = DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/Im"): image_ref})})
    return w._add_object(s)


def _decode_data(v) -> bytes:
    s = str(v or "")
    m = re.match(r"data:[\w/+.-]+;base64,(.*)$", s, re.S)
    try:
        return base64.b64decode(m.group(1) if m else s, validate=False)
    except Exception:
        raise ValueError("The picture data is not valid base64") from None


def image_object(w: PdfWriter, data: bytes) -> tuple:
    from PIL import Image

    if len(data) > MAX_IMAGE:
        raise ValueError("Pictures can be at most 60 MB")
    try:
        pil = Image.open(io.BytesIO(data))
        pil.load()
    except Exception:
        raise ValueError("That file is not a picture formpdf can read (PNG, JPEG, GIF, WebP, BMP or TIFF)") from None
    try:
        orient = int(pil.getexif().get(274, 1) or 1)
    except Exception:
        orient = 1
    orient = orient if orient in ORIENT else 1
    iw, ih = pil.size
    s = StreamObject()
    s[NameObject("/Type")] = NameObject("/XObject")
    s[NameObject("/Subtype")] = NameObject("/Image")
    s[NameObject("/Width")] = NumberObject(iw)
    s[NameObject("/Height")] = NumberObject(ih)
    s[NameObject("/BitsPerComponent")] = NumberObject(8)
    fmt = (pil.format or "").upper()
    if fmt == "JPEG" and pil.mode in ("L", "RGB", "CMYK"):
        s[NameObject("/ColorSpace")] = NameObject({"L": "/DeviceGray", "RGB": "/DeviceRGB", "CMYK": "/DeviceCMYK"}[pil.mode])
        if pil.mode == "CMYK" and "adobe" in pil.info:
            s[NameObject("/Decode")] = ArrayObject([NumberObject(v) for v in (1, 0, 1, 0, 1, 0, 1, 0)])
        s[NameObject("/Filter")] = NameObject("/DCTDecode")
        s._data = data
        return w._add_object(s), iw, ih, orient, "jpeg"
    if getattr(pil, "n_frames", 1) > 1:
        pil.seek(0)
    alpha = pil.mode in ("RGBA", "LA", "PA") or (pil.mode == "P" and "transparency" in pil.info)
    gray = pil.mode in ("L", "LA", "1", "I", "I;16")
    base = pil.convert("LA" if gray and alpha else "L" if gray else "RGBA" if alpha else "RGB")
    if alpha:
        a = base.getchannel("A")
        base = base.convert("L" if gray else "RGB")
        if a.getextrema() != (255, 255):
            m = StreamObject()
            m[NameObject("/Type")] = NameObject("/XObject")
            m[NameObject("/Subtype")] = NameObject("/Image")
            m[NameObject("/Width")] = NumberObject(iw)
            m[NameObject("/Height")] = NumberObject(ih)
            m[NameObject("/BitsPerComponent")] = NumberObject(8)
            m[NameObject("/ColorSpace")] = NameObject("/DeviceGray")
            m[NameObject("/Filter")] = NameObject("/FlateDecode")
            m._data = zlib.compress(a.tobytes(), 6)
            s[NameObject("/SMask")] = w._add_object(m)
    s[NameObject("/ColorSpace")] = NameObject("/DeviceGray" if gray else "/DeviceRGB")
    s[NameObject("/Filter")] = NameObject("/FlateDecode")
    s._data = zlib.compress(base.tobytes(), 6)
    return w._add_object(s), iw, ih, orient, fmt.lower() or "png"


def _norm_paras(v, font: dict) -> list[dict]:
    if isinstance(v, str):
        v = [{"runs": [{"t": line}]} for line in v.replace("\r\n", "\n").split("\n")]
    out = []
    total = 0
    for p in v or []:
        if not isinstance(p, dict):
            continue
        runs = []
        for r in p.get("runs") or []:
            if not isinstance(r, dict):
                continue
            t = str(r.get("t") if r.get("t") is not None else r.get("text") or "").replace("\n", " ")[: MAX_TEXT - total]
            total += len(t)
            run = {"t": t}
            for k in ("b", "i", "u", "s", "sup", "sub"):
                if r.get(k):
                    run[k] = True
            if run.get("sup") and run.get("sub"):
                del run["sub"]
            if r.get("color"):
                run["color"] = _color(r.get("color"), font["color"])
            runs.append(run)
        out.append({"align": p.get("align") if p.get("align") in ALIGNS else "left", "list": p.get("list") if p.get("list") in LISTS else "none",
                    "level": int(_f(p.get("level"), 0, 0, 6)), "runs": runs or [{"t": ""}],
                    **({"hang": round(_f(p.get("hang"), 1.6, 0.3, 4), 3)} if p.get("hang") is not None else {}),
                    **({"start": int(_f(p.get("start"), 1, 1, 9999))} if p.get("start") is not None and p.get("list") == "number" else {})})
    return out or [{"align": "left", "list": "none", "level": 0, "runs": [{"t": ""}]}]


def _norm_font(v, base: dict | None = None) -> dict:
    v = v if isinstance(v, dict) else {}
    base = base or {"family": "sans", "size": 12.0, "color": "#111111", "lineHeight": 1.25}
    fam = v.get("family", base["family"])
    out = {"family": fam if fontkit.known(fam) else "sans", "size": _f(v.get("size"), base["size"], 4, 288),
           "color": _color(v.get("color"), base["color"]), "lineHeight": _f(v.get("lineHeight"), base["lineHeight"], 0.8, 4)}
    op = _f(v.get("opacity", base.get("opacity", 1.0)), 1.0, 0.02, 1.0)
    if op < 0.999:
        out["opacity"] = round(op, 3)
    orig = v.get("orig", base.get("orig")) if fam == base["family"] else None
    if isinstance(orig, dict) and orig.get("name"):
        out["orig"] = {"name": str(orig["name"])[:80], "b": bool(orig.get("b")), "i": bool(orig.get("i"))}
    return out


def _geo(it: dict, req: dict) -> None:
    for k, lo, hi in (("x", -5000, 20000), ("y", -5000, 20000), ("w", 1, 20000), ("h", 1, 20000)):
        if k in req:
            it[k] = round(_f(req[k], it.get(k, 0), lo, hi), 3)
    if "rot" in req:
        it["rot"] = round((_f(req["rot"], 0, -100000, 100000) + 180) % 360 - 180, 3)
    for k in ("flipH", "flipV"):
        if k in req:
            it[k] = bool(req[k])


def _text_item(req: dict, old: dict | None = None) -> dict:
    it = dict(old) if old else {"v": 1, "kind": "text", "rot": 0.0, "x": 36.0, "y": 36.0, "w": 240.0, "h": 20.0, "auto": True}
    it["font"] = _norm_font(req.get("font") if "font" in req else {k: req[k] for k in ("family", "size", "color", "lineHeight") if k in req},
                            old.get("font") if old else None)
    if "paras" in req or "text" in req:
        paras = _norm_paras(req.get("paras", req.get("text")), it["font"])
        if "paras" in req and old and old.get("paras"):
            hangs = [p.get("hang") for p in old["paras"] if p.get("hang")]
            for p in paras:
                if p.get("list") == "bullet" and "hang" not in p and hangs:
                    p["hang"] = hangs[0]
        if "paras" not in req and old and old.get("paras"):
            first = (old["paras"][0].get("runs") or [{}])[0]
            for p in paras:
                p["align"] = old["paras"][0].get("align", "left")
                for r in p["runs"]:
                    r.update({k: True for k in ("b", "i", "u", "s") if first.get(k)})
        for k in ("align", "list"):
            if k in req and req[k] in (ALIGNS if k == "align" else LISTS):
                for p in paras:
                    p[k] = req[k]
        if req.get("bold") or req.get("italic"):
            for p in paras:
                for r in p["runs"]:
                    if req.get("bold"):
                        r["b"] = True
                    if req.get("italic"):
                        r["i"] = True
        it["paras"] = paras
    it.setdefault("paras", _norm_paras("", it["font"]))
    if "auto" in req:
        it["auto"] = bool(req["auto"])
    _geo(it, req)
    if "h" in req and "auto" not in req:
        it["auto"] = False
    if "w" in req:
        it.pop("fit", None)
    return it


def _crop(v, old: dict | None = None) -> dict:
    v = v if isinstance(v, dict) else {}
    old = old or {"l": 0.0, "t": 0.0, "r": 0.0, "b": 0.0}
    c = {k: round(_f(v.get(k), old.get(k, 0.0), 0, 0.95), 5) for k in ("l", "t", "r", "b")}
    if c["l"] + c["r"] > 0.95 or c["t"] + c["b"] > 0.95:
        raise ValueError("A crop must leave some of the picture showing")
    return c


def _recrop(it: dict, old: dict) -> None:
    c = it["crop"]
    ol, ot, orr, ob = (old.get(k, 0.0) for k in ("l", "t", "r", "b"))
    W, H = it["w"] / max(0.01, 1 - ol - orr), it["h"] / max(0.01, 1 - ot - ob)
    nw, nh = W * (1 - c["l"] - c["r"]), H * (1 - c["t"] - c["b"])
    dx = (c["l"] - ol) * W + nw / 2 - it["w"] / 2
    dy = (c["t"] - ot) * H + nh / 2 - it["h"] / 2
    if it.get("flipH"):
        dx = -dx
    if it.get("flipV"):
        dy = -dy
    th = math.radians(it.get("rot", 0.0))
    rx, ry = dx * math.cos(th) - dy * math.sin(th), dx * math.sin(th) + dy * math.cos(th)
    cx, cy = it["x"] + it["w"] / 2 + rx, it["y"] + it["h"] / 2 + ry
    it["w"], it["h"] = round(nw, 3), round(nh, 3)
    it["x"], it["y"] = round(cx - nw / 2, 3), round(cy - nh / 2, 3)


class Page:
    def __init__(self, w: PdfWriter, n: int):
        self.w = w
        self.n = n
        self.page = w.pages[n - 1]
        self.arr = _entries(w, self.page)
        self.res, self.xo = _resources(self.page)

    def items(self) -> list[tuple[int, dict]]:
        out = []
        for i, r in enumerate(self.arr):
            k, v = _kind(r)
            if k == "item" and isinstance(v, dict):
                out.append((i, v))
        return out

    def find(self, item_id: str) -> tuple[int, dict]:
        for i, v in self.items():
            if v.get("id") == item_id:
                return i, v
        raise ValueError(f"There is no item {item_id} on page {self.n}")

    def form_ref(self, item_id: str):
        return self.xo.raw_get(NameObject(PREFIX + item_id)) if NameObject(PREFIX + item_id) in self.xo else None

    def write(self, it: dict, at: int | None = None, form=None) -> None:
        self.prep()
        if form is None:
            form = self.render(it)
        self.xo[NameObject(PREFIX + it["id"])] = form
        ref = _item_stream(self.w, self.page, it)
        if at is None:
            self.arr.append(ref)
        else:
            self.arr[at] = ref

    def render(self, it: dict):
        if it["kind"] == "text":
            ref = it.pop("_oref", None)
            if it["font"].get("orig") and ref is None:
                ref = _form_font(self.form_ref(it["id"]))
            if ref is None:
                it["font"].pop("orig", None)
            else:
                it["_oref"], it["_fi"] = ref, FontInfo(ref)
            try:
                if it.get("fit") and all(p.get("align", "left") == "left" for p in it["paras"]):
                    self.fit(it)
                form = _text_form(self.w, it)
            finally:
                it.pop("_oref", None)
                it.pop("_fi", None)
        else:
            img = it.pop("_image", None) or _form_image(self.form_ref(it["id"]))
            if img is None:
                raise ValueError("The picture of this item is missing")
            form = _picture_form(self.w, it, img)
        form.get_object()[KEY] = TextStringObject(json.dumps(_public(it), separators=(",", ":"), ensure_ascii=False))
        return form

    def fit(self, it: dict) -> None:
        font = it["font"]
        fi, ob = it.get("_fi"), _orig_style(it)
        lines, _ = layout({**it, "w": 1e6})
        natural = max((ln["x"] + sum(_width(wd, font["family"], font["size"], fi, ob) for wd in ln["words"]) for ln in lines), default=0.0)
        vx0, _, vx1, _ = core.view_box(self.page)
        room = max(it["w"], (vx1 - vx0) - it["x"] - 18)
        it["w"] = round(max(it["w"], min(natural + 0.5, room)), 3)

    def base_ops(self) -> tuple[list, list[tuple[int, int, int]]]:
        begin, end = _wrap_bounds(self.arr)
        ops: list = []
        spans: list[tuple[int, int, int]] = []
        for i, r in enumerate(self.arr):
            k, _ = _kind(r)
            if k != "base" or (begin >= 0 and not begin < i < end):
                continue
            try:
                part = ContentStream(r.get_object(), self.w).operations
            except Exception:
                part = []
            spans.append((i, len(ops), len(part)))
            ops.extend(part)
        return ops, spans

    def pictures(self) -> list[dict]:
        ops, _ = self.base_ops()
        it = interp.Interpreter(self.w, forms=False)
        it.run(ops, self.res, interp.IDENTITY, (), 0, set())
        out = []
        for d in it.out.draws:
            if d.kind != "image":
                continue
            xo = self.xo.get(NameObject(d.name))
            xo = xo.get_object() if xo is not None else None
            if xo is None:
                continue
            g = _geometry(self.page, d.ctm)
            if g["w"] < 4 or g["h"] < 4:
                continue
            out.append({"page": self.n, "op": d.op, "name": d.name, **g, "iw": int(xo.get("/Width", 0) or 0), "ih": int(xo.get("/Height", 0) or 0)})
        return out

    def convert(self, op: int) -> dict:
        self.prep()
        ops, spans = self.base_ops()
        if not 0 <= op < len(ops) or ops[op][1] != b"Do":
            raise ValueError(f"There is no picture at that place on page {self.n}; list the page's items again")
        it = interp.Interpreter(self.w, forms=False)
        it.run(ops, self.res, interp.IDENTITY, (), 0, set())
        draw = next((d for d in it.out.draws if d.op == op and d.kind == "image"), None)
        if draw is None:
            raise ValueError(f"There is no picture at that place on page {self.n}")
        img = self.xo.raw_get(NameObject(draw.name))
        xo = img.get_object()
        pos, start, n = next(s for s in spans if s[1] <= op < s[1] + s[2])
        local = op - start
        frag = ops[start:start + n]
        a = ContentStream(None, self.w)
        a.operations = frag[:local]
        b = ContentStream(None, self.w)
        b.operations = frag[local + 1:]
        a_ref, b_ref = self.w._add_object(DecodedStreamObject()), self.w._add_object(DecodedStreamObject())
        a_ref.get_object().set_data(a.get_data())
        b_ref.get_object().set_data(b.get_data())
        new = {"v": 1, "id": _new_id(), "kind": "picture", "page": self.n, **_geometry(self.page, draw.ctm),
               "crop": {"l": 0.0, "t": 0.0, "r": 0.0, "b": 0.0}, "iw": int(xo.get("/Width", 0) or 0), "ih": int(xo.get("/Height", 0) or 0),
               "orient": 1, "format": "existing", "ctx": list(draw.ctm)}
        new["_image"] = img
        self.arr[pos] = a_ref
        self.arr.insert(pos + 1, b_ref)
        form = self.render(new)
        self.xo[NameObject(PREFIX + new["id"])] = form
        self.arr.insert(pos + 1, _item_stream(self.w, self.page, new))
        return new

    def remove(self, item_id: str) -> None:
        i, _ = self.find(item_id)
        del self.arr[i]
        if NameObject(PREFIX + item_id) in self.xo:
            del self.xo[NameObject(PREFIX + item_id)]

    def prep(self) -> None:
        _ensure_wrap(self.w, self.arr)

    def arrange(self, item_id: str, to: str) -> None:
        if to not in ("front", "back", "forward", "backward"):
            raise ValueError("to is front, back, forward or backward")
        self.prep()
        i, it = self.find(item_id)
        ref = self.arr.pop(i)
        begin, end = _wrap_bounds(self.arr)
        is_item = {j for j, _ in self.items()}
        if to == "front":
            at = len(self.arr)
        elif to == "back":
            at = 0
        elif to == "forward":
            at = i + 1 if i in is_item else (end + 1 if i <= end else i)
        else:
            at = i - 1 if i - 1 in is_item else (begin if i > begin else i)
        at = max(0, min(at, len(self.arr)))
        self.arr.insert(at, ref)
        begin, end = _wrap_bounds(self.arr)
        if it.get("ctx") and not begin < at < end:
            it["ctx"] = None
            self.arr[at] = _item_stream(self.w, self.page, it)


def _form_image(form_ref):
    if form_ref is None:
        return None
    if isinstance(form_ref, IndirectObject) and str(form_ref.get_object().get("/Subtype", "")) == "/Image":
        return form_ref
    res = form_ref.get_object().get("/Resources")
    xo = res.get_object().get("/XObject") if res is not None else None
    return xo.get_object().raw_get(NameObject("/Im")) if xo is not None and NameObject("/Im") in xo.get_object() else None


def _form_font(form_ref):
    if form_ref is None:
        return None
    res = form_ref.get_object().get("/Resources")
    fonts = res.get_object().get("/Font") if res is not None else None
    fonts = fonts.get_object() if fonts is not None else None
    return fonts.raw_get(ORIG_RES) if fonts is not None and ORIG_RES in fonts else None


def _arrange_comment(w: PdfWriter, n: int, index: int, to: str) -> None:
    if to not in ("front", "back", "forward", "backward"):
        raise ValueError("to is front, back, forward or backward")
    if not 1 <= n <= len(w.pages):
        raise ValueError("A comment to arrange needs its page")
    page = w.pages[n - 1]
    arr = page.get("/Annots")
    arr = arr.get_object() if arr is not None else None
    if arr is None or not 0 <= index < len(arr):
        raise ValueError(f"There is no comment {index} on page {n}")
    listed = [k for k, r in enumerate(arr) if str(r.get_object().get("/Subtype", "")) in annot.LISTED and "/IRT" not in r.get_object()]
    if index not in listed:
        raise ValueError(f"Item {index} on page {n} is not a comment")
    pos = listed.index(index)
    if to == "front":
        target = listed[-1]
    elif to == "back":
        target = listed[0]
    elif to == "forward":
        target = listed[min(pos + 1, len(listed) - 1)]
    else:
        target = listed[max(pos - 1, 0)]
    ref = arr[index]
    new = ArrayObject(r for k, r in enumerate(arr) if k != index)
    new.insert(target, ref)
    page[NameObject("/Annots")] = new


def _page_keys(w: PdfWriter, n: int) -> str:
    pg = w.pages[n - 1]
    raw = pg.raw_get("/Contents") if "/Contents" in pg else None
    if raw is None:
        return ""
    obj = raw.get_object()
    refs = list(obj) if isinstance(obj, ArrayObject) else [raw]
    return "".join(str(r.get_object().get(KEY, "")) for r in refs)


def _new_id() -> str:
    return uuid.uuid4().hex[:10]


def _merged(page_obj, arr) -> list[dict]:
    seen = set()
    for r in arr:
        k, v = _kind(r)
        if k == "item" and isinstance(v, dict):
            seen.add(v.get("id"))
    res = page_obj.get("/Resources")
    xo = res.get_object().get("/XObject") if res is not None else None
    out = []
    if xo is None:
        return out
    for name, ref in xo.get_object().items():
        if not str(name).startswith(PREFIX) or str(name)[len(PREFIX):] in seen:
            continue
        obj = ref.get_object()
        if KEY in obj:
            try:
                v = json.loads(str(obj[KEY]))
            except ValueError:
                continue
            v["merged"] = True
            out.append(v)
    return out


def read(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    r = core.reader(path, passwords)
    want = core.parse_pages(pages or (args or {}).get("pages"), len(r.pages))
    w = PdfWriter(clone_from=r)
    from . import textedit

    items, pics, paras = [], [], []
    for n in want:
        p = Page(w, n)
        for z, (_, v) in enumerate(p.items()):
            items.append({**_public(v), "page": n, "z": z, "inside": bool(v.get("ctx"))})
        for v in _merged(p.page, p.arr):
            items.append({**_public(v), "page": n, "z": -1, "merged": True})
        if not (args or {}).get("items_only"):
            pics += p.pictures()
            if (args or {}).get("text", True):
                paras += textedit.listing(p)
    lines = [f"p{i['page']} item {i['id']} · {i['kind']} · {i['x']:.0f},{i['y']:.0f} {i['w']:.0f}x{i['h']:.0f}"
             + (f" · {_plain(i)[:60]}" if i["kind"] == "text" else "") for i in items]
    lines += [f"p{p['page']} picture at op {p['op']} · {p['x']:.0f},{p['y']:.0f} {p['w']:.0f}x{p['h']:.0f} · {p['iw']}x{p['ih']} px" for p in pics]
    lines += [f"p{t['page']} text {t['key']} · {t['x']:.0f},{t['y']:.0f} {t['w']:.0f}x{t['h']:.0f} · {t['fontName'] or t['font']['family']} "
              f"{t['font']['size']:g} · {t['text'][:60]}" for t in paras]
    return ("\n".join(lines) or "No added items, pictures or text."), {"items": items, "pictures": pics, "paragraphs": paras}


def _plain(it: dict) -> str:
    return "\n".join("".join(r.get("t", "") for r in p.get("runs", [])) for p in it.get("paras", []))


def _unmerge(p: Page, item_id: str) -> dict | None:
    for v in _merged(p.page, p.arr):
        if v.get("id") != item_id:
            continue
        ops, spans = p.base_ops()
        for k, (operands, op) in enumerate(ops):
            if op == b"Do" and operands and str(operands[0]) == PREFIX + item_id:
                pos, start, n = next(s for s in spans if s[1] <= k < s[1] + s[2])
                frag = ops[start:start + n]
                cs = ContentStream(None, p.w)
                cs.operations = frag[:k - start] + frag[k - start + 1:]
                ref = p.w._add_object(DecodedStreamObject())
                ref.get_object().set_data(cs.get_data())
                p.arr[pos] = ref
                break
        v.pop("merged", None)
        v["ctx"] = None
        v["_image"] = _form_image(p.form_ref(item_id)) if v.get("kind") == "picture" else None
        if v.get("kind") == "picture" and v["_image"] is None:
            v.pop("_image")
        p.write(v)
        return v
    return None


def change(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    for key in ("add", "update", "arrange", "remove", "comments", "thread"):
        if args.get(key) is not None and not isinstance(args[key], list):
            raise ValueError(f"{key} must be a list, not {type(args[key]).__name__}; nothing was changed")
    if "create" in args and "add" not in args:
        raise ValueError("Use add (not create) for new text and pictures; the keys are add, update, arrange, comments and remove")
    w = PdfWriter(clone_from=core.reader(src, passwords))
    n_pages = len(w.pages)
    cache: dict[int, Page] = {}

    def page(n) -> Page:
        try:
            n = int(n)
        except (TypeError, ValueError):
            raise ValueError("Every item needs a page number") from None
        if not 1 <= n <= n_pages:
            raise ValueError(f"Page {n} is out of range (1 to {n_pages})")
        if n not in cache:
            cache[n] = Page(w, n)
        return cache[n]

    def holds(n: int, item_id: str) -> bool:
        res = w.pages[n - 1].get("/Resources")
        xo = res.get_object().get("/XObject") if res is not None else None
        return xo is not None and NameObject(PREFIX + item_id) in xo.get_object()

    def locate(req: dict) -> tuple[Page, int, dict]:
        if req.get("paragraph") is not None and req.get("page") is not None:
            from . import textedit

            p = page(req["page"])
            key = f"{p.n}:t{req['paragraph']}"
            if key not in converted:
                converted[key] = textedit.convert(p, str(req["paragraph"]))["id"]
            i, it = p.find(converted[key])
            return p, i, it
        if req.get("picture") is not None and req.get("page") is not None:
            p = page(req["page"])
            key = f"{p.n}:{int(req['picture'])}"
            if key not in converted:
                converted[key] = p.convert(int(req["picture"]))["id"]
            i, it = p.find(converted[key])
            return p, i, it
        item_id = str(req.get("id") or "")
        if req.get("page") is not None:
            targets = [page(req["page"])]
        else:
            targets = [page(n) for n in range(1, n_pages + 1) if holds(n, item_id)]
        for p in targets:
            try:
                i, it = p.find(item_id)
                return p, i, it
            except ValueError:
                v = _unmerge(p, item_id)
                if v is not None:
                    i, it = p.find(item_id)
                    return p, i, it
        raise ValueError(f"There is no item {item_id}")

    touched: set[str] = set()
    threaded = 0

    def frames_of(tid: str) -> list[tuple[int, dict]]:
        found = [(n, v) for n in range(1, n_pages + 1) if f"\"thread\":\"{tid}\"" in _page_keys(w, n) for _, v in page(n).items() if v.get("thread") == tid]
        return sorted(found, key=lambda t: int(t[1].get("seq") or 0))

    def store(n: int, v: dict) -> None:
        p = page(n)
        i, _ = p.find(v["id"])
        p.write(v, at=i, form=p.form_ref(v["id"]))

    def spare(n: int, v: dict) -> bool:
        p = page(n)
        if p.page.get("/Annots") or [x.get("id") for _, x in p.items()] != [v.get("id")]:
            return False
        return all(_kind(r)[0] != "base" or not r.get_object().get_data().strip() for r in p.arr)

    def flow(tid: str) -> None:
        nonlocal n_pages
        fr = frames_of(tid)
        if not fr:
            return
        if len(fr) == 1 and not fr[0][1].get("grow"):
            n, v = fr[0]
            solo = {k: x for k, x in v.items() if k not in ("thread", "seq", "overflow", "grow")}
            solo["auto"] = True
            page(n).write(solo, at=page(n).find(v["id"])[0])
            return
        head = fr[0][1]
        font, story = head["font"], head["paras"]
        grow = any(v.get("grow") for _, v in fr)
        shares, over = split_story(font, story, [(v["w"], v["h"]) for _, v in fr])
        while over and grow and n_pages < 2000 and len(fr) < 200:
            n, last = fr[-1]
            box = w.pages[n - 1].mediabox
            w.insert_blank_page(width=float(box.width), height=float(box.height), index=n)
            n_pages += 1
            cache.clear()
            nxt = {k: x for k, x in last.items() if k not in ("overflow",)}
            nxt.update({"id": _new_id(), "page": n + 1, "seq": int(last.get("seq") or 0) + 1, "paras": _norm_paras("", font), "grown": True})
            page(n + 1).write({**nxt, "paras": _norm_paras("", font)})
            fr = frames_of(tid)
            shares, over = split_story(font, story, [(v["w"], v["h"]) for _, v in fr])
        while grow and not over and len(fr) > 1 and not shares[-1] and fr[-1][1].get("grown") and spare(*fr[-1]):
            w.remove_page(fr[-1][0] - 1)
            n_pages -= 1
            cache.clear()
            fr = frames_of(tid)
            shares, over = split_story(font, story, [(v["w"], v["h"]) for _, v in fr])
        for k, ((n, v), share) in enumerate(zip(fr, shares)):
            kept = {key: x for key, x in v.items() if key not in ("overflow", "fit")}
            kept.update({"thread": tid, "seq": k, "auto": False, "font": font})
            kept["paras"] = story if k == 0 else _norm_paras("", font)
            if over and k == len(fr) - 1:
                kept["overflow"] = True
            p = page(n)
            i, _ = p.find(v["id"])
            form = p.render({**kept, "paras": share or _norm_paras("", font)})
            form.get_object()[KEY] = TextStringObject(json.dumps(_public(kept), separators=(",", ":"), ensure_ascii=False))
            p.write(kept, at=i, form=form)

    added: list[str] = []
    converted: dict[str, str] = {}
    updated = removed = arranged = 0
    reqs = [r for key in ("update", "arrange", "remove") for r in args.get(key) or [] if isinstance(r, dict) and r.get("page") is not None]
    wanted = {(int(r["page"]), int(r["picture"]), "") for r in reqs if r.get("picture") is not None}
    for r in reqs:
        if r.get("paragraph") is not None and not re.fullmatch(r"\d+\.\d+", str(r["paragraph"])):
            raise ValueError("paragraph is the key a listing gave, such as 12.0; list the page's text again")
    texts: dict[int, list[str]] = {}
    for r in reqs:
        if r.get("paragraph") is not None and r.get("picture") is None:
            texts.setdefault(int(r["page"]), []).append(str(r["paragraph"]))
    shifts: dict[int, dict[int, int]] = {}
    for n, keys in texts.items():
        from . import textedit

        made, shifts[n] = textedit.convert_many(page(n), keys)
        for k, it in made.items():
            converted[f"{n}:t{k}"] = it["id"]
    for n, op, _ in sorted(wanted, key=lambda t: (t[0], -t[1])):
        converted[f"{n}:{op}"] = page(n).convert(shifts.get(n, {}).get(op, op))["id"]
    links: list[dict] = [r for r in args.get("thread") or [] if isinstance(r, dict)]
    for req in args.get("add") or []:
        if not isinstance(req, dict):
            continue
        p = page(req.get("page"))
        if len(p.items()) >= MAX_ITEMS:
            raise ValueError(f"A page can hold at most {MAX_ITEMS} added items")
        kind = req.get("kind", "text")
        if kind == "text":
            it = _text_item(req)
        elif kind == "picture":
            data = Path(str(req["path"])).expanduser().read_bytes() if req.get("path") else _decode_data(req.get("data"))
            img, iw, ih, orient, fmt = image_object(w, data)
            dw, dh = (ih, iw) if orient >= 5 else (iw, ih)
            pw = core.view_box(p.page)[2] - core.view_box(p.page)[0]
            width = _f(req.get("w"), min(dw * 0.75, pw * 0.5), 1, 20000)
            it = {"v": 1, "kind": "picture", "rot": 0.0, "x": 36.0, "y": 36.0, "w": width, "h": _f(req.get("h"), width * dh / max(1, dw), 1, 20000),
                  "crop": _crop(req.get("crop")), "iw": iw, "ih": ih, "orient": orient, "format": fmt, "_image": img}
            _geo(it, {k: v for k, v in req.items() if k not in ("w", "h")})
        else:
            raise ValueError("kind is text or picture")
        it["id"] = _new_id()
        it["page"] = p.n
        z = req.get("at")
        p.write(it)
        if z == "back":
            p.arrange(it["id"], "back")
        added.append(it["id"])
        if req.get("after") and kind == "text":
            links.append({"from": str(req["after"]), "to": it["id"]})
    for req in args.get("update") or []:
        if not isinstance(req, dict):
            continue
        p, i, it = locate(req)
        if it.get("thread") and int(it.get("seq") or 0) > 0 and any(k in req for k in ("paras", "text", "font", "family", "size", "color", "lineHeight")):
            hn, head = frames_of(str(it["thread"]))[0]
            store(hn, _text_item({k: v for k, v in req.items() if k in ("paras", "text", "font", "family", "size", "color", "lineHeight", "align", "list", "bold", "italic")}, head))
            req = {k: v for k, v in req.items() if k not in ("paras", "text", "font", "family", "size", "color", "lineHeight", "align", "list", "bold", "italic")}
        if it["kind"] == "text":
            new = _text_item(req, it)
            if "grow" in req:
                new["grow"] = bool(req["grow"])
            if new.get("grow") and not new.get("thread"):
                new.update({"thread": "T" + new["id"], "seq": 0})
                if it.get("auto", True):
                    vb = core.view_box(p.page)
                    line = new["font"]["size"] * new["font"]["lineHeight"]
                    new["h"] = round(min(new["h"], max(line, (vb[3] - vb[1]) - new["y"] - 36)), 3)
            if new.get("thread"):
                new["auto"] = False
                touched.add(str(new["thread"]))
        else:
            new = dict(it)
            if "crop" in req:
                new["crop"] = _crop(req["crop"], it.get("crop"))
                if not any(k in req for k in ("x", "y", "w", "h")):
                    _recrop(new, it.get("crop") or {})
            _geo(new, req)
            if req.get("path") or req.get("data"):
                data = Path(str(req["path"])).expanduser().read_bytes() if req.get("path") else _decode_data(req.get("data"))
                img, iw, ih, orient, fmt = image_object(w, data)
                dw, dh = (ih, iw) if orient >= 5 else (iw, ih)
                cy = new["y"] + new["h"] / 2
                new["h"] = round(new["w"] * dh / max(1, dw), 3)
                new["y"] = round(cy - new["h"] / 2, 3)
                new.update({"iw": iw, "ih": ih, "orient": orient, "format": fmt, "crop": _crop(None), "_image": img})
        target = req.get("to_page")
        if target is not None and int(target) != p.n:
            dest = page(target)
            if len(dest.items()) >= MAX_ITEMS:
                raise ValueError(f"A page can hold at most {MAX_ITEMS} added items")
            if new["kind"] == "picture" and "_image" not in new:
                new["_image"] = _form_image(p.form_ref(new["id"]))
            p.remove(new["id"])
            new["page"] = dest.n
            dest.write(new)
            updated += 1
            continue
        keep = None
        if new["kind"] == "text" and all(new.get(k) == it.get(k) for k in ("font", "paras", "w")):
            keep = p.form_ref(new["id"])
        elif new["kind"] == "picture" and "_image" not in new and all(new.get(k) == it.get(k) for k in ("w", "h", "crop")):
            keep = p.form_ref(new["id"])
        if keep is not None:
            keep.get_object()[KEY] = TextStringObject(json.dumps(_public(new), separators=(",", ":"), ensure_ascii=False))
        elif new["kind"] == "picture" and "_image" not in new:
            new["_image"] = _form_image(p.form_ref(new["id"]))
        p.write(new, at=i, form=keep)
        updated += 1
    for req in args.get("arrange") or []:
        if not isinstance(req, dict):
            continue
        p, _, it = locate(req)
        p.arrange(it["id"], str(req.get("to") or ""))
        arranged += 1
    for req in args.get("comments") or []:
        if not isinstance(req, dict):
            continue
        _arrange_comment(w, int(_f(req.get("page"), 0, 0, n_pages)), int(_f(req.get("index"), -1, -1, 1e9)), str(req.get("to") or ""))
        arranged += 1
    for req in links:
        pa, _, a = locate({"id": req.get("from")})
        pb, _, b = locate({"id": req.get("to")})
        if a["kind"] != "text" or b["kind"] != "text":
            raise ValueError("Only text boxes can be threaded")
        if b.get("thread"):
            raise ValueError(f"Text box {b['id']} is already in a thread; unthread it first")
        tid = str(a.get("thread") or "T" + a["id"])
        fr = frames_of(tid) if a.get("thread") else [(pa.n, a)]
        pos = next(k for k, (_, v) in enumerate(fr) if v["id"] == a["id"])
        head = fr[0][1]
        story = list(head["paras"]) + ([p for p in b["paras"]] if _plain(b).strip() else [])
        order = fr[:pos + 1] + [(pb.n, b)] + fr[pos + 1:]
        for k, (n, v) in enumerate(order):
            moved = {**v, "thread": tid, "seq": k, "auto": False}
            moved.pop("fit", None)
            if k == 0:
                moved["paras"] = story
            if "grow" in req:
                moved["grow"] = bool(req["grow"])
            store(n, moved)
        touched.add(tid)
        threaded += 1
    for req in args.get("unthread") or []:
        req = req if isinstance(req, dict) else {"id": req}
        p, _, it = locate(req)
        tid = it.get("thread")
        if not tid:
            continue
        fr = [(n, v) for n, v in frames_of(str(tid)) if v["id"] != it["id"]]
        story = frames_of(str(tid))[0][1]["paras"]
        for k, (n, v) in enumerate(fr):
            store(n, {**v, "seq": k, **({"paras": story} if k == 0 else {})})
        alone = {k: v for k, v in it.items() if k not in ("thread", "seq", "overflow", "grow")}
        alone["paras"] = _norm_paras("", it["font"]) if it.get("seq") else story
        if not fr:
            alone["auto"] = True
        p.write(alone, at=p.find(it["id"])[0])
        touched.add(str(tid))
        threaded += 1
    for req in args.get("remove") or []:
        req = req if isinstance(req, dict) else {"id": req}
        p, _, it = locate(req)
        if it.get("thread"):
            fr = frames_of(str(it["thread"]))
            rest = [(n, v) for n, v in fr if v["id"] != it["id"]]
            if rest and int(it.get("seq") or 0) == int(fr[0][1].get("seq") or 0):
                store(rest[0][0], {**rest[0][1], "paras": it["paras"]})
            touched.add(str(it["thread"]))
        p.remove(it["id"])
        removed += 1
    for tid in sorted(touched):
        flow(tid)
    if not (added or updated or removed or arranged or threaded):
        raise ValueError("Nothing to add, change, arrange or remove")
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": n_pages, "added": len(added), "ids": added, "converted": converted, "updated": updated, "arranged": arranged, "deleted": removed,
            "threaded": threaded, "threads": sorted(touched)}


@core.serial
def render_without(path, page: int, target: dict, scale: float = 2.0, passwords: list[str] | None = None) -> bytes:
    import pypdfium2 as pdfium

    w = PdfWriter(clone_from=core.reader(path, passwords))
    if not 1 <= page <= len(w.pages):
        raise ValueError(f"Page {page} is out of range (1 to {len(w.pages)})")
    p = Page(w, page)
    if target.get("id"):
        try:
            p.remove(str(target["id"]))
        except ValueError:
            if _unmerge(p, str(target["id"])) is not None:
                p.remove(str(target["id"]))
    elif target.get("picture") is not None:
        p.remove(p.convert(int(target["picture"]))["id"])
    elif target.get("paragraph"):
        from . import textedit

        p.remove(textedit.convert(p, str(target["paragraph"]))["id"])
    buf = io.BytesIO()
    w.write(buf)
    doc = pdfium.PdfDocument(buf.getvalue())
    try:
        try:
            doc.init_forms()
        except Exception:
            pass
        pg = doc[page - 1]
        w0, h0 = pg.get_size()
        s = max(0.05, min(float(scale), 8.0, 8000 / max(w0, h0, 1)))
        pil = core.render_pil(pg, s)
        out = io.BytesIO()
        pil.save(out, "PNG")
        return out.getvalue()
    finally:
        doc.close()


actions.register(actions.Action("items", "read", "List added text and pictures", words=("page items", "added text", "pictures on the page", "objects"),
                                fields=(actions.PAGES,), run=read))
actions.register(actions.Action("edit_items", "change", "Add or edit page text and pictures", "edited",
                                ("add text", "add picture", "image", "text box on the page", "crop picture", "rotate picture", "flip",
                                 "bring forward", "send backward", "arrange", "align"), run=anchors.following(change)))
