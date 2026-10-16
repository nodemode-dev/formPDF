import base64
import html
import io
import re
from pathlib import Path

from . import actions, core, layout
from .word import MAX_PAGES, _page_images

MAX_ROWS = 400


def document(src, pages=None, passwords: list[str] | None = None, pictures: bool = True) -> dict:
    import pdfplumber

    pw = next(iter(passwords or []), "")
    with pdfplumber.open(str(src), password=pw) as pdf:
        n = len(pdf.pages)
        idx = core.parse_pages(pages, n)
        if len(idx) > MAX_PAGES:
            raise ValueError(f"Convert at most {MAX_PAGES} pages at a time")
        images = _page_images(src, idx, passwords) if pictures else {}
        sample = []
        for i in idx[:4]:
            try:
                sample += pdf.pages[i - 1].extract_words(extra_attrs=["size"], x_tolerance_ratio=0.15)
            except Exception:
                continue
        base = layout.body_size(sample) if sample else 11.0
        out = []
        for i in idx:
            page = pdf.pages[i - 1]
            got = layout.page_blocks(page, body=base, images=images.get(i, []))
            out.append({"page": i, "width": got["width"], "height": got["height"], "blocks": got["blocks"], "margins": got["margins"]})
            page.close()
    shapes = layout.running(out)
    for p in out:
        p["running"] = [b for b in p["blocks"] if layout.is_running(b, p["height"], shapes)]
        p["blocks"] = [b for b in p["blocks"] if not layout.is_running(b, p["height"], shapes)]
    return {"pages": out, "body": base, "title": Path(str(src)).stem}


def _items(blocks: list[dict]):
    group: list[dict] = []
    kind = ""
    for b in blocks:
        li = layout.list_item(b.get("text", "")) if b.get("kind") == "para" and b.get("list") else None
        if li:
            if group and li[0] != kind:
                yield ("list", kind, group)
                group = []
            kind = li[0]
            group.append({**b, "runs": layout.strip_runs(b["runs"], len(li[1])), "text": li[2], "marker": li[1]})
            continue
        if group:
            yield ("list", kind, group)
            group = []
        yield ("block", "", b)
    if group:
        yield ("list", kind, group)


def _html_runs(runs: list[dict]) -> str:
    out = []
    for r in runs:
        t = html.escape(r["text"])
        if r.get("bold"):
            t = f"<strong>{t}</strong>"
        if r.get("italic"):
            t = f"<em>{t}</em>"
        if r.get("color"):
            t = f'<span style="color:{html.escape(r["color"])}">{t}</span>'
        out.append(t)
    return "".join(out)


def _html_table(rows: list[list[str]]) -> str:
    rows = rows[:MAX_ROWS]
    head = "".join(f"<th>{html.escape(c)}</th>" for c in rows[0])
    body = "".join("<tr>" + "".join(f"<td>{html.escape(c)}</td>" for c in r) + "</tr>" for r in rows[1:])
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def _mime(ext: str) -> str:
    return {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "bmp": "image/bmp", "tif": "image/tiff", "tiff": "image/tiff",
            "jp2": "image/jp2"}.get(str(ext).lower().lstrip("."), "image/png")


