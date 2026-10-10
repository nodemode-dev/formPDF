import io
import zlib

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, ByteStringObject, DictionaryObject, FloatObject, NameObject, NumberObject, StreamObject,
                           TextStringObject)

from . import actions, annot, core, frame
from .content import interp, streams

MIN_OVERLAP = 0.4
TEXT_OPS = (b"Tj", b"TJ", b"'", b'"')


def _rgb(hexc: str) -> tuple[float, float, float]:
    s = str(hexc or "#000000").lstrip("#")
    try:
        return tuple(int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return (0.0, 0.0, 0.0)


def _inter(a, b) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def _covers(box, areas) -> bool:
    if box is None:
        return False
    area = max((box[2] - box[0]) * (box[3] - box[1]), 1e-9)
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    for a in areas:
        if a[0] <= cx <= a[2] and a[1] <= cy <= a[3]:
            return True
        if _inter(box, a) / area >= MIN_OVERLAP:
            return True
    return False


def _touches(box, areas) -> bool:
    return box is not None and any(_inter(box, a) > 0 for a in areas)


def _inside(box, areas, pad: float = 0.5) -> bool:
    return box is not None and any(a[0] - pad <= box[0] and a[1] - pad <= box[1] and box[2] <= a[2] + pad and box[3] <= a[3] + pad for a in areas)


def _text_op(operands, op, glyphs: list, remove: set[int]) -> list:
    items = operands[0] if op == b"TJ" and operands else operands[-1:]
    out = ArrayObject()
    buf = b""
    k = 0
    for item in items:
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            if buf:
                out.append(ByteStringObject(buf))
                buf = b""
            out.append(item)
            continue
        data = item.original_bytes if hasattr(item, "original_bytes") else bytes(str(item), "latin-1")
        used = 0
        while used < len(data) and k < len(glyphs):
            g = glyphs[k]
            if g.seq in remove:
                if buf:
                    out.append(ByteStringObject(buf))
                    buf = b""
                n = -(g.advance / (g.tz or 1.0)) / (g.size or 1.0) * 1000
                out.append(FloatObject(round(n, 3)))
            else:
                buf += g.raw
            used += len(g.raw)
            k += 1
        if used < len(data):
            buf += data[used:]
    if buf:
        out.append(ByteStringObject(buf))
    pre = []
    if op == b'"' and len(operands) == 3:
        pre = [([operands[0]], b"Tw"), ([operands[1]], b"Tc"), ([], b"T*")]
    elif op == b"'":
        pre = [([], b"T*")]
    return pre + [([out], b"TJ")]


def _clear_image(w: PdfWriter, xo, ctm, areas, color) -> StreamObject | None:
    from PIL import ImageDraw
    from pypdf.filters import _xobj_to_image

    try:
        _, _, pil = _xobj_to_image(xo)
    except Exception:
        return None
    W, H = pil.size
    inv = None
    try:
        a, b, c, d, e, f = ctm
        det = a * d - b * c
        inv = (d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)
    except ZeroDivisionError:
        return None
    mode = pil.mode if pil.mode in ("L", "RGB", "CMYK") else "RGB"
    img = pil.convert(mode)
    fill = {"L": int(sum(color) / 3 * 255), "RGB": tuple(int(v * 255) for v in color), "CMYK": (0, 0, 0, 255)}[mode]
    draw = ImageDraw.Draw(img)
    hit = False
    for x0, y0, x1, y1 in areas:
        pts = [interp.apply(inv, x, y) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
        us, vs = [p[0] for p in pts], [p[1] for p in pts]
        if max(us) < 0 or min(us) > 1 or max(vs) < 0 or min(vs) > 1:
            continue
        hit = True
        px0, px1 = max(0, min(us)) * W, min(1, max(us)) * W
        py0, py1 = (1 - min(1, max(vs))) * H, (1 - max(0, min(vs))) * H
        draw.rectangle([int(px0) - 1, int(py0) - 1, int(px1 + 1), int(py1 + 1)], fill=fill)
    if not hit:
        return None
    s = StreamObject()
    s[NameObject("/Type")] = NameObject("/XObject")
    s[NameObject("/Subtype")] = NameObject("/Image")
    s[NameObject("/Width")] = NumberObject(W)
    s[NameObject("/Height")] = NumberObject(H)
    s[NameObject("/BitsPerComponent")] = NumberObject(8)
    s[NameObject("/ColorSpace")] = NameObject({"L": "/DeviceGray", "RGB": "/DeviceRGB", "CMYK": "/DeviceCMYK"}[mode])
    filters = []
    try:
        filters = list(xo.get_filters())
    except Exception:
        pass
    if "DCTDecode" in filters and mode in ("L", "RGB"):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=92)
        s[NameObject("/Filter")] = NameObject("/DCTDecode")
        s._data = buf.getvalue()
    else:
        s[NameObject("/Filter")] = NameObject("/FlateDecode")
        s._data = zlib.compress(img.tobytes(), 6)
    for key in ("/SMask", "/Mask", "/Interpolate", "/Intent"):
        if key in xo:
            s[NameObject(key)] = xo.raw_get(key)
    return w._add_object(s)


def _marked_ranges(ops) -> list[tuple[int, int, object]]:
    out, stack = [], []
    for i, (operands, op) in enumerate(ops):
        if op in (b"BDC", b"BMC"):
            stack.append((i, operands[1] if op == b"BDC" and len(operands) > 1 else None))
        elif op == b"EMC" and stack:
            s, props = stack.pop()
            out.append((s, i, props))
    return out


def _strip_props(props) -> None:
    obj = props.get_object() if hasattr(props, "get_object") else props
    if isinstance(obj, (dict, DictionaryObject)):
        for k in ("/ActualText", "/Alt", "/E"):
            if k in obj:
                del obj[k]


def _rewrite(w: PdfWriter, content, where: tuple, areas, color, edited: dict, report: dict) -> list:
    stream = content.streams[where]
    ops = stream.operations
    res = stream.resources
    glyphs: dict[int, list] = {}
    for g in content.glyphs:
        if g.where == where:
            glyphs.setdefault(g.op, []).append(g)
    remove_text: dict[int, set[int]] = {}
    for op_i, gl in glyphs.items():
        gl.sort(key=lambda g: g.seq)
        hit = {g.seq for g in gl if _covers(g.box, areas)}
        if hit:
            remove_text[op_i] = hit
            report["glyphs"] += len(hit)
    drop: set[int] = set()
    rename: dict[int, str] = {}
    for d in content.draws:
        if d.where != where:
            continue
        if d.kind in ("image", "inline") and _touches(d.box, areas):
            if d.kind == "inline" or _inside(d.box, areas):
                drop.add(d.op)
                report["pictures"] += 1
                continue
            xobjects = res.get("/XObject") if res is not None else None
            xo = xobjects.get_object().get(d.name) if xobjects is not None else None
            new = _clear_image(w, xo.get_object(), d.ctm, areas, color) if xo is not None else None
            if new is None:
                drop.add(d.op)
            else:
                xd = xobjects.get_object()
                n = 1
                while NameObject(f"{d.name}_r{n}") in xd:
                    n += 1
                xd[NameObject(f"{d.name}_r{n}")] = new
                rename[d.op] = f"{d.name}_r{n}"
                report["cleared"].add(f"{d.name}_r{n}")
            report["pictures"] += 1
        elif d.kind == "path" and d.box is not None and _inside(d.box, areas):
            drop.add(d.op)
            report["shapes"] += 1
        elif d.kind == "shading" and d.box is not None and _inside(d.box, areas):
            drop.add(d.op)
        elif d.kind == "form" and where + (d.op,) in edited:
            rename[d.op] = edited[where + (d.op,)]
    if not (remove_text or drop or rename):
        return ops
    for s, e, props in _marked_ranges(ops):
        if props is not None and any(s < i < e for i in remove_text):
            _strip_props(props)
    out = []
    for i, (operands, op) in enumerate(ops):
        if i in remove_text and op in TEXT_OPS:
            out.extend(_text_op(operands, op, glyphs[i], remove_text[i]))
        elif i in drop:
            if op in (b"Do", b"INLINE IMAGE", b"sh"):
                continue
            out.append(([], b"n"))
        elif i in rename and op == b"Do":
            out.append(([NameObject(rename[i])], b"Do"))
        else:
            out.append((operands, op))
    return out


def _pruned(res, ops) -> DictionaryObject:
    res = res.get_object() if hasattr(res, "get_object") else res
    out = DictionaryObject(res) if res is not None else DictionaryObject()
    xo = out.get("/XObject")
    if xo is not None:
        used = {str(operands[0]) for operands, op in ops if op == b"Do" and operands}
        out[NameObject("/XObject")] = DictionaryObject({k: v for k, v in xo.get_object().items() if str(k) in used})
    return out


def _page_areas(page, boxes) -> list[tuple[float, float, float, float]]:
    out = []
    for b in boxes:
        x0, y0, x1, y1 = frame.to_pdf(page, *b)
        out.append((min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)))
    return out


