import functools
import io
import re
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject

from . import annot, core
from .search import _page_text, _rects

MARKUP = {"/Highlight": "highlight", "/Underline": "underline", "/StrikeOut": "strikeout", "/Squiggly": "underline"}
POINT = ("/Text", "/Caret")  # notes and carets sit beside words rather than on them, and move with the nearest ones
MAX_ANCHORS = 400


def _o(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _quads(a) -> list[list[float]]:
    q = [float(v) for v in (a.get("/QuadPoints") or [])]
    out = []
    for i in range(0, len(q) - 7, 8):
        xs, ys = q[i:i + 8:2], q[i + 1:i + 8:2]
        out.append([min(xs), min(ys), max(xs), max(ys)])
    return out


def _marked(r: PdfReader) -> list[tuple[int, int, DictionaryObject]]:
    found = []
    for pi, page in enumerate(r.pages):
        for k, ref in enumerate(_o(page.get("/Annots")) or []):
            a = _o(ref)
            if not isinstance(a, DictionaryObject) or "/IRT" in a:
                continue
            sub = str(a.get("/Subtype"))
            if (sub in MARKUP and a.get("/QuadPoints")) or (sub in POINT and a.get("/Rect")):
                found.append((pi, k, a))
                if len(found) >= MAX_ANCHORS:
                    return found
    return found


def _rect(a) -> list[float]:
    r = [float(v) for v in a.get("/Rect") or [0, 0, 0, 0]]
    return [min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])]


def _texts(path, passwords) -> list[tuple[str, object]]:
    doc = core.pdfium_doc(path, passwords)
    pages = []
    for i in range(len(doc)):
        tp = doc[i].get_textpage()
        pages.append((_page_text(tp), tp))
    return pages, doc


def _hits(pages, quote: str) -> list[tuple[int, list[list[float]]]]:
    words = [re.escape(w) for w in quote.split()]
    if not words:
        return []
    rx = re.compile(r"\s*".join(words))
    out = []
    for pi, (text, tp) in enumerate(pages):
        for m in rx.finditer(text):
            rs = _rects(tp, text, m.start(), m.end(), 0.0, 0.0)
            if rs:
                out.append((pi, [[r["x"], -r["y"] - r["h"], r["x"] + r["w"], -r["y"]] for r in rs]))
    return out


def _overlap(a: list[float], b: list[float]) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


@core.serial
def capture(src, passwords: list[str] | None = None) -> list[dict]:
    r = core.reader(src, passwords)
    marked = _marked(r)
    if not marked:
        return []
    pages, doc = _texts(src, passwords)
    caps = []
    try:
        for pi, k, a in marked:
            text, tp = pages[pi]
            if str(a.get("/Subtype")) in POINT:
                cap = _point(pages, pi, k, a)
                if cap is not None:
                    caps.append(cap)
                continue
            quads = _quads(a)
            parts = []
            for q in quads:
                try:
                    parts.append(tp.get_text_bounded(left=q[0] + 0.5, bottom=q[1] + 0.5, right=q[2] - 0.5, top=q[3] - 0.5))
                except Exception:
                    continue
            quote = re.sub(r"\s+", " ", " ".join(parts)).strip()
            if len(quote) < 2:
                continue
            hits = _hits(pages, quote)
            best, score = -1, 0.0
            for i, (hp, rects) in enumerate(hits):
                if hp != pi:
                    continue
                s = sum(_overlap(q, rr) for q in quads for rr in rects)
                if s > score:
                    best, score = i, s
            if best < 0:
                continue
            caps.append({"page": pi, "k": k, "quads": quads, "quote": quote, "nth": best, "count": len(hits), "at": hits[best][1][0]})
    finally:
        doc.close()
    return caps


def _point(pages, pi: int, k: int, a) -> dict | None:
    """A note or caret tied to the words nearest it: the first phrase around them that occurs on its page, and the line
    of that phrase nearest the comment, which is what it moves with."""
    from .carry import _gap, _phrases

    text, tp = pages[pi]
    rect = _rect(a)
    cx, cy = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
    alts = []
    for quote in _phrases(text, tp, rect):
        hits = _hits(pages, quote)
        mine = [i for i, (hp, _r) in enumerate(hits) if hp == pi]
        if not mine:
            continue
        nth = min(mine, key=lambda i: min(_gap(rr, cx, cy) for rr in hits[i][1]))
        olds = hits[nth][1]
        oi = min(range(len(olds)), key=lambda i: _gap(olds[i], cx, cy))
        alts.append({"quote": quote, "nth": nth, "count": len(hits), "line": oi, "lines": len(olds), "at": olds[oi]})
    if not alts:
        return None
    # the first phrase stands in for the rest; follow tries them all and keeps one that occurs as often as before
    return {"page": pi, "k": k, "point": True, "rect": rect, **alts[0], "alts": alts}


