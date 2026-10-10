import math

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, IndirectObject, NameObject, NumberObject,
                           StreamObject)

from . import actions, colour, core
from .content import interp

PAPER = {"letter": (612.0, 792.0), "legal": (612.0, 1008.0), "tabloid": (792.0, 1224.0), "a3": (842.0, 1191.0), "a4": (595.0, 842.0),
         "a5": (420.0, 595.0)}
NUP = (1, 2, 4, 6, 9, 16)
ORDERS = ("horizontal", "horizontal-reversed", "vertical", "vertical-reversed")
MODES = ("fit", "shrink", "actual", "custom")
CONTENT = ("document", "markups", "stamps", "fields")
LAYOUTS = ("pages", "booklet", "poster")
GAP = 6.0
MAX_SHEETS = 4000


def _o(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _num(v, default: float, lo: float, hi: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return default if not math.isfinite(x) else max(lo, min(hi, x))


def display(page) -> tuple[tuple, float, float]:
    x0, y0, x1, y1 = core.view_box(page)
    w, h = x1 - x0, y1 - y0
    rot = core.rotation(page)
    if rot == 90:
        return (0.0, -1.0, 1.0, 0.0, -y0, x1), h, w
    if rot == 180:
        return (-1.0, 0.0, 0.0, -1.0, x1, y1), w, h
    if rot == 270:
        return (0.0, 1.0, -1.0, 0.0, y1, -x0), h, w
    return (1.0, 0.0, 0.0, 1.0, -x0, -y0), w, h


def options(args: dict | None) -> dict:
    a = args or {}
    mode = str(a.get("mode") or "fit")
    if mode not in MODES:
        raise ValueError(f"mode is one of {', '.join(MODES)}")
    layout = str(a.get("layout") or "pages")
    if layout not in LAYOUTS:
        raise ValueError(f"layout is one of {', '.join(LAYOUTS)}")
    try:
        nup = int(a.get("nup") or 1)
    except (TypeError, ValueError):
        nup = 0
    if nup not in NUP:
        raise ValueError(f"nup is one of {', '.join(str(n) for n in NUP)}")
    order = str(a.get("order") or "horizontal")
    if order not in ORDERS:
        raise ValueError(f"order is one of {', '.join(ORDERS)}")
    content = str(a.get("content") or "markups")
    if content not in CONTENT:
        raise ValueError(f"content is one of {', '.join(CONTENT)}")
    paper = a.get("paper") or "auto"
    if isinstance(paper, dict):
        paper = (_num(paper.get("w"), 612, 72, 14400), _num(paper.get("h"), 792, 72, 14400))
    elif str(paper).lower() in PAPER:
        paper = PAPER[str(paper).lower()]
    elif str(paper) != "auto":
        raise ValueError(f"paper is auto, {', '.join(PAPER)} or {{w, h}} in points")
    orient = str(a.get("orientation") or "auto")
    if orient not in ("auto", "portrait", "landscape"):
        raise ValueError("orientation is auto, portrait or landscape")
    fixed = paper != "auto" or layout == "poster"
    poster = a.get("poster") if isinstance(a.get("poster"), dict) else {}
    return {"mode": mode, "layout": layout, "nup": nup, "order": order, "content": content, "paper": paper, "orientation": orient,
            "percent": _num(a.get("percent"), 100, 5, 800), "border": bool(a.get("border")), "rotate": a.get("auto_rotate", True) is not False,
            "margin": _num(a.get("margin"), 18.0 if fixed else 0.0, 0, 144), "binding": "right" if a.get("binding") == "right" else "left",
            "tile": _num(poster.get("scale", a.get("tile")), 200, 10, 2000), "overlap": _num(poster.get("overlap", a.get("overlap")), 18, 0, 144),
            "marks": poster.get("marks", a.get("marks", True)) is not False, "labels": poster.get("labels", a.get("labels", True)) is not False,
            "gray": bool(a.get("gray"))}


def _orient(size: tuple, orient: str) -> list[tuple]:
    w, h = size
    port, land = (min(w, h), max(w, h)), (max(w, h), min(w, h))
    return [port] if orient == "portrait" else [land] if orient == "landscape" else [port, land]


def _place(cell: tuple, dw: float, dh: float, o: dict, rotate: bool) -> dict:
    x, y, w, h = cell
    rot = rotate and abs(dw - dh) > 1 and abs(w - h) > 1 and (w > h) != (dw > dh)
    ew, eh = (dh, dw) if rot else (dw, dh)
    fit = min(w / max(ew, 1e-6), h / max(eh, 1e-6))
    s = {"fit": fit, "shrink": min(1.0, fit), "actual": 1.0, "custom": o["percent"] / 100}[o["mode"]]
    px, py = x + (w - ew * s) / 2, y + (h - eh * s) / 2
    e = (0.0, 1.0, -1.0, 0.0, dh, 0.0) if rot else (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    m = interp.mult(interp.mult(e, (s, 0.0, 0.0, s, 0.0, 0.0)), (1.0, 0.0, 0.0, 1.0, px, py))
    return {"m": m, "clip": cell, "s": s, "rot": 90 if rot else 0, "box": (px, py, ew * s, eh * s)}


def _cells(c: int, r: int, W: float, H: float, m: float, order: str) -> list[tuple]:
    cw, ch = (W - 2 * m - GAP * (c - 1)) / c, (H - 2 * m - GAP * (r - 1)) / r
    seq = []
    if order.startswith("horizontal"):
        for row in range(r):
            cols = range(c - 1, -1, -1) if order.endswith("reversed") else range(c)
            seq += [(col, row) for col in cols]
    else:
        cols = range(c - 1, -1, -1) if order.endswith("reversed") else range(c)
        for col in cols:
            seq += [(col, row) for row in range(r)]
    return [(m + col * (cw + GAP), H - m - (row + 1) * ch - row * GAP, cw, ch) for col, row in seq]


def plan(sizes: list[tuple], o: dict) -> list[dict]:
    sheets: list[dict] = []
    if not sizes:
        return sheets
    m = o["margin"]
    if o["layout"] == "booklet":
        seq = list(sizes) + [None] * (-len(sizes) % 4)
        first = sizes[0]
        if o["paper"] == "auto":
            W, H = 2 * first[1], first[2]
            W, H = W + 2 * m + GAP, H + 2 * m
        else:
            W, H = max(o["paper"]), min(o["paper"])
        cw = (W - 2 * m - GAP) / 2
        left, right = (m, m, cw, H - 2 * m), (m + cw + GAP, m, cw, H - 2 * m)
        N = len(seq)
        for i in range(N // 4):
            for pair in ((seq[N - 1 - 2 * i], seq[2 * i]), (seq[2 * i + 1], seq[N - 2 - 2 * i])):
                a, b = (pair[1], pair[0]) if o["binding"] == "right" else pair
                cells = []
                for cell, pg in ((left, a), (right, b)):
                    if pg is not None:
                        cells.append({"page": pg[0], **_place(cell, pg[1], pg[2], o, False)})
                sheets.append({"w": W, "h": H, "cells": cells, "marks": [], "label": None})
        return sheets
    if o["layout"] == "poster":
        s = o["tile"] / 100
        base = o["paper"] if o["paper"] != "auto" else PAPER["letter"]
        for n, dw, dh in sizes:
            sw, sh = dw * s, dh * s
            best = None
            for W, H in _orient(base, o["orientation"]):
                aw, ah = W - 2 * m, H - 2 * m
                ov = min(o["overlap"], aw / 2, ah / 2)
                cols = 1 if sw <= aw + 0.5 else math.ceil((sw - ov) / (aw - ov))
                rows = 1 if sh <= ah + 0.5 else math.ceil((sh - ov) / (ah - ov))
                if best is None or cols * rows < best[0]:
                    best = (cols * rows, W, H, aw, ah, ov, cols, rows)
            _n, W, H, aw, ah, ov, cols, rows = best
            if len(sheets) + cols * rows > MAX_SHEETS:
                raise ValueError("That poster needs too many sheets; choose a smaller tile scale")
            L = min(m - 3, 14.0)
            for j in range(rows):
                for i in range(cols):
                    ox, oy = i * (aw - ov), j * (ah - ov)
                    mat = (s, 0.0, 0.0, s, m - ox, (H - m + oy) - sh)
                    marks = []
                    if o["marks"] and L >= 4:
                        for cx, cy, dx, dy in ((m, m, -1, -1), (W - m, m, 1, -1), (m, H - m, -1, 1), (W - m, H - m, 1, 1)):
                            marks += [(cx + dx * 2, cy, cx + dx * (2 + L), cy), (cx, cy + dy * 2, cx, cy + dy * (2 + L))]
                    label = f"Page {n + 1} · tile {j * cols + i + 1} of {rows * cols} · row {j + 1}, column {i + 1}" if o["labels"] and m >= 10 else None
                    sheets.append({"w": W, "h": H, "cells": [{"page": n, "m": mat, "clip": (m, m, aw, ah), "s": s, "rot": 0, "box": (m - ox, H - m + oy - sh, sw, sh)}],
                                   "marks": marks, "label": label})
        return sheets
    nup = o["nup"]
    if nup == 1 and o["paper"] == "auto":
        for n, dw, dh in sizes:
            W, H = dw + 2 * m, dh + 2 * m
            sheets.append({"w": W, "h": H, "cells": [{"page": n, **_place((m, m, dw, dh), dw, dh, o, False)}], "marks": [], "label": None})
        return sheets
    first = sizes[0]
    base = o["paper"] if o["paper"] != "auto" else (first[1], first[2])
    best = None
    for W, H in _orient(base, o["orientation"]):
        for c in (k for k in range(1, nup + 1) if nup % k == 0):
            r = nup // c
            cw, ch = (W - 2 * m - GAP * (c - 1)) / c, (H - 2 * m - GAP * (r - 1)) / r
            if cw <= 0 or ch <= 0:
                continue
            fit = min(cw / first[1], ch / first[2])
            if o["rotate"]:
                fit = max(fit, min(cw / first[2], ch / first[1]))
            if best is None or fit > best[0] + 1e-6:
                best = (fit, W, H, c, r)
    if best is None:
        raise ValueError("The margins leave no room on the paper")
    _fit, W, H, c, r = best
    cells = _cells(c, r, W, H, m, o["order"])
    for k in range(0, len(sizes), nup):
        chunk = sizes[k:k + nup]
        placed = [{"page": n, **_place(cell, dw, dh, o, o["rotate"] and nup > 1)} for (n, dw, dh), cell in zip(chunk, cells)]
        sheets.append({"w": W, "h": H, "cells": placed, "marks": [], "label": None})
    return sheets


def _ap(annot):
    ap = _o(annot.get("/AP"))
    if not isinstance(ap, DictionaryObject) or "/N" not in ap:
        return None, None
    ref = ap.raw_get("/N")
    n = _o(ref)
    if isinstance(n, DictionaryObject) and not isinstance(n, StreamObject):
        state = annot.get("/AS")
        if state is None or state not in n:
            return None, None
        ref = n.raw_get(state)
        n = _o(ref)
    if not isinstance(n, StreamObject) or "/BBox" not in n:
        return None, None
    return ref, n


def _ap_matrix(stream, rect) -> tuple | None:
    bx0, by0, bx1, by1 = (float(v) for v in stream["/BBox"])
    mt = tuple(float(v) for v in (stream.get("/Matrix") or [1, 0, 0, 1, 0, 0]))
    pts = [interp.apply(mt, x, y) for x, y in ((bx0, by0), (bx1, by0), (bx0, by1), (bx1, by1))]
    tx0, ty0 = min(p[0] for p in pts), min(p[1] for p in pts)
    tx1, ty1 = max(p[0] for p in pts), max(p[1] for p in pts)
    rx0, rx1 = sorted((float(rect[0]), float(rect[2])))
    ry0, ry1 = sorted((float(rect[1]), float(rect[3])))
    if tx1 - tx0 < 1e-6 or ty1 - ty0 < 1e-6:
        return None
    sx, sy = (rx1 - rx0) / (tx1 - tx0), (ry1 - ry0) / (ty1 - ty0)
    return sx, 0.0, 0.0, sy, rx0 - sx * tx0, ry0 - sy * ty0


def _wanted(a, content: str) -> bool:
    sub = a.get("/Subtype")
    flags = int(_o(a.get("/F", 0)) or 0)
    if sub == "/Popup" or flags & 2 or not flags & 4:
        return False
    if sub == "/Widget":
        return True
    if content == "markups":
        return True
    return content == "stamps" and sub == "/Stamp"


def _mat(m) -> str:
    return " ".join(f"{v:.5f}".rstrip("0").rstrip(".") if v != int(v) else str(int(v)) for v in m)


def _form(r, w: PdfWriter, n: int, content: str):
    page = r.pages[n]
    d, _dw, _dh = display(page)
    x0, y0, x1, y1 = core.view_box(page)
    res_src = page.get("/Resources")
    shared = _o(res_src.clone(w)) if res_src is not None else DictionaryObject()
    res = DictionaryObject({k: v for k, v in shared.items()})
    body = b""
    if content != "fields":
        c = page.get_contents()
        body = c.get_data() if c is not None else b""
    extra = []
    xo = None
    k = 0
    for ref in _o(page.get("/Annots")) or []:
        a = _o(ref)
        if not isinstance(a, DictionaryObject) or not _wanted(a, content):
            continue
        ap_ref, stream = _ap(a)
        if stream is None:
            continue
        mt = _ap_matrix(stream, a.get("/Rect", [0, 0, 0, 0]))
        if mt is None:
            continue
        if xo is None:
            have = _o(res.get("/XObject"))
            xo = DictionaryObject({k: v for k, v in have.items()}) if isinstance(have, DictionaryObject) else DictionaryObject()
            res[NameObject("/XObject")] = xo
        k += 1
        name = f"/FpPrA{k}"
        xo[NameObject(name)] = ap_ref.clone(w) if isinstance(ap_ref, IndirectObject) else w._add_object(stream.clone(w))
        extra.append(f"q {_mat(mt)} cm {name} Do Q".encode())
    f = DecodedStreamObject()
    f[NameObject("/Type")] = NameObject("/XObject")
    f[NameObject("/Subtype")] = NameObject("/Form")
    f[NameObject("/BBox")] = ArrayObject(FloatObject(v) for v in (x0, y0, x1, y1))
    f[NameObject("/Matrix")] = ArrayObject(FloatObject(v) for v in d)
    f[NameObject("/Resources")] = res
    f.set_data(b"q\n" + body + b"\nQ\n" + b"\n".join(extra) + b"\n")
    try:
        f = f.flate_encode()
    except Exception:
        pass
    return w._add_object(f)


def _check(r) -> None:
    if not r.is_encrypted:
        return
    try:
        p = int(_o(r.trailer["/Encrypt"]).get("/P", -1))
    except (TypeError, ValueError):
        return
    if not p & 4:
        raise ValueError("The PDF's security settings do not allow printing")


def sizes_for(r, pages) -> list[tuple]:
    n = len(r.pages)
    idx = core.parse_pages(pages, n, unique=False) if pages else list(range(1, n + 1))
    out = []
    for i in idx:
        _d, dw, dh = display(r.pages[i - 1])
        out.append((i - 1, dw, dh))
    return out


def preview(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    r = core.reader(path, passwords)
    o = options(args)
    got = plan(sizes_for(r, pages or (args or {}).get("pages")), o)
    out = []
    for sh in got[:400]:
        H = sh["h"]
        cells = []
        for c in sh["cells"]:
            bx, by, bw, bh = c["box"]
            cx, cy, cw, ch = c["clip"]
            cells.append({"page": c["page"] + 1, "x": round(bx, 2), "y": round(H - by - bh, 2), "w": round(bw, 2), "h": round(bh, 2), "rot": c["rot"],
                          "clip": {"x": round(cx, 2), "y": round(H - cy - ch, 2), "w": round(cw, 2), "h": round(ch, 2)}, "scale": round(c["s"], 4)})
        out.append({"w": round(sh["w"], 2), "h": round(H, 2), "cells": cells, "label": sh["label"],
                    "marks": [[round(a, 2), round(H - b, 2), round(c2, 2), round(H - d, 2)] for a, b, c2, d in sh["marks"]]})
    first = got[0] if got else None
    text = f"{len(got)} sheet{'s' if len(got) != 1 else ''}" + (f" of {first['w']:.0f} x {first['h']:.0f} pt" if first else "")
    return text, {"sheets": out, "count": len(got), "border": o["border"]}


def build(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    r = core.reader(src, passwords)
    _check(r)
    o = options(args)
    sheets = plan(sizes_for(r, pages or (args or {}).get("pages")), o)
    if not sheets:
        raise ValueError("There are no pages to print")
    w = PdfWriter()
    forms: dict[int, object] = {}
    helv = None
    for sh in sheets:
        page = w.add_blank_page(sh["w"], sh["h"])
        res = DictionaryObject()
        xo = DictionaryObject()
        ops = []
        for k, c in enumerate(sh["cells"]):
            if c["page"] not in forms:
                forms[c["page"]] = _form(r, w, c["page"], o["content"])
            name = f"/P{c['page'] + 1}"
            xo[NameObject(name)] = forms[c["page"]]
            cx, cy, cw, ch = c["clip"]
            ops.append(f"q {cx:.3f} {cy:.3f} {cw:.3f} {ch:.3f} re W n {_mat(c['m'])} cm {name} Do Q")
            if o["border"]:
                bx, by, bw, bh = c["box"]
                ops.append(f"q 0.5 w 0 G {bx:.3f} {by:.3f} {bw:.3f} {bh:.3f} re S Q")
        if sh["marks"]:
            ops.append("q 0.5 w 0 G " + " ".join(f"{a:.2f} {b:.2f} m {c2:.2f} {d:.2f} l S" for a, b, c2, d in sh["marks"]) + " Q")
        if sh["label"]:
            if helv is None:
                helv = w._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                                                       NameObject("/BaseFont"): NameObject("/Helvetica"), NameObject("/Encoding"): NameObject("/WinAnsiEncoding")}))
            res[NameObject("/Font")] = DictionaryObject({NameObject("/Helv"): helv})
            text = sh["label"].replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").replace("·", "-")
            ops.append(f"q 0.35 g BT /Helv 7 Tf {o['margin']:.2f} {max(4.0, o['margin'] / 2 - 3):.2f} Td ({text}) Tj ET Q")
        res[NameObject("/XObject")] = xo
        page[NameObject("/Resources")] = res
        s = DecodedStreamObject()
        s.set_data("\n".join(ops).encode("latin-1", "replace"))
        page[NameObject("/Contents")] = w._add_object(s.flate_encode())
    if o["gray"]:
        colour.convert(w, "gray")
    title = (r.metadata or {}).get("/Title")
    w.add_metadata({"/Producer": "formpdf", **({"/Title": str(title)} if title else {})})
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(sheets), "sheets": len(sheets), "w": round(sheets[0]["w"], 2), "h": round(sheets[0]["h"], 2)}


actions.register(actions.Action("print_layout", "read", "Print layout preview", words=("print preview", "imposition"), run=preview))
actions.register(actions.Action("print_pdf", "export", "Make a print PDF", ext=".pdf", words=("print", "booklet", "n-up", "pages per sheet", "poster", "tile", "grayscale"),
                                fields=(actions.Field("layout", "Layout", "select", "pages", LAYOUTS), actions.Field("nup", "Pages per sheet", "select", "1", tuple(str(n) for n in NUP)),
                                        actions.Field("paper", "Paper", "select", "auto", ("auto", *PAPER)), actions.Field("gray", "Grayscale", "bool", False),
                                        actions.PAGES), run=build))