def _clip_out(page, areas) -> tuple[list, list]:
    m = page.mediabox
    bx0, bx1 = sorted((float(m.left), float(m.right)))
    by0, by1 = sorted((float(m.bottom), float(m.top)))
    pre = []
    for x0, y0, x1, y1 in areas:
        pre += [([], b"q")] if not pre else []
        pre += [([FloatObject(bx0 - 10), FloatObject(by0 - 10), FloatObject(bx1 - bx0 + 20), FloatObject(by1 - by0 + 20)], b"re"),
                ([FloatObject(x0), FloatObject(y0), FloatObject(x1 - x0), FloatObject(y1 - y0)], b"re"), ([], b"W*"), ([], b"n")]
    return pre, [([], b"Q")] if pre else []


def _overlay(w: PdfWriter, page, areas, looks) -> list:
    ops = []
    for (x0, y0, x1, y1), (color, _) in zip(areas, looks):
        ops += [([], b"q"), ([FloatObject(c) for c in color], b"rg"),
                ([FloatObject(x0), FloatObject(y0), FloatObject(x1 - x0), FloatObject(y1 - y0)], b"re"), ([], b"f"), ([], b"Q")]
    if any(t.strip() for _, t in looks):
        res = page["/Resources"].get_object() if "/Resources" in page else DictionaryObject()
        fonts = res.get("/Font")
        fonts = DictionaryObject(fonts.get_object()) if fonts is not None else DictionaryObject()
        fonts[NameObject("/FpRedact")] = w._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                                                                         NameObject("/BaseFont"): NameObject("/Helvetica"),
                                                                         NameObject("/Encoding"): NameObject("/WinAnsiEncoding")}))
        res = DictionaryObject(res)
        res[NameObject("/Font")] = fonts
        page[NameObject("/Resources")] = res
        from reportlab.pdfbase.pdfmetrics import stringWidth

        for (x0, y0, x1, y1), (color, text) in zip(areas, looks):
            safe = text.strip()[:120].encode("cp1252", "replace").decode("cp1252")
            if not safe:
                continue
            light = sum(color) / 3 < 0.5
            size = max(4.0, min(12.0, (y1 - y0) * 0.6))
            tw = stringWidth(safe, "Helvetica", size)
            if tw > (x1 - x0) - 2:
                size = max(3.0, size * ((x1 - x0) - 2) / max(tw, 1))
                tw = stringWidth(safe, "Helvetica", size)
            ops += [([], b"q"), ([FloatObject(1 if light else 0)] * 3, b"rg"), ([], b"BT"), ([NameObject("/FpRedact"), FloatObject(size)], b"Tf"),
                    ([FloatObject(x0 + ((x1 - x0) - tw) / 2), FloatObject(y0 + ((y1 - y0) - size * 0.7) / 2)], b"Td"),
                    ([TextStringObject(safe)], b"Tj"), ([], b"ET"), ([], b"Q")]
    return ops