def _same(a, cap) -> bool:
    if cap.get("point"):
        return all(abs(x - y) < 0.01 for x, y in zip(_rect(a), cap["rect"]))
    q = _quads(a)
    return len(q) == len(cap["quads"]) and all(abs(x - y) < 0.01 for qa, qb in zip(q, cap["quads"]) for x, y in zip(qa, qb))


@core.serial
def follow(out, caps: list[dict], passwords: list[str] | None = None) -> int:
    if not caps:
        return 0
    pages, doc = _texts(out, passwords)
    try:
        found = {c["quote"]: _hits(pages, c["quote"]) for c in caps}
        for c in caps:
            if not c.get("point"):
                continue
            choice = None
            for alt in c["alts"]:
                hits = found.setdefault(alt["quote"], _hits(pages, alt["quote"]))
                if hits and len(hits) == alt["count"]:
                    choice = alt
                    break
                if hits and choice is None:
                    choice = alt
            if choice is not None:
                c.update(choice)
    finally:
        doc.close()
    w = PdfWriter(clone_from=PdfReader(str(out)))
    moved = 0
    redraw = []
    for c in caps:
        hits = found[c["quote"]]
        if not hits or c["page"] >= len(w.pages):
            continue
        if len(hits) == c["count"]:
            hp, rects = hits[c["nth"]]
        else:
            ax = c["at"]
            hp, rects = min(hits, key=lambda h: abs(h[0] - c["page"]) * 100000 + abs(h[1][0][0] - ax[0]) + abs(h[1][0][3] - ax[3]))
        if c.get("point"):
            moved += _follow_point(w, c, hp, rects)
            continue
        old = c["quads"]
        if hp == c["page"] and len(rects) == len(old) and all(abs(x - y) < 0.5 for qa, qb in zip(rects, old) for x, y in zip(qa, qb)):
            continue
        page = w.pages[c["page"]]
        arr = _o(page.get("/Annots")) or []
        if c["k"] >= len(arr):
            continue
        ref = arr[c["k"]]
        a = _o(ref)
        if not isinstance(a, DictionaryObject) or not _same(a, c):
            continue
        dx, dy = rects[0][0] - old[0][0], rects[0][3] - old[0][3]
        quads = []
        for l, b, r_, t in rects:
            quads += [l, t, r_, t, l, b, r_, b]
        a[NameObject("/QuadPoints")] = annot._arr(quads)
        x0, y0 = min(q[0] for q in rects), min(q[1] for q in rects)
        x1, y1 = max(q[2] for q in rects), max(q[3] for q in rects)
        same_shape = len(rects) == len(old) and all(abs((n[2] - n[0]) - (o[2] - o[0])) < 0.5 and abs((n[3] - n[1]) - (o[3] - o[1])) < 0.5 for n, o in zip(rects, old))
        rect = [float(v) for v in a.get("/Rect") or [x0, y0, x1, y1]]
        if same_shape and "/AP" in a:
            a[NameObject("/Rect")] = annot._arr([rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy])
        else:
            a[NameObject("/Rect")] = annot._arr([x0 - 1, y0 - 1, x1 + 1, y1 + 1])
            redraw.append((hp, a, rects))
        if hp != c["page"]:
            _move(w, c["page"], hp, ref)
        moved += 1
    for hp, a, rects in redraw:
        _redraw(w, hp, a, rects)
    if moved:
        buf = io.BytesIO()
        w.write(buf)
        Path(out).write_bytes(buf.getvalue())
    return moved


