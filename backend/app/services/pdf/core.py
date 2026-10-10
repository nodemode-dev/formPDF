import functools
import io
import re
import threading
import zipfile
from pathlib import Path

from pypdf import PdfReader, PdfWriter

MAX_IMAGES = 400
PDFIUM = threading.RLock()


class Locked(Exception):
    pass


def serial(fn):
    @functools.wraps(fn)
    def run(*args, **kwargs):
        with PDFIUM:
            return fn(*args, **kwargs)
    return run


def render_pil(page, scale: float):
    bitmap = page.render(scale=scale, may_draw_forms=True)
    try:
        return bitmap.to_pil().copy()
    finally:
        bitmap.close()


def reader(path, passwords: list[str] | None = None) -> PdfReader:
    r = PdfReader(str(path))
    if r.is_encrypted:
        for pw in [*(passwords or []), ""]:
            try:
                if r.decrypt(pw):
                    return r
            except Exception:
                continue
        raise Locked("This PDF is password protected. Unlock it with its password first.")
    return r


def pdfium_doc(path, passwords: list[str] | None = None):
    import pypdfium2 as pdfium

    last: Exception | None = None
    for pw in [None, *(passwords or [])]:
        try:
            return pdfium.PdfDocument(str(path), password=pw)
        except Exception as e:
            last = e
    raise Locked("This PDF is password protected. Unlock it with its password first.") from last


def view_box(page) -> tuple[float, float, float, float]:
    m, c = page.mediabox, page.cropbox
    mx0, mx1 = sorted((float(m.left), float(m.right)))
    my0, my1 = sorted((float(m.bottom), float(m.top)))
    cx0, cx1 = sorted((float(c.left), float(c.right)))
    cy0, cy1 = sorted((float(c.bottom), float(c.top)))
    x0, y0, x1, y1 = max(mx0, cx0), max(my0, cy0), min(mx1, cx1), min(my1, cy1)
    if x1 - x0 < 1 or y1 - y0 < 1:
        return mx0, my0, mx1, my1
    return x0, y0, x1, y1


def rotation(page) -> int:
    try:
        r = int(page.rotation)
    except (TypeError, ValueError):
        return 0
    return r % 360 if r % 90 == 0 else 0


def parse_pages(spec, n: int, unique: bool = True) -> list[int]:
    if spec is None or (isinstance(spec, str) and spec.strip().lower() in ("", "all")):
        return list(range(1, n + 1))
    if isinstance(spec, (list, tuple)):
        out = [int(p) for p in spec]
    else:
        out = []
        for part in re.split(r"[,\s;]+", str(spec).strip()):
            if not part:
                continue
            m = re.fullmatch(r"(\d*)\s*-\s*(\d*)", part)
            if m:
                a = int(m.group(1)) if m.group(1) else 1
                b = int(m.group(2)) if m.group(2) else n
                if a > b:
                    raise ValueError(f"The range {part} runs backwards")
                out.extend(range(a, b + 1))
            elif part.isdigit():
                out.append(int(part))
            else:
                raise ValueError(f"{part} is not a page number or range")
    for p in out:
        if not 1 <= p <= n:
            raise ValueError(f"Page {p} is out of range (1 to {n})")
    if unique:
        out = list(dict.fromkeys(out))
    if not out:
        raise ValueError("No pages selected")
    return out


def _date(value) -> str | None:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


def _outline(r: PdfReader, limit: int = 600) -> list[dict]:
    out: list[dict] = []

    def walk(items, level: int) -> None:
        for it in items:
            if len(out) >= limit:
                return
            if isinstance(it, list):
                walk(it, level + 1)
                continue
            try:
                page = r.get_destination_page_number(it) + 1
            except Exception:
                page = None
            title = str(getattr(it, "title", "") or "").strip()
            if title:
                out.append({"title": title, "page": page, "level": level})

    try:
        walk(r.outline, 0)
    except Exception:
        pass
    return out


