"""Comments carried from a reviewed PDF to a new version of it, such as a new PDF from the layout app.

Each comment is tied to the words it marks or sits next to on the old pages, those words are found again in the new
file, and the comment moves by as much as they moved (to another page if they did). Highlights and other text markups
take the shape of the words where they now stand. The move is written as XFDF and brought in by the XFDF import, so
replies, statuses, appearances and duplicates (comments already carried) are handled the same way as an import."""
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape

from . import actions, anchors, core, docs, xfdf

NEAR = 48.0  # points from a comment to the nearest word it can be tied to
WORDS = 5


def _source(args: dict) -> Path:
    if args.get("from_doc"):
        did = str(args["from_doc"])
        if not docs.valid(did):
            raise ValueError("from_doc is not a document in this library")
        return docs.path_of(did)
    if args.get("from"):
        p = Path(str(args["from"])).expanduser()
        if not p.is_file():
            raise ValueError(f"{p} is not a file")
        return p
    raise ValueError("Give the reviewed PDF as from (a path) or from_doc (a document in the library)")


def _phrases(text: str, tp, rect: list[float]) -> list[str]:
    """Short phrases around the word nearest a point comment: starting at it, ending at it and centred on it, so that
    one of them stays whole when the new layout breaks a line or a page next to the word."""
    cx, cy = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
    best, dist = -1, NEAR
    for i, ch in enumerate(text):
        if not ch.strip():
            continue
        try:
            l, b, r, t = tp.get_charbox(i)
        except Exception:
            continue
        dx = max(l - cx, 0, cx - r)
        dy = max(b - cy, 0, cy - t)
        d = (dx * dx + dy * dy) ** 0.5
        if d < dist:
            best, dist = i, d
            if d == 0:
                break
    if best < 0:
        return []
    start = best
    while start > 0 and not text[start - 1].isspace():
        start -= 1
    after = re.findall(r"\S+", text[start:start + 200])
    before = re.findall(r"\S+", text[max(0, start - 200):start])
    out = []
    for words in (after[:WORDS], before[-(WORDS - 1):] + after[:1], before[-2:] + after[:3], after[:2], before[-1:] + after[:1]):
        quote = " ".join(words)
        if len(quote) >= 3 and quote not in out:
            out.append(quote)
    return out


def _quote(text: str, tp, quads: list[list[float]]) -> str:
    parts = []
    for q in quads:
        try:
            parts.append(tp.get_text_bounded(left=q[0] + 0.5, bottom=q[1] + 0.5, right=q[2] - 0.5, top=q[3] - 0.5))
        except Exception:
            continue
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def _gap(r: list[float], x: float, y: float) -> float:
    """How far a point is from a box, 0 inside it."""
    return max(r[0] - x, 0, x - r[2]) + max(r[1] - y, 0, y - r[3])


def _pick(hits: list, old_page: int, old_box: list[float], nth: int, count: int):
    """The occurrence in the new file: the same one by count when the words occur as often as before, else the nearest."""
    if not hits:
        return None
    if len(hits) == count and 0 <= nth < len(hits):
        return hits[nth]
    return min(hits, key=lambda h: abs(h[0] - old_page) * 100000 + abs(h[1][0][0] - old_box[0]) + abs(h[1][0][3] - old_box[3]))


def _shift_el(el: ET.Element, page: int, dx: float, dy: float) -> None:
    el.set("page", str(page))
    if el.get("rect"):
        r = xfdf._floats(el.get("rect"))
        el.set("rect", xfdf._nums([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]))
    for key in ("start", "end"):
        if el.get(key):
            x, y = xfdf._floats(el.get(key))[:2]
            el.set(key, xfdf._nums([x + dx, y + dy]))
    if el.get("coords"):
        c = xfdf._floats(el.get("coords"))
        el.set("coords", xfdf._nums([v + (dx if i % 2 == 0 else dy) for i, v in enumerate(c)]))
    v = el.find("vertices")
    if v is not None and v.text:
        c = xfdf._floats(v.text)
        v.text = xfdf._nums([x + (dx if i % 2 == 0 else dy) for i, x in enumerate(c)])
    for g in el.iter("gesture"):
        pts = [p.split(",") for p in (g.text or "").split(";") if "," in p]
        g.text = ";".join(f"{xfdf._num(float(x) + dx)},{xfdf._num(float(y) + dy)}" for x, y in pts)