def _annots(w: PdfWriter, page, areas, report: dict) -> set[int]:
    arr = page.get("/Annots")
    if arr is None:
        return set()
    keep = ArrayObject()
    gone_ids: set[int] = set()
    widgets: set[int] = set()
    items = list(arr.get_object())
    for ref in items:
        a = ref.get_object()
        rect = a.get("/Rect")
        try:
            xs, ys = sorted((float(rect[0]), float(rect[2]))), sorted((float(rect[1]), float(rect[3])))
            box = (xs[0], ys[0], xs[1], ys[1])
        except (TypeError, ValueError, IndexError):
            box = None
        if box is not None and str(a.get("/Subtype", "")) not in ("/Popup", "/Redact") and _touches(box, areas):
            gone_ids.add(getattr(ref, "idnum", -1))
            if a.get("/Subtype") == "/Widget":
                widgets.add(getattr(ref, "idnum", -1))
            report["comments"] += 1
            continue
        keep.append(ref)
    final = ArrayObject()
    for ref in keep:
        a = ref.get_object()
        parent = a.raw_get("/Parent") if "/Parent" in a else None
        irt = a.raw_get("/IRT") if "/IRT" in a else None
        if getattr(parent, "idnum", None) in gone_ids or getattr(irt, "idnum", None) in gone_ids:
            continue
        final.append(ref)
    page[NameObject("/Annots")] = final
    return widgets


