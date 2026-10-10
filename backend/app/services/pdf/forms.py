import re

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject,
                           TextStringObject)
from reportlab.pdfbase.pdfmetrics import stringWidth

from . import core, edit

TYPES = ("text", "multiline", "checkbox", "radio", "dropdown", "listbox", "date", "signature")
DATE_FORMATS = ("dd/mm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd", "d mmmm yyyy", "mmm d, yyyy")
NAME_RE = re.compile(r"^[^.\x00-\x1f]{1,120}$")
BORDER = (0.55, 0.55, 0.6)
MAX_FIELDS = 500


def _arr(vals) -> ArrayObject:
    return ArrayObject([FloatObject(round(float(v), 4)) for v in vals])


def _pdfstr(s: str) -> bytes:
    raw = str(s).encode("cp1252", "replace")
    return b"(" + raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)").replace(b"\r", b"").replace(b"\n", b" ") + b")"


def _num(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".") or "0"


def _fonts(w: PdfWriter) -> tuple:
    root = w._root_object
    form = root.get("/AcroForm")
    if form is None:
        form = DictionaryObject({NameObject("/Fields"): ArrayObject()})
        root[NameObject("/AcroForm")] = w._add_object(form)
    form = form.get_object()
    if "/Fields" not in form:
        form[NameObject("/Fields")] = ArrayObject()
    dr = form.get("/DR")
    dr = dr.get_object() if dr is not None else DictionaryObject()
    form[NameObject("/DR")] = dr
    fonts = dr.get("/Font")
    fonts = fonts.get_object() if fonts is not None else DictionaryObject()
    dr[NameObject("/Font")] = fonts
    if "/Helv" not in fonts:
        fonts[NameObject("/Helv")] = w._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"), NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
            NameObject("/Name"): NameObject("/Helv")}))
    if "/ZaDb" not in fonts:
        fonts[NameObject("/ZaDb")] = w._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/ZapfDingbats"), NameObject("/Name"): NameObject("/ZaDb")}))
    if "/DA" not in form:
        form[NameObject("/DA")] = TextStringObject("/Helv 0 Tf 0 g")
    form[NameObject("/NeedAppearances")] = BooleanObject(True)
    return form, fonts["/Helv"], fonts["/ZaDb"]


def _matrix(rot: int, w: float, h: float) -> tuple[list[float], float, float]:
    if rot == 90:
        return [0, 1, -1, 0, w, 0], h, w
    if rot == 180:
        return [-1, 0, 0, -1, w, h], w, h
    if rot == 270:
        return [0, -1, 1, 0, 0, h], h, w
    return [1, 0, 0, 1, 0, 0], w, h


def _xobj(w: PdfWriter, body: bytes, bw: float, bh: float, matrix: list[float], helv, zadb):
    s = DecodedStreamObject()
    s.set_data(body)
    s.update({
        NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"), NameObject("/FormType"): NumberObject(1),
        NameObject("/BBox"): _arr([0, 0, bw, bh]), NameObject("/Matrix"): _arr(matrix),
        NameObject("/Resources"): DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/Helv"): helv, NameObject("/ZaDb"): zadb})}),
    })
    return w._add_object(s)


def _frame(bw: float, bh: float, fill: bool = False) -> bytes:
    out = b"q "
    if fill:
        out += b"1 1 1 rg 0 0 " + f"{_num(bw)} {_num(bh)}".encode() + b" re f "
    out += f"{BORDER[0]} {BORDER[1]} {BORDER[2]} RG 1 w 0.5 0.5 {_num(bw - 1)} {_num(bh - 1)} re S Q\n".encode()
    return out


def _auto(size: float, bh: float, multiline: bool) -> float:
    if size and size > 0:
        return max(4.0, min(72.0, float(size)))
    return 10.0 if multiline else max(4.0, min(12.0, (bh - 3) * 0.72))


