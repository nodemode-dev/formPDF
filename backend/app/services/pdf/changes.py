import datetime
import json
import re
from pathlib import Path

from pypdf.generic import DictionaryObject

from . import actions, core
from .anchors import _overlap, _quads, _texts
from .search import _rects
from .xfdf import _name_of, _str

CONTEXT = 40
NOTED = {"/Highlight", "/Underline", "/Squiggly", "/Text", "/FreeText"}


def _o(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _flat(s: str) -> str:
    return re.sub(r"\s+", " ", s or "")


def _context(pages, pi: int, quads, quote: str) -> tuple[str, str]:
    text, tp = pages[pi]
    best, score = None, 0.0
    words = [re.escape(w) for w in quote.split()]
    if not words:
        return "", ""
    for m in re.finditer(r"\s*".join(words), text):
        rects = [[r["x"], -r["y"] - r["h"], r["x"] + r["w"], -r["y"]] for r in _rects(tp, text, m.start(), m.end(), 0.0, 0.0)]
        s = sum(_overlap(q, r) for q in quads for r in rects)
        if best is None or s > score:
            best, score = m, s
    if best is None:
        return "", ""
    return _flat(text[max(0, best.start() - CONTEXT):best.start()]).lstrip(), _flat(text[best.end():best.end() + CONTEXT]).rstrip()


def _caret(pages, pi: int, rect) -> tuple[str, str]:
    text, tp = pages[pi]
    x, y = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
    best, dist = -1, 1e9
    for i in range(len(text)):
        if text[i].isspace():
            continue
        try:
            l, b, r, t = tp.get_charbox(i, loose=True)
        except Exception:
            continue
        if not b - 2 <= y <= t + 2:
            continue
        d = abs(r - x)
        if d < dist:
            best, dist = i, d
    if best < 0:
        return "", ""
    return _flat(text[max(0, best + 1 - CONTEXT):best + 1]).lstrip(), _flat(text[best + 1:best + 1 + CONTEXT]).rstrip()


@core.serial
def export(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    r = core.reader(src, passwords)
    idx = set(core.parse_pages(pages, len(r.pages))) if pages else None
    texts, doc = _texts(src, passwords)
    changes = []
    try:
        for pi, page in enumerate(r.pages):
            if idx is not None and pi + 1 not in idx:
                continue
            arr = [(k, ref, _o(ref)) for k, ref in enumerate(_o(page.get("/Annots")) or [])]
            arr = [(k, ref, a) for k, ref, a in arr if isinstance(a, DictionaryObject)]
            kids: dict[int, list[DictionaryObject]] = {}
            for _k, _ref, a in arr:
                irt = a.raw_get("/IRT") if "/IRT" in a else None
                if irt is not None:
                    kids.setdefault(getattr(irt, "idnum", -1), []).append(a)
            for k, ref, a in arr:
                if "/IRT" in a:
                    continue
                sub = str(a.get("/Subtype"))
                mine = kids.get(getattr(ref, "idnum", -2), [])
                states = sorted(((_str(c.get("/M") or c.get("/CreationDate")), str(c["/State"])[1:].lower()) for c in mine
                                 if "/State" in c and str(c.get("/StateModel") or "/Review") == "/Review"))
                group = [c for c in mine if str(c.get("/RT") or "") == "/Group" and str(c.get("/Subtype")) == "/Caret"]
                replies = [_str(c.get("/Contents")) for c in mine if "/State" not in c and str(c.get("/RT") or "/R") != "/Group" and _str(c.get("/Contents"))]
                rect = [float(v) for v in a.get("/Rect") or [0, 0, 0, 0]]
                row = {"id": _name_of(a, pi, k), "page": pi + 1, "author": _str(a.get("/T")), "date": _str(a.get("/M") or a.get("/CreationDate")),
                       "status": states[-1][1] if states else "none", "replies": replies}
                note = _str(a.get("/Contents")).strip()
                if sub in ("/StrikeOut",) or (sub in NOTED and a.get("/QuadPoints")):
                    quads = _quads(a)
                    _text, tp = texts[pi]
                    parts = []
                    for q in quads:
                        try:
                            parts.append(tp.get_text_bounded(left=q[0] + 0.5, bottom=q[1] + 0.5, right=q[2] - 0.5, top=q[3] - 0.5))
                        except Exception:
                            continue
                    target = _flat(" ".join(parts)).strip()
                    before, after = _context(texts, pi, quads, target) if target else ("", "")
                    row.update(text=target, before=before, after=after)
                    if sub == "/StrikeOut":
                        if group:
                            row.update(type="replace", **{"with": _str(group[0].get("/Contents"))})
                        else:
                            row.update(type="delete")
                        if note and not group:
                            row["note"] = note
                    elif note:
                        row.update(type="comment", note=note)
                    else:
                        continue
                elif sub == "/Caret":
                    if not note:
                        continue
                    before, after = _caret(texts, pi, rect)
                    row.update(type="insert", **{"with": note}, before=before, after=after)
                elif sub in NOTED and note:
                    row.update(type="comment", note=note)
                else:
                    continue
                changes.append(row)
    finally:
        doc.close()
    name = Path(str((args or {}).get("name") or Path(str(src)).name)).name
    body = {"format": "formpdf-changes", "version": 1, "document": name, "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "how": "Each change names the text it applies to with the words before and after it, so it can be found after the layout has moved. type is delete, replace (text becomes with), insert (with goes between before and after) or comment (a note on text). status is the review state: none, accepted, rejected, completed or cancelled.",
            "changes": changes}
    Path(out).write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    counts = {t: sum(1 for c in changes if c["type"] == t) for t in ("delete", "replace", "insert", "comment")}
    return {"changes": len(changes), **counts}


actions.register(actions.Action("export_changes", "export", "Export text changes for a layout app (JSON)", ext=".json",
                                words=("change list", "text edits", "indesign", "corrections", "proof corrections", "json"), run=export))