def _strip_items(page, areas) -> int:
    import json

    from .items import KEY

    res = page.get("/Resources")
    xo = res.get_object().get("/XObject") if res is not None else None
    stripped = 0
    if xo is None:
        return 0
    for name, ref in xo.get_object().items():
        obj = ref.get_object()
        if not str(name).startswith("/FpI_") or KEY not in obj:
            continue
        try:
            it = json.loads(str(obj[KEY]))
            x0, y0, x1, y1 = frame.to_pdf(page, float(it["x"]), float(it["y"]), float(it["w"]), float(it["h"]))
            box = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        except (ValueError, KeyError, TypeError):
            box = None
        if box is None or _touches(box, areas) or abs(float(it.get("rot", 0) or 0)) > 0.01:
            del obj[KEY]
            stripped += 1
    return stripped


def _verify(w: PdfWriter, n: int, areas, cleared: set[str]) -> str | None:
    page = w.pages[n - 1]
    content = interp.walk(page, w)
    for g in content.glyphs:
        if _covers(g.box, areas) and g.text.strip():
            return f"text is still under a redaction on page {n}"
    for d in content.draws:
        if d.kind in ("image", "inline") and _touches(d.box, areas) and d.name not in cleared:
            return f"a picture is still under a redaction on page {n}"
    return None


@core.serial
def _render_check(data: bytes, n: int, page_box, areas) -> str | None:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(data)
    try:
        pg = doc[n - 1]
        scale = 2.0
        pil = core.render_pil(pg, scale).convert("RGB")
        x0, _, _, y1 = page_box
        for ax0, ay0, ax1, ay1 in areas:
            l, t = int((ax0 - x0) * scale) + 2, int((y1 - ay1) * scale) + 2
            r, b = int((ax1 - x0) * scale) - 2, int((y1 - ay0) * scale) - 2
            if r - l < 2 or b - t < 2:
                continue
            region = pil.crop((max(0, l), max(0, t), min(pil.width, r), min(pil.height, b)))
            lo, hi = region.convert("L").getextrema()
            if hi - lo > 8:
                return f"something still shows inside a redaction on page {n}"
    finally:
        doc.close()
    return None