def _text_ap(value: str, bw: float, bh: float, size: float, align: int, multiline: bool) -> bytes:
    fs = _auto(size, bh, multiline)
    body = _frame(bw, bh)
    if not value:
        return body
    lines = [value]
    if multiline:
        from . import annot

        lines = annot.wrap(value, "Helvetica", fs, max(4.0, bw - 4))
    lead = fs * 1.15
    y = bh - 2 - fs * 0.9 if multiline else (bh - fs * 0.72) / 2
    out = [b"/Tx BMC q 1 1 " + f"{_num(bw - 2)} {_num(bh - 2)}".encode() + b" re W n BT /Helv " + _num(fs).encode() + b" Tf 0 g"]
    for line in lines:
        if y < -fs:
            break
        tw = stringWidth(line, "Helvetica", fs)
        x = 2.0 if align == 0 else (bw - tw) / 2 if align == 1 else bw - 2 - tw
        out.append(f"1 0 0 1 {_num(x)} {_num(y)} Tm ".encode() + _pdfstr(line) + b" Tj")
        y -= lead
    out.append(b"ET Q EMC\n")
    return body + b" ".join(out)


def _check_ap(on: bool, bw: float, bh: float) -> bytes:
    body = _frame(bw, bh, True)
    if not on:
        return body
    fs = min(bw, bh) * 0.8
    tw = stringWidth("4", "ZapfDingbats", fs)
    return body + f"q BT /ZaDb {_num(fs)} Tf 0 g {_num((bw - tw) / 2)} {_num((bh - fs * 0.7) / 2)} Td (4) Tj ET Q\n".encode()


def _circle(cx: float, cy: float, r: float) -> bytes:
    k = 0.5523 * r
    pts = [(cx + r, cy), (cx + r, cy + k, cx + k, cy + r, cx, cy + r), (cx - k, cy + r, cx - r, cy + k, cx - r, cy),
           (cx - r, cy - k, cx - k, cy - r, cx, cy - r), (cx + k, cy - r, cx + r, cy - k, cx + r, cy)]
    out = f"{_num(pts[0][0])} {_num(pts[0][1])} m ".encode()
    for p in pts[1:]:
        out += (" ".join(_num(v) for v in p) + " c ").encode()
    return out


def _radio_ap(on: bool, bw: float, bh: float) -> bytes:
    r = min(bw, bh) / 2 - 0.75
    cx, cy = bw / 2, bh / 2
    body = b"q 1 1 1 rg " + _circle(cx, cy, r) + b"f " + f"{BORDER[0]} {BORDER[1]} {BORDER[2]} RG 1 w ".encode() + _circle(cx, cy, r) + b"S Q\n"
    if on:
        body += b"q 0 g " + _circle(cx, cy, r * 0.45) + b"f Q\n"
    return body


def _list_ap(options: list[str], selected: str, bw: float, bh: float, size: float) -> bytes:
    fs = size if size and size > 0 else 10.0
    lead = fs * 1.2
    out = [_frame(bw, bh, True), b"/Tx BMC q 1 1 " + f"{_num(bw - 2)} {_num(bh - 2)}".encode() + b" re W n"]
    y = bh - 1
    for opt in options:
        if y - lead < -lead:
            break
        if opt == selected:
            out.append(f"0.6 0.75 0.9 rg 1 {_num(y - lead)} {_num(bw - 2)} {_num(lead)} re f".encode())
        out.append(b"BT /Helv " + _num(fs).encode() + b" Tf 0 g " + f"1 0 0 1 3 {_num(y - lead + fs * 0.28)} Tm ".encode() + _pdfstr(opt) + b" Tj ET")
        y -= lead
    out.append(b"Q EMC\n")
    return b" ".join(out)


def _flags(f: dict) -> int:
    v = (1 if f.get("readonly") else 0) | (2 if f.get("required") else 0)
    t = f["type"]
    if t == "multiline":
        v |= 1 << 12
    elif t == "radio":
        v |= (1 << 14) | (1 << 15)
    elif t == "dropdown":
        v |= 1 << 17
    return v


