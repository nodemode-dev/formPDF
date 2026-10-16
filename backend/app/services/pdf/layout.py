import re
from collections import Counter
from statistics import median

BULLET = re.compile(r"^([•●▪◦–\N{EM DASH}\-\*·]|\(cid:\d+\)|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s")
MAX_DEPTH = 24
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff￾￿]")
RTL = "֐-ࣿיִ-﷿ﹰ-﻿"  # Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms
RTL_RE = re.compile(f"[{RTL}]")
_RTL_RUNS = re.compile(f"[{RTL}]+|[^{RTL}]+")


def logical(text: str) -> str:
    """A word read off the page in visual order (left to right, as pdfplumber gives it) put back in logical order: its
    right-to-left runs come first and read backwards, while digits and Latin inside it keep their own direction."""
    if not RTL_RE.search(text):
        return text
    return "".join(r[::-1] if RTL_RE.match(r) else r for r in reversed(_RTL_RUNS.findall(text)))


def _clean_font(name: str) -> str:
    return re.sub(r"^[A-Z]{6}\+", "", str(name or ""))


def is_bold(font: str) -> bool:
    return bool(re.search(r"bold|black|heavy|semibold|demi|-bd|,bd", _clean_font(font), re.IGNORECASE))


def is_italic(font: str) -> bool:
    return bool(re.search(r"italic|oblique|-it\b|,it\b|-ital", _clean_font(font), re.IGNORECASE))


def family(font: str) -> str:
    f = _clean_font(font)
    low = f.lower()
    if "times" in low:
        return "Times New Roman"
    if "helvetica" in low or "arial" in low:
        return "Arial"
    if "courier" in low:
        return "Courier New"
    base = re.split(r"[-,]", f)[0]
    base = re.sub(r"(MT|PS|Std|Pro|LT)$", "", base)
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", base).strip() or "Arial"


def hex_color(c) -> str | None:
    if c is None:
        return None
    try:
        vals = [float(v) for v in (c if isinstance(c, (list, tuple)) else [c])]
    except (TypeError, ValueError):
        return None
    if len(vals) == 1:
        r = g = b = vals[0]
    elif len(vals) == 3:
        r, g, b = vals
    elif len(vals) == 4:
        cc, m, y, k = vals
        r, g, b = (1 - cc) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)
    else:
        return None
    out = "".join(f"{max(0, min(255, round(v * 255))):02X}" for v in (r, g, b))
    return None if out == "000000" else f"#{out}"


def _gaps(intervals: list[tuple[float, float]], lo: float, hi: float, need: float) -> list[tuple[float, float]]:
    out = []
    cur = lo
    for a, b in sorted(intervals):
        if a - cur >= need and cur > lo:
            out.append((cur, a))
        cur = max(cur, b)
    return out


def _vcuts(items: list[dict]) -> list[tuple[float, float]]:
    if len(items) < 4:
        return []
    x0 = min(w["x0"] for w in items)
    x1 = max(w["x1"] for w in items)
    size = median(w["size"] for w in items)
    width = x1 - x0
    cuts = []
    for a, b in _gaps([(w["x0"], w["x1"]) for w in items], x0, x1, max(8.0, size * 1.1)):
        left = [w for w in items if w["x1"] <= a + 0.1]
        right = [w for w in items if w["x0"] >= b - 0.1]
        if not left or not right:
            continue
        lw = max(w["x1"] for w in left) - min(w["x0"] for w in left)
        rw = max(w["x1"] for w in right) - min(w["x0"] for w in right)
        lines_l = len({round(w["top"] / max(size, 1)) for w in left})
        lines_r = len({round(w["top"] / max(size, 1)) for w in right})
        if lw >= width * 0.2 and rw >= width * 0.2 and lines_l >= 3 and lines_r >= 3:
            cuts.append((a, b))
    return cuts