def apply(src, out, areas: list[dict], *, passwords: list[str] | None = None, color: str = "#000000", overlay: str = "", marks: bool = True) -> int:
    from .edit import _scrub_fields

    w = PdfWriter(clone_from=core.reader(src, passwords))
    n_pages = len(w.pages)
    by_page: dict[int, list] = {}
    looks: dict[int, list] = {}
    fill = _rgb(color)
    for a in areas or []:
        try:
            p = int(a["page"])
            box = annot._rect(a)
        except (KeyError, TypeError, ValueError):
            raise ValueError("Each redaction needs a page and a box") from None
        if not 1 <= p <= n_pages:
            raise ValueError(f"Page {p} is out of range (1 to {n_pages})")
        if box[2] >= 0.5 and box[3] >= 0.5:
            by_page.setdefault(p, []).append(box)
            looks.setdefault(p, []).append((fill, str(overlay or "")))
    if marks:
        for pi, page in enumerate(w.pages):
            for ref in page.get("/Annots") or []:
                a = ref.get_object()
                if a.get("/Subtype") == "/Redact" and a.get("/Rect") is not None:
                    by_page.setdefault(pi + 1, []).append(tuple(frame.from_pdf(page, a["/Rect"])[k] for k in ("x", "y", "w", "h")))
                    ic = a.get("/IC")
                    mark_fill = tuple(float(c) for c in ic)[:3] if ic is not None and len(ic) >= 3 else fill
                    looks.setdefault(pi + 1, []).append((mark_fill, str(a.get("/OverlayText") or overlay or "")))
    if not by_page:
        raise ValueError("Mark at least one area to redact")
    report = {"glyphs": 0, "pictures": 0, "shapes": 0, "comments": 0, "cleared": set()}
    widgets: set[int] = set()
    overlays: dict[int, list] = {}
    for p, boxes in sorted(by_page.items()):
        page = w.pages[p - 1]
        areas_pdf = _page_areas(page, boxes)
        content = interp.walk(page, w)
        edited: dict[tuple, str] = {}
        for where in sorted(content.streams, key=len, reverse=True):
            if where == ():
                continue
            st = content.streams[where]
            new_ops = _rewrite(w, content, where, areas_pdf, fill, edited, report)
            if new_ops is not st.operations:
                parent = content.streams.get(where[:-1])
                if parent is None:
                    continue
                name = streams.replace_form(w, page.get("/Resources"), st, new_ops, parent.resources)
                edited[where] = name
                form = parent.resources.get("/XObject").get_object()[NameObject(name)].get_object()
                if "/Resources" in form:
                    form[NameObject("/Resources")] = _pruned(form["/Resources"], new_ops)
        top = _rewrite(w, content, (), areas_pdf, fill, edited, report)
        pre, post = _clip_out(page, areas_pdf)
        streams.write_page(page, w, pre + list(top) + post)
        if "/Resources" in page:
            page[NameObject("/Resources")] = _pruned(page["/Resources"], top)
        _strip_items(page, areas_pdf)
        widgets |= _annots(w, page, areas_pdf, report)
        problem = _verify(w, p, areas_pdf, report["cleared"])
        if problem:
            raise ValueError(f"Redaction stopped: {problem}. Nothing was changed.")
        overlays[p] = areas_pdf
    _scrub_fields(w, widgets)
    for k in ("/Redact",):
        for page in w.pages:
            arr = page.get("/Annots")
            if arr is not None:
                page[NameObject("/Annots")] = ArrayObject(r for r in arr.get_object() if r.get_object().get("/Subtype") != k)
    buf = io.BytesIO()
    w.write(buf)
    for p, areas_pdf in overlays.items():
        problem = _render_check(buf.getvalue(), p, core.view_box(w.pages[p - 1]), areas_pdf)
        if problem:
            raise ValueError(f"Redaction stopped: {problem}. Nothing was changed.")
    for p, areas_pdf in overlays.items():
        page = w.pages[p - 1]
        ops = interp.page_operations(page, w)
        streams.write_page(page, w, list(ops) + _overlay(w, page, areas_pdf, looks[p]))
    try:
        w.compress_identical_objects(remove_identicals=False, remove_orphans=True)
    except Exception:
        pass
    with open(out, "wb") as fh:
        w.write(fh)
    apply.last = report
    return n_pages


def mark(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    areas = (args or {}).get("areas") or []
    if not areas:
        raise ValueError("mark_redactions needs areas: [{page, x, y, w, h}]")
    w = PdfWriter(clone_from=core.reader(src, passwords))
    color = _rgb((args or {}).get("color") or "#000000")
    text = str((args or {}).get("overlay") or "")[:120]
    added = 0
    for a in areas:
        p = int(a.get("page") or 0)
        if not 1 <= p <= len(w.pages):
            raise ValueError(f"Page {a.get('page')} is out of range")
        page = w.pages[p - 1]
        x0, y0, x1, y1 = frame.to_pdf(page, *frame.box(a))
        d = DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Redact"),
            NameObject("/Rect"): ArrayObject([FloatObject(round(v, 3)) for v in (x0, y0, x1, y1)]),
            NameObject("/QuadPoints"): ArrayObject([FloatObject(round(v, 3)) for v in (x0, y1, x1, y1, x0, y0, x1, y0)]),
            NameObject("/IC"): ArrayObject([FloatObject(v) for v in color]), NameObject("/C"): ArrayObject([FloatObject(1), FloatObject(0), FloatObject(0)]),
            NameObject("/F"): NumberObject(4), NameObject("/Contents"): TextStringObject(text or "Marked for redaction"),
        })
        if text:
            d[NameObject("/OverlayText")] = TextStringObject(text)
        w.add_annotation(p - 1, d)
        added += 1
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "added": added}


actions.register(actions.Action("mark_redactions", "change", "Mark for redaction", "marked", ("mark redactions", "redaction marks"),
                                run=mark))
