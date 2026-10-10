from . import core


def to_pdf(page, x: float, y: float, w: float, h: float) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = core.view_box(page)
    return x0 + x, y1 - (y + h), x0 + x + w, y1 - y


def point_to_pdf(page, x: float, y: float) -> tuple[float, float]:
    x0, _, _, y1 = core.view_box(page)
    return x0 + x, y1 - y


def from_pdf(page, rect) -> dict:
    x0, _, _, y1 = core.view_box(page)
    a, b, c, d = (float(v) for v in rect)
    lx, ux, ly, uy = min(a, c), max(a, c), min(b, d), max(b, d)
    return {"x": round(lx - x0, 2), "y": round(y1 - uy, 2), "w": round(ux - lx, 2), "h": round(uy - ly, 2)}


def overlaps(a: dict, b: dict, pad: float = 0.5) -> bool:
    return not (a["x"] + a["w"] < b["x"] + pad or b["x"] + b["w"] < a["x"] + pad or a["y"] + a["h"] < b["y"] + pad or b["y"] + b["h"] < a["y"] + pad)


def box(v: dict) -> tuple[float, float, float, float]:
    try:
        x, y, w, h = float(v["x"]), float(v["y"]), float(v["w"]), float(v["h"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("A box needs x, y, w and h in points from the top left of the page") from None
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    return x, y, w, h