@core.serial
def _plan(old: Path, new: Path, passwords) -> tuple[dict, dict]:
    """For each top-level comment on the old pages, by its XFDF name: the new page and the move, or None when its words
    were not found, plus the new shape of text markups."""
    r = core.reader(old)
    old_pages, old_doc = anchors._texts(old, None)
    new_pages, new_doc = anchors._texts(new, passwords)
    moves: dict[str, tuple | None] = {}
    shapes: dict[str, list[list[float]]] = {}
    cache: dict[str, list] = {}
    try:
        for pi, page in enumerate(r.pages):
            text, tp = old_pages[pi]
            for k, ref in enumerate(anchors._o(page.get("/Annots")) or []):
                a = anchors._o(ref)
                if not hasattr(a, "get") or str(a.get("/Subtype")) not in xfdf.ELEMENT or "/IRT" in a:
                    continue
                name = xfdf._name_of(a, pi, k)
                quads = anchors._quads(a) if a.get("/QuadPoints") else []
                rect = [float(v) for v in a.get("/Rect") or [0, 0, 0, 0]]
                rect = [min(rect[0], rect[2]), min(rect[1], rect[3]), max(rect[0], rect[2]), max(rect[1], rect[3])]
                quotes = [_quote(text, tp, quads)] if quads else _phrases(text, tp, rect)
                moves[name] = None
                fallback = None
                for quote in (q for q in quotes if len(q) >= 2):
                    old_hits = cache.setdefault("o" + quote, anchors._hits(old_pages, quote))
                    mine = [i for i, (hp, _r) in enumerate(old_hits) if hp == pi]
                    if not mine:
                        continue
                    if quads:
                        nth = max(mine, key=lambda i: sum(anchors._overlap(q, rr) for q in quads for rr in old_hits[i][1]))
                    else:
                        cx, cy = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
                        nth = min(mine, key=lambda i: min(_gap(rr, cx, cy) for rr in old_hits[i][1]))
                    ref_box = old_hits[nth][1][0]
                    new_hits = cache.setdefault("n" + quote, anchors._hits(new_pages, quote))
                    hit = _pick(new_hits, pi, ref_box, nth, len(old_hits))
                    if hit is None:
                        continue
                    hp, rects = hit
                    # move with the line nearest the comment: the phrase may wrap differently in the new layout
                    olds = old_hits[nth][1]
                    cx, cy = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
                    oi = min(range(len(olds)), key=lambda i: _gap(olds[i], cx, cy))
                    ni = oi if len(rects) == len(olds) else (0 if oi == 0 else len(rects) - 1)
                    ref_box = olds[oi]
                    found = ((hp, rects[ni][0] - ref_box[0], rects[ni][3] - ref_box[3]), rects)
                    if len(new_hits) == len(old_hits):  # the same number of occurrences: the same one, by its place in order
                        fallback = found
                        break
                    fallback = fallback or found
                if fallback is not None:
                    moves[name] = fallback[0]
                    if quads:
                        shapes[name] = fallback[1]
    finally:
        old_doc.close()
        new_doc.close()
    return moves, shapes


def carry(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    old = _source(args)
    if Path(old).resolve() == Path(src).resolve():
        raise ValueError("The reviewed PDF and this one are the same file")
    tmp = Path(out).with_suffix(".carry.xfdf")
    try:
        got = xfdf.export(old, tmp)
        if not got["comments"] and not got["replies"]:
            raise ValueError("The reviewed PDF has no comments to carry")
        items = xfdf._parse(tmp.read_bytes())
    finally:
        tmp.unlink(missing_ok=True)
    moves, shapes = _plan(Path(old), Path(src), passwords)
    total = len(core.reader(src, passwords).pages)
    placed: dict[str, tuple] = {}
    counts = {"followed": 0, "in_place": 0, "left_out": 0}
    keep = []
    for el in items:
        if el.get("inreplyto"):
            continue
        name = el.get("name") or ""
        mv = moves.get(name)
        if mv is not None:
            page, dx, dy = mv
            _shift_el(el, page, dx, dy)
            if name in shapes:
                rects = shapes[name]
                quads = []
                for l, b, r_, t in rects:
                    quads += [l, t, r_, t, l, b, r_, b]
                el.set("coords", xfdf._nums(quads))
                el.set("rect", xfdf._nums([min(q[0] for q in rects) - 1, min(q[1] for q in rects) - 1, max(q[2] for q in rects) + 1, max(q[3] for q in rects) + 1]))
            placed[name] = (page, dx, dy)
            counts["followed"] += 1
        else:
            page = int(el.get("page") or 0)
            if page >= total:
                counts["left_out"] += 1
                continue
            placed[name] = (page, 0.0, 0.0)  # not tied to words: kept where it was, on the same page
            counts["in_place"] += 1
        keep.append(el)
    for el in items:  # replies go with the comment they answer
        if not el.get("inreplyto"):
            continue
        parent = placed.get(el.get("inreplyto") or "")
        if parent is None:
            continue
        _shift_el(el, *parent)
        placed[el.get("name") or ""] = parent
        keep.append(el)
    if not keep:
        raise ValueError("None of the reviewed PDF's comments fit on this file's pages")
    body = "".join(ET.tostring(el, encoding="unicode") for el in keep)
    data = f'<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="{xfdf.NS}" xml:space="preserve"><annots>{body}</annots><f href="{escape(Path(str(old)).name)}"/></xfdf>'
    res = xfdf.import_(src, out, args={"data": data}, passwords=passwords)
    return {**res, **counts}


actions.register(actions.Action("carry_comments", "change", "Carry comments from the reviewed version", "comments",
                                ("carry comments", "new version", "transfer comments", "migrate comments", "layout app", "reviewed pdf"),
                                fields=(actions.Field("from", "Reviewed PDF", hint="Path of the earlier PDF whose comments come across"),),
                                run=carry))
