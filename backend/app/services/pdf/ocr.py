import io
import math
import statistics
import threading
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, IndirectObject, NameObject, TextStringObject

from app.core import config

from . import actions, annot, core, fontkit
from .content import interp

KEY = NameObject("/FormpdfOCR")
PREFIX = "/FpOCR"
MODELS = {"det": "PP-OCRv6_det_small.onnx", "rec": "PP-OCRv6_rec_small.onnx", "cls": "ch_ppocr_mobile_v2.0_cls_mobile.onnx"}
MISSING = ("Text recognition is not installed. Run ./formpdf install (formpdf.bat install on Windows) to add it; "
           "formpdf never downloads it while you work.")
MAX_DPI = 400
_engine = None
_lock = threading.Lock()


def _model_paths() -> dict[str, Path] | None:
    own = config.models_dir() / "ocr"
    try:
        import rapidocr

        packaged = Path(rapidocr.__file__).resolve().parent / "models"
    except Exception:
        packaged = None
    out = {}
    for k, name in MODELS.items():
        hit = next((d / name for d in (own, packaged) if d is not None and (d / name).is_file()), None)
        if hit is None:
            return None
        out[k] = hit
    return out


def status() -> dict:
    try:
        import onnxruntime  # noqa: F401
        import rapidocr  # noqa: F401
    except Exception:
        return {"available": False, "reason": MISSING}
    if _model_paths() is None:
        return {"available": False, "reason": MISSING}
    return {"available": True, "reason": ""}


def engine():
    global _engine
    with _lock:
        if _engine is None:
            st = status()
            if not st["available"]:
                raise ValueError(st["reason"])
            from rapidocr import RapidOCR

            paths = _model_paths()
            _engine = RapidOCR(params={"Global.log_level": "error", "Det.model_path": str(paths["det"]), "Rec.model_path": str(paths["rec"]),
                                       "Cls.model_path": str(paths["cls"])})
        return _engine


def _recognise(img) -> list[list[tuple[str, list]]]:
    import numpy as np

    r = engine()(np.asarray(img.convert("RGB"))[:, :, ::-1], return_word_box=True)
    lines = []
    for words in r.word_results or ():
        line = [(str(t), [list(map(float, p)) for p in box]) for t, _s, box in words if str(t).strip()]
        if line:
            lines.append(line)
    return lines


def _skew(lines) -> float:
    angles = []
    for line in lines:
        (x0, y0), (x1, y1) = line[0][1][0], line[-1][1][1]
        if x1 - x0 > 40:
            angles.append(math.degrees(math.atan2(y1 - y0, x1 - x0)))
    return statistics.median(angles) if len(angles) >= 3 else 0.0


def _rotate_back(lines, deg: float, cx: float, cy: float):
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)

    def pt(p):
        x, y = p[0] - cx, p[1] - cy
        return [x * c - y * s + cx, x * s + y * c + cy]

    return [[(t, [pt(p) for p in box]) for t, box in line] for line in lines]


def _level(lines):
    out = []
    for line in lines:
        mid = statistics.mean((box[2][1] + box[3][1]) / 2 for _, box in line)
        fixed = []
        for t, box in line:
            dy = mid - (box[2][1] + box[3][1]) / 2
            fixed.append((t, [[p[0], p[1] + dy] for p in box]))
        out.append(fixed)
    return out


def _scan_draws(page, w):
    content = interp.walk(page, w, forms=True)
    x0, y0, x1, y1 = core.view_box(page)
    area = (x1 - x0) * (y1 - y0)
    imgs = [d for d in content.draws if d.kind == "image" and d.where == ()]
    other = [d for d in content.draws if d.kind in ("path", "shading", "inline", "form")]
    visible = [g for g in content.glyphs if g.render != 3 and g.text.strip()]
    return imgs, other, visible, area


def _scan_only(page, w) -> bool:
    imgs, other, visible, area = _scan_draws(page, w)
    if len(imgs) != 1 or visible or any(d.kind != "path" for d in other):
        return False
    b = imgs[0].box
    return b is not None and (b[2] - b[0]) * (b[3] - b[1]) >= 0.9 * area


def _scan_is_jpeg(page) -> bool:
    res = page.get("/Resources")
    xo = res.get_object().get("/XObject") if res is not None else None
    for _, ref in (xo.get_object().items() if xo is not None else []):
        obj = ref.get_object()
        if obj.get("/Subtype") == "/Image":
            f = obj.get("/Filter")
            return "/DCTDecode" in (str(f) if not isinstance(f, ArrayObject) else " ".join(map(str, f)))
    return False


