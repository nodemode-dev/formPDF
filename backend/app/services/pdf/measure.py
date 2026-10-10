import math

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject

from . import actions, core, frame
from .annot import rgb
from .content import walk

KINDS = {"distance": ("/Line", "/LineDimension", "Distance"), "perimeter": ("/PolyLine", "/PolyLineDimension", "Perimeter"),
         "area": ("/Polygon", "/PolygonDimension", "Area")}
IT_KIND = {v[1]: k for k, v in KINDS.items()}
UNITS = {"pt": 1.0, "in": 1 / 72, "ft": 1 / 864, "mm": 25.4 / 72, "cm": 2.54 / 72, "m": 0.0254 / 72}
MAX_SNAP = 4000
MAX_SEGMENTS = 700


def length(points: list[tuple[float, float]]) -> float:
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


def area(points: list[tuple[float, float]]) -> float:
    s = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def value(kind: str, points: list[tuple[float, float]], factor: float) -> float:
    if kind == "area":
        return area(points) * factor * factor
    return length(points if kind == "perimeter" else points[:2]) * factor


def label(kind: str, v: float, unit: str) -> str:
    digits = 0 if v >= 1000 else 1 if v >= 100 else 2
    return f"{v:,.{digits}f} {'sq ' if kind == 'area' else ''}{unit}"


def _scale(item: dict) -> tuple[float, str]:
    unit = str(item.get("unit") or "mm")[:12]
    try:
        factor = float(item.get("factor") or UNITS.get(unit, 0) or 0)
    except (TypeError, ValueError):
        factor = 0.0
    if not (factor > 0 and math.isfinite(factor)):
        raise ValueError("A measurement needs a scale: units per point greater than zero")
    return factor, unit


def _fmt(unit: str, factor: float) -> DictionaryObject:
    return DictionaryObject({NameObject("/Type"): NameObject("/NumberFormat"), NameObject("/U"): TextStringObject(unit),
                             NameObject("/C"): FloatObject(round(factor, 10)), NameObject("/D"): NumberObject(100)})


def _measure_dict(unit: str, factor: float) -> DictionaryObject:
    ratio = f"1 pt = {factor:.4g} {unit}"
    return DictionaryObject({NameObject("/Type"): NameObject("/Measure"), NameObject("/Subtype"): NameObject("/RL"),
                             NameObject("/R"): TextStringObject(ratio), NameObject("/X"): ArrayObject([_fmt(unit, factor)]),
                             NameObject("/D"): ArrayObject([_fmt(unit, 1.0)]), NameObject("/A"): ArrayObject([_fmt(f"sq {unit}", 1.0)])})


def _appearance(w: PdfWriter, kind: str, pts: list[tuple[float, float]], text: str, color, bbox: list[float]):
    from reportlab.pdfbase.pdfmetrics import stringWidth

    r, g, b = color
    ox, oy = bbox[0], bbox[1]
    rel = [(x - ox, y - oy) for x, y in pts]
    ops = [f"q {r:.3f} {g:.3f} {b:.3f} RG 1.25 w 1 J 1 j"]
    if kind == "area":
        ops.append(f"q {r:.3f} {g:.3f} {b:.3f} rg /Ga gs " + " ".join(f"{x:.2f} {y:.2f} {'m' if i == 0 else 'l'}" for i, (x, y) in enumerate(rel)) + " h f Q")
    ops.append(" ".join(f"{x:.2f} {y:.2f} {'m' if i == 0 else 'l'}" for i, (x, y) in enumerate(rel)) + (" h S" if kind == "area" else " S"))
    if kind == "distance" and len(rel) == 2:
        (x1, y1), (x2, y2) = rel
        ang = math.atan2(y2 - y1, x2 - x1)
        for (px, py), a in (((x1, y1), ang), ((x2, y2), ang + math.pi)):
            for d in (0.45, -0.45):
                ops.append(f"{px:.2f} {py:.2f} m {px + 7 * math.cos(a + d):.2f} {py + 7 * math.sin(a + d):.2f} l S")
    size = 9.0
    tw = stringWidth(text, "Helvetica", size)
    if kind == "distance":
        cx, cy = (rel[0][0] + rel[1][0]) / 2, (rel[0][1] + rel[1][1]) / 2 + 5
    elif kind == "area":
        cx, cy = sum(p[0] for p in rel) / len(rel), sum(p[1] for p in rel) / len(rel)
    else:
        cx, cy = rel[-1][0], rel[-1][1] + 5
    tx, ty = cx - tw / 2, cy
    ops.append(f"Q q 1 1 1 rg {tx - 2:.2f} {ty - 2.5:.2f} {tw + 4:.2f} {size + 2:.2f} re f {r:.3f} {g:.3f} {b:.3f} rg BT /Helv {size} Tf {tx:.2f} {ty:.2f} Td ({_pdf_str(text)}) Tj ET Q")
    ap = DecodedStreamObject()
    ap.set_data(" ".join(ops).encode("latin-1", "replace"))
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                             NameObject("/BaseFont"): NameObject("/Helvetica"), NameObject("/Encoding"): NameObject("/WinAnsiEncoding")})
    gs = DictionaryObject({NameObject("/Type"): NameObject("/ExtGState"), NameObject("/ca"): FloatObject(0.12)})
    ap.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"),
               NameObject("/BBox"): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(bbox[2] - bbox[0]), FloatObject(bbox[3] - bbox[1])]),
               NameObject("/Matrix"): ArrayObject([FloatObject(v) for v in (1, 0, 0, 1, 0, 0)]),
               NameObject("/Resources"): DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/Helv"): w._add_object(font)}),
                                                           NameObject("/ExtGState"): DictionaryObject({NameObject("/Ga"): w._add_object(gs)})})})
    return w._add_object(ap), tx + ox, ty + oy, tw


