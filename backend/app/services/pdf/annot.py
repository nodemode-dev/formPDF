import base64
import io
import math
import re
import time
import uuid
from functools import lru_cache
from pathlib import Path

from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject,
                           NumberObject, TextStringObject)
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rlcanvas

from app.core import config

from . import core

KINDS = ("highlight", "underline", "strikeout", "squiggly", "note", "freetext", "callout", "ink", "rect", "ellipse", "line", "arrow", "polygon", "polyline",
         "cloud", "image", "stamp")
MARKUP = ("highlight", "underline", "strikeout", "squiggly")
POLY = ("polygon", "polyline", "cloud")
BOXED = ("note", "freetext", "image", "rect", "ellipse", "stamp")
SUBTYPE = {"highlight": "/Highlight", "underline": "/Underline", "strikeout": "/StrikeOut", "squiggly": "/Squiggly", "note": "/Text", "freetext": "/FreeText", "callout": "/FreeText",
           "ink": "/Ink", "rect": "/Square", "ellipse": "/Circle", "line": "/Line", "arrow": "/Line", "polygon": "/Polygon", "polyline": "/PolyLine",
           "cloud": "/Polygon", "image": "/Stamp", "stamp": "/Stamp"}
DEFAULT_COLOR = {"highlight": "#FFD400", "note": "#FFD400", "freetext": "#111111", "callout": "#E11D48", "image": "#111111", "stamp": "#15803D"}
SHAPES = ("box", "tag", "mark")
NOTE = 20.0
MAX_ANNOTS = 2000
STATES = {"none": "/None", "accepted": "/Accepted", "rejected": "/Rejected", "completed": "/Completed", "cancelled": "/Cancelled"}
LISTED = {"/Text": "note", "/FreeText": "freetext", "/Line": "line", "/Square": "rect", "/Circle": "ellipse", "/Polygon": "polygon",
          "/PolyLine": "polyline", "/Highlight": "highlight", "/Underline": "underline", "/Squiggly": "squiggly", "/StrikeOut": "strikeout",
          "/Stamp": "stamp", "/Caret": "caret", "/Ink": "ink", "/FileAttachment": "attachment", "/Sound": "sound", "/Redact": "redact"}


