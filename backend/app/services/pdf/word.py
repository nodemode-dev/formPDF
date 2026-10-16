import io
import re

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


def _para(doc, b: dict, body: float, style: str | None = None):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    if b["kind"] == "heading":
        p = doc.add_heading(level=min(3, max(1, int(b.get("level") or 2))))
    elif style:
        p = doc.add_paragraph(style=style)
    else:
        p = doc.add_paragraph()
    p.alignment = {"center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT}.get(b.get("align"), WD_ALIGN_PARAGRAPH.LEFT)
    letters = sum(ch.isalpha() for ch in b["text"])
    rtl = letters > 0 and len(layout.RTL_RE.findall(b["text"])) > letters * 0.5
    if rtl:
        from docx.oxml.ns import qn

        # a right-to-left paragraph: in it Word's "left" means its start, the right edge; centred text stays centred and
        # everything else starts there, since a ragged right-to-left line reads as left-set to the alignment guess
        ppr = p._p.get_or_add_pPr()
        ppr.insert_element_before(ppr.makeelement(qn("w:bidi"), {}), "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind",
                                  "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc", "w:textDirection",
                                  "w:textAlignment", "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange")
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER if b.get("align") == "center" else WD_ALIGN_PARAGRAPH.LEFT
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
        if rtl and layout.RTL_RE.search(r["text"]):
            run.font.rtl = True
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


def _cols(section, count: int, gutter: float) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    sect = section._sectPr
    for old in sect.findall(qn("w:cols")):
        sect.remove(old)
    el = OxmlElement("w:cols")
    el.set(qn("w:num"), str(count))
    el.set(qn("w:space"), str(int(round(gutter * 20))))
    sect.append(el)


def _restart(doc, p, start: int) -> None:
    numbering = doc.part.numbering_part.numbering_definitions._numbering
    style_id = doc.styles["List Number"]._element.pPr.numPr.numId.val
    num = numbering.add_num(numbering.num_having_numId(style_id).abstractNumId.val)
    num.add_lvlOverride(ilvl=0).add_startOverride(start)
    numPr = p._p.get_or_add_pPr().get_or_add_numPr()
    numPr.get_or_add_ilvl().val = 0
    numPr.get_or_add_numId().val = num.numId


def _field(p, text: str, number: int) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    m = re.search(rf"(?<!\d){number}(?!\d)", text)
    if not m:
        p.add_run(text)
        return
    if m.start():
        p.add_run(text[:m.start()])
    for kind, instr in (("begin", None), (None, " PAGE "), ("separate", None), (None, str(number)), ("end", None)):
        r = p.add_run()
        if kind:
            fc = OxmlElement("w:fldChar")
            fc.set(qn("w:fldCharType"), kind)
            r._r.append(fc)
        elif instr.strip() == "PAGE":
            it = OxmlElement("w:instrText")
            it.set(qn("xml:space"), "preserve")
            it.text = instr
            r._r.append(it)
        else:
            r.text = instr
    if m.end() < len(text):
        p.add_run(text[m.end():])


def _running(section, page: dict) -> int:
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    done = 0
    for top, part in ((True, section.header), (False, section.footer)):
        got = [b for b in page["running"] if (b["top"] < page["height"] / 2) == top]
        if not got:
            continue
        for j, b in enumerate(sorted(got, key=lambda b: (b["top"], b.get("x0", 0)))):
            p = part.paragraphs[0] if j == 0 else part.add_paragraph()
            p.alignment = {"center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT}.get(b.get("align"), WD_ALIGN_PARAGRAPH.LEFT)
            _field(p, b["text"], page["page"])
            done += 1
    return done


def to_docx(src, out, *, pages=None, passwords: list[str] | None = None) -> dict:
    import docx
    from docx.enum.section import WD_SECTION
    from docx.shared import Pt

    from .exports import _items, document

    got = document(src, pages, passwords)
    base = got["body"]
    doc = docx.Document()
    doc.styles["Normal"].font.size = Pt(base)
    prev = None
    cur = 1
    fresh = True
    counts = {"paragraphs": 0, "headings": 0, "tables": 0, "pictures": 0, "lists": 0, "columned_pages": 0, "running": 0}

    def want(n: int, gutter: float) -> None:
        nonlocal cur, fresh
        if n == cur:
            return
        sec = doc.sections[-1] if fresh else doc.add_section(WD_SECTION.CONTINUOUS)
        _cols(sec, n, gutter)
        cur, fresh = n, True

    for k, pg in enumerate(got["pages"]):
        W, H, m = pg["width"], pg["height"], pg["margins"]
        shape = (round(W), round(H))
        cols = layout.columns(pg["blocks"], W)
        if k == 0:
            _setup(doc.sections[0], W, H, m)
        elif prev != shape or cur != 1 or cols:
            sec = doc.add_section(WD_SECTION.NEW_PAGE)
            _setup(sec, W, H, m)
            _cols(sec, 1, 36)
            cur, fresh = 1, True
        else:
            doc.add_page_break()
        prev = shape
        if not counts["running"] and pg["running"]:
            counts["running"] = _running(doc.sections[-1], pg)
        counts["columned_pages"] += bool(cols)
        sec = doc.sections[-1]
        content_w = (sec.page_width - sec.left_margin - sec.right_margin) / 12700
        span = (cols["right"] - cols["left"]) if cols else 0
        for what, kind, item in _items(pg["blocks"]):
            head = item[0] if what == "list" else item
            inside = bool(cols) and "x0" in head and head["top"] >= cols["top"] - 1 and head["bottom"] <= cols["bottom"] + 1 \
                and head["x1"] - head["x0"] < span * 0.58
            want(cols["count"] if inside else 1, cols["gutter"] if cols else 36)
            fresh = False
            if what == "list":
                style = "List Number" if kind == "ol" else "List Bullet"
                for j, b in enumerate(item):
                    p = _para(doc, b, base, style)
                    if kind == "ol" and j == 0:
                        digits = re.sub(r"\D", "", head.get("marker", ""))
                        _restart(doc, p, int(digits) if digits else 1)
                counts["lists"] += 1
            elif item["kind"] in ("para", "heading"):
                _para(doc, item, base)
                counts["headings" if item["kind"] == "heading" else "paragraphs"] += 1
            elif item["kind"] == "table":
                _table(doc, item["rows"])
                counts["tables"] += 1
            elif item["kind"] == "image":
                _picture(doc, item, content_w / (cur if cur > 1 else 1), W)
                counts["pictures"] += 1
    doc.core_properties.title = got["title"]
    doc.save(str(out))
    return {"pages": len(got["pages"]), **counts}
