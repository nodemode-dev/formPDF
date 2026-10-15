import re

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, ContentStream, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject

from . import actions, core, items
from .content import interp

CONSTRUCT = {b"m", b"l", b"c", b"v", b"y", b"re", b"h", b"W", b"W*"}
BLENDS = ("Normal", "Multiply", "Screen", "Overlay", "Darken", "Lighten", "ColorDodge", "ColorBurn", "HardLight", "SoftLight", "Difference", "Exclusion")
MAX_EDITS = 500


def _mul(a, b) -> tuple:
    return (a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
            a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5])


def _inv(m) -> tuple:
    det = m[0] * m[3] - m[1] * m[2]
    if abs(det) < 1e-12:
        raise ValueError("This path is drawn with a flat transform and cannot be moved")
    a, b, c, d = m[3] / det, -m[1] / det, -m[2] / det, m[0] / det
    return (a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d))


def _layout(page_obj, arr) -> list[tuple[int, int, int, str]]:
    out, start = [], 0
    begin, end = items._wrap_bounds(arr)
    for i, ref in enumerate(arr):
        kind, _ = items._kind(ref)
        try:
            n = len(ContentStream(ref.get_object(), None).operations)
        except Exception:
            n = 0
        base = kind == "base" and (begin < 0 or begin < i < end)
        out.append((i, start, n, "base" if base else kind))
        start += n
    return out


def _start(ops: list, paint: int) -> int:
    k = paint
    while k > 0 and ops[k - 1][1] in CONSTRUCT:
        k -= 1
    return k


def _display(page, box) -> dict:
    vx0, vy0, vx1, vy1 = core.view_box(page)
    x0, y0, x1, y1 = box
    return {"x": round(x0 - vx0, 2), "y": round(vy1 - y1, 2), "w": round(x1 - x0, 2), "h": round(y1 - y0, 2)}


def _paths(w: PdfWriter, n: int) -> tuple[items.Page, list[dict], list]:
    p = items.Page(w, n)
    content = interp.walk(p.page, w, forms=False)
    ops = interp.page_operations(p.page, w)
    spans = _layout(p.page, p.arr)
    found = []
    for d in content.draws:
        if d.kind != "path" or d.where != () or d.box is None:
            continue
        span = next((s for s in spans if s[1] <= d.op < s[1] + s[2]), None)
        if span is None or span[3] != "base":
            continue
        start = _start(ops, d.op)
        if start < span[1]:
            continue
        found.append({"page": n, "op": d.op, "start": start, "paint": d.paint, "box": _display(p.page, d.box), "ctm": d.ctm,
                      "stream": span[0], "offset": span[1], "points": sum(len(s) for s in d.points)})
    return p, found, ops


