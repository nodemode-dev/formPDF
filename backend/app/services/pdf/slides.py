import io
import math
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import ContentStream

from . import core, layout

EMU_PER_PT = 12700
MIN_EMU = 914400
MAX_EMU = 51206400
PLAIN_TABLE = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"
SHEET_MAX = 12


def _textless(src, passwords: list[str] | None) -> bytes | None:
    try:
        r = core.reader(src, passwords)
        w = PdfWriter(clone_from=r)
        for page in w.pages:
            contents = page.get_contents()
            if contents is None:
                continue
            cs = ContentStream(contents, w)
            out = []
            for operands, op in cs.operations:
                if op in (b"Tj", b"TJ"):
                    continue
                if op == b"'":
                    out.append(([], b"T*"))
                    continue
                if op == b'"':
                    if len(operands) >= 3:
                        out += [([operands[0]], b"Tw"), ([operands[1]], b"Tc")]
                    out.append(([], b"T*"))
                    continue
                out.append((operands, op))
            cs.operations = out
            page.replace_contents(cs)
        buf = io.BytesIO()
        w.write(buf)
        return buf.getvalue()
    except core.Locked:
        raise
    except Exception:
        return None


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
    import pypdfium2 as pdfium
    from pptx import Presentation
    from pptx.util import Emu

    stripped = _textless(src, passwords) if text else None
    pw = next(iter(passwords or []), "")
    bg = pdfium.PdfDocument(stripped) if stripped else core.pdfium_doc(src, passwords)
    counts = {"textboxes": 0, "tables": 0}
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
                scale = max(0.2, min(dpi / 72, 6000 / max(W, H, 1)))
                pil = core.render_pil(pg, scale).convert("RGB")
                pg.close()
                buf = io.BytesIO()
                pil.save(buf, "JPEG", quality=88)
                buf.seek(0)
                pic = slide.shapes.add_picture(buf, Emu(int(ox)), Emu(int(oy)), Emu(int(W * k)), Emu(int(H * k)))
                pic.name = f"Page {i}"
                if text:
                    got = layout.page_blocks(page, body=base)
                    for b in got["blocks"]:
                        if b["kind"] in ("para", "heading") and b.get("text"):
                            _textbox(slide, b, k, ox, oy)
                            counts["textboxes"] += 1
                        elif b["kind"] == "table":
                            _table(slide, b, k, ox, oy, got["body"])
                            counts["tables"] += 1
                page.close()
            prs.core_properties.title = Path(str(src)).stem[:200]
            prs.save(str(out))
        return {"pages": len(idx), "slides": len(idx), "width": round(sw / EMU_PER_PT, 2), "height": round(sh / EMU_PER_PT, 2),
                "text": bool(text), "layered": bool(stripped), **counts}
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