def to_html(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    doc = document(src, pages, passwords, pictures=(args or {}).get("pictures", True) is not False)
    counts = {"headings": 0, "paragraphs": 0, "lists": 0, "tables": 0, "pictures": 0}
    parts = []
    for p in doc["pages"]:
        sec = [f'<section class="page" id="page-{p["page"]}" aria-label="Page {p["page"]}">']
        for what, kind, b in _items(p["blocks"]):
            if what == "list":
                sec.append(f"<{kind}>" + "".join(f"<li>{_html_runs(x['runs'])}</li>" for x in b) + f"</{kind}>")
                counts["lists"] += 1
            elif b["kind"] == "heading":
                lv = min(6, max(1, int(b.get("level") or 2)))
                sec.append(f"<h{lv} dir=\"auto\">{_html_runs(b['runs'])}</h{lv}>")  # auto: right-to-left text sets its own direction
                counts["headings"] += 1
            elif b["kind"] == "para":
                align = b.get("align") if b.get("align") in ("center", "right") else ""
                sec.append(f"<p dir=\"auto\"{f' style=\"text-align:{align}\"' if align else ''}>{_html_runs(b['runs'])}</p>")
                counts["paragraphs"] += 1
            elif b["kind"] == "table":
                sec.append(_html_table(b["rows"]))
                counts["tables"] += 1
            elif b["kind"] == "image":
                data = base64.b64encode(b["data"]).decode("ascii")
                sec.append(f'<figure><img src="data:{_mime(b.get("ext", "png"))};base64,{data}" width="{round(float(b["w"]))}" alt=""></figure>')
                counts["pictures"] += 1
        sec.append("</section>")
        parts.append("\n".join(sec))
    title = html.escape(doc["title"])
    style = ("body{margin:0 auto;max-width:46rem;padding:2rem 1.25rem;font:16px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1d1d1f}"
             "h1,h2,h3{line-height:1.25}table{border-collapse:collapse;margin:1em 0;width:100%}th,td{border:1px solid #c8c8cc;padding:.35em .5em;text-align:left;vertical-align:top}"
             "th{background:#f2f2f4}figure{margin:1em 0}img{max-width:100%;height:auto}section.page+section.page{border-top:1px solid #e3e3e6;margin-top:2rem;padding-top:1rem}")
    doc_html = (f'<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n'
                f"<title>{title}</title>\n<style>{style}</style>\n</head>\n<body>\n" + "\n".join(parts) + "\n</body>\n</html>\n")
    Path(out).write_text(doc_html, encoding="utf-8")
    return {"pages": len(doc["pages"]), **counts}


def _rtf_text(s: str) -> str:
    out = []
    for ch in s:
        o = ord(ch)
        if ch in "\\{}":
            out.append("\\" + ch)
        elif ch == "\n":
            out.append("\\line ")
        elif o < 128:
            out.append(ch)
        elif o < 65536:
            out.append(f"\\u{o if o < 32768 else o - 65536}?")
        else:
            for unit in ch.encode("utf-16-be").hex(" ", 2).split():
                v = int(unit, 16)
                out.append(f"\\u{v if v < 32768 else v - 65536}?")
    return "".join(out)


def _rtf_runs(runs: list[dict], colors: dict[str, int], scale: float = 1.0) -> str:
    out = []
    for r in runs:
        fs = round(max(4.0, min(144.0, float(r.get("size") or 11) * scale)) * 2)
        c = colors.get(r.get("color") or "", 0)
        fmt = f"\\fs{fs}" + ("\\b" if r.get("bold") else "") + ("\\i" if r.get("italic") else "") + (f"\\cf{c}" if c else "")
        out.append("{" + fmt + " " + _rtf_text(r["text"]) + "}")
    return "".join(out)


def _rtf_picture(b: dict) -> str:
    from PIL import Image

    data, ext = b["data"], str(b.get("ext", "png")).lower().lstrip(".")
    try:
        im = Image.open(io.BytesIO(data))
        pw, ph = im.size
        if ext not in ("jpg", "jpeg", "png"):
            buf = io.BytesIO()
            im.convert("RGBA" if "A" in im.getbands() else "RGB").save(buf, "PNG")
            data, ext = buf.getvalue(), "png"
    except Exception:
        return ""
    blip = "\\jpegblip" if ext in ("jpg", "jpeg") else "\\pngblip"
    gw, gh = round(float(b["w"]) * 20), round(float(b.get("h") or b["w"] * ph / max(1, pw)) * 20)
    return f"{{\\pard\\sa120{{\\pict{blip}\\picw{pw}\\pich{ph}\\picwgoal{gw}\\pichgoal{gh} {data.hex()}}}\\par}}"


def to_rtf(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    doc = document(src, pages, passwords, pictures=(args or {}).get("pictures", True) is not False)
    colors: dict[str, int] = {}
    for p in doc["pages"]:
        for b in p["blocks"]:
            for r in b.get("runs") or []:
                c = r.get("color")
                if c and c not in colors and re.fullmatch(r"#[0-9a-fA-F]{6}", c):
                    colors[c] = len(colors) + 1
    table = "".join(f"\\red{int(c[1:3], 16)}\\green{int(c[3:5], 16)}\\blue{int(c[5:7], 16)};" for c in colors)
    parts = ["{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fswiss Arial;}{\\f1\\froman Times New Roman;}}{\\colortbl ;" + table + "}",
             f"{{\\info{{\\title {_rtf_text(doc['title'])}}}}}\\viewkind4\\f0\\fs{round(doc['body'] * 2)}"]
    counts = {"headings": 0, "paragraphs": 0, "lists": 0, "tables": 0, "pictures": 0}
    for k, p in enumerate(doc["pages"]):
        if k:
            parts.append("\\page")
        for what, kind, b in _items(p["blocks"]):
            if what == "list":
                for n, x in enumerate(b, 1):
                    mark = f"{n}." if kind == "ol" else "\\u8226?"
                    parts.append(f"{{\\pard\\li360\\fi-360\\sa60 {mark}\\tab {_rtf_runs(x['runs'], colors)}\\par}}")
                counts["lists"] += 1
            elif b["kind"] in ("heading", "para"):
                align = {"center": "\\qc", "right": "\\qr"}.get(b.get("align"), "\\ql")
                lead = "\\sb200\\sa100\\keepn" if b["kind"] == "heading" else "\\sa120"
                runs = [{**r, "bold": True} for r in b["runs"]] if b["kind"] == "heading" else b["runs"]
                parts.append(f"{{\\pard{align}{lead} {_rtf_runs(runs, colors)}\\par}}")
                counts["headings" if b["kind"] == "heading" else "paragraphs"] += 1
            elif b["kind"] == "table":
                rows = b["rows"][:MAX_ROWS]
                cols = max(len(r) for r in rows)
                width = round((p["width"] - 144) * 20 / max(1, cols))
                edges = "".join(f"\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10\\cellx{width * (c + 1)}" for c in range(cols))
                for ri, r in enumerate(rows):
                    cells = "".join(("{\\b " if ri == 0 else "{") + _rtf_text(r[c] if c < len(r) else "") + "}\\cell" for c in range(cols))
                    parts.append(f"\\trowd\\trgaph80{edges}\\pard\\intbl {cells}\\row")
                parts.append("\\pard\\sa120\\par")
                counts["tables"] += 1
            elif b["kind"] == "image":
                pic = _rtf_picture(b)
                if pic:
                    parts.append(pic)
                    counts["pictures"] += 1
    parts.append("}")
    Path(out).write_text("\n".join(parts), encoding="ascii", errors="replace")
    return {"pages": len(doc["pages"]), **counts}


NUMBER = re.compile(r"^\(?[-+]?[$€£]?\s?\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?%?\)?$|^\(?[-+]?[$€£]?\d+(?:\.\d+)?%?\)?$")


def _cell_value(s: str):
    t = (s or "").strip()
    if not t or not NUMBER.match(t):
        return t, None
    neg = t.startswith("(") and t.endswith(")") or t.startswith("-")
    pct = t.endswith("%") or t.endswith("%)")
    money = re.search(r"[$€£]", t)
    digits = re.sub(r"[^\d.]", "", t)
    try:
        v = float(digits)
    except ValueError:
        return t, None
    if neg:
        v = -v
    if pct:
        places = len(digits.partition(".")[2])
        return v / 100, "0." + "0" * places + "%" if places else "0%"
    if money:
        return v, f'"{money.group(0)}"#,##0.00'
    return (int(v) if v.is_integer() and "." not in digits else v), ("#,##0" if "," in t else None)


def _put(ws, row: int, col: int, value):
    c = ws.cell(row=row, column=col)
    c.value = value
    if isinstance(value, str) and value.startswith("="):
        c.data_type = "s"
    return c


def to_xlsx(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    doc = document(src, pages, passwords, pictures=False)
    wb = Workbook()
    wb.remove(wb.active)
    bold, head_fill = Font(bold=True), PatternFill("solid", fgColor="F2F2F4")
    counts = {"sheets": 0, "tables": 0, "rows": 0}
    only_tables = bool((args or {}).get("tables_only"))
    for p in doc["pages"]:
        ws = wb.create_sheet(f"Page {p['page']}"[:31])
        counts["sheets"] += 1
        row = 1
        widest = 1
        for b in p["blocks"]:
            if b["kind"] == "table":
                rows = b["rows"][:MAX_ROWS]
                for ri, r in enumerate(rows):
                    for ci, txt in enumerate(r):
                        v, fmt = _cell_value(txt) if ri else (txt, None)
                        c = _put(ws, row, ci + 1, v)
                        if fmt:
                            c.number_format = fmt
                        if ri == 0:
                            c.font, c.fill = bold, head_fill
                    widest = max(widest, len(r))
                    row += 1
                    counts["rows"] += 1
                row += 1
                counts["tables"] += 1
            elif b["kind"] in ("heading", "para") and not only_tables:
                item = layout.list_item(b["text"])
                c = _put(ws, row, 1, (("• " if item[0] == "ul" else item[1] + " ") + item[2]) if item else b["text"])
                c.alignment = Alignment(wrap_text=True, vertical="top")
                if b["kind"] == "heading":
                    c.font = Font(bold=True, size=max(11, min(18, round(float(b.get("size") or 12)))))
                row += 1
                counts["rows"] += 1
        ws.column_dimensions["A"].width = 60 if not only_tables else 18
        for ci in range(2, widest + 1):
            ws.column_dimensions[ws.cell(row=1, column=ci).column_letter].width = 18
    if only_tables and not counts["tables"]:
        raise ValueError("No tables were found in those pages")
    wb.properties.title = doc["title"]
    wb.save(str(out))
    return {"pages": len(doc["pages"]), **counts}


PICTURES = actions.Field("pictures", "Include pictures", "bool", True)
actions.register(actions.Action("to_html", "export", "Save as HTML", ext=".html", words=("html", "web page", "export"), fields=(PICTURES,), run=to_html))
actions.register(actions.Action("to_rtf", "export", "Save as RTF", ext=".rtf", words=("rtf", "rich text", "wordpad", "export"), fields=(PICTURES,), run=to_rtf))
actions.register(actions.Action("to_xlsx", "export", "Save as Excel", ext=".xlsx", words=("excel", "xlsx", "spreadsheet", "export"),
                                fields=(actions.Field("tables_only", "Tables only", "bool", False),), run=to_xlsx))