def _norm(f: dict, pages: int) -> dict:
    t = str(f.get("type") or "")
    if t not in TYPES:
        raise ValueError(f"Unknown field type {t!r}")
    name = str(f.get("name") or "").strip()
    if not NAME_RE.match(name):
        raise ValueError("Each field needs a name without dots, up to 120 characters")
    try:
        page = int(f.get("page"))
        x, y, w, h = (float(f[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"The field {name} needs a page and a box") from None
    if not 1 <= page <= pages:
        raise ValueError(f"Page {page} is out of range (1 to {pages})")
    if w < 4 or h < 4:
        raise ValueError(f"The field {name} is too small")
    opts = [str(o).strip()[:200] for o in (f.get("options") or []) if str(o).strip()][:200]
    if t in ("dropdown", "listbox") and not opts:
        raise ValueError(f"The {t} {name} needs at least one option")
    fmt = str(f.get("dateFormat") or "dd/mm/yyyy")
    if t == "date" and fmt not in DATE_FORMATS:
        raise ValueError(f"The date format is one of {', '.join(DATE_FORMATS)}")
    align = {"left": 0, "center": 1, "centre": 1, "right": 2}.get(str(f.get("align") or "left").lower(), 0)
    export = re.sub(r"[^A-Za-z0-9_-]+", "_", str(f.get("export") or "").strip())[:60] or "Choice"
    try:
        size = max(0.0, min(72.0, float(f.get("fontSize") or 0)))
    except (TypeError, ValueError):
        size = 0.0
    return {"type": t, "name": name, "page": page, "x": x, "y": y, "w": w, "h": h, "tooltip": str(f.get("tooltip") or "").strip()[:500],
            "required": bool(f.get("required")), "readonly": bool(f.get("readonly")), "value": str(f.get("value") or "")[:2000],
            "checked": bool(f.get("checked")), "options": opts, "dateFormat": fmt, "align": align, "export": export, "size": size}


def _widget(f: dict, page, geo, helv, zadb, w: PdfWriter) -> DictionaryObject:
    x0, y0, x1, y1, rot = geo
    rect = [x0 + f["x"], y1 - f["y"] - f["h"], x0 + f["x"] + f["w"], y1 - f["y"]]
    matrix, bw, bh = _matrix(rot, f["w"], f["h"])
    d = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"), NameObject("/Rect"): _arr(rect),
        NameObject("/F"): NumberObject(4), NameObject("/P"): page.indirect_reference,
    })
    mk = DictionaryObject({NameObject("/BC"): _arr(BORDER)})
    if rot:
        mk[NameObject("/R")] = NumberObject(rot)
    t = f["type"]
    if t in ("checkbox", "radio"):
        mk[NameObject("/BG")] = _arr([1, 1, 1])
        mk[NameObject("/CA")] = TextStringObject("4" if t == "checkbox" else "l")
        on = "Yes" if t == "checkbox" else f["export"]
        draw = _check_ap if t == "checkbox" else _radio_ap
        d[NameObject("/AP")] = DictionaryObject({NameObject("/N"): DictionaryObject({
            NameObject(f"/{on}"): _xobj(w, draw(True, bw, bh), bw, bh, matrix, helv, zadb),
            NameObject("/Off"): _xobj(w, draw(False, bw, bh), bw, bh, matrix, helv, zadb)})})
        state = f"/{on}" if (t == "checkbox" and f["checked"]) or (t == "radio" and f["checked"]) else "/Off"
        d[NameObject("/AS")] = NameObject(state)
        d[NameObject("/DA")] = TextStringObject("/ZaDb 0 Tf 0 g")
    elif t == "signature":
        d[NameObject("/AP")] = DictionaryObject({NameObject("/N"): _xobj(w, _frame(bw, bh), bw, bh, matrix, helv, zadb)})
    elif t == "listbox":
        d[NameObject("/AP")] = DictionaryObject({NameObject("/N"): _xobj(w, _list_ap(f["options"], f["value"], bw, bh, f["size"]), bw, bh, matrix, helv, zadb)})
        d[NameObject("/DA")] = TextStringObject(f"/Helv {_num(f['size'] or 10)} Tf 0 g")
    else:
        value = f["value"] if t != "dropdown" or f["value"] in f["options"] else ""
        d[NameObject("/AP")] = DictionaryObject({NameObject("/N"): _xobj(w, _text_ap(value, bw, bh, f["size"], f["align"], t == "multiline"), bw, bh, matrix, helv, zadb)})
        d[NameObject("/DA")] = TextStringObject(f"/Helv {_num(f['size'])} Tf 0 g")
        d[NameObject("/Q")] = NumberObject(f["align"])
    d[NameObject("/MK")] = mk
    return d


