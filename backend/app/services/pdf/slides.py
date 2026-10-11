import io
import math
from pathlib import Path

from . import core, layout, objects

EMU_PER_PT = 12700
MIN_EMU = 914400
MAX_EMU = 51206400
PLAIN_TABLE = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"
SHEET_MAX = 12


def _unstyle(shape) -> None:
    from pptx.oxml.ns import qn

    style = shape._element.find(qn("p:style"))
    if style is not None:
        shape._element.remove(style)


def _alpha(shape, path: str, a: int) -> None:
    from pptx.oxml.ns import qn

    if a >= 255:
        return
    clr = shape._element.find(".//" + "/".join(qn(p) for p in path.split("/")))
    if clr is not None:
        clr.append(clr.makeelement(qn("a:alpha"), {"val": str(int(a / 255 * 100000))}))


def _paint(shape, rec: dict, k: float) -> None:
    from pptx.dml.color import RGBColor
    from pptx.enum.dml import MSO_LINE_DASH_STYLE
    from pptx.util import Emu

    _unstyle(shape)
    fill = rec.get("fill")
    if hasattr(shape, "fill"):
        if fill:
            shape.fill.solid()
            shape.fill.fore_color.rgb = RGBColor(*fill[:3])
            _alpha(shape, "p:spPr/a:solidFill/a:srgbClr", fill[3])
        else:
            shape.fill.background()
    line = rec.get("stroke")
    if line:
        shape.line.color.rgb = RGBColor(*line[:3])
        shape.line.width = Emu(int(max(3175, rec["width"] * k)))
        if rec.get("dash"):
            shape.line.dash_style = MSO_LINE_DASH_STYLE.DASH
        _alpha(shape, "a:ln/a:solidFill/a:srgbClr", line[3])
    else:
        shape.line.fill.background()


def _shape(slide, rec: dict, to) -> bool:
    from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
    from pptx.util import Emu

    k = to.k
    subs = [[to(*p) for p in s] for s in rec["subs"]]
    if len(subs) == 1:
        pts = subs[0]
        ring = pts[:-1] if len(pts) == 5 and math.dist(pts[0], pts[-1]) < 1 else pts
        xs, ys = sorted({round(p[0]) for p in ring}), sorted({round(p[1]) for p in ring})
        if len(ring) == 4 and len(xs) == 2 and len(ys) == 2 and (rec["closed"][0] or len(pts) == 5 or rec.get("fill") is not None):
            shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(xs[0]), Emu(ys[0]), Emu(max(1, xs[1] - xs[0])), Emu(max(1, ys[1] - ys[0])))
            shape.name = "Rectangle"
            _paint(shape, rec, k)
            return True
        if len(pts) == 2 and not rec.get("fill") and rec.get("stroke"):
            shape = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Emu(int(pts[0][0])), Emu(int(pts[0][1])), Emu(int(pts[1][0])), Emu(int(pts[1][1])))
            shape.name = "Line"
            _paint(shape, rec, k)
            return True
    first = subs[0][0]
    fb = slide.shapes.build_freeform(int(first[0]), int(first[1]), scale=1.0)
    for n, (s, closed) in enumerate(zip(subs, rec["closed"])):
        if n:
            fb.move_to(int(s[0][0]), int(s[0][1]))
        fb.add_line_segments([(int(x), int(y)) for x, y in s[1:]], close=bool(closed or rec.get("fill") is not None))
    shape = fb.convert_to_shape()
    shape.name = "Shape"
    _paint(shape, rec, k)
    return True


def _picture(slide, rec: dict, to) -> bool:
    from pptx.util import Emu

    x0, y0, x1, y1 = rec["box"]
    (ax, ay), (bx, by) = to(x0, y1), to(x1, y0)
    buf = io.BytesIO()
    pil = rec["pil"]
    if pil.mode in ("RGBA", "LA", "P"):
        pil.convert("RGBA").save(buf, "PNG", optimize=False)
    else:
        pil.convert("RGB").save(buf, "JPEG", quality=90)
    buf.seek(0)
    pic = slide.shapes.add_picture(buf, Emu(int(ax)), Emu(int(ay)), Emu(int(max(1, bx - ax))), Emu(int(max(1, by - ay))))
    pic.name = "Picture"
    return True


