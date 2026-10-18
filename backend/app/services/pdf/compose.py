import base64
import re
import tempfile
from pathlib import Path

from pypdf import PdfWriter

from . import actions, core, items, layout

LEVELS = {"title": (2.0, True), "heading": (1.4, True), "subheading": (1.12, True), "text": (1.0, False)}
LISTS = {"bullets": "bullet", "steps": "number"}
MARKER = re.compile(r"^\s*(?:[•●▪◦\-\*·–]|\(?\d{1,3}[.)]|step\s*\d{1,3}[.:)]?)\s*", re.I)


PAGENO = re.compile(r"^\s*(page\s*)?\d{1,4}\s*(/|of)\s*\d{1,4}\s*$", re.I)
_CACHE: dict[tuple, dict] = {}
_ORIGIN: dict[str, dict] = {}


def _joins(a: dict, b: dict, new_page: bool) -> bool:
    if a["kind"] == "heading" or b["kind"] == "heading" or b.get("list") or abs(a["size"] - b["size"]) > 0.6:
        return False
    if all(r.get("bold") for r in a["runs"]) and not all(r.get("bold") for r in b["runs"]):
        return False
    if new_page:
        return b["x0"] > a["x0first"] + 3 or b["text"][:1].islower()
    return 0 <= b["top"] - a["bottom"] < a["size"] * 0.75 and b["x0"] >= a["x0first"] - 2


def source(path, passwords: list[str] | None = None) -> dict:
    p = Path(str(path))
    if str(p.resolve()) in _ORIGIN:
        return _ORIGIN[str(p.resolve())]
    key = (str(p), p.stat().st_mtime_ns, p.stat().st_size)
    if key in _CACHE:
        return _CACHE[key]
    import pdfplumber

    merged: list[dict] = []
    pw = next(iter(passwords or []), "")
    with pdfplumber.open(str(path), password=pw) as pdf:
        for pn, page in enumerate(pdf.pages, start=1):
            got = layout.page_blocks(page, tables=False)
            first = True
            for b in got["blocks"]:
                if b["kind"] not in ("para", "heading"):
                    continue
                text = re.sub(r"\s+", " ", b["text"]).strip()
                if not text or (PAGENO.match(text) and b["size"] < got["body"]):
                    continue
                cur = {**b, "text": text, "page": pn, "x0first": b["x0"]}
                prev = merged[-1] if merged else None
                if prev and _joins(prev, cur, first and prev["page"] != pn):
                    prev["text"] = prev["text"] + " " + text
                    prev["bottom"] = cur["bottom"]
                    prev["runs"] = prev["runs"] + cur["runs"]
                else:
                    merged.append(cur)
                first = False
            page.close()
    blocks = []
    for n, b in enumerate(merged, start=1):
        kind = f"h{b.get('level', 2)}" if b["kind"] == "heading" else "list" if b.get("list") else \
            "bold" if all(r.get("bold") for r in b["runs"]) else "para"
        blocks.append({"id": f"b{n}", "page": b["page"], "kind": kind, "text": b["text"]})
    pics, k, seen = [], 0, set()
    r = core.reader(path, passwords)
    for pi, page in enumerate(r.pages):
        try:
            found = list(page.images)
        except Exception:
            found = []
        for im in found:
            try:
                w, h = im.image.size
            except Exception:
                continue
            digest = hash(im.data)
            if min(w, h) < 48 or digest in seen:
                continue
            seen.add(digest)
            k += 1
            pics.append({"id": f"p{k}", "page": pi + 1, "w": w, "h": h, "data": im.data})
    out = {"blocks": blocks, "pictures": pics}
    if len(_CACHE) > 16:
        _CACHE.clear()
    _CACHE[key] = out
    return out