def rgb(value, default: str = "#000000") -> tuple[float, float, float]:
    s = str(value or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if not re.fullmatch(r"[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", s):
        s = default.lstrip("#")
    return tuple(int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _clamp(v, lo: float, hi: float, default: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(f) else max(lo, min(hi, f))


@lru_cache(maxsize=1)
def text_font() -> str:
    import reportlab

    candidates = [config.fonts_dir() / "Inter-Regular.ttf", Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
                  Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"), Path("/Library/Fonts/Arial Unicode.ttf"),
                  Path("C:/Windows/Fonts/arial.ttf"), Path(reportlab.__file__).parent / "fonts" / "Vera.ttf"]
    for p in candidates:
        if p.is_file():
            try:
                pdfmetrics.registerFont(TTFont("FsSans", str(p)))
                return "FsSans"
            except Exception:
                continue
    return "Helvetica"


def font_for(text: str, bold: bool = False) -> str:
    try:
        text.encode("cp1252")
        return "Helvetica-Bold" if bold else "Helvetica"
    except UnicodeEncodeError:
        return text_font()


def wrap(text: str, font: str, size: float, width: float) -> list[str]:
    lines: list[str] = []
    for para in str(text or "").split("\n"):
        words = para.split(" ")
        line = ""
        for word in words:
            cand = word if not line else f"{line} {word}"
            if pdfmetrics.stringWidth(cand, font, size) <= width or not line:
                line = cand
                while pdfmetrics.stringWidth(line, font, size) > width and len(line) > 1:
                    cut = len(line)
                    while cut > 1 and pdfmetrics.stringWidth(line[:cut], font, size) > width:
                        cut -= 1
                    lines.append(line[:cut])
                    line = line[cut:]
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def _pt(v) -> tuple[float, float]:
    if isinstance(v, dict):
        return float(v["x"]), float(v["y"])
    return float(v[0]), float(v[1])


def _rect(v) -> tuple[float, float, float, float]:
    if isinstance(v, dict):
        x, y, w, h = float(v["x"]), float(v["y"]), float(v["w"]), float(v["h"])
    else:
        x, y, w, h = (float(n) for n in v[:4])
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    return x, y, w, h


def _image(data_url: str):
    from PIL import Image

    m = re.fullmatch(r"data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)", str(data_url or "").strip())
    if not m:
        raise ValueError("An image annotation needs a PNG or JPEG data URL")
    raw = base64.b64decode(m.group(2))
    if len(raw) > 12 * 1024 * 1024:
        raise ValueError("The stamp image is larger than 12 MB")
    img = Image.open(io.BytesIO(raw))
    img.load()
    return img.convert("RGBA") if img.mode not in ("RGB", "RGBA") else img


def _replies(v) -> list[str]:
    out = []
    for r in (v if isinstance(v, list) else [])[:200]:
        text = str((r.get("text") if isinstance(r, dict) else r) or "").strip()[:8000]
        if text:
            out.append(text)
    return out


def _status(v) -> str | None:
    if v in (None, ""):
        return None
    s = str(v).strip().lower()
    if s not in STATES:
        raise ValueError(f"A comment status is one of {', '.join(STATES)}")
    return s


def _stamp_spec(v) -> dict:
    v = v if isinstance(v, dict) else {}
    label = re.sub(r"\s+", " ", str(v.get("label") or "")).strip()[:60]
    shape = str(v.get("shape") or "box")
    if shape not in SHAPES:
        raise ValueError(f"A stamp shape is one of {', '.join(SHAPES)}")
    mark = str(v.get("mark") or "")
    if shape == "mark" and mark not in ("check", "cross"):
        raise ValueError("A mark stamp is a check or a cross")
    if shape != "mark" and not label:
        raise ValueError("A stamp needs a label")
    name = re.sub(r"[^A-Za-z0-9]", "", str(v.get("name") or label.title())) or "Stamp"
    return {"label": label, "sub": re.sub(r"\s+", " ", str(v.get("sub") or "")).strip()[:120], "shape": shape, "mark": mark, "name": name[:40]}


def normalize(a: dict, sizes: list[tuple[float, float]]) -> dict:
    kind = a.get("kind")
    if kind not in KINDS:
        raise ValueError(f"Unknown annotation kind {kind!r}")
    try:
        page = int(a.get("page"))
    except (TypeError, ValueError):
        raise ValueError("Every annotation needs a page number") from None
    if not 1 <= page <= len(sizes):
        raise ValueError(f"Page {page} is out of range (1 to {len(sizes)})")
    rot = int(round(_clamp(a.get("rot"), -720, 720, 0) / 90)) * 90 % 360
    out = {"kind": kind, "page": page, "color": rgb(a.get("color"), DEFAULT_COLOR.get(kind, "#E11D48")), "rot": rot,
           "opacity": _clamp(a.get("opacity"), 0.05, 1, 0.4 if kind == "highlight" else 1), "width": _clamp(a.get("width"), 0.25, 48, 2),
           "text": str(a.get("text") or "")[:8000], "size": _clamp(a.get("size"), 4, 144, 12), "flatten": a.get("flatten"),
           "fill": rgb(a["fill"]) if a.get("fill") else None, "replies": _replies(a.get("replies")), "status": _status(a.get("status"))}
    try:
        if kind in MARKUP:
            out["rects"] = [_rect(r) for r in (a.get("rects") or [])][:400]
            if not out["rects"]:
                raise ValueError(f"A {kind} needs at least one rectangle")
        elif kind in ("line", "arrow"):
            pts = [_pt(p) for p in (a.get("points") or [])]
            if len(pts) < 2:
                raise ValueError(f"A {kind} needs two points")
            out["points"] = pts[:2]
        elif kind in POLY:
            pts = [_pt(p) for p in (a.get("points") or [])][:2000]
            if len(pts) < (2 if kind == "polyline" else 3):
                raise ValueError(f"A {kind} needs at least {2 if kind == 'polyline' else 3} points")
            out["points"] = pts
        elif kind == "ink":
            paths = [[_pt(p) for p in path][:4000] for path in (a.get("paths") or []) if path]
            if not paths:
                raise ValueError("An ink annotation needs at least one stroke")
            out["paths"] = paths[:200]
        else:
            x, y = float(a.get("x", 0)), float(a.get("y", 0))
            w, h = (NOTE, NOTE) if kind == "note" else (float(a.get("w", 0)), float(a.get("h", 0)))
            out["box"] = _rect((x, y, max(w, 1), max(h, 1)))
            if kind == "image":
                out["image"] = _image(a.get("image"))
            elif kind == "callout":
                tip = a.get("anchor") or (a.get("points") or [None])[0]
                if tip is None:
                    raise ValueError("A callout needs an anchor point it points at")
                out["points"] = [_pt(tip)]
                out["width"] = _clamp(a.get("width"), 0.25, 48, 1)
            elif kind == "stamp":
                out["stamp"] = _stamp_spec(a.get("stamp"))
                if not out["text"]:
                    out["text"] = " ".join(p for p in (out["stamp"]["label"], out["stamp"]["sub"]) if p) or out["stamp"]["mark"].title()
    except (KeyError, TypeError, IndexError):
        raise ValueError(f"The {kind} annotation on page {page} has malformed coordinates") from None
    return out


def cloud_r(a: dict) -> float:
    return max(4.0, a["width"] * 3)


def cloud_arcs(pts: list[tuple[float, float]], r: float) -> list[tuple[tuple[float, float], ...]]:
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    sign = 1 if area >= 0 else -1
    segs = []
    for i in range(n):
        (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % n]
        length = math.hypot(x1 - x0, y1 - y0)
        if length < 1e-6:
            continue
        k = max(1, round(length / (2 * r)))
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        nx, ny = uy * sign, -ux * sign
        h = length / k * 0.66
        for j in range(k):
            ax, ay = x0 + ux * length * j / k, y0 + uy * length * j / k
            bx, by = x0 + ux * length * (j + 1) / k, y0 + uy * length * (j + 1) / k
            segs.append(((ax, ay), (ax + nx * h, ay + ny * h), (bx + nx * h, by + ny * h), (bx, by)))
    return segs


def squiggle(x: float, y: float, w: float, h: float, rot: int) -> tuple[list[tuple[float, float]], float]:
    across = h if rot % 180 == 0 else w
    amp = max(0.6, min(across * 0.06, 2.4))
    step = amp * 2
    if rot % 180 == 0:
        base = y + h - amp if rot == 0 else y + amp
        n = max(2, int(w / step))
        return [(x + w * i / n, base + (amp if i % 2 else -amp) * 0.5 * (1 if rot == 0 else -1)) for i in range(n + 1)], amp
    base = x + w - amp if rot == 90 else x + amp
    n = max(2, int(h / step))
    return [(base + (amp if i % 2 else -amp) * 0.5, y + h * i / n) for i in range(n + 1)], amp


def callout_leg(a: dict) -> tuple[tuple[float, float], tuple[float, float], tuple[float, float]]:
    x, y, w, h = a["box"]
    ax, ay = a["points"][0]
    cx, cy = x + w / 2, y + h / 2
    if abs(ax - cx) - w / 2 >= abs(ay - cy) - h / 2:
        side = 1 if ax > cx else -1
        end = (cx + side * w / 2, cy)
        knee = (end[0] + side * min(18.0, abs(ax - end[0]) / 2), cy)
    else:
        side = 1 if ay > cy else -1
        end = (cx, cy + side * h / 2)
        knee = (cx, end[1] + side * min(18.0, abs(ay - end[1]) / 2))
    return (ax, ay), knee, end


def bbox(a: dict) -> tuple[float, float, float, float]:
    pad = a["width"] / 2 + 1
    if a["kind"] == "callout":
        x, y, w, h = a["box"]
        ax, ay = a["points"][0]
        e = pad + max(8.0, a["width"] * 4)
        return min(x - pad, ax - e), min(y - pad, ay - e), max(x + w + pad, ax + e), max(y + h + pad, ay + e)
    if a["kind"] in MARKUP:
        xs = [r[0] for r in a["rects"]] + [r[0] + r[2] for r in a["rects"]]
        ys = [r[1] for r in a["rects"]] + [r[1] + r[3] for r in a["rects"]]
        return min(xs) - 1, min(ys) - 1, max(xs) + 1, max(ys) + 1
    if a["kind"] in ("line", "arrow", "ink") + POLY:
        pts = a["points"] if a["kind"] != "ink" else [p for path in a["paths"] for p in path]
        extra = max(8.0, a["width"] * 4) if a["kind"] == "arrow" else cloud_r(a) if a["kind"] == "cloud" else 0
        return (min(p[0] for p in pts) - pad - extra, min(p[1] for p in pts) - pad - extra,
                max(p[0] for p in pts) + pad + extra, max(p[1] for p in pts) + pad + extra)
    x, y, w, h = a["box"]
    p = pad if a["kind"] in ("rect", "ellipse") else 0
    return x - p, y - p, x + w + p, y + h + p


def _alpha(c, fill: float | None = None, stroke: float | None = None) -> None:
    if fill is not None:
        c.setFillAlpha(fill)
    if stroke is not None:
        c.setStrokeAlpha(stroke)


def _upright(c, a: dict, H: float) -> tuple[float, float]:
    x, y, w, h = a["box"]
    c.translate(x + w / 2, H - (y + h / 2))
    c.rotate(a["rot"])
    return (w, h) if a["rot"] % 180 == 0 else (h, w)


def _text_block(c, text: str, size: float, color, cw: float, ch: float, pad: float = 2) -> None:
    font = font_for(text)
    c.setFont(font, size)
    c.setFillColorRGB(*color)
    lead = size * 1.2
    y = ch / 2 - pad - size * 0.82
    for line in wrap(text, font, size, max(4.0, cw - 2 * pad)):
        if y < -ch / 2 - size * 0.2:
            break
        c.drawString(-cw / 2 + pad, y, line)
        y -= lead


def _note_icon(c, color, cw: float, ch: float) -> None:
    x0, y0 = -cw / 2, -ch / 2
    c.setFillColorRGB(*color)
    c.setStrokeColorRGB(*(v * 0.55 for v in color))
    c.setLineWidth(0.8)
    p = c.beginPath()
    p.moveTo(x0 + 1, y0 + 4)
    p.lineTo(x0 + 1, y0 + ch - 1)
    p.lineTo(x0 + cw - 1, y0 + ch - 1)
    p.lineTo(x0 + cw - 1, y0 + 4)
    p.lineTo(x0 + 7, y0 + 4)
    p.lineTo(x0 + 3, y0 + 0.5)
    p.lineTo(x0 + 4, y0 + 4)
    p.close()
    c.drawPath(p, stroke=1, fill=1)
    c.setLineWidth(1)
    for k in range(3):
        yy = y0 + ch - 6 - k * 4
        c.line(x0 + 4.5, yy, x0 + cw - 4.5, yy)


def _fit(text: str, font: str, size: float, width: float) -> float:
    tw = pdfmetrics.stringWidth(text, font, 1) if text else 0
    return max(3.0, min(size, width / tw)) if tw > 0 else size


def _rounded(c, x: float, y: float, w: float, h: float, r: float) -> None:
    p = c.beginPath()
    p.roundRect(x, y, w, h, max(0.0, min(r, w / 2, h / 2)))
    c.drawPath(p, stroke=1, fill=1)


def _stamp(c, s: dict, color, cw: float, ch: float, opacity: float) -> None:
    lw = max(0.8, ch * 0.055)
    x0, y0 = -cw / 2, -ch / 2
    dark = tuple(v * 0.78 for v in color)
    if s["shape"] == "mark":
        c.setStrokeColorRGB(*color)
        c.setStrokeAlpha(opacity)
        c.setLineWidth(max(1.0, min(cw, ch) * 0.14))
        pts = [(0.14, 0.55), (0.40, 0.80), (0.88, 0.22)] if s["mark"] == "check" else [(0.2, 0.2), (0.8, 0.8), None, (0.8, 0.2), (0.2, 0.8)]
        p = c.beginPath()
        start = True
        for pt in pts:
            if pt is None:
                start = True
                continue
            x, y = x0 + pt[0] * cw, -y0 - pt[1] * ch
            if start:
                p.moveTo(x, y)
                start = False
            else:
                p.lineTo(x, y)
        c.drawPath(p, stroke=1, fill=0)
        return
    font = font_for(s["label"] + s["sub"], bold=True)
    if s["shape"] == "tag":
        tip = ch * 0.42
        c.setFillColorRGB(*color)
        c.setStrokeColorRGB(*dark)
        c.setFillAlpha(opacity * 0.92)
        c.setStrokeAlpha(opacity)
        c.setLineWidth(lw * 0.6)
        p = c.beginPath()
        p.moveTo(x0 + lw / 2, 0)
        p.lineTo(x0 + tip, ch / 2 - lw / 2)
        p.lineTo(cw / 2 - lw / 2, ch / 2 - lw / 2)
        p.lineTo(cw / 2 - lw / 2, -ch / 2 + lw / 2)
        p.lineTo(x0 + tip, -ch / 2 + lw / 2)
        p.close()
        c.drawPath(p, stroke=1, fill=1)
        size = _fit(s["label"], font, ch * 0.46, cw - tip - ch * 0.3)
        c.setFillColorRGB(1, 1, 1)
        c.setFillAlpha(opacity)
        c.setFont(font, size)
        c.drawCentredString((x0 + tip + cw / 2) / 2, -size * 0.35, s["label"])
        return
    r = min(ch * 0.2, cw * 0.2)
    c.setStrokeColorRGB(*color)
    c.setFillColorRGB(*color)
    c.setLineWidth(lw)
    c.setStrokeAlpha(opacity)
    c.setFillAlpha(opacity * 0.08)
    _rounded(c, x0 + lw / 2, y0 + lw / 2, cw - lw, ch - lw, r)
    inset = lw * 2.2
    c.setLineWidth(lw * 0.45)
    c.setFillAlpha(0)
    _rounded(c, x0 + inset, y0 + inset, cw - 2 * inset, ch - 2 * inset, r * 0.7)
    pad = ch * 0.24 + inset
    c.setFillColorRGB(*color)
    c.setFillAlpha(opacity)
    if s["sub"]:
        size = _fit(s["label"], font, ch * 0.38, cw - 2 * pad)
        c.setFont(font, size)
        c.drawCentredString(0, ch * 0.06, s["label"])
        sub = _fit(s["sub"], font_for(s["sub"]), ch * 0.15, cw - 2 * pad)
        c.setFont(font_for(s["sub"]), sub)
        c.drawCentredString(0, -ch * 0.28, s["sub"])
    else:
        size = _fit(s["label"], font, ch * 0.5, cw - 2 * pad)
        c.setFont(font, size)
        c.drawCentredString(0, -size * 0.35, s["label"])


def draw(c, a: dict, H: float, flat: bool) -> None:
    kind, color = a["kind"], a["color"]
    c.saveState()
    c.setLineCap(1)
    c.setLineJoin(1)
    if kind == "highlight":
        c.setFillColorRGB(*color)
        _alpha(c, fill=a["opacity"])
        c.setBlendMode("Multiply")
        for x, y, w, h in a["rects"]:
            c.rect(x, H - y - h, w, h, stroke=0, fill=1)
    elif kind in ("underline", "strikeout"):
        c.setStrokeColorRGB(*color)
        _alpha(c, stroke=a["opacity"])
        for x, y, w, h in a["rects"]:
            across = h if a["rot"] % 180 == 0 else w
            lw = max(0.75, min(across * 0.08, 3))
            c.setLineWidth(lw)
            mid = 0.5
            if a["rot"] == 0:
                yy = y + h - lw / 2 if kind == "underline" else y + h * mid
                c.line(x, H - yy, x + w, H - yy)
            elif a["rot"] == 180:
                yy = y + lw / 2 if kind == "underline" else y + h * mid
                c.line(x, H - yy, x + w, H - yy)
            elif a["rot"] == 90:
                xx = x + w - lw / 2 if kind == "underline" else x + w * mid
                c.line(xx, H - y, xx, H - y - h)
            else:
                xx = x + lw / 2 if kind == "underline" else x + w * mid
                c.line(xx, H - y, xx, H - y - h)
    elif kind == "squiggly":
        c.setStrokeColorRGB(*color)
        _alpha(c, stroke=a["opacity"])
        for x, y, w, h in a["rects"]:
            pts, amp = squiggle(x, y, w, h, a["rot"])
            c.setLineWidth(max(0.5, amp * 0.6))
            p = c.beginPath()
            p.moveTo(pts[0][0], H - pts[0][1])
            for px, py in pts[1:]:
                p.lineTo(px, H - py)
            c.drawPath(p, stroke=1, fill=0)
    elif kind in POLY:
        c.setStrokeColorRGB(*color)
        c.setLineWidth(a["width"])
        _alpha(c, fill=a["opacity"], stroke=a["opacity"])
        filled = bool(a["fill"]) and kind != "polyline"
        if filled:
            c.setFillColorRGB(*a["fill"])
        pts = a["points"]
        p = c.beginPath()
        if kind == "cloud":
            segs = cloud_arcs(pts, cloud_r(a))
            p.moveTo(segs[0][0][0], H - segs[0][0][1])
            for _, c1, c2, e in segs:
                p.curveTo(c1[0], H - c1[1], c2[0], H - c2[1], e[0], H - e[1])
            p.close()
        else:
            p.moveTo(pts[0][0], H - pts[0][1])
            for px, py in pts[1:]:
                p.lineTo(px, H - py)
            if kind == "polygon":
                p.close()
        c.drawPath(p, stroke=1, fill=1 if filled else 0)
    elif kind == "ink":
        c.setStrokeColorRGB(*color)
        _alpha(c, stroke=a["opacity"])
        c.setLineWidth(a["width"])
        for path in a["paths"]:
            p = c.beginPath()
            p.moveTo(path[0][0], H - path[0][1])
            if len(path) == 1:
                p.lineTo(path[0][0] + 0.01, H - path[0][1])
            for px, py in path[1:]:
                p.lineTo(px, H - py)
            c.drawPath(p, stroke=1, fill=0)
    elif kind in ("rect", "ellipse"):
        x, y, w, h = a["box"]
        c.setStrokeColorRGB(*color)
        c.setLineWidth(a["width"])
        _alpha(c, fill=a["opacity"], stroke=a["opacity"])
        if a["fill"]:
            c.setFillColorRGB(*a["fill"])
        if kind == "rect":
            c.rect(x, H - y - h, w, h, stroke=1, fill=1 if a["fill"] else 0)
        else:
            c.ellipse(x, H - y - h, x + w, H - y, stroke=1, fill=1 if a["fill"] else 0)
    elif kind in ("line", "arrow"):
        (x1, y1), (x2, y2) = a["points"]
        c.setStrokeColorRGB(*color)
        c.setLineWidth(a["width"])
        _alpha(c, stroke=a["opacity"])
        c.line(x1, H - y1, x2, H - y2)
        if kind == "arrow":
            ang = math.atan2(-(y2 - y1), x2 - x1)
            size = max(8.0, a["width"] * 4)
            for side in (-1, 1):
                t = ang + math.pi - side * math.radians(28)
                c.line(x2, H - y2, x2 + size * math.cos(t), H - y2 + size * math.sin(t))
    elif kind == "note":
        cw, ch = _upright(c, a, H)
        _note_icon(c, color, cw, ch)
        if flat and a["text"].strip():
            font = font_for(a["text"])
            lines = wrap(a["text"], font, 9, 172)[:40]
            bw, bh = 180, 8 + 10.8 * len(lines)
            c.setFillColorRGB(1, 0.98, 0.84)
            c.setStrokeColorRGB(*(v * 0.55 for v in color))
            c.setLineWidth(0.6)
            c.rect(cw / 2 + 4, ch / 2 - bh, bw, bh, stroke=1, fill=1)
            c.setFillColorRGB(0.1, 0.1, 0.1)
            c.setFont(font, 9)
            yy = ch / 2 - 4 - 9 * 0.82
            for line in lines:
                c.drawString(cw / 2 + 8, yy, line)
                yy -= 10.8
    elif kind == "callout":
        tip, knee, end = callout_leg(a)
        c.setStrokeColorRGB(*color)
        c.setLineWidth(a["width"])
        _alpha(c, fill=a["opacity"], stroke=a["opacity"])
        p = c.beginPath()
        p.moveTo(tip[0], H - tip[1])
        p.lineTo(knee[0], H - knee[1])
        p.lineTo(end[0], H - end[1])
        c.drawPath(p, stroke=1, fill=0)
        ang = math.atan2(-(tip[1] - knee[1]), tip[0] - knee[0])
        size = max(8.0, a["width"] * 4)
        for side in (-1, 1):
            t = ang + math.pi - side * math.radians(28)
            c.line(tip[0], H - tip[1], tip[0] + size * math.cos(t), H - tip[1] + size * math.sin(t))
        cw, ch = _upright(c, a, H)
        if a["fill"]:
            c.setFillColorRGB(*a["fill"])
        c.rect(-cw / 2, -ch / 2, cw, ch, stroke=1, fill=1 if a["fill"] else 0)
        _text_block(c, a["text"], a["size"], color, cw, ch, pad=max(2.0, a["width"] + 1.5))
    elif kind == "freetext":
        cw, ch = _upright(c, a, H)
        if a["fill"]:
            c.setFillColorRGB(*a["fill"])
            c.rect(-cw / 2, -ch / 2, cw, ch, stroke=0, fill=1)
        _alpha(c, fill=a["opacity"])
        _text_block(c, a["text"], a["size"], color, cw, ch)
    elif kind == "image":
        cw, ch = _upright(c, a, H)
        _alpha(c, fill=a["opacity"])
        c.drawImage(ImageReader(a["image"]), -cw / 2, -ch / 2, cw, ch, mask="auto", preserveAspectRatio=False)
    elif kind == "stamp":
        cw, ch = _upright(c, a, H)
        _stamp(c, a["stamp"], color, cw, ch, a["opacity"])
    c.restoreState()


def _arr(vals) -> ArrayObject:
    return ArrayObject([FloatObject(round(float(v), 4)) for v in vals])


def _form(w: PdfWriter, page, bb: list[float]):
    contents = page.get_contents()
    stream = DecodedStreamObject()
    stream.set_data(contents.get_data() if contents is not None else b"")
    stream[NameObject("/Type")] = NameObject("/XObject")
    stream[NameObject("/Subtype")] = NameObject("/Form")
    stream[NameObject("/FormType")] = NumberObject(1)
    stream[NameObject("/BBox")] = _arr(bb)
    res = page.get("/Resources")
    if res is not None:
        w.__dict__.setdefault("_fs_sources", []).append(page.pdf)
        stream[NameObject("/Resources")] = res.get_object().clone(w)
    return w._add_object(stream.flate_encode())


def _pdf_date() -> str:
    t = time.localtime()
    off = -time.timezone if not t.tm_isdst else -time.altzone
    sign = "+" if off >= 0 else "-"
    return time.strftime("D:%Y%m%d%H%M%S", t) + f"{sign}{abs(off) // 3600:02d}'{abs(off) % 3600 // 60:02d}'"


def _annot(a: dict, rect: list[float], ap, llx: float, lly: float, H: float, author: str) -> DictionaryObject:
    stamp = _pdf_date()
    d = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject(SUBTYPE[a["kind"]]),
        NameObject("/Rect"): _arr(rect), NameObject("/F"): NumberObject(4), NameObject("/C"): _arr(a["color"]),
        NameObject("/CA"): FloatObject(round(a["opacity"], 3)), NameObject("/M"): TextStringObject(stamp),
        NameObject("/CreationDate"): TextStringObject(stamp), NameObject("/NM"): TextStringObject(f"fs-{uuid.uuid4().hex[:16]}"),
        NameObject("/AP"): DictionaryObject({NameObject("/N"): ap}),
    })
    if author:
        d[NameObject("/T")] = TextStringObject(author)
    if a["text"]:
        d[NameObject("/Contents")] = TextStringObject(a["text"])

    def U(x: float, y: float) -> tuple[float, float]:
        return llx + x, lly + H - y

    bs = DictionaryObject({NameObject("/W"): FloatObject(round(a["width"], 3)), NameObject("/S"): NameObject("/S")})
    kind = a["kind"]
    if kind in MARKUP:
        quads = []
        for x, y, w, h in a["rects"]:
            (ax, ay), (bx, by) = U(x, y), U(x + w, y + h)
            quads += [ax, ay, bx, ay, ax, by, bx, by]
        d[NameObject("/QuadPoints")] = _arr(quads)
    elif kind == "ink":
        d[NameObject("/InkList")] = ArrayObject([_arr([v for p in path for v in U(*p)]) for path in a["paths"]])
        d[NameObject("/BS")] = bs
    elif kind in ("rect", "ellipse"):
        d[NameObject("/BS")] = bs
        if a["fill"]:
            d[NameObject("/IC")] = _arr(a["fill"])
    elif kind in POLY:
        d[NameObject("/Vertices")] = _arr([v for p in a["points"] for v in U(*p)])
        d[NameObject("/BS")] = bs
        if a["fill"] and kind != "polyline":
            d[NameObject("/IC")] = _arr(a["fill"])
        if kind == "cloud":
            d[NameObject("/BE")] = DictionaryObject({NameObject("/S"): NameObject("/C"), NameObject("/I"): NumberObject(1)})
            d[NameObject("/IT")] = NameObject("/PolygonCloud")
        if kind == "polyline":
            d[NameObject("/LE")] = ArrayObject([NameObject("/None"), NameObject("/None")])
    elif kind in ("line", "arrow"):
        d[NameObject("/L")] = _arr([*U(*a["points"][0]), *U(*a["points"][1])])
        d[NameObject("/BS")] = bs
        d[NameObject("/LE")] = ArrayObject([NameObject("/None"), NameObject("/OpenArrow" if kind == "arrow" else "/None")])
    elif kind == "note":
        d[NameObject("/Name")] = NameObject("/Comment")
        d[NameObject("/Open")] = BooleanObject(False)
    elif kind == "freetext":
        r, g, b = a["color"]
        d[NameObject("/DA")] = TextStringObject(f"/Helv {a['size']:g} Tf {r:.3f} {g:.3f} {b:.3f} rg")
        d[NameObject("/Border")] = _arr([0, 0, 0])
    elif kind == "callout":
        r, g, b = a["color"]
        d[NameObject("/DA")] = TextStringObject(f"/Helv {a['size']:g} Tf {r:.3f} {g:.3f} {b:.3f} rg")
        d[NameObject("/IT")] = NameObject("/FreeTextCallout")
        d[NameObject("/CL")] = _arr([v for p in callout_leg(a) for v in U(*p)])
        d[NameObject("/LE")] = NameObject("/OpenArrow")
        d[NameObject("/BS")] = bs
        if a["fill"]:
            d[NameObject("/IC")] = _arr(a["fill"])
        x, y, w, h = a["box"]
        (ix0, iy0), (ix1, iy1) = U(x, y + h), U(x + w, y)
        d[NameObject("/RD")] = _arr([ix0 - rect[0], rect[3] - iy1, rect[2] - ix1, iy0 - rect[1]])
    elif kind == "image":
        d[NameObject("/Name")] = NameObject("/Image")
    elif kind == "stamp":
        d[NameObject("/Name")] = NameObject(f"/{a['stamp']['name']}")
    return d


def _blank_ap(w: PdfWriter):
    stream = DecodedStreamObject()
    stream.set_data(b"")
    stream[NameObject("/Type")] = NameObject("/XObject")
    stream[NameObject("/Subtype")] = NameObject("/Form")
    stream[NameObject("/BBox")] = _arr([0, 0, 1, 1])
    return w._add_object(stream)


def _thread(w: PdfWriter, page: int, parent, replies: list[str], status: str | None, author: str, blank) -> None:
    rect = [float(v) for v in parent.get_object().get("/Rect", [0, 0, 0, 0])]
    entries = [(t, None) for t in replies] + ([(None, status)] if status else [])
    for text, state in entries:
        stamp = _pdf_date()
        d = DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Text"), NameObject("/Rect"): _arr(rect),
            NameObject("/F"): NumberObject(30 if state else 28), NameObject("/IRT"): parent, NameObject("/M"): TextStringObject(stamp),
            NameObject("/CreationDate"): TextStringObject(stamp), NameObject("/NM"): TextStringObject(f"fs-{uuid.uuid4().hex[:16]}"),
            NameObject("/Name"): NameObject("/Comment"), NameObject("/Open"): BooleanObject(False),
            NameObject("/AP"): DictionaryObject({NameObject("/N"): blank}),
        })
        if author:
            d[NameObject("/T")] = TextStringObject(author)
        if state:
            d[NameObject("/State")] = NameObject(STATES[state])
            d[NameObject("/StateModel")] = NameObject("/Review")
            d[NameObject("/Contents")] = TextStringObject(f"{state.capitalize()} set by {author or 'a reviewer'}")
        else:
            d[NameObject("/RT")] = NameObject("/R")
            d[NameObject("/Contents")] = TextStringObject(text)
        w.add_annotation(page, d)


