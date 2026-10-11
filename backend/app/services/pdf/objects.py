import ctypes
import math
import re

import pypdfium2 as pdfium
import pypdfium2.raw as R

TEXT, PATH, IMAGE, SHADING, FORM = 1, 2, 3, 4, 5
LINETO, BEZIERTO, MOVETO = 0, 1, 2
MAX_LEAVES = 4000
MAX_REBUILT = 1500
MAX_SEGMENTS = 6000
MAX_DEPTH = 8
IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
TILT = 0.01


def mul(m, n) -> tuple:
    return (m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
            m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5])


def apply(m, x: float, y: float) -> tuple[float, float]:
    return m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]


def _matrix(o) -> tuple:
    m = R.FS_MATRIX()
    if not R.FPDFPageObj_GetMatrix(o, ctypes.byref(m)):
        return IDENTITY
    return (m.a, m.b, m.c, m.d, m.e, m.f)


def _color(fn, o):
    r, g, b, a = (ctypes.c_uint() for _ in range(4))
    if not fn(o, ctypes.byref(r), ctypes.byref(g), ctypes.byref(b), ctypes.byref(a)):
        return None
    return (r.value, g.value, b.value, a.value)


def _point(seg) -> tuple[float, float]:
    x, y = ctypes.c_float(), ctypes.c_float()
    R.FPDFPathSegment_GetPoint(seg, ctypes.byref(x), ctypes.byref(y))
    return x.value, y.value


def _box(pts) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def view(page) -> tuple:
    x0, y0, x1, y1 = (float(v) for v in page.get_cropbox())
    r = page.get_rotation() % 360
    return {0: (1.0, 0.0, 0.0, 1.0, -x0, -y0), 90: (0.0, -1.0, 1.0, 0.0, -y0, x1), 180: (-1.0, 0.0, 0.0, -1.0, x1, y1),
            270: (0.0, 1.0, -1.0, 0.0, y1, -x0)}.get(r, (1.0, 0.0, 0.0, 1.0, -x0, -y0))


def leaves(page_raw, start=IDENTITY):
    out = []

    def walk(form, chain, depth):
        n = R.FPDFFormObj_CountObjects(form) if form else R.FPDFPage_CountObjects(page_raw)
        for i in range(n):
            o = R.FPDFFormObj_GetObject(form, i) if form else R.FPDFPage_GetObject(page_raw, i)
            if not o:
                continue
            t = R.FPDFPageObj_GetType(o)
            if t == FORM and depth < MAX_DEPTH:
                walk(o, mul(_matrix(o), chain), depth + 1)
            else:
                out.append((o, form, chain, t))
            if len(out) > MAX_LEAVES:
                return

    walk(None, start, 0)
    return out


def _clip(o, chain):
    clip = R.FPDFPageObj_GetClipPath(o)
    if not clip:
        return None
    boxes = []
    for i in range(max(0, R.FPDFClipPath_CountPaths(clip))):
        pts = [apply(chain, *_point(R.FPDFClipPath_GetPathSegment(clip, i, j))) for j in range(max(0, R.FPDFClipPath_CountPathSegments(clip, i)))]
        if pts:
            boxes.append((_box(pts), len(pts)))
    if not boxes:
        return None
    x0 = max(b[0][0] for b in boxes)
    y0 = max(b[0][1] for b in boxes)
    x1 = min(b[0][2] for b in boxes)
    y1 = min(b[0][3] for b in boxes)
    rect = all(n <= 5 for _, n in boxes)
    return (x0, y0, x1, y1), rect


def _inside(box, clip, tol: float = 1.0) -> bool:
    return box[0] >= clip[0] - tol and box[1] >= clip[1] - tol and box[2] <= clip[2] + tol and box[3] <= clip[3] + tol


def _bezier(p0, p1, p2, p3, steps: int) -> list:
    out = []
    for s in range(1, steps + 1):
        t = s / steps
        u = 1 - t
        out.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                    u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
    return out