def _tilted_box(slide, t: dict, to) -> None:
    from pptx.dml.color import RGBColor
    from pptx.enum.text import MSO_AUTO_SIZE, PP_ALIGN
    from pptx.util import Emu, Pt

    k = to.k
    cx, cy = to(*t["center"])
    w, h = max(t["length"], 1) * k * 1.04, max(t["height"], t["size"] * 1.15, 1) * k
    box = slide.shapes.add_textbox(Emu(int(cx - w / 2)), Emu(int(cy - h / 2)), Emu(int(w)), Emu(int(h)))
    box.name = "Text"
    box.rotation = (-math.degrees(t["angle"])) % 360
    tf = box.text_frame
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.word_wrap = False
    tf.auto_size = MSO_AUTO_SIZE.NONE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    run = p.add_run()
    run.text = t["text"]
    f = run.font
    f.size = Pt(max(1.0, t["size"] * k / EMU_PER_PT))
    f.bold = bool(t.get("bold"))
    if t.get("font"):
        f.name = str(t["font"])[:60]
    if t.get("color"):
        f.color.rgb = RGBColor(*t["color"][:3])
        _alpha(box, "a:solidFill/a:srgbClr", t["color"][3])


class _Map:
    def __init__(self, k: float, ox: float, oy: float, cb):
        self.k, self.ox, self.oy, self.x0, self.y1 = k, ox, oy, float(cb[0]), float(cb[3])

    def __call__(self, x: float, y: float) -> tuple[float, float]:
        return self.ox + (x - self.x0) * self.k, self.oy + (self.y1 - y) * self.k


def _words(page) -> list[dict]:
    try:
        ws = page.extract_words(extra_attrs=["size"], keep_blank_chars=False, x_tolerance_ratio=0.15)
    except Exception:
        return []
    ox, oy = float(page.bbox[0]), float(page.bbox[1])
    return [{"text": w["text"], "x0": w["x0"] - ox, "x1": w["x1"] - ox, "top": w["top"] - oy, "bottom": w["bottom"] - oy, "size": w.get("size", 0)} for w in ws]


def _spread(b: dict, words: list[dict]) -> list[dict]:
    mine = sorted((w for w in words if w["x0"] >= b["x0"] - 1 and w["x1"] <= b["x1"] + 1 and w["top"] >= b["top"] - 1 and w["bottom"] <= b["bottom"] + 1),
                  key=lambda w: w["x0"])
    if len(mine) < 2:
        return [b]
    groups = [[mine[0]]]
    for w in mine[1:]:
        gap = w["x0"] - groups[-1][-1]["x1"]
        if gap > 1.5 * max(b["size"], w["size"] or 0, 1):
            groups.append([w])
        else:
            groups[-1].append(w)
    if len(groups) == 1:
        return [b]
    styles = [r for r in (b.get("runs") or []) for _ in str(r.get("text") or "")]
    flat = "".join(str(r.get("text") or "") for r in (b.get("runs") or []))
    cursor = 0
    out = []
    for g in groups:
        text = " ".join(w["text"] for w in g)
        at = flat.find(g[0]["text"], cursor)
        run = dict(styles[at]) if 0 <= at < len(styles) else dict((b.get("runs") or [{}])[0])
        cursor = at + len(g[0]["text"]) if at >= 0 else cursor
        out.append({**b, "text": text, "x0": g[0]["x0"], "x1": g[-1]["x1"], "top": min(w["top"] for w in g), "bottom": max(w["bottom"] for w in g),
                    "runs": [{**run, "text": text, "size": run.get("size") or b["size"]}], "align": "left"})
    return out


def _tilted_char(o) -> bool:
    if o.get("object_type") != "char":
        return False
    m = o.get("matrix") or (1, 0, 0, 1, 0, 0)
    return abs(m[1]) > objects.TILT * math.hypot(m[0], m[1]) or m[0] < 0


def _rgb(hexc: str | None):
    from pptx.dml.color import RGBColor

    if not hexc or len(hexc) != 7:
        return None
    try:
        return RGBColor.from_string(hexc[1:].upper())
    except ValueError:
        return None


def _fit(W: float, H: float, sw: int, sh: int) -> tuple[float, float, float]:
    k = min(sw / max(W, 1), sh / max(H, 1))
    return k, (sw - W * k) / 2, (sh - H * k) / 2