def _pdf_str(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _annot(w: PdfWriter, page, item: dict, author: str) -> tuple[DictionaryObject, str]:
    kind = str(item.get("kind") or "")
    if kind not in KINDS:
        raise ValueError("kind is distance, perimeter or area")
    raw = item.get("points") or []
    try:
        pts_frame = [(float(p[0]), float(p[1])) for p in raw]
    except (TypeError, ValueError, IndexError):
        raise ValueError("points are [x, y] pairs in points from the top left of the page") from None
    need = 2 if kind != "area" else 3
    if len(pts_frame) < need:
        raise ValueError(f"A {kind} needs at least {need} points")
    if kind == "distance":
        pts_frame = pts_frame[:2]
    factor, unit = _scale(item)
    pts = [frame.point_to_pdf(page, x, y) for x, y in pts_frame]
    v = value(kind, pts, factor)
    text = label(kind, v, unit)
    if item.get("label"):
        text = f"{str(item['label'])[:60]}: {text}"
    color = rgb(item.get("color") or "#E11D48")
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    from reportlab.pdfbase.pdfmetrics import stringWidth

    pad = stringWidth(text, "Helvetica", 9) / 2 + 10
    bbox = [min(xs) - pad, min(ys) - 12, max(xs) + pad, max(ys) + 18]
    sub, it, subj = KINDS[kind]
    ap, *_ = _appearance(w, kind, pts, text, color, bbox)
    d = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject(sub), NameObject("/IT"): NameObject(it),
        NameObject("/Rect"): ArrayObject([FloatObject(round(v, 3)) for v in bbox]), NameObject("/C"): ArrayObject([FloatObject(c) for c in color]),
        NameObject("/BS"): DictionaryObject({NameObject("/W"): FloatObject(1.25)}), NameObject("/F"): NumberObject(4),
        NameObject("/Contents"): TextStringObject(text), NameObject("/Subj"): TextStringObject(f"{subj} measurement"),
        NameObject("/T"): TextStringObject(author), NameObject("/Measure"): _measure_dict(unit, factor),
        NameObject("/AP"): DictionaryObject({NameObject("/N"): ap})})
    flat = ArrayObject([FloatObject(round(c, 3)) for p in pts for c in p])
    if kind == "distance":
        d[NameObject("/L")] = flat
        d[NameObject("/LE")] = ArrayObject([NameObject("/OpenArrow"), NameObject("/OpenArrow")])
        d[NameObject("/Cap")] = BooleanObject(True)
    else:
        d[NameObject("/Vertices")] = flat
    return d, text


def _existing(r) -> list[dict]:
    out = []
    for pi, page in enumerate(r.pages):
        k = 0
        for ref in page.get("/Annots") or []:
            a = ref.get_object()
            kind = IT_KIND.get(str(a.get("/IT", "")))
            if kind is None and a.get("/Measure") is not None:
                kind = {"/Line": "distance", "/PolyLine": "perimeter", "/Polygon": "area"}.get(str(a.get("/Subtype")))
            if kind is None:
                continue
            raw = a.get("/L") if kind == "distance" else a.get("/Vertices")
            vals = [float(v) for v in raw] if raw is not None else []
            x0, _, _, y1 = core.view_box(page)
            pts = [[round(vals[i] - x0, 2), round(y1 - vals[i + 1], 2)] for i in range(0, len(vals) - 1, 2)]
            m = a.get("/Measure")
            m = m.get_object() if m is not None else {}
            unit, factor = "", None
            try:
                fmt = m["/X"][0].get_object()
                unit, factor = str(fmt.get("/U", "")), float(fmt.get("/C"))
            except Exception:
                pass
            item = {"page": pi + 1, "index": k, "kind": kind, "points": pts, "text": str(a.get("/Contents", "")), "unit": unit,
                    "author": str(a.get("/T", ""))}
            if factor and pts:
                pdf_pts = [(vals[i], vals[i + 1]) for i in range(0, len(vals) - 1, 2)]
                item["value"] = round(value(kind, pdf_pts, factor), 6)
            out.append(item)
            k += 1
    return out