def info(path, passwords: list[str] | None = None) -> dict:
    p = Path(path)
    out: dict = {"bytes": p.stat().st_size, "encrypted": False, "locked": False}
    r = PdfReader(str(p))
    if r.is_encrypted:
        out["encrypted"] = True
        try:
            reader(p, passwords)
        except Locked:
            out.update(locked=True, pages=0, sizes=[], outline=[], fields=0)
            return out
        r = reader(p, passwords)
    meta = r.metadata or {}

    def field(attr: str, key: str) -> str:
        try:
            v = getattr(meta, attr) if hasattr(meta, attr) else meta.get(key)
        except Exception:
            v = None
        return str(v).strip() if v else ""

    out.update(title=field("title", "/Title"), author=field("author", "/Author"), subject=field("subject", "/Subject"),
               keywords=field("keywords", "/Keywords"), creator=field("creator", "/Creator"), producer=field("producer", "/Producer"))
    for key, attr in (("created", "creation_date"), ("modified", "modification_date")):
        try:
            out[key] = _date(getattr(meta, attr, None))
        except Exception:
            out[key] = None
    sizes = []
    for page in r.pages:
        x0, y0, x1, y1 = view_box(page)
        sizes.append({"w": round(x1 - x0, 3), "h": round(y1 - y0, 3), "rotate": rotation(page)})
    out["pages"] = len(sizes)
    out["sizes"] = sizes
    out["outline"] = _outline(r)
    try:
        out["fields"] = len(r.get_fields() or {})
    except Exception:
        out["fields"] = 0
    out["version"] = (r.pdf_header or "").replace("%PDF-", "")
    return out


def page_count(path, passwords: list[str] | None = None) -> int:
    try:
        return len(reader(path, passwords).pages)
    except Locked:
        return 0


@serial
def extract_text(path, pages=None, passwords: list[str] | None = None) -> list[dict]:
    doc = pdfium_doc(path, passwords)
    try:
        out = []
        for i in parse_pages(pages, len(doc)):
            page = doc[i - 1]
            tp = page.get_textpage()
            text = tp.get_text_range().replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
            tp.close()
            page.close()
            out.append({"page": i, "text": re.sub(r"[ \t]+\n", "\n", text).strip()})
        return out
    finally:
        doc.close()


def _image_bytes(obj) -> tuple[bytes, str] | None:
    try:
        filters = list(obj.get_filters())
    except Exception:
        filters = []
    if filters == ["DCTDecode"]:
        try:
            buf = io.BytesIO()
            obj.extract(buf)
            if buf.getvalue()[:2] == b"\xff\xd8":
                return buf.getvalue(), "jpg"
        except Exception:
            pass
    pil = None
    for render in (True, False):
        try:
            bitmap = obj.get_bitmap(render=render)
        except Exception:
            continue
        try:
            pil = bitmap.to_pil().copy()
            break
        except Exception:
            continue
        finally:
            bitmap.close()
    if pil is None:
        return None
    buf = io.BytesIO()
    if "A" in pil.getbands() and pil.getchannel("A").getextrema()[0] >= 250:
        pil = pil.convert("RGB")
    if "A" in pil.getbands() or pil.getcolors(256) is not None:
        pil.save(buf, "PNG")
        return buf.getvalue(), "png"
    pil.convert("RGB").save(buf, "JPEG", quality=92)
    return buf.getvalue(), "jpg"


@serial
def extract_images(path, pages=None, passwords: list[str] | None = None, min_px: int = 24, name: str | None = None) -> list[dict]:
    import pypdfium2.raw as pdfium_c

    from app.services import media

    store = media.store()
    stem = Path(name or path).stem
    doc = pdfium_doc(path, passwords)
    out: list[dict] = []
    seen: set[str] = set()
    try:
        for i in parse_pages(pages, len(doc)):
            if len(out) >= MAX_IMAGES:
                break
            page = doc[i - 1]
            try:
                objs = list(page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_IMAGE,), max_depth=4))
            except Exception:
                objs = []
            for k, obj in enumerate(objs):
                try:
                    w, h = obj.get_px_size()
                except Exception:
                    continue
                if w < min_px or h < min_px:
                    continue
                got = _image_bytes(obj)
                if not got:
                    continue
                meta = store.put(got[0], f"{stem}-p{i}-{k + 1}.{got[1]}")
                if meta["id"] in seen:
                    continue
                seen.add(meta["id"])
                out.append({"page": i, "id": meta["id"], "w": meta.get("w", w), "h": meta.get("h", h), "mime": meta["mime"],
                            "bytes": meta["bytes"], "name": meta["name"]})
                if len(out) >= MAX_IMAGES:
                    break
            page.close()
        return out
    finally:
        doc.close()