def _bands(items: list[dict]) -> list[list[dict]]:
    size = median(w["size"] for w in items)
    y0 = min(w["top"] for w in items)
    y1 = max(w["bottom"] for w in items)
    gaps = _gaps([(w["top"], w["bottom"]) for w in items], y0, y1, max(2.0, size * 0.55))
    if not gaps:
        return [items]
    edges = [y0 - 1] + [(a + b) / 2 for a, b in gaps] + [y1 + 1]
    bands = [[] for _ in range(len(edges) - 1)]
    for w in items:
        mid = (w["top"] + w["bottom"]) / 2
        for k in range(len(edges) - 1):
            if edges[k] <= mid < edges[k + 1]:
                bands[k].append(w)
                break
    return [b for b in bands if b]


def _split_cols(items: list[dict], cuts: list[tuple[float, float]], rtl: bool = False) -> list[list[dict]]:
    edges = [float("-inf")] + [(a + b) / 2 for a, b in cuts] + [float("inf")]
    cols = [[] for _ in range(len(edges) - 1)]
    for w in items:
        mid = (w["x0"] + w["x1"]) / 2
        for k in range(len(edges) - 1):
            if edges[k] <= mid < edges[k + 1]:
                cols[k].append(w)
                break
    cols = [c for c in cols if c]
    return cols[::-1] if rtl else cols  # a right-to-left page reads its rightmost column first


