"""Text contrast measured on the rendered page (WCAG 2 contrast ratio), so any colour space, transparency and background counts."""
import io

from PIL import Image

from . import core
from .content import interp

SCALE = 2.0
MAX_PAGES = 40
MAX_RUNS = 4000


def _lum(px) -> float:
    def ch(v: float) -> float:
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = px[:3]
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def ratio(a: float, b: float) -> float:
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def _runs(page, doc) -> list[dict]:
    """Visible text grouped by the operator that drew it, with its box in page space and its size."""
    try:
        c = interp.walk(page, doc)
    except Exception:
        return []
    runs: dict = {}
    for g in c.glyphs:
        if g.render == 3 or not g.box or not g.text.strip():
            continue
        r = runs.setdefault((g.where, g.op), {"box": list(g.box), "text": "", "size": 0.0, "font": g.font, "end": None})
        b = r["box"]
        r["box"] = [min(b[0], g.box[0]), min(b[1], g.box[1]), max(b[2], g.box[2]), max(b[3], g.box[3])]
        gap = g.box[0] - r["end"] if r["end"] is not None else 0.0
        r["text"] += (" " if gap > 0.2 * abs(g.box[3] - g.box[1]) and not r["text"].endswith(" ") else "") + g.text
        r["end"] = g.box[2]
        r["size"] = max(r["size"], abs(g.box[3] - g.box[1]))
    return list(runs.values())


def _measure(img: Image.Image, box, vb) -> tuple[float, float] | None:
    """Background and text luminance for a run: the ring just outside its box, and the pixels inside that differ most from it."""
    vx0, _vy0, _vx1, vy1 = vb
    x0, x1 = int((box[0] - vx0) * SCALE), int((box[2] - vx0) * SCALE + 1)
    y0, y1 = int((vy1 - box[3]) * SCALE), int((vy1 - box[1]) * SCALE + 1)
    w, h = img.size
    if x1 - x0 < 3 or y1 - y0 < 3 or x0 < 0 or y0 < 0 or x1 > w or y1 > h:
        return None
    pad = 3
    ring = []
    for x in range(max(0, x0 - pad), min(w, x1 + pad), 2):
        for y in (max(0, y0 - pad), min(h - 1, y1 + pad)):
            ring.append(_lum(img.getpixel((x, y))))
    for y in range(max(0, y0 - pad), min(h, y1 + pad), 2):
        for x in (max(0, x0 - pad), min(w - 1, x1 + pad)):
            ring.append(_lum(img.getpixel((x, y))))
    if not ring:
        return None
    ring.sort()
    bg = ring[len(ring) // 2]
    if ring[int(len(ring) * 0.9)] - ring[int(len(ring) * 0.1)] > 0.35:
        return None  # a busy background (a picture, a pattern): no single ratio describes it
    inside = sorted((abs(_lum(img.getpixel((x, y))) - bg), _lum(img.getpixel((x, y))))
                    for x in range(x0, x1, 1) for y in range(y0, y1, 1))
    if not inside:
        return None
    fg = inside[int(len(inside) * 0.98)][1]
    return bg, fg


def low_contrast(path, passwords=None, max_pages: int = MAX_PAGES) -> tuple[list[dict], int]:
    """Runs of text below 4.5 to 1 (3 to 1 for large text: 18 pt, or 14 pt bold), and how many runs were measured."""
    r = core.reader(path, passwords)
    found, checked = [], 0
    for n, page in enumerate(r.pages[:max_pages], 1):
        runs = _runs(page, r)
        if not runs:
            continue
        try:
            img = Image.open(io.BytesIO(core.render_png(path, n, SCALE, passwords))).convert("RGB")
        except Exception:
            continue
        vb = core.view_box(page)
        for run in runs[:MAX_RUNS]:
            got = _measure(img, run["box"], vb)
            if got is None:
                continue
            checked += 1
            bg, fg = got
            cr = ratio(bg, fg)
            large = run["size"] >= 18 or (run["size"] >= 14 and "bold" in str(run["font"]).lower())
            need = 3.0 if large else 4.5
            if cr + 0.05 < need:
                x0, y0, x1, y1 = run["box"]
                found.append({"page": n, "text": f"{cr:.1f} to 1, needs {need:g}: {run['text'].strip()[:60]}",
                              "box": {"x": round(x0 - vb[0], 2), "y": round(vb[3] - y1, 2), "w": round(x1 - x0, 2), "h": round(y1 - y0, 2)},
                              "ratio": round(cr, 2)})
    return found, checked