def _cell(v) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()


def extract_tables(path, pages=None, passwords: list[str] | None = None) -> list[dict]:
    import pdfplumber

    out = []
    pw = next(iter(passwords or []), "")
    with pdfplumber.open(str(path), password=pw) as pdf:
        for i in parse_pages(pages, len(pdf.pages)):
            page = pdf.pages[i - 1]
            try:
                found = page.extract_tables()
            except Exception:
                found = []
            for t in found:
                rows = [[_cell(c) for c in row] for row in t if row]
                rows = [r for r in rows if any(r)]
                if len(rows) < 2 or max(len(r) for r in rows) < 2:
                    continue
                width = max(len(r) for r in rows)
                rows = [r + [""] * (width - len(r)) for r in rows]
                out.append({"page": i, "header": rows[0], "rows": rows[1:]})
            page.close()
    return out


def tables_xlsx(tables: list[dict]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    wb.remove(wb.active)
    for n, t in enumerate(tables, 1):
        ws = wb.create_sheet(f"Table {n} (p{t['page']})"[:31])
        ws.append(t["header"])
        for c in ws[1]:
            c.font = Font(bold=True)
        for row in t["rows"]:
            ws.append(row)
    if not wb.worksheets:
        wb.create_sheet("No tables")
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def merge(paths, out, passwords: list[str] | None = None) -> dict:
    w = PdfWriter()
    for p in paths:
        w.append(reader(p, passwords))
    with open(out, "wb") as fh:
        w.write(fh)
    return {"path": str(out), "pages": len(w.pages)}


def split(path, ranges: list[str], out_dir, passwords: list[str] | None = None) -> list[str]:
    r = reader(path, passwords)
    n = len(r.pages)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    if not ranges:
        raise ValueError("Give at least one page range, for example 1-3")
    plans = [(spec, parse_pages(spec, n, unique=False)) for spec in ranges]
    paths = []
    for k, (spec, idx) in enumerate(plans, 1):
        w = PdfWriter()
        for i in idx:
            w.add_page(r.pages[i - 1])
        dest = out_dir / f"{Path(path).stem}-part{k}-{re.sub(r'[^0-9a-z-]+', '_', str(spec).lower())}.pdf"
        with open(dest, "wb") as fh:
            w.write(fh)
        paths.append(str(dest))
    return paths


@serial
def render_png(path, page: int, scale: float = 2.0, passwords: list[str] | None = None) -> bytes:
    doc = pdfium_doc(path, passwords)
    try:
        if not 1 <= page <= len(doc):
            raise ValueError(f"Page {page} is out of range (1 to {len(doc)})")
        try:
            doc.init_forms()
        except Exception:
            pass
        pg = doc[page - 1]
        w, h = pg.get_size()
        s = max(0.05, min(float(scale), 8.0, 8000 / max(w, h, 1)))
        pil = render_pil(pg, s)
        pg.close()
        buf = io.BytesIO()
        pil.save(buf, "PNG", compress_level=6)
        return buf.getvalue()
    finally:
        doc.close()


@serial
def pages_zip(path, scale: float = 2.0, pages=None, passwords: list[str] | None = None) -> bytes:
    doc = pdfium_doc(path, passwords)
    stem = Path(path).stem
    buf = io.BytesIO()
    try:
        try:
            doc.init_forms()
        except Exception:
            pass
        idx = parse_pages(pages, len(doc))
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for i in idx:
                pg = doc[i - 1]
                w, h = pg.get_size()
                s = max(0.1, min(float(scale), 8.0, 8000 / max(w, h, 1)))
                img = io.BytesIO()
                render_pil(pg, s).save(img, "PNG", compress_level=6)
                pg.close()
                zf.writestr(f"{stem}-page-{i:03d}.png", img.getvalue())
        return buf.getvalue()
    finally:
        doc.close()