def read(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    src = source(path, passwords)
    lines = [f"{b['id']} p{b['page']} {b['kind']}: {b['text']}" for b in src["blocks"]]
    lines += [f"{p['id']} p{p['page']} picture {p['w']}x{p['h']} px" for p in src["pictures"]]
    if src.get("composed"):
        lines.insert(0, "This PDF was made by compose; these are the blocks of the document it was made from, so compose again with them to change it.")
    note = ("Use these ids with compose: {max_pages, blocks: [{kind: title | heading | subheading | text | bullets | steps | picture, "
            "ref | text | items: ['b4-b9', {ref | text, label, level}], width}]}")
    return "\n".join(lines) + "\n" + note, {"blocks": lines, "how": note}


def _expand(ref: str, by: dict) -> list[dict]:
    m = re.fullmatch(r"\s*b(\d+)\s*(?:-\s*b?(\d+))?\s*", str(ref))
    if not m:
        raise ValueError(f"{ref!r} is not a block id like b4 or a range like b4-b9 (read them with the blocks action)")
    a, b = int(m.group(1)), int(m.group(2) or m.group(1))
    if b < a:
        a, b = b, a
    out = []
    for i in range(a, b + 1):
        if f"b{i}" not in by:
            raise ValueError(f"There is no block b{i}; the document has b1 to b{len(by)}")
        out.append(by[f"b{i}"])
    return out


def _texts(spec, by: dict) -> list[str]:
    if isinstance(spec, dict):
        if spec.get("text") is not None:
            return [str(spec["text"])]
        return [b["text"] for b in _expand(spec.get("ref", ""), by)]
    s = str(spec)
    return [b["text"] for b in _expand(s, by)] if re.fullmatch(r"\s*b\d+\s*(-\s*b?\d+)?\s*", s) else [s]


def _elements(spec: list, by: dict, pics: dict) -> list[dict]:
    els = []
    for blk in spec:
        if not isinstance(blk, dict):
            raise ValueError("Each block is an object with a kind")
        kind = blk.get("kind")
        if kind in LEVELS:
            text = " ".join(_texts(blk, by)) if (blk.get("ref") or blk.get("text") is not None) else ""
            for r in blk.get("refs") or []:
                text = (text + " " + " ".join(_texts(r, by))).strip()
            if not text.strip():
                raise ValueError(f"A {kind} block needs ref, refs or text")
            els.append({"kind": kind, "runs": [{"t": text.strip()}]})
        elif kind in LISTS:
            n = 0
            for entry in blk.get("items") or []:
                level = int(entry.get("level", 0)) if isinstance(entry, dict) else 0
                label = entry.get("label") if isinstance(entry, dict) else None
                for t in _texts(entry, by):
                    t = MARKER.sub("", t, count=1) if kind == "steps" or layout.BULLET.match(t) else t
                    if level == 0:
                        n += 1
                    if label:
                        lab = str(label).strip().rstrip(":").strip()
                        if t.lower().startswith(lab.lower()):
                            t = t[len(lab):].lstrip(" :.,;-–").lstrip()
                        label = lab
                    runs = ([{"t": label + ": ", "b": True}] if label else []) + [{"t": t}]
                    els.append({"kind": kind, "runs": runs, "level": max(0, min(3, level)), "n": n})
            if not n and not any(e.get("level") for e in els[-1:]):
                raise ValueError(f"A {kind} block needs items")
        elif kind == "picture":
            pid = str(blk.get("ref", "p1"))
            if pid not in pics:
                raise ValueError(f"There is no picture {pid}; the document has {', '.join(pics) or 'none'}")
            els.append({"kind": "picture", "pic": pics[pid], "width": float(blk.get("width", 0.5))})
        else:
            raise ValueError(f"kind is title, heading, subheading, text, bullets, steps or picture (got {kind!r}); nothing was changed")
    return els


def _req(el: dict, s: float, x: float, w: float, color: str) -> dict:
    if el["kind"] in LEVELS:
        k, bold = LEVELS[el["kind"]]
        runs = [dict(r, b=True) if bold else r for r in el["runs"]]
        return {"kind": "text", "x": x, "w": w, "font": {"family": "sans", "size": round(s * k, 2), "color": color, "lineHeight": 1.2 if bold else 1.32},
                "paras": [{"align": "left", "list": "none", "runs": runs}]}
    para = {"align": "left", "list": LISTS[el["kind"]], "level": el.get("level", 0), "runs": el["runs"]}
    if el["kind"] == "steps" and not el.get("level"):
        para["start"] = el["n"]
    return {"kind": "text", "x": x, "w": w, "font": {"family": "sans", "size": s, "color": color, "lineHeight": 1.32}, "paras": [para]}


def _height(req: dict) -> float:
    return items.layout(items._text_item(req))[1]


def _space(el: dict, prev: dict | None, s: float) -> float:
    if prev is None:
        return 0.0
    k = el["kind"]
    if k == "heading":
        return s * 1.1
    if k == "subheading":
        return s * 0.6
    if k == "picture" or prev["kind"] in ("picture", "title"):
        return s * 0.8
    if k in LISTS and prev["kind"] == k:
        return s * 0.18
    return s * 0.45


def _plan(els: list[dict], s: float, pic_scale: float, W: float, H: float, m: float, color: str) -> list[list[tuple[dict, dict, float]]]:
    cw, ch = W - 2 * m, H - 2 * m
    sized = []
    for el in els:
        if el["kind"] == "picture":
            iw, ih = el["pic"]["w"], el["pic"]["h"]
            share = el["width"] / cw if el["width"] > 1 else el["width"]
            pw = cw * max(0.1, min(1.0, share)) * pic_scale
            ph = pw * ih / max(1, iw)
            if ph > ch * 0.45:
                ph = ch * 0.45
                pw = ph * iw / max(1, ih)
            sized.append(({"kind": "picture", "x": m + (cw - pw) / 2, "w": pw, "h": ph}, ph))
        else:
            indent = s * 1.5 * el.get("level", 0) if el["kind"] in LISTS else 0.0
            req = _req(el, s, m + indent, cw - indent, color)
            sized.append((req, _height(req)))
    pages: list[list[tuple[dict, dict, float]]] = [[]]
    y, prev = 0.0, None
    for i, el in enumerate(els):
        req, h = sized[i]
        gap = _space(el, prev, s)
        keep, j = 0.0, i + 1
        if el["kind"] in ("heading", "subheading", "title"):
            while j < len(els) and els[j]["kind"] in ("heading", "subheading"):
                keep += _space(els[j], els[j - 1], s) + sized[j][1]
                j += 1
            if j < len(els):
                keep += _space(els[j], els[j - 1], s) + min(sized[j][1], ch * 0.5)
        if pages[-1] and y + gap + h + keep > ch:
            pages.append([])
            y, gap = 0.0, 0.0
        pages[-1].append((el, req, m + y + gap))
        y += gap + h
        prev = el
    return pages


def compose(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    spec = args.get("blocks")
    if not isinstance(spec, list) or not spec:
        raise ValueError("blocks is the list of blocks to lay out, in order (read their ids with the blocks action)")
    count = args.get("max_pages") or args.get("pages") or pages
    limit = int(count) if str(count or "").strip().isdigit() else 99
    got = source(src, passwords)
    by = {b["id"]: b for b in got["blocks"]}
    pics = {p["id"]: p for p in got["pictures"]}
    els = _elements(spec, by, pics)
    r = core.reader(src, passwords)
    x0, y0, x1, y1 = core.view_box(r.pages[0])
    W, H = x1 - x0, y1 - y0
    m = float(args.get("margin") or 54)
    color = str(args.get("color") or "#1f1f1f")
    hi, lo = float(args.get("size") or 11.5), float(args.get("min_size") or 7.0)
    best = None
    for pic_scale in (1.0, 0.8, 0.6):
        a, b = lo, hi
        if len(_plan(els, a, pic_scale, W, H, m, color)) > limit:
            continue
        while b - a > 0.15:
            mid = (a + b) / 2
            if len(_plan(els, mid, pic_scale, W, H, m, color)) <= limit:
                a = mid
            else:
                b = mid
        size = round(a - 0.05, 2) if len(_plan(els, round(a, 2), pic_scale, W, H, m, color)) > limit else round(a, 2)
        best = (size, pic_scale)
        break
    if best is None:
        raise ValueError(f"The blocks do not fit within the page limit ({limit}) even at {lo:g} pt; leave some out or allow more pages")
    size, pic_scale = best
    plan = _plan(els, size, pic_scale, W, H, m, color)
    w = PdfWriter(clone_from=r)
    for i in range(len(w.pages) - 1, -1, -1):
        w.remove_page(i)
    for _ in plan:
        w.add_blank_page(W, H)
    try:
        del w._root_object["/Outlines"]
    except KeyError:
        pass
    add = []
    with tempfile.TemporaryDirectory() as tmp:
        for pn, placed in enumerate(plan, start=1):
            for el, req, y in placed:
                item = {**req, "page": pn, "y": y}
                if req["kind"] == "picture":
                    item["data"] = base64.b64encode(el["pic"]["data"]).decode("ascii")
                add.append(item)
        blank = Path(tmp) / "blank.pdf"
        with open(blank, "wb") as fh:
            w.write(fh)
        res = items.change(blank, out, args={"add": add})
    if len(_ORIGIN) > 32:
        _ORIGIN.clear()
    _ORIGIN[str(Path(str(out)).resolve())] = {**got, "composed": True}
    return {"pages": len(plan), "size": size, "picture_scale": pic_scale, "items": len(res.get("ids") or [])}


actions.register(actions.Action("blocks", "read", "List text blocks and pictures by id", words=("blocks", "structure", "reading order", "restructure"),
                                run=read))
actions.register(actions.Action("compose", "change", "Rebuild the document from chosen blocks", "composed",
                                ("rebuild", "relayout", "restructure", "fit to pages", "reformat", "clean up layout"), run=compose))