def _textbox(slide, b: dict, k: float, ox: float, oy: float) -> None:
    from pptx.enum.text import MSO_AUTO_SIZE, PP_ALIGN
    from pptx.util import Emu, Pt

    pad = max(2.0, (b["x1"] - b["x0"]) * 0.03)
    x, y = ox + b["x0"] * k, oy + b["top"] * k
    w, h = (b["x1"] - b["x0"] + pad) * k, max(1.0, b["bottom"] - b["top"]) * k
    box = slide.shapes.add_textbox(Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    box.name = "Heading" if b["kind"] == "heading" else "Text"
    tf = box.text_frame
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.word_wrap = b.get("lines", 1) > 1
    tf.auto_size = MSO_AUTO_SIZE.NONE
    p = tf.paragraphs[0]
    p.alignment = {"center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}.get(b.get("align") or "", PP_ALIGN.LEFT)
    for r in b.get("runs") or [{"text": b["text"], "size": b["size"]}]:
        if not r.get("text"):
            continue
        run = p.add_run()
        run.text = r["text"]
        f = run.font
        f.size = Pt(max(1.0, float(r.get("size") or b["size"]) * k / EMU_PER_PT))
        f.bold = bool(r.get("bold"))
        f.italic = bool(r.get("italic"))
        if r.get("font"):
            f.name = str(r["font"])[:60]
        c = _rgb(r.get("color"))
        if c is not None:
            f.color.rgb = c


def _table(slide, b: dict, k: float, ox: float, oy: float, body: float) -> None:
    from pptx.oxml.ns import qn
    from pptx.util import Emu, Pt

    rows = [r for r in b["rows"] if any(r)][:60]
    if len(rows) < 2:
        return
    cols = max(len(r) for r in rows)
    x, y = ox + b["x0"] * k, oy + b["top"] * k
    w, h = max(1.0, b["x1"] - b["x0"]) * k, max(1.0, b["bottom"] - b["top"]) * k
    shape = slide.shapes.add_table(len(rows), cols, Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    shape.name = "Table"
    table = shape.table
    tbl_pr = table._tbl.tblPr
    for attr in ("firstRow", "bandRow"):
        tbl_pr.set(attr, "0")
    style = tbl_pr.find(qn("a:tableStyleId"))
    if style is None:
        style = tbl_pr.makeelement(qn("a:tableStyleId"), {})
        tbl_pr.append(style)
    style.text = PLAIN_TABLE
    for ci in range(cols):
        table.columns[ci].width = Emu(int(w / cols))
    size = Pt(max(1.0, body * 0.9 * k / EMU_PER_PT))
    for ri, row in enumerate(rows):
        table.rows[ri].height = Emu(int(h / len(rows)))
        for ci in range(cols):
            cell = table.cell(ri, ci)
            cell.fill.background()
            cell.margin_left = cell.margin_right = Emu(int(2 * k))
            cell.margin_top = cell.margin_bottom = Emu(int(1 * k))
            cell.text = row[ci] if ci < len(row) else ""
            for para in cell.text_frame.paragraphs:
                for run in para.runs:
                    run.font.size = size
                    run.font.bold = ri == 0


@core.serial
def to_pptx(src, out, *, pages=None, passwords: list[str] | None = None, dpi: float = 150, text: bool = True) -> dict:
    import pdfplumber
    from pptx import Presentation
    from pptx.util import Emu

    pw = next(iter(passwords or []), "")
    bg = core.pdfium_doc(src, passwords)
    counts = {"textboxes": 0, "tables": 0, "shapes": 0, "pictures": 0}
    try:
        with pdfplumber.open(str(src), password=pw) as pdf:
            n = len(pdf.pages)
            idx = core.parse_pages(pages, n)
            if not idx:
                raise ValueError("The PDF has no pages")
            first = pdf.pages[idx[0] - 1]
            W0, H0 = float(first.width), float(first.height)
            shrink = min(1.0, MAX_EMU / max(W0 * EMU_PER_PT, H0 * EMU_PER_PT))
            sw = int(max(MIN_EMU, min(MAX_EMU, W0 * EMU_PER_PT * shrink)))
            sh = int(max(MIN_EMU, min(MAX_EMU, H0 * EMU_PER_PT * shrink)))
            prs = Presentation()
            prs.slide_width, prs.slide_height = Emu(sw), Emu(sh)
            blank = prs.slide_layouts[6]
            sample = []
            for i in idx[:4]:
                try:
                    sample += pdf.pages[i - 1].extract_words(extra_attrs=["size"])
                except Exception:
                    continue
            base = layout.body_size(sample) if sample else None
            try:
                bg.init_forms()
            except Exception:
                pass
            for i in idx:
                page = pdf.pages[i - 1]
                W, H = float(page.width), float(page.height)
                k, ox, oy = _fit(W, H, sw, sh)
                slide = prs.slides.add_slide(blank)
                pg = bg[i - 1]
                parts = objects.split(bg, pg, text=True) if text else {"objects": [], "tilted": []}
                cx0, cy0, cx1, cy1 = pg.get_cropbox()
                side = (cy1 - cy0, cx1 - cx0) if pg.get_rotation() % 180 else (cx1 - cx0, cy1 - cy0)
                to = _Map(k, ox, oy, (0.0, 0.0, side[0], side[1]))
                scale = max(0.2, min(dpi / 72, 6000 / max(W, H, 1)))
                pil = core.render_pil(pg, scale).convert("RGB")
                pg.close()
                buf = io.BytesIO()
                pil.save(buf, "JPEG", quality=88)
                buf.seek(0)
                pic = slide.shapes.add_picture(buf, Emu(int(ox)), Emu(int(oy)), Emu(int(W * k)), Emu(int(H * k)))
                pic.name = f"Page {i}"
                for rec in parts["objects"]:
                    try:
                        if rec["kind"] == "image":
                            counts["pictures"] += _picture(slide, rec, to)
                        else:
                            counts["shapes"] += _shape(slide, rec, to)
                    except Exception:
                        continue
                for t in parts["tilted"]:
                    _tilted_box(slide, t, to)
                    counts["textboxes"] += 1
                if text:
                    flat = page.filter(lambda o: not _tilted_char(o))
                    got = layout.page_blocks(flat, body=base)
                    words = None
                    for b in got["blocks"]:
                        if b["kind"] in ("para", "heading") and b.get("text"):
                            if b.get("lines", 1) == 1:
                                words = words if words is not None else _words(flat)
                                parts_b = _spread(b, words)
                            else:
                                parts_b = [b]
                            for pb in parts_b:
                                _textbox(slide, pb, k, ox, oy)
                                counts["textboxes"] += 1
                        elif b["kind"] == "table":
                            _table(slide, b, k, ox, oy, got["body"])
                            counts["tables"] += 1
                page.close()
            prs.core_properties.title = Path(str(src)).stem[:200]
            prs.save(str(out))
        return {"pages": len(idx), "slides": len(idx), "width": round(sw / EMU_PER_PT, 2), "height": round(sh / EMU_PER_PT, 2),
                "text": bool(text), "layered": bool(text), **counts}
    finally:
        bg.close()


@core.serial
def contact_sheet(src, pages=None, passwords: list[str] | None = None, width: int = 1600) -> tuple[bytes, list[int]]:
    from PIL import Image, ImageDraw, ImageFont

    doc = core.pdfium_doc(src, passwords)
    try:
        try:
            doc.init_forms()
        except Exception:
            pass
        idx = core.parse_pages(pages, len(doc))[:SHEET_MAX]
        if not idx:
            raise ValueError("The PDF has no pages")
        cols = 1 if len(idx) == 1 else 2 if len(idx) <= 4 else 3 if len(idx) <= 9 else 4
        gap, label = 16, 26
        cell = (width - gap * (cols + 1)) // cols
        thumbs = []
        for i in idx:
            pg = doc[i - 1]
            w, h = pg.get_size()
            pil = core.render_pil(pg, max(0.05, min(4.0, cell / max(w, h, 1)))).convert("RGB")
            pg.close()
            thumbs.append(pil)
        rows = math.ceil(len(thumbs) / cols)
        row_h = [max(t.height for t in thumbs[r * cols:(r + 1) * cols]) for r in range(rows)]
        sheet = Image.new("RGB", (width, gap + sum(h + label + gap for h in row_h)), (32, 32, 36))
        draw = ImageDraw.Draw(sheet)
        try:
            font = ImageFont.load_default(size=16)
        except TypeError:
            font = ImageFont.load_default()
        y = gap
        for r in range(rows):
            for c, t in enumerate(thumbs[r * cols:(r + 1) * cols]):
                x = gap + c * (cell + gap) + (cell - t.width) // 2
                sheet.paste(t, (x, y + (row_h[r] - t.height) // 2))
                draw.rectangle([x - 1, y + (row_h[r] - t.height) // 2 - 1, x + t.width, y + (row_h[r] + t.height) // 2], outline=(90, 90, 96))
                draw.text((gap + c * (cell + gap) + cell // 2, y + row_h[r] + 5), f"Page {idx[r * cols + c]}", fill=(220, 220, 226), font=font, anchor="ma")
            y += row_h[r] + label + gap
        buf = io.BytesIO()
        sheet.save(buf, "PNG", optimize=True)
        return buf.getvalue(), idx
    finally:
        doc.close()
