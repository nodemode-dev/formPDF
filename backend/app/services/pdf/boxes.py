from pypdf import PdfWriter
from pypdf.generic import NameObject, RectangleObject

from . import actions, core

KINDS = ("media", "crop", "bleed", "trim", "art")
MM = 72 / 25.4


def _rect(page, kind: str) -> tuple[float, float, float, float]:
    r = getattr(page, f"{kind}box")
    return float(r.left), float(r.bottom), float(r.right), float(r.top)


def _shown(page, r) -> dict:
    mx0, my0, mx1, my1 = _rect(page, "media")
    x0, y0, x1, y1 = r
    return {"x": round(x0 - mx0, 3), "y": round(my1 - y1, 3), "w": round(x1 - x0, 3), "h": round(y1 - y0, 3)}


def describe(page) -> dict:
    own = {k: f"/{k.capitalize()}Box" in page for k in KINDS}
    return {k: {**_shown(page, _rect(page, k)), "set": own[k]} for k in KINDS}


def read(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    r = core.reader(path, passwords)
    want = core.parse_pages(pages or (args or {}).get("pages"), len(r.pages))
    rows = [{"page": n, **describe(r.pages[n - 1])} for n in want]
    lines = []
    for row in rows[:200]:
        trim, bleed = row["trim"], row["bleed"]
        extra = round(max(trim["x"] - bleed["x"], trim["y"] - bleed["y"]) / MM, 2) if row["bleed"]["set"] else 0
        lines.append(f"p{row['page']} media {row['media']['w']:.1f}x{row['media']['h']:.1f} pt · trim {trim['w']:.1f}x{trim['h']:.1f}"
                     f"{' set' if trim['set'] else ' (= crop)'} · bleed {extra} mm{'' if row['bleed']['set'] else ' (not set)'}")
    return "\n".join(lines), {"pages": rows}


def _from_shown(page, box: dict) -> tuple[float, float, float, float]:
    mx0, my0, mx1, my1 = _rect(page, "media")
    x, y, w, h = (float(box[k]) for k in ("x", "y", "w", "h"))
    if w <= 0 or h <= 0:
        raise ValueError("A box needs a positive width and height")
    return mx0 + x, my1 - y - h, mx0 + x + w, my1 - y


def change(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    w = PdfWriter(clone_from=core.reader(src, passwords))
    want = core.parse_pages(pages or args.get("pages"), len(w.pages))
    done = 0
    for n in want:
        page = w.pages[n - 1]
        for kind in KINDS:
            box = args.get(kind)
            if isinstance(box, dict):
                x0, y0, x1, y1 = _from_shown(page, box)
                if kind != "media":
                    mx0, my0, mx1, my1 = _rect(page, "media")
                    x0, y0, x1, y1 = max(x0, mx0), max(y0, my0), min(x1, mx1), min(y1, my1)
                page[NameObject(f"/{kind.capitalize()}Box")] = RectangleObject([x0, y0, x1, y1])
                done += 1
        mm = args.get("bleed_mm")
        if mm is not None:
            pad = max(0.0, float(mm)) * MM
            tx0, ty0, tx1, ty1 = _rect(page, "trim")
            mx0, my0, mx1, my1 = _rect(page, "media")
            if args.get("grow_media", True) and (tx0 - pad < mx0 or ty0 - pad < my0 or tx1 + pad > mx1 or ty1 + pad > my1):
                shown = _rect(page, "crop")
                page[NameObject("/MediaBox")] = RectangleObject([min(mx0, tx0 - pad), min(my0, ty0 - pad), max(mx1, tx1 + pad), max(my1, ty1 + pad)])
                if "/TrimBox" not in page:
                    page[NameObject("/TrimBox")] = RectangleObject([tx0, ty0, tx1, ty1])
                page[NameObject("/CropBox")] = RectangleObject(list(shown))
                mx0, my0, mx1, my1 = _rect(page, "media")
            page[NameObject("/BleedBox")] = RectangleObject([max(mx0, tx0 - pad), max(my0, ty0 - pad), min(mx1, tx1 + pad), min(my1, ty1 + pad)])
            done += 1
        for kind in args.get("clear") or []:
            if kind in KINDS[1:] and f"/{kind.capitalize()}Box" in page:
                del page[f"/{kind.capitalize()}Box"]
                done += 1
    if not done:
        raise ValueError("Give a box (crop, bleed, trim, art, media as {x, y, w, h} in points from the media box's top left), bleed_mm, or clear")
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "changed": done}


actions.register(actions.Action("boxes", "read", "Page boxes: media, crop, bleed, trim and art", words=("page boxes", "bleed", "trim box", "crop box", "art box", "media box"), run=read))
actions.register(actions.Action("edit_boxes", "change", "Set page boxes and bleed", "boxes", ("bleed", "trim", "trim box", "bleed box", "page size", "art box", "print production"), run=change))