def read(path, *, args: dict, pages=None, passwords: list[str] | None = None):
    r = core.reader(path, passwords)
    got = _existing(r)
    if pages:
        keep = set(core.parse_pages(pages, len(r.pages)))
        got = [x for x in got if x["page"] in keep]
    lines = [f"p{x['page']} #{x['index']} · {x['kind']} · {x['text']}" for x in got]
    return ("\n".join(lines) or "No measurements."), {"measurements": got, "count": len(got)}


def change(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    r = core.reader(src, passwords)
    w = PdfWriter(clone_from=r)
    n = len(w.pages)
    gone = {(int(x["page"]), int(x["index"])) for x in args.get("remove") or [] if isinstance(x, dict)}
    deleted = 0
    if gone:
        for pi, page in enumerate(w.pages):
            if "/Annots" not in page:
                continue
            keep, k = ArrayObject(), 0
            for ref in page["/Annots"].get_object():
                a = ref.get_object()
                is_m = str(a.get("/IT", "")) in IT_KIND or (a.get("/Measure") is not None and str(a.get("/Subtype")) in ("/Line", "/PolyLine", "/Polygon"))
                if is_m:
                    if (pi + 1, k) in gone:
                        deleted += 1
                        k += 1
                        continue
                    k += 1
                keep.append(ref)
            page[NameObject("/Annots")] = keep
    added, texts = 0, []
    for item in args.get("add") or []:
        if not isinstance(item, dict):
            continue
        p = int(item.get("page") or 0)
        if not 1 <= p <= n:
            raise ValueError(f"Page {p} is out of range (1 to {n})")
        d, text = _annot(w, w.pages[p - 1], item, str(args.get("author") or ""))
        w.add_annotation(p - 1, d)
        texts.append(text)
        added += 1
    if not added and not deleted:
        raise ValueError("Give measurements to add or to remove")
    with open(out, "wb") as f:
        w.write(f)
    return {"pages": n, "added": added, "deleted": deleted, "values": texts}


def snap(path, *, args: dict, pages=None, passwords: list[str] | None = None):
    r = core.reader(path, passwords)
    p = int(args.get("page") or 1)
    if not 1 <= p <= len(r.pages):
        raise ValueError(f"Page {p} is out of range (1 to {len(r.pages)})")
    page = r.pages[p - 1]
    x0, _, _, y1 = core.view_box(page)
    pc = walk(page, r)
    out: list[list] = []
    segs: list[tuple[tuple[float, float], tuple[float, float]]] = []
    seen: set[tuple[int, int]] = set()

    def add(x: float, y: float, kind: str) -> None:
        fx, fy = round(x - x0, 2), round(y1 - y, 2)
        key = (round(fx * 2), round(fy * 2))
        if key not in seen and len(out) < MAX_SNAP:
            seen.add(key)
            out.append([fx, fy, kind])

    for d in pc.draws:
        for sub in d.points:
            for a, b in zip(sub, sub[1:]):
                if math.dist(a, b) < 0.5:
                    continue
                add(a[0], a[1], "end")
                add(b[0], b[1], "end")
                add((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, "mid")
                if len(segs) < MAX_SEGMENTS:
                    segs.append((a, b))
    for i in range(len(segs)):
        (ax, ay), (bx, by) = segs[i]
        for j in range(i + 1, len(segs)):
            (cx, cy), (dx, dy) = segs[j]
            den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
            if abs(den) < 1e-9:
                continue
            t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den
            u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den
            if 0.01 < t < 0.99 and 0.01 < u < 0.99:
                add(ax + t * (bx - ax), ay + t * (by - ay), "cross")
    return f"{len(out)} snap points on page {p}.", {"page": p, "points": out}


actions.register(actions.Action("measurements", "read", "List measurements", words=("measure", "dimensions", "distances", "areas"), run=read))
actions.register(actions.Action("measure", "change", "Measure", "measured", ("measure", "distance", "perimeter", "area", "ruler", "dimension", "scale"),
                                run=change))
actions.register(actions.Action("snap_points", "read", "Snap points for measuring", words=("snap",), run=snap))