def _path(o, full) -> dict | None:
    n = R.FPDFPath_CountSegments(o)
    if n <= 0 or n > MAX_SEGMENTS:
        return None
    mode, stroke = ctypes.c_int(), ctypes.c_int()
    if not R.FPDFPath_GetDrawMode(o, ctypes.byref(mode), ctypes.byref(stroke)):
        return None
    fill = _color(R.FPDFPageObj_GetFillColor, o) if mode.value else None
    line = _color(R.FPDFPageObj_GetStrokeColor, o) if stroke.value else None
    if (mode.value and fill is None) or (stroke.value and line is None) or (fill is None and line is None):
        return None
    if R.FPDFPageObj_HasTransparency(o) and (fill or (0, 0, 0, 255))[3] == 255 and (line or (0, 0, 0, 255))[3] == 255:
        return None
    subs: list[list] = []
    closed: list[bool] = []
    i = 0
    while i < n:
        seg = R.FPDFPath_GetPathSegment(o, i)
        kind = R.FPDFPathSegment_GetType(seg)
        pt = apply(full, *_point(seg))
        if kind == MOVETO or not subs:
            subs.append([pt])
            closed.append(False)
        elif kind == BEZIERTO and i + 2 < n:
            c2 = apply(full, *_point(R.FPDFPath_GetPathSegment(o, i + 1)))
            end_seg = R.FPDFPath_GetPathSegment(o, i + 2)
            end = apply(full, *_point(end_seg))
            p0 = subs[-1][-1]
            span = math.dist(p0, end) + math.dist(p0, pt) + math.dist(c2, end)
            subs[-1] += _bezier(p0, pt, c2, end, max(4, min(24, int(span / 6))))
            if R.FPDFPathSegment_GetClose(end_seg):
                closed[-1] = True
            i += 3
            continue
        else:
            subs[-1].append(pt)
        if R.FPDFPathSegment_GetClose(seg):
            closed[-1] = True
        i += 1
    subs_closed = [(s, c) for s, c in zip(subs, closed) if len(s) >= 2]
    if not subs_closed:
        return None
    if all(len(s) < 3 for s, _ in subs_closed):
        if line is None:
            return {"kind": "none", "box": _box([p for s, _ in subs_closed for p in s])}
        fill = None
    width = ctypes.c_float(1.0)
    R.FPDFPageObj_GetStrokeWidth(o, ctypes.byref(width))
    scale = math.sqrt(abs(full[0] * full[3] - full[1] * full[2])) or 1.0
    pts = [p for s, _ in subs_closed for p in s]
    return {"kind": "path", "subs": [s for s, _ in subs_closed], "closed": [c for _, c in subs_closed], "fill": fill, "stroke": line,
            "width": max(0.0, width.value) * scale, "dash": R.FPDFPageObj_GetDashCount(o) > 0, "box": _box(pts)}


def _inverse(m) -> tuple:
    det = m[0] * m[3] - m[1] * m[2] or 1.0
    a, b, c, d = m[3] / det, -m[1] / det, -m[2] / det, m[0] / det
    return (a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d))


def _image(o, chain, page, pdf, clip, vw=IDENTITY, rot: int = 0) -> dict | None:
    full = mul(_matrix(o), chain)
    inner = mul(full, _inverse(vw))
    form = mul(chain, _inverse(vw))
    if abs(inner[1]) > 1e-3 * abs(inner[0] or 1) or abs(inner[2]) > 1e-3 * abs(inner[3] or 1) or form[0] < 0 or form[3] < 0:
        return None
    box = _box([apply(full, 0, 0), apply(full, 1, 1)])
    if box[2] - box[0] < 1 or box[3] - box[1] < 1:
        return None
    try:
        bm = pdfium.PdfImage(o, page=page, pdf=pdf).get_bitmap(render=True)
        pil = bm.to_pil()
    except Exception:
        return None
    if pil.width * pil.height > 40_000_000 or pil.width < 1 or pil.height < 1:
        return None
    if rot:
        pil = pil.rotate(-rot, expand=True)
    if clip is not None:
        (cx0, cy0, cx1, cy1), rect = clip
        if not _inside(box, (cx0, cy0, cx1, cy1)):
            if not rect:
                return None
            x0, y0, x1, y1 = max(box[0], cx0), max(box[1], cy0), min(box[2], cx1), min(box[3], cy1)
            if x1 - x0 < 1 or y1 - y0 < 1:
                return None
            sx, sy = pil.width / (box[2] - box[0]), pil.height / (box[3] - box[1])
            pil = pil.crop((round((x0 - box[0]) * sx), round((box[3] - y1) * sy), round((x1 - box[0]) * sx), round((box[3] - y0) * sy)))
            box = (x0, y0, x1, y1)
    return {"kind": "image", "pil": pil, "box": box}


def _tilted(m) -> bool:
    return abs(m[1]) > TILT * math.hypot(m[0], m[1]) or m[0] < 0


