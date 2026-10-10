import re

from . import core

MAX_MATCHES = 2000
CONTEXT = 48
MONTH = (r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|"
         r"Nov(?:ember)?|Dec(?:ember)?)")
ORD = r"(?:st|nd|rd|th)?"


def _digits(s: str) -> int:
    return sum(ch.isdigit() for ch in s)


def _phone_ok(s: str) -> bool:
    return 7 <= _digits(s) <= 15


def _luhn(s: str) -> bool:
    nums = [int(ch) for ch in s if ch.isdigit()]
    if not 13 <= len(nums) <= 19:
        return False
    total = 0
    for k, d in enumerate(reversed(nums)):
        if k % 2:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


PRESETS: dict[str, tuple[str, int, object]] = {
    "email": (r"(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])", 0, None),
    "phone": (r"(?<![\w+])(?<!\d[ .-])(?:\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,4}(?:[ .-]?\d{2,4}){1,4}|\(\d{2,5}\)[ .-]?\d{3,4}[ .-]?\d{3,5}"
              r"|\d{2,5}[ .-]\d{3,4}[ .-]\d{3,5}|\d{2}(?:[ .]\d{2}){4})(?!\w)(?![ .-]\d)", 0, _phone_ok),
    "card": (r"(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])", 0, _luhn),
    "date": (rf"(?<![\w/.-])(?:\d{{4}}-\d{{1,2}}-\d{{1,2}}|\d{{1,2}}[/.-]\d{{1,2}}[/.-](?:\d{{4}}|\d{{2}})|\d{{1,2}}{ORD}\s+{MONTH}\.?,?\s+\d{{4}}"
             rf"|{MONTH}\.?\s+\d{{1,2}}{ORD},?\s+\d{{4}}|{MONTH}\.?\s+\d{{4}})(?![\w/])", re.IGNORECASE, None),
}


def pattern(query: str | None = None, *, regex: bool = False, preset: str | None = None, case_sensitive: bool = False,
            whole_word: bool = False) -> tuple[re.Pattern, object]:
    if preset:
        if preset not in PRESETS:
            raise ValueError(f"preset must be one of {', '.join(PRESETS)}")
        src, flags, check = PRESETS[preset]
        return re.compile(src, flags), check
    q = str(query or "")
    if not q.strip():
        raise ValueError("Type a word, phrase or pattern to find")
    if len(q) > 500:
        raise ValueError("The search is longer than 500 characters")
    if regex:
        src = q
    else:
        src = r"\s+".join(re.escape(part) for part in q.strip().split())
    if whole_word:
        src = rf"(?<!\w)(?:{src})(?!\w)"
    try:
        return re.compile(src, 0 if case_sensitive else re.IGNORECASE), None
    except re.error as e:
        raise ValueError(f"That pattern is not a valid regular expression: {e}") from None


def _page_text(tp) -> str:
    n = tp.count_chars()
    text = tp.get_text_range() if n else ""
    if len(text) != n:
        import pypdfium2.raw as pdfium_c

        text = "".join(chr(pdfium_c.FPDFText_GetUnicode(tp.raw, i) or 32) for i in range(n))
    return "".join(ch if ch in "\r\n\t" or ch.isprintable() else " " for ch in text)


def _rects(tp, text: str, start: int, end: int, x0: float, y1: float) -> list[dict]:
    boxes: list[list[float]] = []
    cur: list[float] | None = None
    for i in range(start, end):
        ch = text[i]
        if ch in "\r\n":
            if cur:
                boxes.append(cur)
                cur = None
            continue
        if ch.isspace():
            continue
        left, bottom, right, top = tp.get_charbox(i, loose=True)
        if right - left <= 0 or top - bottom <= 0:
            continue
        if cur and (bottom >= cur[3] or top <= cur[1]):
            boxes.append(cur)
            cur = None
        cur = [left, bottom, right, top] if cur is None else [min(cur[0], left), min(cur[1], bottom), max(cur[2], right), max(cur[3], top)]
    if cur:
        boxes.append(cur)
    return [{"x": round(b[0] - x0, 2), "y": round(y1 - b[3], 2), "w": round(b[2] - b[0], 2), "h": round(b[3] - b[1], 2)} for b in boxes]


def _flat(s: str) -> str:
    return re.sub(r"\s+", " ", s)


@core.serial
def find(path, query: str | None = None, *, regex: bool = False, preset: str | None = None, case_sensitive: bool = False,
         whole_word: bool = False, pages=None, passwords: list[str] | None = None) -> dict:
    rx, check = pattern(query, regex=regex, preset=preset, case_sensitive=case_sensitive, whole_word=whole_word)
    r = core.reader(path, passwords)
    boxes = [core.view_box(p) for p in r.pages]
    doc = core.pdfium_doc(path, passwords)
    matches: list[dict] = []
    truncated = False
    try:
        for i in core.parse_pages(pages, len(doc)):
            page = doc[i - 1]
            tp = page.get_textpage()
            try:
                text = _page_text(tp)
                x0, _, _, y1 = boxes[i - 1]
                for m in rx.finditer(text):
                    if m.end() <= m.start() or not m.group(0).strip():
                        continue
                    if check and not check(m.group(0)):
                        continue
                    rects = _rects(tp, text, m.start(), m.end(), x0, y1)
                    if not rects:
                        continue
                    before, after = _flat(text[max(0, m.start() - CONTEXT):m.start()]).lstrip(), _flat(text[m.end():m.end() + CONTEXT]).rstrip()
                    if m.start() > CONTEXT and " " in before:
                        before = "…" + before.split(" ", 1)[1]
                    if m.end() + CONTEXT < len(text) and " " in after.strip():
                        after = after.rsplit(" ", 1)[0] + "…"
                    found = _flat(m.group(0)).strip()
                    matches.append({"page": i, "text": found, "before": before, "after": after, "context": f"{before}{found}{after}".strip(),
                                    "rects": rects})
                    if len(matches) >= MAX_MATCHES:
                        truncated = True
                        break
            finally:
                tp.close()
                page.close()
            if truncated:
                break
    finally:
        doc.close()
    return {"matches": matches, "count": len(matches), "pages": len({m["page"] for m in matches}), "truncated": truncated}


def areas(matches: list[dict], pad: float = 1.0) -> list[dict]:
    out = []
    for m in matches:
        for rc in m.get("rects") or []:
            out.append({"page": int(m["page"]), "x": float(rc["x"]) - pad, "y": float(rc["y"]) - pad, "w": float(rc["w"]) + 2 * pad,
                        "h": float(rc["h"]) + 2 * pad})
    return out