def _replace_scan(w, page, img, src_jpeg: bool) -> None:
    import zlib

    from pypdf.generic import NumberObject, StreamObject

    x0, y0, x1, y1 = core.view_box(page)
    dw, dh = (y1 - y0, x1 - x0) if core.rotation(page) in (90, 270) else (x1 - x0, y1 - y0)
    img = img.convert("L") if _is_gray(img) else img.convert("RGB")
    buf = io.BytesIO()
    s = StreamObject()
    if src_jpeg:
        img.save(buf, "JPEG", quality=85)
        s._data = buf.getvalue()
        s[NameObject("/Filter")] = NameObject("/DCTDecode")
    else:
        s._data = zlib.compress(img.tobytes())
        s[NameObject("/Filter")] = NameObject("/FlateDecode")
    s.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"),
              NameObject("/Width"): NumberObject(img.width), NameObject("/Height"): NumberObject(img.height),
              NameObject("/ColorSpace"): NameObject("/DeviceGray" if img.mode == "L" else "/DeviceRGB"),
              NameObject("/BitsPerComponent"): NumberObject(8)})
    ref = w._add_object(s)
    m = _placement(page)
    body = DecodedStreamObject()
    body.set_data(f"q {' '.join(f'{v:g}' for v in m)} cm {dw:g} 0 0 {dh:g} 0 0 cm /FpScan Do Q\n".encode())
    res = page.get("/Resources")
    res = DictionaryObject(res.get_object()) if res is not None else DictionaryObject()
    res[NameObject("/XObject")] = DictionaryObject({NameObject("/FpScan"): ref})
    page[NameObject("/Resources")] = res
    page[NameObject("/Contents")] = ArrayObject([w._add_object(body)])


def _is_gray(img) -> bool:
    small = img.convert("RGB").resize((64, 64))
    return all(abs(r - g) < 8 and abs(g - b) < 8 for r, g, b in small.getdata())


def _image_dpi(page, w) -> float:
    content = interp.walk(page, w, forms=True)
    best = 0.0
    for d in content.draws:
        if d.kind != "image":
            continue
        width_pt = math.hypot(d.ctm[0], d.ctm[1])
        if width_pt < 72:
            continue
        stream = content.streams.get(d.where)
        xo = stream.resources.get("/XObject") if stream is not None and stream.resources is not None else None
        img = xo.get_object().get(NameObject(d.name)) if xo is not None else None
        px = float(img.get_object().get("/Width", 0) or 0) if img is not None else 0.0
        if px:
            best = max(best, px / (width_pt / 72))
    return best


def _has_text(page, w) -> bool:
    content = interp.walk(page, w, forms=True)
    return sum(1 for g in content.glyphs if g.render != 3 and g.text.strip()) >= 12


def _layer(lines, scale: float, dw: float, dh: float) -> bytes:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfgen import canvas as rlcanvas

    buf = io.BytesIO()
    c = rlcanvas.Canvas(buf, pagesize=(dw, dh))
    for line in lines:
        t = c.beginText()
        t.setTextRenderMode(3)
        for k, (word, box) in enumerate(line):
            text = word + (" " if k < len(line) - 1 else "")
            _, name = fontkit.pick(word, "sans")
            face = getattr(pdfmetrics.getFont(name), "face", None)
            asc = getattr(face, "ascent", 800) / 1000 if face is not None else 0.8
            desc = getattr(face, "descent", -200) / 1000 if face is not None else -0.2
            (x0, y0), (x1, y1), (x2, y2), (x3, y3) = [(p[0] / scale, dh - p[1] / scale) for p in box]
            bw, bh = math.hypot(x1 - x0, y1 - y0), math.hypot(x3 - x0, y3 - y0)
            if bw < 0.5 or bh < 0.5:
                continue
            ang = math.atan2(y1 - y0, x1 - x0)
            if abs(math.degrees(ang)) < 5:
                ang = 0.0
                x3, y3 = min(x0, x3), (y2 + y3) / 2
            ca, sa = math.cos(ang), math.sin(ang)
            size = max(1.0, bh / max(0.5, asc - desc))
            natural = pdfmetrics.stringWidth(word, name, size) or bw
            ox, oy = x3 + sa * desc * size, y3 - ca * desc * size
            t.setFont(name, size)
            t.setHorizScale(max(10.0, min(1000.0, bw / natural * 100)))
            t.setTextTransform(ca, sa, -sa, ca, ox, oy)
            t.textOut(text)
        c.drawText(t)
    c.showPage()
    c.save()
    return buf.getvalue()


def _placement(page) -> tuple:
    x0, y0, x1, y1 = core.view_box(page)
    r = core.rotation(page)
    if r == 90:
        return (0.0, 1.0, -1.0, 0.0, x1, y0)
    if r == 180:
        return (-1.0, 0.0, 0.0, -1.0, x1, y1)
    if r == 270:
        return (0.0, -1.0, 1.0, 0.0, x0, y1)
    return (1.0, 0.0, 0.0, 1.0, x0, y0)