def _field_keys(d: DictionaryObject, f: dict) -> None:
    t = f["type"]
    d[NameObject("/T")] = TextStringObject(f["name"])
    if f["tooltip"] or t == "date":
        d[NameObject("/TU")] = TextStringObject(f["tooltip"] or f"Date ({f['dateFormat']})")
    ff = _flags(f)
    if ff:
        d[NameObject("/Ff")] = NumberObject(ff)
    if t in ("text", "multiline", "date"):
        d[NameObject("/FT")] = NameObject("/Tx")
        if f["value"]:
            d[NameObject("/V")] = TextStringObject(f["value"])
            d[NameObject("/DV")] = TextStringObject(f["value"])
        if t == "date":
            fmt = f["dateFormat"]
            d[NameObject("/AA")] = DictionaryObject({
                NameObject("/F"): DictionaryObject({NameObject("/S"): NameObject("/JavaScript"), NameObject("/JS"): TextStringObject(f'AFDate_FormatEx("{fmt}");')}),
                NameObject("/K"): DictionaryObject({NameObject("/S"): NameObject("/JavaScript"), NameObject("/JS"): TextStringObject(f'AFDate_KeystrokeEx("{fmt}");')}),
            })
    elif t == "checkbox":
        d[NameObject("/FT")] = NameObject("/Btn")
        v = NameObject("/Yes" if f["checked"] else "/Off")
        d[NameObject("/V")] = v
        d[NameObject("/DV")] = v
    elif t in ("dropdown", "listbox"):
        d[NameObject("/FT")] = NameObject("/Ch")
        d[NameObject("/Opt")] = ArrayObject([TextStringObject(o) for o in f["options"]])
        if f["value"] in f["options"]:
            d[NameObject("/V")] = TextStringObject(f["value"])
            d[NameObject("/DV")] = TextStringObject(f["value"])
    elif t == "signature":
        d[NameObject("/FT")] = NameObject("/Sig")


def _existing(w: PdfWriter) -> dict[str, list]:
    out: dict[str, list] = {}
    for page in w.pages:
        for ref in page.get("/Annots") or []:
            a = ref.get_object()
            if a.get("/Subtype") == "/Widget":
                out.setdefault(edit._name(a), []).append(ref)
    return out


def _holder(widget):
    node = widget.get_object()
    while node is not None:
        if "/T" in node:
            return node
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
    return None