def _overlaps(a: list[tuple[float, float]], b: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out = []
    for p, q in a:
        for r, s in b:
            lo, hi = max(p, r), min(q, s)
            if hi - lo >= 4:
                out.append((lo, hi))
    return out


def xycut(items: list[dict], depth: int = 0, rtl: bool = False) -> list[list[dict]]:
    if len(items) <= 1 or depth > MAX_DEPTH:
        return [items]
    cuts = _vcuts(items)
    if cuts:
        out = []
        for col in _split_cols(items, cuts, rtl):
            out += xycut(col, depth + 1, rtl)
        return out
    bands = _bands(items)
    if len(bands) == 1:
        return [items]
    groups: list[tuple[list[dict], list[tuple[float, float]]]] = []
    for band in bands:
        g = _vcuts(band) if len(band) >= 4 else []
        if groups and g and groups[-1][1]:
            shared = _overlaps(groups[-1][1], g)
            if shared:
                groups[-1] = (groups[-1][0] + band, shared)
                continue
        groups.append((band, g))
    if len(groups) == 1:
        band, g = groups[0]
        return [part for col in _split_cols(band, g, rtl) for part in xycut(col, depth + 1, rtl)] if g else [band]
    out = []
    for band, g in groups:
        if g:
            for col in _split_cols(band, g, rtl):
                out += xycut(col, depth + 1, rtl)
        else:
            out += xycut(band, depth + 1, rtl)
    return out


def _lines(words: list[dict], rtl: bool = False) -> list[list[dict]]:
    lines: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        h = max(1.0, w["bottom"] - w["top"])
        for line in reversed(lines[-3:]):
            top = min(x["top"] for x in line)
            bot = max(x["bottom"] for x in line)
            ov = min(bot, w["bottom"]) - max(top, w["top"])
            if ov >= 0.45 * min(h, bot - top) and not any(min(x["x1"], w["x1"]) - max(x["x0"], w["x0"]) > 0.6 * min(x["x1"] - x["x0"], w["x1"] - w["x0"]) for x in line):
                line.append(w)
                break
        else:
            lines.append([w])
    for line in lines:
        line.sort(key=lambda w: w["x0"], reverse=rtl)  # words of a right-to-left line read from the right
    lines.sort(key=lambda ln: (min(w["top"] for w in ln), min(w["x0"] for w in ln)))
    return lines


def _style(w: dict) -> tuple:
    return (round(float(w["size"]) * 2) / 2, is_bold(w["fontname"]), is_italic(w["fontname"]), hex_color(w.get("non_stroking_color")),
            family(w["fontname"]))


def _line_info(line: list[dict]) -> dict:
    sizes = Counter()
    for w in line:
        sizes[round(float(w["size"]), 1)] += len(w["text"])
    return {"words": line, "x0": min(w["x0"] for w in line), "x1": max(w["x1"] for w in line), "top": min(w["top"] for w in line),
            "bottom": max(w["bottom"] for w in line), "size": sizes.most_common(1)[0][0],
            "bold": sum(len(w["text"]) for w in line if is_bold(w["fontname"])) > 0.6 * sum(len(w["text"]) for w in line),
            "text": " ".join(w["text"] for w in line)}


def _paragraphs(lines: list[dict]) -> list[list[dict]]:
    paras: list[list[dict]] = []
    if not lines:
        return paras
    left = min(ln["x0"] for ln in lines)
    right = max(ln["x1"] for ln in lines)
    gaps = [b["top"] - a["bottom"] for a, b in zip(lines, lines[1:]) if b["top"] > a["bottom"] - 1]
    typical = median(gaps) if gaps else 0
    for ln in lines:
        if paras:
            prev = paras[-1][-1]
            gap = ln["top"] - prev["bottom"]
            new = (abs(ln["size"] - prev["size"]) > 0.6 or ln["bold"] != prev["bold"] and (len(prev["text"]) < 90 or len(ln["text"]) < 90)
                   or gap > max(typical * 1.6, ln["size"] * 0.5) or bool(BULLET.match(ln["text"]))
                   or (prev["x1"] < right - max(36.0, (right - left) * 0.2) and prev["text"].rstrip()[-1:] in ".:!?")
                   or (ln["x0"] > left + ln["size"] * 0.8 and prev["x0"] <= left + 1 and len(paras[-1]) > 1))
            if not new:
                paras[-1].append(ln)
                continue
        paras.append([ln])
    return paras


def _runs(lines: list[dict]) -> list[dict]:
    runs: list[dict] = []
    for ln in lines:
        last = None
        for wi, w in enumerate(ln["words"]):
            text = w["text"]
            sep = ""
            if runs:
                prev = runs[-1]["text"]
                if wi == 0 and prev.endswith("-") and len(prev) > 1 and prev[-2].isalpha() and text[:1].islower():
                    runs[-1]["text"] = prev[:-1]
                elif last is None or max(w["x0"] - last["x1"], last["x0"] - w["x1"]) > float(w["size"]) * 0.08:  # either direction
                    sep = " "
            last = w
            st = _style(w)
            if runs and runs[-1]["_st"] == st:
                runs[-1]["text"] += sep + text
            else:
                if sep and runs:
                    runs[-1]["text"] += sep
                runs.append({"text": text, "_st": st, "size": st[0], "bold": st[1], "italic": st[2], "color": st[3], "font": st[4]})
    for r in runs:
        del r["_st"]
    return runs


def body_size(words: list[dict]) -> float:
    c = Counter()
    for w in words:
        c[round(float(w["size"]) * 2) / 2] += len(w["text"])
    return c.most_common(1)[0][0] if c else 11.0


def _align(p_x0: float, p_x1: float, left: float, right: float, lines: int) -> str:
    mid = (p_x0 + p_x1) / 2
    width = right - left
    if width <= 0:
        return "left"
    if p_x0 > left + width * 0.08 and abs(mid - (left + right) / 2) < width * 0.04 and p_x1 < right - width * 0.08:
        return "center"
    if p_x0 > left + width * 0.3 and abs(p_x1 - right) < 4 and lines <= 3:
        return "right"
    return "left"


def _inside(w: dict, boxes: list[tuple[float, float, float, float]]) -> bool:
    cx, cy = (w["x0"] + w["x1"]) / 2, (w["top"] + w["bottom"]) / 2
    return any(b[0] - 1 <= cx <= b[2] + 1 and b[1] - 1 <= cy <= b[3] + 1 for b in boxes)


def page_blocks(page, *, body: float | None = None, tables: bool = True, images: list[dict] | None = None) -> dict:
    W, H = float(page.width), float(page.height)
    ox, oy = float(page.bbox[0]), float(page.bbox[1])
    try:
        words = page.extract_words(extra_attrs=["fontname", "size", "non_stroking_color", "upright"], keep_blank_chars=False, x_tolerance_ratio=0.15)
    except Exception:
        words = []
    words = [dict(w, text=CONTROL.sub("", str(w["text"])), x0=w["x0"] - ox, x1=w["x1"] - ox, top=w["top"] - oy, bottom=w["bottom"] - oy)
             for w in words if CONTROL.sub("", str(w.get("text", ""))).strip()]
    words = [dict(w, text=logical(w["text"])) for w in words if w.get("upright", True) and -2 <= w["x0"] <= W + 2 and -2 <= w["top"] <= H + 2]
    letters = sum(1 for w in words for ch in w["text"] if ch.isalpha())
    rtl = letters > 0 and sum(len(RTL_RE.findall(w["text"])) for w in words) > letters * 0.5
    found = []
    if tables:
        try:
            for t in page.find_tables():
                x0, top, x1, bottom = t.bbox
                rows = [[re.sub(r"\s+", " ", str(c or "")).strip() for c in r] for r in t.extract() if r]
                rows = [r for r in rows if any(r)]
                if len(rows) >= 2 and max(len(r) for r in rows) >= 2:
                    width = max(len(r) for r in rows)
                    found.append({"kind": "table", "bbox": (x0 - ox, top - oy, x1 - ox, bottom - oy), "rows": [r + [""] * (width - len(r)) for r in rows]})
        except Exception:
            found = []
    tboxes = [t["bbox"] for t in found]
    text_words = [w for w in words if not _inside(w, tboxes)]
    base = body or body_size(text_words)
    pseudo = [{"text": "", "size": base, "fontname": "", "x0": t["bbox"][0], "x1": t["bbox"][2], "top": t["bbox"][1], "bottom": t["bbox"][3],
               "block": {"kind": "table", "rows": t["rows"], "top": t["bbox"][1], "bottom": t["bbox"][3], "x0": t["bbox"][0], "x1": t["bbox"][2]}}
              for t in found]
    pseudo += [{"text": "", "size": base, "fontname": "", "x0": img["x0"], "x1": img["x1"], "top": img["top"], "bottom": img["bottom"],
                "block": {"kind": "image", **img}} for img in images or []]
    order: list[dict] = []
    items = text_words + pseudo
    if items:
        left = min(w["x0"] for w in text_words) if text_words else 0
        right = max(w["x1"] for w in text_words) if text_words else W
        for leaf in xycut(items, rtl=rtl):
            local: list[dict] = [w["block"] for w in leaf if "block" in w]
            infos = [_line_info(ln) for ln in _lines([w for w in leaf if "block" not in w], rtl)]
            for para in _paragraphs(infos):
                runs = _runs(para)
                text = "".join(r["text"] for r in runs).strip()
                if not text:
                    continue
                size = Counter({ln["size"]: len(ln["text"]) for ln in para}).most_common(1)[0][0]
                p_x0 = min(ln["x0"] for ln in para)
                p_x1 = max(ln["x1"] for ln in para)
                block = {"kind": "para", "text": text, "runs": runs, "size": size, "top": para[0]["top"], "bottom": para[-1]["bottom"],
                         "x0": p_x0, "x1": p_x1, "lines": len(para), "align": _align(p_x0, p_x1, left, right, len(para))}
                ratio = size / max(base, 1)
                if ratio >= 1.15 and len(text) <= 200 and len(para) <= 4:
                    block["kind"] = "heading"
                    block["level"] = 1 if ratio >= 1.75 else 2 if ratio >= 1.35 else 3
                elif BULLET.match(text):
                    block["list"] = True
                local.append(block)
            order += sorted(local, key=lambda b: b["top"])
    margins = None
    boxes = [(b["x0"], b["top"], b["x1"], b["bottom"]) for b in order if "x0" in b]
    if boxes:
        margins = {"left": min(b[0] for b in boxes), "top": min(b[1] for b in boxes), "right": W - max(b[2] for b in boxes),
                   "bottom": H - max(b[3] for b in boxes)}
    return {"width": W, "height": H, "body": base, "blocks": order, "margins": margins, "rtl": rtl}


def reflow(path, pages=None, passwords: list[str] | None = None) -> dict:
    import pdfplumber

    from . import core

    pw = next(iter(passwords or []), "")
    out = []
    with pdfplumber.open(str(path), password=pw) as pdf:
        n = len(pdf.pages)
        idx = core.parse_pages(pages, n)
        sample = []
        for i in idx[:4]:
            try:
                sample += pdf.pages[i - 1].extract_words(extra_attrs=["size"])
            except Exception:
                continue
        base = body_size(sample) if sample else None
        for i in idx:
            page = pdf.pages[i - 1]
            got = page_blocks(page, body=base)
            blocks = []
            for b in got["blocks"]:
                if b["kind"] in ("para", "heading"):
                    item = {"kind": b["kind"], "text": b["text"], "size": b["size"], "align": b["align"],
                            "runs": [{"text": r["text"], "bold": r["bold"], "italic": r["italic"]} for r in b["runs"]]}
                    if b["kind"] == "heading":
                        item["level"] = b["level"]
                    if b.get("list"):
                        item["list"] = True
                    blocks.append(item)
                elif b["kind"] == "table":
                    blocks.append({"kind": "table", "rows": b["rows"][:200]})
            out.append({"page": i, "blocks": blocks})
            page.close()
    return {"pages": out, "total": n, "body": base or 11.0}


def list_item(text: str) -> tuple[str, str, str] | None:
    m = BULLET.match(text or "")
    if not m:
        return None
    marker = m.group(1)
    kind = "ol" if re.match(r"\(?(\d{1,3}|[a-zA-Z])[.)]", marker) else "ul"
    return kind, marker, text[m.end():]


def strip_runs(runs: list[dict], n: int) -> list[dict]:
    out, left = [], n
    for r in runs:
        t = r["text"]
        if left > 0:
            cut = min(left, len(t))
            t, left = t[cut:], left - cut
            if not out:
                t = t.lstrip()
        if t:
            out.append({**r, "text": t})
    return out


def columns(blocks: list[dict], width: float) -> dict | None:
    body = [b for b in blocks if b.get("kind") in ("para", "heading", "table", "image") and "x0" in b]
    if len(body) < 4:
        return None
    left, right = min(b["x0"] for b in body), max(b["x1"] for b in body)
    span = right - left
    if span <= 0:
        return None
    narrow = [b for b in body if b["x1"] - b["x0"] < span * 0.58]
    if len(narrow) < 3:
        return None
    groups: list[list[dict]] = []
    for b in sorted(narrow, key=lambda b: b["x0"]):
        if groups and b["x0"] < max(x["x1"] for x in groups[-1]) - 2:
            groups[-1].append(b)
        else:
            groups.append([b])
    if not 2 <= len(groups) <= 3 or min(len(g) for g in groups) < 1:
        return None
    tops = [(min(b["top"] for b in g), max(b["bottom"] for b in g)) for g in groups]
    if max(t[0] for t in tops) >= min(t[1] for t in tops):
        return None
    if sum(1 for b in narrow) < 0.6 * len(body):
        return None
    gaps = [min(b["x0"] for b in groups[i + 1]) - max(b["x1"] for b in groups[i]) for i in range(len(groups) - 1)]
    region_top = min(t[0] for t in tops)
    region_bottom = max(t[1] for t in tops)
    return {"count": len(groups), "gutter": max(6.0, min(gaps)), "top": region_top, "bottom": region_bottom, "left": left, "right": right}


def _shape(text: str) -> str:
    return re.sub(r"\d+", "#", re.sub(r"\s+", " ", text.strip().lower()))


def running(pages: list[dict], share: float = 0.6) -> set[str]:
    if len(pages) < 2:
        return set()
    seen: Counter = Counter()
    for p in pages:
        H = p["height"]
        shapes = {_shape(b["text"]) for b in p["blocks"] if b.get("kind") in ("para", "heading") and b.get("text")
                  and (b["bottom"] < H * 0.1 or b["top"] > H * 0.9) and len(b["text"]) <= 120}
        seen.update(shapes)
    need = max(2, int(len(pages) * share + 0.999))
    return {s for s, c in seen.items() if c >= need}


def is_running(b: dict, height: float, shapes: set[str]) -> bool:
    return bool(shapes) and b.get("kind") in ("para", "heading") and bool(b.get("text")) and (b["bottom"] < height * 0.1 or b["top"] > height * 0.9) \
        and _shape(b["text"]) in shapes