def _entries(w, page) -> ArrayObject:
    raw = page.raw_get("/Contents") if "/Contents" in page else None
    refs = [] if raw is None else (list(raw.get_object()) if isinstance(raw.get_object(), ArrayObject) else [raw])
    out = ArrayObject(r if isinstance(r, IndirectObject) else w._add_object(r.get_object()) for r in refs)
    page[NameObject("/Contents")] = out
    return out


def _remove_layers(w, page) -> int:
    arr = _entries(w, page)
    keep = ArrayObject(r for r in arr if KEY not in r.get_object())
    gone = len(arr) - len(keep)
    page[NameObject("/Contents")] = keep
    res = page.get("/Resources")
    xo = res.get_object().get("/XObject") if res is not None else None
    if xo is not None:
        xo = xo.get_object()
        for name in [k for k in xo if str(k).startswith(PREFIX)]:
            del xo[name]
    return gone


def has_layer(page) -> bool:
    raw = page.get("/Contents")
    if raw is None:
        return False
    obj = raw.get_object()
    return any(KEY in r.get_object() for r in (obj if isinstance(obj, ArrayObject) else [obj]))


@core.serial
def run(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    st = status()
    if not st["available"]:
        raise ValueError(st["reason"])
    w = PdfWriter(clone_from=core.reader(src, passwords))
    want = core.parse_pages(pages or args.get("pages"), len(w.pages))
    dpi = max(100.0, min(float(args.get("dpi") or 300), MAX_DPI))
    skip_text = args.get("skip_text", True) is not False
    deskew = args.get("deskew", True) is not False
    redo = bool(args.get("redo"))
    doc = core.pdfium_doc(src, passwords)
    done = skipped = words = straightened = layered = 0
    try:
        for n in want:
            page = w.pages[n - 1]
            if has_layer(page):
                if not redo:
                    skipped += 1
                    layered += 1
                    continue
                _remove_layers(w, page)
            elif skip_text and _has_text(page, w):
                skipped += 1
                continue
            cap = _image_dpi(page, w)
            use = min(dpi, max(150.0, cap)) if cap else dpi
            scale = use / 72
            pg = doc[n - 1]
            dw, dh = pg.get_size()
            bitmap = pg.render(scale=scale, may_draw_forms=False)
            try:
                img = bitmap.to_pil().convert("RGB")
            finally:
                bitmap.close()
                pg.close()
            lines = _recognise(img)
            angle = _skew(lines) if deskew else 0.0
            if abs(angle) > 0.4:
                turned = img.rotate(angle, resample=3, fillcolor="white")
                again = _recognise(turned)
                if again and _scan_only(page, w):
                    _replace_scan(w, page, turned, src_jpeg=_scan_is_jpeg(page))
                    lines = again
                    straightened += 1
                elif again:
                    lines = _level(_rotate_back(again, angle, img.width / 2, img.height / 2))
            if not lines:
                done += 1
                continue
            data = _layer(lines, scale, dw, dh)
            form = annot._form(w, PdfReader(io.BytesIO(data)).pages[0], [0, 0, dw, dh])
            name = f"{PREFIX}{n}"
            res = page.get("/Resources")
            res = DictionaryObject(res.get_object()) if res is not None else DictionaryObject()
            xo = res.get("/XObject")
            xo = DictionaryObject(xo.get_object()) if xo is not None else DictionaryObject()
            xo[NameObject(name)] = form
            res[NameObject("/XObject")] = xo
            page[NameObject("/Resources")] = res
            m = _placement(page)
            s = DecodedStreamObject()
            s.set_data(f"q {' '.join(f'{v:g}' for v in m)} cm {name} Do Q\n".encode())
            s[KEY] = TextStringObject("ocr")
            _entries(w, page).append(w._add_object(s))
            done += 1
            words += sum(len(line) for line in lines)
    finally:
        doc.close()
    if not done and layered:
        raise ValueError("These pages are already searchable from an earlier recognition. Turn on Recognise again to redo them.")
    if not done:
        raise ValueError("Every page already has text, so nothing was recognised. Turn off Skip pages with text to recognise them anyway.")
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "recognised": done, "skipped": skipped, "words": words, "straightened": straightened}


actions.register(actions.Action("ocr", "change", "Recognise text (OCR)", "searchable",
                                ("ocr", "scanned", "make searchable", "recognize text", "recognise text", "scan to text"),
                                fields=(actions.Field("dpi", "Resolution (dpi)", "number", 300, hint="150 to 400; never above the scan's own"),
                                        actions.Field("skip_text", "Skip pages that already have text", "bool", True),
                                        actions.Field("deskew", "Straighten tilted scans", "bool", True),
                                        actions.Field("redo", "Recognise again where formpdf already did", "bool", False), actions.PAGES),
                                run=run))