def _follow_point(w: PdfWriter, c: dict, hp: int, rects: list[list[float]]) -> int:
    """Moves a note or caret by as much as its line moved; its popup moves with it."""
    ni = c["line"] if len(rects) == c["lines"] else (0 if c["line"] == 0 else len(rects) - 1)
    dx, dy = rects[ni][0] - c["at"][0], rects[ni][3] - c["at"][3]
    if hp == c["page"] and abs(dx) < 0.5 and abs(dy) < 0.5:
        return 0
    arr = list(_o(w.pages[c["page"]].get("/Annots")) or [])
    # by its place first, then by its box: an earlier comment moving to another page shifts the places after it
    order = ([arr[c["k"]]] if c["k"] < len(arr) else []) + arr
    ref = next((x for x in order if isinstance(_o(x), DictionaryObject) and str(_o(x).get("/Subtype")) in POINT
                and "/IRT" not in _o(x) and _same(_o(x), c)), None)
    if ref is None:
        return 0
    a = _o(ref)
    r = c["rect"]
    a[NameObject("/Rect")] = annot._arr([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy])
    popup = _o(a.get("/Popup")) if "/Popup" in a else None
    if isinstance(popup, DictionaryObject) and popup.get("/Rect") is not None:
        p = _rect(popup)
        popup[NameObject("/Rect")] = annot._arr([p[0] + dx, p[1] + dy, p[2] + dx, p[3] + dy])
    if hp != c["page"]:
        _move(w, c["page"], hp, ref)
    return 1


def _move(w: PdfWriter, src: int, dst: int, ref) -> None:
    a = _o(ref)
    group = [ref]
    popup = a.raw_get("/Popup") if "/Popup" in a else None
    if popup is not None:
        group.append(popup)
    old = _o(w.pages[src].get("/Annots")) or ArrayObject()
    target = getattr(ref, "idnum", None)
    for r in list(old):
        o = _o(r)
        irt = o.raw_get("/IRT") if isinstance(o, DictionaryObject) and "/IRT" in o else None
        if irt is not None and getattr(irt, "idnum", None) == target:
            group.append(r)
    ids = {getattr(g, "idnum", None) for g in group}
    w.pages[src][NameObject("/Annots")] = ArrayObject([r for r in old if getattr(r, "idnum", None) not in ids])
    page = w.pages[dst]
    arr = _o(page.get("/Annots"))
    if not isinstance(arr, ArrayObject):
        arr = ArrayObject()
        page[NameObject("/Annots")] = arr
    for g in group:
        arr.append(g)
        _o(g)[NameObject("/P")] = page.indirect_reference


def _redraw(w: PdfWriter, pi: int, a: DictionaryObject, rects: list[list[float]]) -> None:
    from reportlab.pdfgen import canvas as rlcanvas

    llx, lly, x1, y1 = core.view_box(w.pages[pi])
    W, H = x1 - llx, y1 - lly
    col = [float(v) for v in a.get("/C") or [1, 0.83, 0]][:3]
    win = {"kind": MARKUP[str(a["/Subtype"])], "page": pi + 1, "width": 1, "text": "",
           "color": "#" + "".join(f"{max(0, min(255, round(c * 255))):02X}" for c in col),
           "rects": [[l - llx, lly + H - t, r_ - l, t - b] for l, b, r_, t in rects]}
    if a.get("/CA") is not None:
        win["opacity"] = float(a["/CA"])
    try:
        spec = annot.normalize(win, [(W, H)] * (pi + 1))
        buf = io.BytesIO()
        c = rlcanvas.Canvas(buf, pagesize=(W, H))
        annot.draw(c, spec, H, False)
        c.showPage()
        c.save()
        ov = PdfReader(io.BytesIO(buf.getvalue()))
        bx0, by0, bx1, by1 = annot.bbox(spec)
        bb = [bx0, H - by1, bx1, H - by0]
        a[NameObject("/AP")] = DictionaryObject({NameObject("/N"): annot._form(w, ov.pages[0], bb)})
        a[NameObject("/Rect")] = annot._arr([llx + bb[0], lly + bb[1], llx + bb[2], lly + bb[3]])
    except Exception:
        if "/AP" in a:
            del a["/AP"]


def following(fn):
    @functools.wraps(fn)
    def run(src, out, *args, **kw):
        pw = kw.get("passwords")
        try:
            caps = capture(src, pw)
        except Exception:
            caps = []
        result = fn(src, out, *args, **kw)
        if caps:
            try:
                n = follow(out, caps, pw)
            except Exception:
                n = 0
            if n and isinstance(result, dict):
                result["comments_followed"] = n
        return result
    return run