def _target(w: PdfWriter, req: dict):
    try:
        p, index = int(req.get("page")), int((req.get("target") or {}).get("index"))
    except (TypeError, ValueError, AttributeError):
        raise ValueError("A reply needs the page and target of the comment it answers") from None
    if not 1 <= p <= len(w.pages):
        raise ValueError(f"Page {p} is out of range (1 to {len(w.pages)})")
    page = w.pages[p - 1]
    arr = page.get("/Annots")
    arr = arr.get_object() if arr is not None else ArrayObject()
    nm = str((req.get("target") or {}).get("nm") or "")
    k = index if 0 <= index < len(arr) else -1
    if nm and (k < 0 or str(arr[k].get_object().get("/NM") or "") != nm):
        k = next((j for j, ref in enumerate(arr) if str(ref.get_object().get("/NM") or "") == nm), -1)
    if k < 0:
        raise ValueError(f"The comment being answered on page {p} is no longer in this PDF")
    ref = arr[k]
    if not hasattr(ref, "idnum"):
        ref = w._add_object(ref)
        arr[k] = ref
    return p - 1, ref


def _when(v) -> str:
    m = re.match(r"(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?", str(v or "").strip())
    if not m:
        return ""
    y, mo, d, hh, mi, ss = (m.group(k) or dflt for k, dflt in zip(range(1, 7), ("", "01", "01", "00", "00", "00")))
    return f"{y}-{mo}-{d}T{hh}:{mi}:{ss}"


