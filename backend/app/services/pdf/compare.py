import difflib
import re
import unicodedata

from . import core, search

MAX_PAGES = 1000
MAX_CHANGES = 3000
WORD = re.compile(r"\S+")


def _norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s).replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')


def _texts(path, passwords) -> list[tuple[str, list[tuple[int, int]], list[str]]]:
    doc = core.pdfium_doc(path, passwords)
    out = []
    try:
        n = len(doc)
        if n > MAX_PAGES:
            raise ValueError(f"Compare PDFs of at most {MAX_PAGES} pages")
        for i in range(n):
            page = doc[i]
            tp = page.get_textpage()
            try:
                text = search._page_text(tp)
            finally:
                tp.close()
                page.close()
            spans = [(m.start(), m.end()) for m in WORD.finditer(text)]
            out.append((text, spans, [_norm(text[a:b]) for a, b in spans]))
    finally:
        doc.close()
    return out


def _sim(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _align_block(a_idx: list[int], b_idx: list[int], sets_a: list[set], sets_b: list[set]) -> list[tuple[int | None, int | None]]:
    n, m = len(a_idx), len(b_idx)
    if not n or not m:
        return [(i, None) for i in a_idx] + [(None, j) for j in b_idx]
    sim = [[_sim(sets_a[i], sets_b[j]) for j in b_idx] for i in a_idx]
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best = max(score[i - 1][j], score[i][j - 1])
            s = sim[i - 1][j - 1]
            if s >= 0.25:
                best = max(best, score[i - 1][j - 1] + s)
            score[i][j] = best
    pairs: list[tuple[int | None, int | None]] = []
    i, j = n, m
    while i > 0 and j > 0:
        s = sim[i - 1][j - 1]
        if s >= 0.25 and abs(score[i][j] - (score[i - 1][j - 1] + s)) < 1e-9:
            pairs.append((a_idx[i - 1], b_idx[j - 1]))
            i, j = i - 1, j - 1
        elif score[i - 1][j] >= score[i][j - 1]:
            pairs.append((a_idx[i - 1], None))
            i -= 1
        else:
            pairs.append((None, b_idx[j - 1]))
            j -= 1
    while i > 0:
        pairs.append((a_idx[i - 1], None))
        i -= 1
    while j > 0:
        pairs.append((None, b_idx[j - 1]))
        j -= 1
    return pairs[::-1]


def align(words_a: list[list[str]], words_b: list[list[str]]) -> list[tuple[int | None, int | None]]:
    keys_a = [" ".join(w) for w in words_a]
    keys_b = [" ".join(w) for w in words_b]
    sets_a = [set(w) for w in words_a]
    sets_b = [set(w) for w in words_b]
    out: list[tuple[int | None, int | None]] = []
    sm = difflib.SequenceMatcher(None, keys_a, keys_b, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out += [(i1 + k, j1 + k) for k in range(i2 - i1)]
        else:
            out += _align_block(list(range(i1, i2)), list(range(j1, j2)), sets_a, sets_b)
    return out


@core.serial
def _rects_for(path, passwords, page: int, spans: list[tuple[int, int]], box) -> list[list[dict]]:
    doc = core.pdfium_doc(path, passwords)
    try:
        pg = doc[page]
        tp = pg.get_textpage()
        try:
            text = search._page_text(tp)
            x0, _, _, y1 = box
            return [search._rects(tp, text, a, b, x0, y1) if b > a else [] for a, b in spans]
        finally:
            tp.close()
            pg.close()
    finally:
        doc.close()


def _caret(rects: list[dict], at_end: bool) -> list[dict]:
    if not rects:
        return []
    r = rects[-1] if at_end else rects[0]
    x = r["x"] + r["w"] if at_end else r["x"]
    return [{"x": round(x - 1.5, 2), "y": r["y"], "w": 3.0, "h": r["h"]}]


@core.serial
def _picture_regions(path_a, pw_a, path_b, pw_b, pairs: list[tuple[int, int]], boxes_a) -> dict[int, list[dict]]:
    from PIL import Image, ImageChops

    out: dict[int, list[dict]] = {}
    da = core.pdfium_doc(path_a, pw_a)
    db = core.pdfium_doc(path_b, pw_b)
    try:
        for ia, ib in pairs[:300]:
            pa, pb = da[ia], db[ib]
            wa, ha = pa.get_size()
            s = min(1.0, 900 / max(wa, ha, 1))
            img_a = core.render_pil(pa, s).convert("L")
            img_b = core.render_pil(pb, s * wa / max(pb.get_size()[0], 1)).convert("L")
            pa.close()
            pb.close()
            if img_b.size != img_a.size:
                img_b = img_b.resize(img_a.size)
            diff = ImageChops.difference(img_a, img_b).point(lambda v: 255 if v > 48 else 0)
            if not diff.getbbox():
                continue
            cell = 12
            cols, rows = max(1, img_a.width // cell), max(1, img_a.height // cell)
            grid = diff.resize((cols, rows), Image.BOX)
            px = grid.load()
            on = {(x, y) for y in range(rows) for x in range(cols) if px[x, y] > 6}
            regions = []
            while on:
                stack = [on.pop()]
                xs, ys = [], []
                while stack:
                    x, y = stack.pop()
                    xs.append(x)
                    ys.append(y)
                    for nx in (x - 1, x, x + 1):
                        for ny in (y - 1, y, y + 1):
                            if (nx, ny) in on:
                                on.discard((nx, ny))
                                stack.append((nx, ny))
                kx, ky = wa / cols, ha / rows
                regions.append({"x": round(min(xs) * kx, 2), "y": round(min(ys) * ky, 2), "w": round((max(xs) - min(xs) + 1) * kx, 2),
                                "h": round((max(ys) - min(ys) + 1) * ky, 2)})
            if regions:
                out[ia] = regions[:60]
    finally:
        da.close()
        db.close()
    return out


def compare(current, other, *, passwords: list[str] | None = None, other_passwords: list[str] | None = None, other_is_newer: bool = False,
            pictures: bool = False) -> dict:
    ta = core.serial(_texts)(current, passwords)
    tb = core.serial(_texts)(other, other_passwords)
    boxes = [core.view_box(p) for p in core.reader(current, passwords).pages]
    pairs = align([t[2] for t in ta], [t[2] for t in tb])
    changes: list[dict] = []
    pages: list[dict] = []
    added = removed = changed = same = 0
    counts = {"inserted": 0, "deleted": 0, "changed": 0}
    last_a = 0
    for ia, ib in pairs:
        if ia is not None:
            last_a = ia + 1
        if ib is None:
            added += 1
            kind = "page-removed" if other_is_newer else "page-added"
            pages.append({"page": ia + 1, "other": None, "status": kind})
            changes.append({"kind": kind, "page": ia + 1, "other": None, "before": "", "after": "", "rects": [
                {"x": 0, "y": 0, "w": round(boxes[ia][2] - boxes[ia][0], 2), "h": round(boxes[ia][3] - boxes[ia][1], 2)}]})
            continue
        if ia is None:
            removed += 1
            kind = "page-added" if other_is_newer else "page-removed"
            pages.append({"page": None, "other": ib + 1, "status": kind, "at": last_a})
            text = " ".join(tb[ib][2])[:160]
            changes.append({"kind": kind, "page": None, "at": last_a, "other": ib + 1, "rects": [],
                            "before": text if kind == "page-removed" else "", "after": text if kind == "page-added" else ""})
            continue
        wa, wb = ta[ia][2], tb[ib][2]
        old, new = (wa, wb) if other_is_newer else (wb, wa)
        ops = [op for op in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes() if op[0] != "equal"]
        if not ops:
            same += 1
            pages.append({"page": ia + 1, "other": ib + 1, "status": "same"})
            continue
        changed += 1
        pages.append({"page": ia + 1, "other": ib + 1, "status": "changed"})
        spans_cur = ta[ia][1]
        want: list[tuple[int, int]] = []
        plan = []
        for tag, i1, i2, j1, j2 in ops:
            if len(changes) + len(plan) >= MAX_CHANGES:
                break
            if other_is_newer:
                c1, c2 = i1, i2
            else:
                c1, c2 = j1, j2
            if c2 > c1:
                want.append((spans_cur[c1][0], spans_cur[c2 - 1][1]))
                caret = None
            else:
                at = min(c1, len(spans_cur) - 1)
                want.append((spans_cur[at][0], spans_cur[at][1]) if spans_cur else (0, 0))
                caret = c1 >= len(spans_cur)
            label = {"replace": "changed", "insert": "inserted", "delete": "deleted"}[tag]
            plan.append((label, " ".join(old[i1:i2]), " ".join(new[j1:j2]), caret))
            counts[label] += 1
        rects = _rects_for(current, passwords, ia, want, boxes[ia]) if want else []
        for (label, before, after, caret), rc in zip(plan, rects):
            changes.append({"kind": label, "page": ia + 1, "other": ib + 1, "before": before[:400], "after": after[:400],
                            "rects": _caret(rc, bool(caret)) if caret is not None else rc})
    regions: dict[int, list[dict]] = {}
    if pictures:
        regions = _picture_regions(current, passwords, other, other_passwords, [(a, b) for a, b in pairs if a is not None and b is not None], boxes)
        for ia, rects in sorted(regions.items()):
            changes.append({"kind": "picture", "page": ia + 1, "other": None, "before": "", "after": "", "rects": rects})
    changes.sort(key=lambda c: (c["page"] if c["page"] is not None else c.get("at", 0) + 0.5, c["rects"][0]["y"] if c["rects"] else 0))
    for k, c in enumerate(changes):
        c["id"] = k
    return {"summary": {"pages": len(ta), "otherPages": len(tb), "added": added if not other_is_newer else removed,
                        "removed": removed if not other_is_newer else added, "changed": changed, "same": same, "pictures": len(regions), "words": counts},
            "changes": changes, "pages": pages, "truncated": len(changes) >= MAX_CHANGES}