def prepare(src, out, *, create: list[dict] | None = None, rename: dict | None = None, delete: list[str] | None = None,
            passwords: list[str] | None = None) -> dict:
    create = list(create or [])
    rename = {str(k): str(v).strip() for k, v in (rename or {}).items() if str(k) != str(v).strip()}
    delete = [str(d) for d in (delete or [])]
    if not create and not rename and not delete:
        raise ValueError("There are no form changes to apply")
    if len(create) > MAX_FIELDS:
        raise ValueError(f"Add at most {MAX_FIELDS} fields at a time")
    w = PdfWriter(clone_from=core.reader(src, passwords))
    have = _existing(w)
    gone = {n for n in have if any(n == d or n.startswith(d + ".") for d in delete)}
    if delete:
        missing = [d for d in delete if not any(n == d or n.startswith(d + ".") for n in have)]
        if missing:
            raise ValueError(f"There is no field called {missing[0]}")
        ids = {getattr(r, "idnum", None) for n in gone for r in have[n]}
        for page in w.pages:
            arr = page.get("/Annots")
            if arr is None:
                continue
            arr = arr.get_object()
            kept = ArrayObject([r for r in arr if getattr(r, "idnum", None) not in ids])
            if len(kept) != len(arr):
                page[NameObject("/Annots")] = kept
        edit._scrub_fields(w, ids)
    names = {n for n in have if n not in gone}
    for old, new in rename.items():
        if old not in names:
            raise ValueError(f"There is no field called {old}")
        if not NAME_RE.match(new):
            raise ValueError("Field names cannot be empty or contain dots")
        prefix = old.rsplit(".", 1)[0] + "." if "." in old else ""
        full = prefix + new
        if full in names:
            raise ValueError(f"A field called {full} already exists")
        node = _holder(have[old][0])
        if node is None:
            raise ValueError(f"The field {old} cannot be renamed")
        node[NameObject("/T")] = TextStringObject(new)
        names.discard(old)
        names.add(full)
    made = 0
    if create:
        form, helv, zadb = _fonts(w)
        fields = form["/Fields"]
        items = [_norm(f, len(w.pages)) for f in create]
        groups: dict[str, list[dict]] = {}
        for f in items:
            if f["type"] == "radio":
                groups.setdefault(f["name"], []).append(f)
            elif f["name"] in names:
                raise ValueError(f"A field called {f['name']} already exists")
            else:
                names.add(f["name"])
        for g in groups:
            if g in names:
                raise ValueError(f"A field called {g} already exists")
            names.add(g)
        geo = []
        for page in w.pages:
            x0, y0, x1, y1 = core.view_box(page)
            geo.append((x0, y0, x1, y1, core.rotation(page)))
        for f in items:
            if f["type"] == "radio":
                continue
            page = w.pages[f["page"] - 1]
            d = _widget(f, page, geo[f["page"] - 1], helv, zadb, w)
            _field_keys(d, f)
            added = w.add_annotation(f["page"] - 1, d)
            fields.append(added.indirect_reference)
            made += 1
        for gname, kids in groups.items():
            used: set[str] = set()
            for k in kids:
                base, n = k["export"], 1
                while k["export"] in used:
                    n += 1
                    k["export"] = f"{base}{n}"
                used.add(k["export"])
            on = next((k["export"] for k in kids if k["checked"]), None)
            parent = DictionaryObject({NameObject("/FT"): NameObject("/Btn"), NameObject("/T"): TextStringObject(gname),
                                       NameObject("/Ff"): NumberObject(_flags(kids[0])), NameObject("/V"): NameObject(f"/{on}" if on else "/Off"),
                                       NameObject("/Kids"): ArrayObject()})
            if on:
                parent[NameObject("/DV")] = NameObject(f"/{on}")
            tip = next((k["tooltip"] for k in kids if k["tooltip"]), "")
            if tip:
                parent[NameObject("/TU")] = TextStringObject(tip)
            pref = w._add_object(parent)
            for k in kids:
                k["checked"] = k["export"] == on
                page = w.pages[k["page"] - 1]
                d = _widget(k, page, geo[k["page"] - 1], helv, zadb, w)
                d[NameObject("/Parent")] = pref
                added = w.add_annotation(k["page"] - 1, d)
                parent["/Kids"].append(added.indirect_reference)
                made += 1
            fields.append(pref)
    elif rename and "/AcroForm" in w._root_object:
        w._root_object["/AcroForm"].get_object()[NameObject("/NeedAppearances")] = BooleanObject(True)
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "created": made, "renamed": len(rename), "deleted": len(gone)}