def _text(v) -> str:
    v = v.get_object() if hasattr(v, "get_object") else v
    return str(v or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def comments(path, passwords: list[str] | None = None, limit: int = 2000) -> list[dict]:
    r = core.reader(path, passwords)
    out: list[dict] = []
    for pi, page in enumerate(r.pages):
        arr = page.get("/Annots")
        if arr is None:
            continue
        x0, y0, x1, y1 = core.view_box(page)
        rows: list[tuple[int, int | None, DictionaryObject]] = []
        for k, ref in enumerate(arr.get_object()):
            a = ref.get_object()
            if isinstance(a, DictionaryObject) and a.get("/Subtype") in LISTED:
                rows.append((k, getattr(ref, "idnum", None), a))
        by_id = {idn: (k, a) for k, idn, a in rows if idn is not None}
        tops: dict[int, dict] = {}
        children: list[tuple[int, DictionaryObject]] = []
        for k, idn, a in rows:
            irt = a.raw_get("/IRT") if "/IRT" in a else None
            if irt is not None:
                children.append((getattr(irt, "idnum", -1), a))
                continue
            if int(a.get("/F", 0) or 0) & 2:
                continue
            rx0, ry0, rx1, ry1 = (float(v) for v in (a.get("/Rect") or [0, 0, 0, 0]))
            rx0, rx1 = sorted((rx0, rx1))
            ry0, ry1 = sorted((ry0, ry1))
            color = a.get("/C") or a.get("/IC") or []
            hexc = "#" + "".join(f"{max(0, min(255, round(float(c) * 255))):02X}" for c in list(color)[:3]) if len(color) >= 3 else ""
            tops[k] = {"page": pi + 1, "index": k, "nm": _text(a.get("/NM")), "kind": "cloud" if a["/Subtype"] == "/Polygon" and (str(a.get("/IT") or "") == "/PolygonCloud" or str((a.get("/BE") or {}).get("/S") or "") == "/C") else "callout" if a["/Subtype"] == "/FreeText" and (str(a.get("/IT") or "") == "/FreeTextCallout" or "/CL" in a) else LISTED[a["/Subtype"]], "label": str(a["/Subtype"])[1:],
                       "text": _text(a.get("/Contents")), "author": _text(a.get("/T")), "date": _when(a.get("/M") or a.get("/CreationDate")),
                       "color": hexc, "rect": {"x": round(rx0 - x0, 2), "y": round(y1 - ry1, 2), "w": round(rx1 - rx0, 2), "h": round(ry1 - ry0, 2)},
                       "replies": [], "status": "none", "statusBy": ""}
        states: dict[int, tuple[str, str, str]] = {}
        for parent_id, a in children:
            seen: set[int] = set()
            pid = parent_id
            while pid in by_id and pid not in seen:
                seen.add(pid)
                k, pa = by_id[pid]
                if k in tops:
                    break
                nxt = pa.raw_get("/IRT") if "/IRT" in pa else None
                pid = getattr(nxt, "idnum", -1)
            root = by_id.get(pid, (None, None))[0]
            if root not in tops or str(a.get("/RT") or "/R") == "/Group":
                continue
            when = _when(a.get("/M") or a.get("/CreationDate"))
            if "/State" in a:
                if str(a.get("/StateModel") or "/Review") == "/Review":
                    state = str(a["/State"])[1:].lower()
                    if state in STATES and (root not in states or when >= states[root][1]):
                        states[root] = (state, when, _text(a.get("/T")))
                continue
            tops[root]["replies"].append({"text": _text(a.get("/Contents")), "author": _text(a.get("/T")), "date": when})
        for root, (state, _, who) in states.items():
            tops[root]["status"], tops[root]["statusBy"] = state, who
        for item in tops.values():
            item["replies"].sort(key=lambda x: x["date"])
            out.append(item)
            if len(out) >= limit:
                return out
    return out


def annotate(src, out, annotations: list[dict], *, flatten: bool = False, passwords: list[str] | None = None, author: str = "") -> int:
    if not annotations:
        raise ValueError("There are no annotations to apply")
    if len(annotations) > MAX_ANNOTS:
        raise ValueError(f"Apply at most {MAX_ANNOTS} annotations at a time")
    w = core.writer(src, passwords) if not flatten else PdfWriter(clone_from=core.reader(src, passwords))
    geo = []
    for page in w.pages:
        x0, y0, x1, y1 = core.view_box(page)
        geo.append((x0, y0, x1 - x0, y1 - y0))
    asks = [a for a in annotations if isinstance(a, dict) and a.get("kind") == "reply"]
    items = [normalize(a, [(g[2], g[3]) for g in geo]) for a in annotations if not (isinstance(a, dict) and a.get("kind") == "reply")]
    blank = _blank_ap(w) if asks or any(a["replies"] or a["status"] for a in items) else None
    flat: list[dict] = []
    live: list[dict] = []
    for a in items:
        (flat if (a["flatten"] if isinstance(a["flatten"], bool) else flatten) else live).append(a)
    if flat:
        order = sorted({a["page"] for a in flat})
        buf = io.BytesIO()
        c = rlcanvas.Canvas(buf)
        for p in order:
            _, _, W, H = geo[p - 1]
            c.setPageSize((W, H))
            for a in flat:
                if a["page"] == p:
                    draw(c, a, H, True)
            c.showPage()
        c.save()
        ov = PdfReader(io.BytesIO(buf.getvalue()))
        for k, p in enumerate(order):
            llx, lly = geo[p - 1][:2]
            w.pages[p - 1].merge_transformed_page(ov.pages[k], Transformation().translate(llx, lly))
    if live:
        buf = io.BytesIO()
        c = rlcanvas.Canvas(buf)
        for a in live:
            _, _, W, H = geo[a["page"] - 1]
            c.setPageSize((W, H))
            draw(c, a, H, False)
            c.showPage()
        c.save()
        ov = PdfReader(io.BytesIO(buf.getvalue()))
        for k, a in enumerate(live):
            llx, lly, W, H = geo[a["page"] - 1]
            x0, y0, x1, y1 = bbox(a)
            bb = [x0, H - y1, x1, H - y0]
            ap = _form(w, ov.pages[k], bb)
            added = w.add_annotation(a["page"] - 1, _annot(a, [llx + bb[0], lly + bb[1], llx + bb[2], lly + bb[3]], ap, llx, lly, H, author))
            if a["replies"] or a["status"]:
                _thread(w, a["page"] - 1, added.indirect_reference, a["replies"], a["status"], author, blank)
    touched: set[int] = set()
    for req in asks:
        texts = _replies([req.get("text")])
        status = _status(req.get("status"))
        if not texts and not status:
            raise ValueError("A reply needs text or a status")
        page, parent = _target(w, req)
        _thread(w, page, parent, texts, status, author, blank)
        touched.add(page)
    core.keep_pages(w, touched | {a["page"] - 1 for a in items})
    with open(out, "wb") as fh:
        w.write(fh)
    return len(w.pages)