def _text(o, chain, tp) -> dict | None:
    full = mul(_matrix(o), chain)
    if not _tilted(full):
        return None
    n = R.FPDFTextObj_GetText(o, tp, None, 0)
    if n <= 2:
        return None
    buf = ctypes.create_string_buffer(n)
    R.FPDFTextObj_GetText(o, tp, ctypes.cast(buf, ctypes.POINTER(ctypes.c_ushort)), n)
    text = buf.raw[:n - 2].decode("utf-16-le", "replace").strip()
    if not text:
        return None
    size = ctypes.c_float(0)
    R.FPDFTextObj_GetFontSize(o, ctypes.byref(size))
    fs = size.value * math.hypot(full[2], full[3])
    q = R.FS_QUADPOINTSF()
    if not R.FPDFPageObj_GetRotatedBounds(o, ctypes.byref(q)):
        return None
    quad = [apply(chain, x, y) for x, y in ((q.x1, q.y1), (q.x2, q.y2), (q.x3, q.y3), (q.x4, q.y4))]
    angle = math.atan2(full[1], full[0])
    color = _color(R.FPDFPageObj_GetFillColor, o)
    bold = False
    font = R.FPDFTextObj_GetFont(o)
    family = ""
    if font:
        try:
            k = R.FPDFFont_GetFamilyName(font, None, 0)
            if 1 < k < 512:
                fb = ctypes.create_string_buffer(k)
                R.FPDFFont_GetFamilyName(font, fb, k)
                family = fb.value.decode("utf-8", "replace")
            k = R.FPDFFont_GetBaseFontName(font, None, 0)
            base = ""
            if 1 < k < 512:
                bb = ctypes.create_string_buffer(k)
                R.FPDFFont_GetBaseFontName(font, bb, k)
                base = bb.value.decode("utf-8", "replace")
            bold = R.FPDFFont_GetWeight(font) >= 600 or bool(re.search(r"bold|black|heavy", base, re.I))
            plain = re.sub(r"(PSMT|MT|PS)$", "", re.split(r"[-,]", re.sub(r"^[A-Z]{6}\+", "", base))[0].strip())
            if plain:
                family = plain if " " in plain else re.sub(r"(?<=[a-z])(?=[A-Z])", " ", plain)
        except Exception:
            pass
    return {"kind": "text", "text": text, "size": fs, "angle": angle, "quad": quad, "color": color, "font": family, "bold": bold}


def _remove(o, form, page_raw) -> None:
    ok = R.FPDFFormObj_RemoveObject(form, o) if form else R.FPDFPage_RemoveObject(page_raw, o)
    if ok:
        R.FPDFPageObj_Destroy(o)


def lines(texts: list[dict]) -> list[dict]:
    out: list[dict] = []
    for t in texts:
        d = (math.cos(t["angle"]), math.sin(t["angle"]))
        nrm = (-d[1], d[0])
        along = [p[0] * d[0] + p[1] * d[1] for p in t["quad"]]
        across = [p[0] * nrm[0] + p[1] * nrm[1] for p in t["quad"]]
        t = {**t, "a0": min(along), "a1": max(along), "n0": min(across), "n1": max(across)}
        last = out[-1] if out else None
        if (last and abs(last["angle"] - t["angle"]) < 0.01 and abs((last["n0"] + last["n1"]) / 2 - (t["n0"] + t["n1"]) / 2) < 0.3 * max(t["size"], 1)
                and -0.5 * t["size"] < t["a0"] - last["a1"] < 1.5 * max(t["size"], 1)):
            gap = " " if t["a0"] - last["a1"] > 0.15 * t["size"] else ""
            last.update(text=last["text"] + gap + t["text"], a1=max(last["a1"], t["a1"]), n0=min(last["n0"], t["n0"]), n1=max(last["n1"], t["n1"]))
            continue
        out.append(t)
    for t in out:
        d = (math.cos(t["angle"]), math.sin(t["angle"]))
        nrm = (-d[1], d[0])
        ca, cn = (t["a0"] + t["a1"]) / 2, (t["n0"] + t["n1"]) / 2
        t["center"] = (ca * d[0] + cn * nrm[0], ca * d[1] + cn * nrm[1])
        t["length"] = t["a1"] - t["a0"]
        t["height"] = t["n1"] - t["n0"]
    return out


def split(pdf, page, *, text: bool = True, shapes: bool = True) -> dict:
    page_raw = page.raw
    vw = view(page)
    rot = page.get_rotation() % 360
    found = leaves(page_raw, vw)
    out = {"objects": [], "tilted": [], "kept": 0}
    if len(found) > MAX_LEAVES:
        return out
    tp = page.get_textpage() if text and shapes else None
    plan = []
    last_keep = -1
    try:
        for i, (o, form, chain, t) in enumerate(found):
            if t == TEXT:
                if not shapes and _tilted(mul(_matrix(o), chain)):
                    continue
                plan.append(("text", o, form, _text(o, chain, tp.raw) if tp else None))
                continue
            if not shapes:
                continue
            rec = None
            clip = _clip(o, chain)
            if t == PATH:
                rec = _path(o, mul(_matrix(o), chain))
                if rec is not None and clip is not None and not _inside(rec["box"], clip[0]):
                    rec = None
            elif t == IMAGE:
                rec = _image(o, chain, page, pdf, clip, vw, rot)
            if rec is None:
                last_keep = i
                out["kept"] += 1
            plan.append(("obj", o, form, rec))
        rebuilt = [(i, p) for i, p in enumerate(plan) if p[0] == "obj" and p[3] is not None and i > last_keep]
        if len(rebuilt) > MAX_REBUILT:
            rebuilt = []
        for _, (_, o, form, rec) in rebuilt:
            if rec["kind"] != "none":
                out["objects"].append(rec)
            _remove(o, form, page_raw)
        if text:
            tilted = []
            for kind, o, form, rec in plan:
                if kind == "text":
                    if rec is not None:
                        tilted.append(rec)
                    _remove(o, form, page_raw)
            out["tilted"] = lines(tilted)
    finally:
        if tp is not None:
            tp.close()
    return out