def read(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    r = core.reader(path, passwords)
    w = PdfWriter(clone_from=r)
    want = core.parse_pages(pages or (args or {}).get("pages"), len(w.pages))
    rows = []
    for n in want:
        _, found, _ = _paths(w, n)
        for f in found[:2000]:
            rows.append({k: f[k] for k in ("page", "op", "paint", "box", "points")})
    lines = [f"p{r_['page']} path {r_['op']} · {r_['paint']} · {r_['box']['x']:.0f},{r_['box']['y']:.0f} {r_['box']['w']:.0f}x{r_['box']['h']:.0f}" for r_ in rows[:400]]
    return (f"{len(rows)} paths" + ("\n" + "\n".join(lines) if lines else "")), {"paths": rows}


def _color(v) -> list | None:
    if v is None:
        return None
    if isinstance(v, str) and re.fullmatch(r"#?[0-9a-fA-F]{6}", v):
        h = v.lstrip("#")
        return [("rgb", [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])]
    if isinstance(v, dict) and isinstance(v.get("cmyk"), list) and len(v["cmyk"]) == 4:
        return [("cmyk", [max(0.0, min(1.0, float(x) / (100 if float(x) > 1 else 1))) for x in v["cmyk"]])]
    if isinstance(v, dict) and v.get("gray") is not None:
        return [("gray", [max(0.0, min(1.0, float(v["gray"])))])]
    if isinstance(v, dict) and isinstance(v.get("spot"), dict):
        s = v["spot"]
        name = re.sub(r"[^A-Za-z0-9 ._-]", "", str(s.get("name") or "")).strip()[:60]
        alt = s.get("cmyk")
        if not name or not isinstance(alt, list) or len(alt) != 4:
            raise ValueError("A spot colour is {spot: {name, cmyk: [c, m, y, k] for screens and proofs, tint: 0..1}}")
        cmyk = [max(0.0, min(1.0, float(x) / (100 if float(x) > 1 else 1))) for x in alt]
        return [("spot", [name, cmyk, max(0.0, min(1.0, float(s.get("tint", 1))))])]
    raise ValueError("A colour is #rrggbb, {cmyk: [c, m, y, k]} (0 to 1 or percent), {gray: 0..1} or {spot: {name, cmyk, tint}}")


def _separation(page, name: str, cmyk: list) -> NameObject:
    res = page.get("/Resources")
    res = res.get_object() if res is not None else DictionaryObject()
    old = res.get("/ColorSpace")
    spaces = DictionaryObject(old.get_object()) if old is not None else DictionaryObject()
    fn = DictionaryObject({NameObject("/FunctionType"): NumberObject(2), NameObject("/Domain"): ArrayObject([FloatObject(0), FloatObject(1)]),
                           NameObject("/C0"): ArrayObject([FloatObject(0)] * 4), NameObject("/C1"): ArrayObject([FloatObject(round(x, 4)) for x in cmyk]),
                           NameObject("/N"): NumberObject(1)})
    space = ArrayObject([NameObject("/Separation"), NameObject("/" + name), NameObject("/DeviceCMYK"), fn])
    for k, v in spaces.items():
        o = v.get_object()
        if isinstance(o, ArrayObject) and len(o) > 1 and o[0] == "/Separation" and str(o[1]) == str(space[1]):
            res[NameObject("/ColorSpace")] = spaces
            page[NameObject("/Resources")] = res
            return NameObject(k)
    k = 1
    while NameObject(f"/FpSpot{k}") in spaces:
        k += 1
    key = NameObject(f"/FpSpot{k}")
    spaces[key] = space
    res[NameObject("/ColorSpace")] = spaces
    page[NameObject("/Resources")] = res
    return key


def _color_ops(spec, stroke: bool, page=None) -> list:
    out = []
    for kind, vals in spec:
        if kind == "spot":
            key = _separation(page, vals[0], vals[1])
            out.append(([key], b"CS" if stroke else b"cs"))
            out.append(([FloatObject(round(vals[2], 4))], b"SCN" if stroke else b"scn"))
            continue
        nums = [FloatObject(round(x, 4)) for x in vals]
        op = {"rgb": b"rg", "cmyk": b"k", "gray": b"g"}[kind]
        out.append((nums, op.upper() if stroke else op))
    return out


def _gstate(page, alpha: float | None, blend: str | None) -> NameObject:
    res = page.get("/Resources")
    res = res.get_object() if res is not None else DictionaryObject()
    gs_old = res.get("/ExtGState")
    gs = DictionaryObject(gs_old.get_object()) if gs_old is not None else DictionaryObject()
    entry = DictionaryObject({NameObject("/Type"): NameObject("/ExtGState")})
    if alpha is not None:
        entry[NameObject("/ca")] = FloatObject(alpha)
        entry[NameObject("/CA")] = FloatObject(alpha)
    if blend:
        entry[NameObject("/BM")] = NameObject("/" + blend)
    k = 1
    while NameObject(f"/FpPath{k}") in gs:
        k += 1
    name = NameObject(f"/FpPath{k}")
    gs[name] = entry
    res[NameObject("/ExtGState")] = gs
    page[NameObject("/Resources")] = res
    return name


def change(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    edits = [e for e in (args or {}).get("edits") or [] if isinstance(e, dict)]
    if not edits:
        raise ValueError("edits is a list of {page, op (from paths), dx, dy, scale, fill, stroke, opacity, blend}")
    if len(edits) > MAX_EDITS:
        raise ValueError(f"At most {MAX_EDITS} path edits at once")
    w = PdfWriter(clone_from=core.reader(src, passwords))
    by_page: dict[int, list[dict]] = {}
    for e in edits:
        n = int(e.get("page") or 0)
        if not 1 <= n <= len(w.pages):
            raise ValueError(f"Page {e.get('page')} is out of range")
        by_page.setdefault(n, []).append(e)
    done = 0
    moved: dict[int, dict[int, int]] = {}
    for n, todo in by_page.items():
        p, found, _ = _paths(w, n)
        index = {f["op"]: f for f in found}
        streams: dict[int, list] = {}
        plan = []
        for e in todo:
            f = index.get(int(e.get("op", -1)))
            if f is None:
                raise ValueError(f"There is no editable path {e.get('op')} on page {n}; list them with paths")
            plan.append((f, e))
        grown: dict[int, int] = {}
        for f, e in sorted(plan, key=lambda t: -t[0]["op"]):
            if f["stream"] not in streams:
                streams[f["stream"]] = list(ContentStream(p.arr[f["stream"]].get_object(), w).operations)
            ops = streams[f["stream"]]
            a, b = f["start"] - f["offset"], f["op"] - f["offset"]
            head: list = [([], b"q")]
            dx, dy = float(e.get("dx") or 0), float(e.get("dy") or 0)
            scale = float(e.get("scale") or 1)
            if not 0.01 <= scale <= 100:
                raise ValueError("scale is between 0.01 and 100")
            if dx or dy or scale != 1:
                bx = f["box"]
                vx0, vy0, vx1, vy1 = core.view_box(p.page)
                cx, cy = vx0 + bx["x"] + bx["w"] / 2, vy1 - bx["y"] - bx["h"] / 2
                t = (scale, 0, 0, scale, cx * (1 - scale) + dx, cy * (1 - scale) - dy)
                ctm = tuple(float(v) for v in f["ctm"])
                m = _mul(_mul(ctm, t), _inv(ctm))
                head.append(([FloatObject(round(v, 6)) for v in m], b"cm"))
            alpha = e.get("opacity")
            blend = e.get("blend")
            if alpha is not None:
                alpha = max(0.0, min(1.0, float(alpha)))
            if blend is not None and blend not in BLENDS:
                raise ValueError(f"blend is one of {', '.join(BLENDS)}")
            if alpha is not None or blend:
                head.append(([_gstate(p.page, alpha, blend)], b"gs"))
            fill, stroke = _color(e.get("fill")), _color(e.get("stroke"))
            if fill:
                head += _color_ops(fill, False, p.page)
            if stroke:
                head += _color_ops(stroke, True, p.page)
            if e.get("width") is not None:
                head.append(([FloatObject(max(0.0, float(e["width"])))], b"w"))
            if len(head) == 1:
                continue
            ops[a:b + 1] = head + ops[a:b + 1] + [([], b"Q")]
            grown[f["op"]] = len(head)
            done += 1
        shift = 0
        for op in sorted(grown):
            moved.setdefault(n, {})[op] = op + shift + grown[op]
            shift += grown[op] + 1
        for pos, ops in streams.items():
            cs = ContentStream(None, w)
            cs.operations = ops
            ref = w._add_object(DecodedStreamObject())
            ref.get_object().set_data(cs.get_data())
            p.arr[pos] = ref
    if not done:
        raise ValueError("Nothing to change: give dx, dy, scale, fill, stroke, width, opacity or blend")
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "edited": done, "ops": {str(n): {str(k): v for k, v in m.items()} for n, m in moved.items()}}


actions.register(actions.Action("paths", "read", "List shapes and lines on the page", words=("paths", "shapes", "vector", "lines", "artwork", "logo"), run=read))
actions.register(actions.Action("edit_paths", "change", "Move, scale, recolour or fade shapes", "shapes",
                                ("recolour", "recolor", "move shape", "scale shape", "opacity", "transparency", "blend mode", "spot", "cmyk fill"), run=change))
