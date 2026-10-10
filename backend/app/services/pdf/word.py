import io
from pathlib import Path

from . import core, layout

MAX_PAGES = 500
MAX_ROWS = 400


@core.serial
def _page_images(path, idx: list[int], passwords: list[str] | None, min_pt: float = 12) -> dict[int, list[dict]]:
    import pypdfium2.raw as pdfium_c

    doc = core.pdfium_doc(path, passwords)
    out: dict[int, list[dict]] = {}
    try:
        for i in idx:
            page = doc[i - 1]
            W, H = page.get_size()
            x_off, y_off = 0.0, 0.0
            try:
                box = page.get_cropbox()
                x_off, y_off = float(box[0]), float(box[1])
            except Exception:
                pass
            got: list[dict] = []
            try:
                objs = list(page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_IMAGE,), max_depth=4))
            except Exception:
                objs = []
            for obj in objs[:60]:
                try:
                    left, bottom, right, top = obj.get_bounds()
                except Exception:
                    continue
                w, h = right - left, top - bottom
                if w < min_pt or h < min_pt:
                    continue
                data = core._image_bytes(obj)
                if not data:
                    continue
                got.append({"x0": left - x_off, "x1": right - x_off, "top": H - (top - y_off), "bottom": H - (bottom - y_off), "w": w, "h": h,
                            "data": data[0], "ext": data[1]})
            page.close()
            out[i] = got
    finally:
        doc.close()
    return out


def _color(hexc: str | None):
    from docx.shared import RGBColor

    if not hexc:
        return None
    s = hexc.lstrip("#")
    return RGBColor(int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def _setup(section, W: float, H: float, m: dict | None) -> None:
    from docx.enum.section import WD_ORIENT
    from docx.shared import Pt

    section.page_width, section.page_height = Pt(W), Pt(H)
    section.orientation = WD_ORIENT.LANDSCAPE if W > H else WD_ORIENT.PORTRAIT
    m = m or {}
    for attr, key in (("left_margin", "left"), ("right_margin", "right"), ("top_margin", "top"), ("bottom_margin", "bottom")):
        v = float(m.get(key, 54) or 54)
        setattr(section, attr, Pt(max(18.0, min(144.0, v - 4))))
    section.header_distance = Pt(18)
    section.footer_distance = Pt(18)


def _para(doc, b: dict, body: float):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    if b["kind"] == "heading":
        p = doc.add_heading(level=min(3, max(1, int(b.get("level") or 2))))
    elif b.get("list"):
        p = doc.add_paragraph()
    else:
        p = doc.add_paragraph()
    p.alignment = {"center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT}.get(b.get("align"), WD_ALIGN_PARAGRAPH.LEFT)
    fmt = p.paragraph_format
    fmt.space_before = Pt(0 if b["kind"] != "heading" else max(4.0, b["size"] * 0.4))
    fmt.space_after = Pt(max(2.0, min(12.0, body * 0.5)))
    for r in b["runs"]:
        run = p.add_run(r["text"])
        run.font.size = Pt(max(4.0, min(144.0, float(r["size"]))))
        run.font.bold = bool(r["bold"]) or None
        run.font.italic = bool(r["italic"]) or None
        if r.get("font"):
            run.font.name = r["font"]
        c = _color(r.get("color"))
        run.font.color.rgb = c if c is not None else _color("#000000") if b["kind"] == "heading" else None
    return p


def _table(doc, rows: list[list[str]]):
    rows = rows[:MAX_ROWS]
    cols = max(len(r) for r in rows)
    t = doc.add_table(rows=len(rows), cols=cols)
    try:
        t.style = "Table Grid"
    except Exception:
        pass
    for ri, r in enumerate(rows):
        for ci in range(cols):
            cell = t.cell(ri, ci)
            cell.text = r[ci] if ci < len(r) else ""
            if ri == 0:
                for run in cell.paragraphs[0].runs:
                    run.font.bold = True
    doc.add_paragraph()
    return t


def _picture(doc, img: dict, content_w: float, page_w: float) -> None:
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    w = min(float(img["w"]), content_w)
    p = doc.add_paragraph()
    centred = abs((img["x0"] + img["x1"]) / 2 - page_w / 2) < page_w * 0.05 and img["x0"] > page_w * 0.15
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER if centred else WD_ALIGN_PARAGRAPH.LEFT
    try:
        p.add_run().add_picture(io.BytesIO(img["data"]), width=Pt(w))
    except Exception:
        try:
            from PIL import Image

            pil = Image.open(io.BytesIO(img["data"]))
            buf = io.BytesIO()
            pil.convert("RGBA" if "A" in pil.getbands() else "RGB").save(buf, "PNG")
            p.add_run().add_picture(io.BytesIO(buf.getvalue()), width=Pt(w))
        except Exception:
            p._element.getparent().remove(p._element)


def to_docx(src, out, *, pages=None, passwords: list[str] | None = None) -> dict:
    import docx
    import pdfplumber
    from docx.enum.section import WD_SECTION
    from docx.shared import Pt

    pw = next(iter(passwords or []), "")
    with pdfplumber.open(str(src), password=pw) as pdf:
        n = len(pdf.pages)
        idx = core.parse_pages(pages, n)
        if len(idx) > MAX_PAGES:
            raise ValueError(f"Convert at most {MAX_PAGES} pages at a time")
        images = _page_images(src, idx, passwords)
        sample = []
        for i in idx[:4]:
            try:
                sample += pdf.pages[i - 1].extract_words(extra_attrs=["size"], x_tolerance_ratio=0.15)
            except Exception:
                continue
        base = layout.body_size(sample) if sample else 11.0
        doc = docx.Document()
        normal = doc.styles["Normal"]
        normal.font.size = Pt(base)
        prev = None
        counts = {"paragraphs": 0, "headings": 0, "tables": 0, "pictures": 0}
        for k, i in enumerate(idx):
            page = pdf.pages[i - 1]
            got = layout.page_blocks(page, body=base, images=images.get(i, []))
            W, H, m = got["width"], got["height"], got["margins"]
            shape = (round(W), round(H))
            if k == 0:
                _setup(doc.sections[0], W, H, m)
            elif prev != shape:
                _setup(doc.add_section(WD_SECTION.NEW_PAGE), W, H, m)
            else:
                doc.add_page_break()
            prev = shape
            sec = doc.sections[-1]
            content_w = (sec.page_width - sec.left_margin - sec.right_margin) / 12700
            for b in got["blocks"]:
                if b["kind"] in ("para", "heading"):
                    _para(doc, b, base)
                    counts["headings" if b["kind"] == "heading" else "paragraphs"] += 1
                elif b["kind"] == "table":
                    _table(doc, b["rows"])
                    counts["tables"] += 1
                elif b["kind"] == "image":
                    _picture(doc, b, content_w, W)
                    counts["pictures"] += 1
            page.close()
        props = doc.core_properties
        props.title = Path(src).stem
        doc.save(str(out))
    return {"pages": len(idx), **counts}
