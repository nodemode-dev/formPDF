import datetime
import html
import re
import uuid
from pathlib import Path

from pypdf import PdfWriter
from pypdf._codecs import adobe_glyphs
from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, DecodedStreamObject, DictionaryObject, FloatObject, IndirectObject,
                           NameObject, NumberObject, StreamObject, TextStringObject)

from app.core import config

from . import actions, colour, core
from .content.fonts import FontInfo

LEVELS = {"2b": (2, "B"), "2u": (2, "U"), "3b": (3, "B")}
STANDARD_BM = {"/Normal", "/Compatible", "/Multiply", "/Screen", "/Overlay", "/Darken", "/Lighten", "/ColorDodge", "/ColorBurn", "/HardLight",
               "/SoftLight", "/Difference", "/Exclusion", "/Hue", "/Saturation", "/Color", "/Luminosity"}
BAD_ANNOTS = {"/Sound", "/Movie", "/Screen", "/3D", "/RichMedia", "/TrapNet"}
BAD_ACTIONS = {"/Launch", "/Sound", "/Movie", "/ResetForm", "/ImportData", "/JavaScript", "/Hide", "/SetOCGState", "/Rendition", "/Trans",
               "/GoTo3DView", "/RichMediaExecute", "/GoToE"}
NAMED_OK = {"/NextPage", "/PrevPage", "/FirstPage", "/LastPage"}
BASE14 = {"Helvetica": ("Sans", False, False), "Helvetica-Bold": ("Sans", True, False), "Helvetica-Oblique": ("Sans", False, True),
          "Helvetica-BoldOblique": ("Sans", True, True), "Times-Roman": ("Serif", False, False), "Times-Bold": ("Serif", True, False),
          "Times-Italic": ("Serif", False, True), "Times-BoldItalic": ("Serif", True, True), "Courier": ("Mono", False, False),
          "Courier-Bold": ("Mono", True, False), "Courier-Oblique": ("Mono", False, True), "Courier-BoldOblique": ("Mono", True, True)}
NO_SUBSTITUTE = ("Symbol", "ZapfDingbats", "Wingdings", "Webdings", "Dingbats")
STYLE = {(False, False): "Regular", (True, False): "Bold", (False, True): "Italic", (True, True): "BoldItalic"}
_NAME_OF = {}


def _o(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _glyph_name(ch: str) -> str | None:
    if not _NAME_OF:
        from reportlab.pdfbase import _fontdata

        for enc in ("WinAnsiEncoding", "StandardEncoding", "MacRomanEncoding", "PDFDocEncoding"):
            for name in _fontdata.encodings[enc]:
                u = adobe_glyphs.get("/" + name) if name else None
                if u and len(u) == 1 and u not in _NAME_OF:
                    _NAME_OF[u] = name
    return _NAME_OF.get(ch)


class Issues:
    def __init__(self):
        self.items: dict[str, dict] = {}

    def add(self, key: str, clause: str, text: str, page: int | None = None, fix: bool = True) -> None:
        it = self.items.setdefault(key, {"clause": clause, "text": text, "pages": set(), "fix": fix, "count": 0})
        it["count"] += 1
        if page is not None:
            it["pages"].add(page + 1)

    def out(self) -> list[dict]:
        rows = []
        for k, v in sorted(self.items.items(), key=lambda kv: [int(x) if x.isdigit() else 0 for x in kv[1]["clause"].split(".")]):
            pages = sorted(v["pages"])
            rows.append({"id": k, "clause": v["clause"], "text": v["text"], "pages": pages[:200], "count": v["count"], "fixable": v["fix"]})
        return rows


def walk(doc):
    """Every resource dictionary, XObject and annotation, page by page. A generator, and on a large file read lazily the
    reader's object cache is dropped after each page, so a file of big pictures is never held in memory at once."""
    seen: set = set()

    def res(r, pi, depth=0):
        r = _o(r)
        if not isinstance(r, DictionaryObject) or id(r) in seen or depth > 16:
            return
        seen.add(id(r))
        yield ("res", pi, r)
        for _n, xo in (_o(r.get("/XObject")) or {}).items():
            x = _o(xo)
            if isinstance(x, StreamObject) and id(x) not in seen:
                seen.add(id(x))
                yield ("xobject", pi, x)
                if x.get("/Subtype") == "/Form":
                    yield from res(x.get("/Resources"), pi, depth + 1)
        for _n, pat in (_o(r.get("/Pattern")) or {}).items():
            p = _o(pat)
            if isinstance(p, DictionaryObject) and p.get("/Resources") is not None:
                yield from res(p.get("/Resources"), pi, depth + 1)
        for _n, f in (_o(r.get("/Font")) or {}).items():
            fo = _o(f)
            if isinstance(fo, DictionaryObject) and fo.get("/Subtype") == "/Type3" and fo.get("/Resources") is not None:
                yield from res(fo.get("/Resources"), pi, depth + 1)

    for pi, page in enumerate(doc.pages):
        yield from res(page.get("/Resources"), pi)
        for ref in _o(page.get("/Annots")) or []:
            a = _o(ref)
            if not isinstance(a, DictionaryObject):
                continue
            yield ("annot", pi, a)
            ap = _o(a.get("/AP"))
            if isinstance(ap, DictionaryObject):
                for key in ap:
                    v = _o(ap[key])
                    streams = [v] if isinstance(v, StreamObject) else [_o(x) for x in v.values()] if isinstance(v, DictionaryObject) else []
                    for s in streams:
                        if isinstance(s, StreamObject) and id(s) not in seen:
                            seen.add(id(s))
                            yield ("xobject", pi, s)
                            yield from res(s.get("/Resources"), pi)
        core.lean(doc)
    root = doc.trailer["/Root"] if hasattr(doc, "trailer") else doc._root_object
    form = _o(root.get("/AcroForm"))
    if isinstance(form, DictionaryObject):
        yield from res(form.get("/DR"), None)


def fonts(doc) -> list[tuple]:
    found, seen = [], set()
    for kind, pi, r in walk(doc):
        if kind != "res":
            continue
        for _n, ref in (_o(r.get("/Font")) or {}).items():
            f = _o(ref)
            if not isinstance(f, DictionaryObject) or id(f) in seen:
                continue
            seen.add(id(f))
            found.append((pi, ref, f))
    return found


def _desc(f):
    if f.get("/Subtype") == "/Type0":
        kids = _o(f.get("/DescendantFonts")) or []
        d = _o(_o(kids[0]).get("/FontDescriptor")) if kids else None
    else:
        d = _o(f.get("/FontDescriptor"))
    return d if isinstance(d, DictionaryObject) else None


def embedded(f) -> bool:
    if f.get("/Subtype") == "/Type3":
        return True
    d = _desc(f)
    return bool(d is not None and any(k in d for k in ("/FontFile", "/FontFile2", "/FontFile3")))


def _base(f) -> str:
    name = str(f.get("/BaseFont") or "").lstrip("/")
    return re.sub(r"^[A-Z]{6}\+", "", name)


def substitute(f) -> tuple[str, bool, bool] | None:
    if f.get("/Subtype") not in ("/Type1", "/TrueType", "/MMType1"):
        return None
    name = _base(f)
    if any(s.lower() in name.lower() for s in NO_SUBSTITUTE):
        return None
    if name in BASE14:
        return BASE14[name]
    d = _desc(f)
    flags = int(_o(d.get("/Flags", 0))) if d is not None else 0
    low = name.lower().replace(" ", "")
    if d is not None and flags & 4 and not (flags & 32) and "/Encoding" not in f:
        return None
    fam = "Mono" if flags & 1 or any(k in low for k in ("courier", "mono", "consol")) else "Serif" if flags & 2 or any(
        k in low for k in ("times", "serif", "georgia", "garamond", "roman", "cambria", "book")) and "sans" not in low else "Sans"
    weight = int(_o(d.get("/FontWeight", 400))) if d is not None and d.get("/FontWeight") is not None else 400
    bold = "bold" in low or "black" in low or "heavy" in low or weight >= 600 or bool(flags & (1 << 18))
    italic = "italic" in low or "oblique" in low or bool(flags & 64)
    return fam, bold, italic


def _ttf(fam: str, bold: bool, italic: bool) -> Path:
    return config.fonts_dir() / f"Liberation{fam}-{STYLE[(bold, italic)]}.ttf"


def _embed(w: PdfWriter, f, sub: tuple) -> str:
    from reportlab.pdfbase.ttfonts import TTFontFile

    fam, bold, italic = sub
    path = _ttf(fam, bold, italic)
    if not path.is_file():
        raise ValueError(f"The bundled font {path.name} is missing; reinstall formpdf")
    tt = TTFontFile(str(path))
    info = FontInfo(f)
    base = _base(f)
    from pypdf._codecs import _win_encoding

    diffs = ArrayObject()
    run = None
    for code in range(256):
        want = info.to_uni.get(code)
        have = _win_encoding[code] if code < len(_win_encoding) else None
        if not want or len(want) != 1 or want == have:
            continue
        name = _glyph_name(want)
        if not name:
            continue
        if run != code - 1:
            diffs.append(NumberObject(code))
        diffs.append(NameObject("/" + name))
        run = code
    enc_obj = DictionaryObject({NameObject("/Type"): NameObject("/Encoding"), NameObject("/BaseEncoding"): NameObject("/WinAnsiEncoding")})
    if diffs:
        enc_obj[NameObject("/Differences")] = diffs
    f[NameObject("/Encoding")] = enc_obj
    info = FontInfo(f)
    first, last = 0, 255
    widths = ArrayObject()
    for code in range(first, last + 1):
        u = info.unicode(code)
        wv = tt.charWidths.get(ord(u)) if u and len(u) == 1 else None
        widths.append(FloatObject(round(wv, 2)) if wv is not None else NumberObject(0))
    data = path.read_bytes()
    prog = DecodedStreamObject()
    prog.set_data(data)
    prog[NameObject("/Length1")] = NumberObject(len(data))
    prog = prog.flate_encode()
    psname = tt.name.decode("latin-1") if isinstance(tt.name, bytes) else str(tt.name)
    psname = f"{psname}-{STYLE[(bold, italic)]}" if STYLE[(bold, italic)] != "Regular" and "-" not in psname else psname
    desc = DictionaryObject({NameObject("/Type"): NameObject("/FontDescriptor"), NameObject("/FontName"): NameObject("/" + psname),
                             NameObject("/Flags"): NumberObject(32 | (64 if italic else 0)),
                             NameObject("/FontBBox"): ArrayObject(FloatObject(round(v, 2)) for v in tt.bbox),
                             NameObject("/ItalicAngle"): FloatObject(tt.italicAngle), NameObject("/Ascent"): FloatObject(round(tt.ascent, 2)),
                             NameObject("/Descent"): FloatObject(round(tt.descent, 2)), NameObject("/CapHeight"): FloatObject(round(tt.capHeight, 2)),
                             NameObject("/StemV"): NumberObject(int(tt.stemV)), NameObject("/FontFile2"): w._add_object(prog)})
    f[NameObject("/Subtype")] = NameObject("/TrueType")
    f[NameObject("/BaseFont")] = NameObject("/" + psname)
    f[NameObject("/FirstChar")] = NumberObject(first)
    f[NameObject("/LastChar")] = NumberObject(last)
    f[NameObject("/Widths")] = widths
    f[NameObject("/FontDescriptor")] = w._add_object(desc)
    return f"{base} as Liberation {fam} {STYLE[(bold, italic)]}"


def _tounicode(w: PdfWriter, f) -> bool:
    info = FontInfo(f)
    pairs = [(c, u) for c, u in sorted(info.to_uni.items()) if u and 0 <= c <= 0xFFFF]
    if not pairs:
        return False
    two = bool(info.two_byte)
    width = 4 if two else 2
    lines = []
    for i in range(0, len(pairs), 100):
        chunk = pairs[i:i + 100]
        lines.append(f"{len(chunk)} beginbfchar")
        for c, u in chunk:
            hexu = "".join(f"{ord(ch):04X}" if ord(ch) < 0x10000 else
                           f"{0xD800 + ((ord(ch) - 0x10000) >> 10):04X}{0xDC00 + ((ord(ch) - 0x10000) & 0x3FF):04X}" for ch in u)
            lines.append(f"<{c:0{width}X}> <{hexu}>")
        lines.append("endbfchar")
    body = ("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
            "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n"
            f"<{'0' * width}> <{'F' * width}>\nendcodespacerange\n" + "\n".join(lines) + "\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n")
    s = DecodedStreamObject()
    s.set_data(body.encode())
    f[NameObject("/ToUnicode")] = w._add_object(s.flate_encode())
    return True


def _tu_gap(f) -> bool:
    from .content.fonts import parse_cmap

    tu = _o(f.get("/ToUnicode"))
    if not isinstance(tu, StreamObject):
        return False
    try:
        have = parse_cmap(tu.get_data())[1]
    except Exception:
        return False
    return any(u and c not in have for c, u in FontInfo(f).to_uni.items())


def _action_bad(a) -> bool:
    a = _o(a)
    if not isinstance(a, DictionaryObject):
        return False
    s = a.get("/S")
    if s in BAD_ACTIONS or s == "/Named" and a.get("/N") not in NAMED_OK:
        return True
    nxt = _o(a.get("/Next"))
    items = nxt if isinstance(nxt, ArrayObject) else [nxt] if nxt is not None else []
    return any(_action_bad(x) for x in items)


def _pdf_date(v) -> datetime.datetime | None:
    m = re.match(r"D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+\-])?(\d{2})?'?(\d{2})?", str(v or ""))
    if not m:
        return None
    y, mo, d, hh, mi, ss = (int(x) if x else dflt for x, dflt in zip(m.groups()[:6], (0, 1, 1, 0, 0, 0)))
    try:
        tz = datetime.timezone.utc
        if m.group(7) in ("+", "-"):
            off = datetime.timedelta(hours=int(m.group(8) or 0), minutes=int(m.group(9) or 0))
            tz = datetime.timezone(off if m.group(7) == "+" else -off)
        return datetime.datetime(y, mo, d, hh, mi, ss, tzinfo=tz)
    except ValueError:
        return None


def _iso(dt: datetime.datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _pdfd(dt: datetime.datetime) -> str:
    off = dt.utcoffset() or datetime.timedelta(0)
    mins = int(off.total_seconds() // 60)
    sign = "+" if mins >= 0 else "-"
    return dt.strftime("D:%Y%m%d%H%M%S") + f"{sign}{abs(mins) // 60:02d}'{abs(mins) % 60:02d}'"


def _xmp(meta: dict, part: int | None, conf: str | None, pdfx: str | None = None) -> bytes:
    e = html.escape
    rows = []
    if meta.get("title"):
        rows.append(f'<dc:title><rdf:Alt><rdf:li xml:lang="x-default">{e(meta["title"])}</rdf:li></rdf:Alt></dc:title>')
    if meta.get("author"):
        rows.append(f'<dc:creator><rdf:Seq><rdf:li>{e(meta["author"])}</rdf:li></rdf:Seq></dc:creator>')
    if meta.get("subject"):
        rows.append(f'<dc:description><rdf:Alt><rdf:li xml:lang="x-default">{e(meta["subject"])}</rdf:li></rdf:Alt></dc:description>')
    rows.append("<dc:format>application/pdf</dc:format>")
    rows.append(f"<xmp:CreateDate>{meta['created']}</xmp:CreateDate><xmp:ModifyDate>{meta['modified']}</xmp:ModifyDate><xmp:MetadataDate>{meta['modified']}</xmp:MetadataDate>")
    if meta.get("creator"):
        rows.append(f"<xmp:CreatorTool>{e(meta['creator'])}</xmp:CreatorTool>")
    rows.append(f"<pdf:Producer>{e(meta['producer'])}</pdf:Producer>")
    if meta.get("keywords"):
        rows.append(f"<pdf:Keywords>{e(meta['keywords'])}</pdf:Keywords>")
    if part:
        rows.append(f"<pdfaid:part>{part}</pdfaid:part><pdfaid:conformance>{conf}</pdfaid:conformance>")
    if pdfx:
        rows.append(f"<pdfxid:GTS_PDFXVersion>{pdfx}</pdfxid:GTS_PDFXVersion>")
    rows.append(f"<xmpMM:DocumentID>uuid:{meta['doc']}</xmpMM:DocumentID><xmpMM:InstanceID>uuid:{uuid.uuid4()}</xmpMM:InstanceID>")
    body = ("<?xpacket begin=\"﻿\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n"
            "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n<rdf:Description rdf:about=\"\" "
            "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\" "
            "xmlns:xmpMM=\"http://ns.adobe.com/xap/1.0/mm/\" xmlns:pdfaid=\"http://www.aiim.org/pdfa/ns/id/\" xmlns:pdfxid=\"http://www.npes.org/pdfx/ns/id/\">\n"
            + "\n".join(rows) + "\n</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n" + (" " * 100 + "\n") * 20 + "<?xpacket end=\"w\"?>")
    return body.encode("utf-8")


def _xmp_part(root) -> tuple[str, str, str]:
    m = _o(root.get("/Metadata"))
    if not isinstance(m, StreamObject):
        return "", "", ""
    try:
        t = m.get_data().decode("utf-8", "replace")
    except Exception:
        return "", "", ""
    part = re.search(r"pdfaid:part(?:>|=\")\s*(\d)", t)
    conf = re.search(r"pdfaid:conformance(?:>|=\")\s*([ABUabu])", t)
    x = re.search(r"GTS_PDFXVersion(?:>|=\")\s*([^<\"]+)", t)
    return (part.group(1) if part else ""), (conf.group(1).upper() if conf else ""), (x.group(1).strip() if x else "")


def _uses_device_colour(doc) -> tuple[set, dict]:
    c = colour.scan(doc)
    return set(c.used), {k: sorted(v) for k, v in c.where.items()}


def check_doc(doc, level: str, raw: bytes | None = None, encrypted: bool = False) -> list[dict]:
    part, conf = LEVELS[level]
    iss = Issues()
    root = doc.trailer["/Root"] if hasattr(doc, "trailer") else doc._root_object
    if raw is not None:
        head = raw[:16]
        if not head.startswith(b"%PDF-1.") or (part >= 2 and head[5:8] > b"1.7"):
            iss.add("header", "6.1.2", "The file header is not %PDF-1.x")
        if b"%PDF" in raw[:8] and not re.match(rb"%PDF-1\.\d\r?\n?%[\x80-\xff]{4}", raw[:20]):
            iss.add("binary", "6.1.2", "The header is not followed by a comment with four binary characters")
        tail = raw[-2048:]
        if b"/ID" not in tail and b"/ID" not in raw[-65536:]:
            iss.add("id", "6.1.3", "The trailer has no file identifier (ID)")
    if encrypted:
        iss.add("encrypt", "6.1.3", "The file is encrypted")
    have_part, have_conf, _x = _xmp_part(root)
    if have_part != str(part) or have_conf != conf:
        iss.add("xmp", "6.6.2.1", f"The metadata does not identify the file as PDF/A-{part}{conf.lower()}")
    names = _o(root.get("/Names"))
    if isinstance(names, DictionaryObject) and names.get("/JavaScript") is not None:
        iss.add("js", "6.6.1", "The document has JavaScript")
    if root.get("/AA") is not None:
        iss.add("aa", "6.6.2", "The catalogue has additional actions")
    if root.get("/OpenAction") is not None and _action_bad(root.get("/OpenAction")):
        iss.add("open", "6.6.1", "The document runs a forbidden action when it opens")
    form = _o(root.get("/AcroForm"))
    if isinstance(form, DictionaryObject):
        if form.get("/NeedAppearances"):
            iss.add("needap", "6.4.1", "Form fields ask the reader to draw their own appearances (NeedAppearances)")
        if form.get("/XFA") is not None:
            iss.add("xfa", "6.4.2", "The form includes an XFA form")
    ef = _o(names.get("/EmbeddedFiles")) if isinstance(names, DictionaryObject) else None
    if ef is not None and part == 2:
        iss.add("embedded", "6.8", "The PDF has attached files, which PDF/A-2b and 2u allow only when they are PDF/A themselves")
    ocp = _o(root.get("/OCProperties"))
    if isinstance(ocp, DictionaryObject):
        configs = [_o(ocp.get("/D"))] + [_o(c) for c in (_o(ocp.get("/Configs")) or [])]
        for c in configs:
            if isinstance(c, DictionaryObject) and (c.get("/Name") is None or c.get("/AS") is not None):
                iss.add("oc", "6.9", "An optional content (layer) configuration has no name or has an AS entry")
    used, where = _uses_device_colour(doc)
    intents = [_o(x) for x in (_o(root.get("/OutputIntents")) or [])]
    pdfa_intent = next((x for x in intents if isinstance(x, DictionaryObject) and x.get("/S") == "/GTS_PDFA1"), None)
    intent_n = None
    if pdfa_intent is not None:
        prof = _o(pdfa_intent.get("/DestOutputProfile"))
        intent_n = int(_o(prof.get("/N"))) if isinstance(prof, StreamObject) and prof.get("/N") is not None else None
    device = used & {"rgb", "cmyk", "gray"}
    if device and pdfa_intent is None:
        for k in sorted(device):
            for p in where.get(k, []):
                iss.add("intent", "6.2.4.3", "Device colours are used but there is no PDF/A output intent", p - 1)
    if intent_n == 3 and "cmyk" in used:
        for p in where.get("cmyk", []):
            iss.add("cmyk", "6.2.4.3", "CMYK colour is used with an RGB output intent", p - 1)
    if intent_n == 4 and "rgb" in used:
        for p in where.get("rgb", []):
            iss.add("rgb", "6.2.4.3", "RGB colour is used with a CMYK output intent", p - 1)
    for kind, pi, obj in walk(doc):
        if kind == "res":
            for _n, gs in (_o(obj.get("/ExtGState")) or {}).items():
                g = _o(gs)
                if isinstance(g, DictionaryObject):
                    bm = _o(g.get("/BM"))
                    names_bm = list(bm) if isinstance(bm, ArrayObject) else [bm] if bm is not None else []
                    if any(str(_o(b)) not in STANDARD_BM for b in names_bm):
                        iss.add("bm", "6.2.10.6", "A non-standard blend mode is used", pi, fix=False)
                    if g.get("/TR") is not None or g.get("/TR2") not in (None, "/Default"):
                        iss.add("tr", "6.2.5", "A transfer function is used", pi)
        elif kind == "xobject":
            sub = obj.get("/Subtype")
            if obj.get("/Interpolate"):
                iss.add("interp", "6.2.8", "An image or form asks for interpolation", pi)
            if obj.get("/Alternates") is not None or obj.get("/OPI") is not None:
                iss.add("alternates", "6.2.8", "An image has alternates or OPI references", pi)
            if sub == "/PS" or obj.get("/Subtype2") == "/PS" or obj.get("/Ref") is not None:
                iss.add("psxo", "6.2.9", "A PostScript or reference XObject is used", pi)
            if obj.get("/F") is not None:
                iss.add("external", "6.1.7.1", "A stream refers to external file content", pi, fix=False)
            filt = _o(obj.get("/Filter"))
            if "/LZWDecode" in (list(map(str, filt)) if isinstance(filt, ArrayObject) else [str(filt)]):
                iss.add("lzw", "6.1.7.2", "A stream uses LZW compression", pi)
        elif kind == "annot":
            sub = obj.get("/Subtype")
            if sub in BAD_ANNOTS or (sub == "/FileAttachment" and part == 2):
                iss.add("annot_type", "6.3.1", f"{str(sub).lstrip('/')} annotations are not allowed", pi)
                continue
            flags = int(_o(obj.get("/F", 0)) or 0)
            if sub != "/Popup" and (not flags & 4 or flags & (1 | 2 | 32 | 256)):
                iss.add("annot_flags", "6.3.2", "An annotation is not set to print, or is hidden", pi)
            rect = [float(v) for v in obj.get("/Rect", [0, 0, 0, 0])]
            zero = abs(rect[2] - rect[0]) < 1e-6 and abs(rect[3] - rect[1]) < 1e-6
            if sub not in ("/Popup", "/Link") and not zero and not isinstance(_o(obj.get("/AP")), DictionaryObject):
                iss.add("annot_ap", "6.3.3", "An annotation has no appearance", pi)
            ap = _o(obj.get("/AP"))
            if isinstance(ap, DictionaryObject) and any(k != "/N" for k in ap.keys()) and sub != "/Widget":
                iss.add("annot_apkeys", "6.3.3", "An annotation appearance has rollover or down states", pi)
            if obj.get("/AA") is not None or (sub in ("/Link", "/Widget") and _action_bad(obj.get("/A"))):
                iss.add("annot_action", "6.6.1", "A link or field runs a forbidden action", pi)
    for pi, page in enumerate(doc.pages):
        if page.get("/AA") is not None:
            iss.add("page_aa", "6.6.2", "A page has additional actions", pi)
    for pi, _ref, f in fonts(doc):
        name = _base(f) or "unnamed"
        if not embedded(f):
            ok = substitute(f) is not None
            iss.add(f"font:{name}", "6.2.11.4.1", f"The font {name} is not embedded" + ("" if ok else "; formpdf has no matching font to embed"), pi, fix=ok)
        d = _desc(f)
        if d is not None and (d.get("/CIDSet") is not None or d.get("/CharSet") is not None):
            iss.add("cidset", "6.2.11.4.2", "A font lists its glyphs (CIDSet or CharSet), which must then be complete", pi)
        if conf == "U" and f.get("/ToUnicode") is None:
            fixable = bool(FontInfo(f).to_uni)
            iss.add(f"tounicode:{name}", "6.2.11.7.2", f"The font {name} has no ToUnicode map", pi, fix=fixable)
        elif conf == "U" and _tu_gap(f):
            iss.add(f"tounicode:{name}", "6.2.11.7.2", f"The ToUnicode map of the font {name} leaves out characters the font can name", pi)
    from .access import page_marks

    for pi, page in enumerate(doc.pages):
        try:
            m = page_marks(page, doc)
        except Exception:
            continue
        if conf == "U":
            for key, n in m.nouni.items():
                iss.add(f"nouni:{key}", "6.2.11.7.2", f"Characters in the font {key.lstrip('/')} have no text equivalent", pi, fix=False)
        for g in m.content.glyphs:
            fi = m.content.fonts.get("/" + g.font)
            if fi is None:
                continue
            notdef = fi.cid(g.code) == 0 if fi.type0 else g.code == 0 and not g.text
            if notdef:
                iss.add(f"notdef:{g.font}", "6.2.11.8", f"Text in the font {g.font} uses the .notdef glyph", pi, fix=False)
    return iss.out()


def check(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    level = str((args or {}).get("level") or "2b").lower()
    if level not in LEVELS:
        raise ValueError(f"level is one of {', '.join(LEVELS)}")
    r = core.reader(path, passwords)
    raw = Path(path).read_bytes()
    found = check_doc(r, level, raw, r.is_encrypted)
    claims = _xmp_part(r.trailer["/Root"])
    ok = not found
    lines = [f"PDF/A-{level}: " + ("conforms to the checks formpdf runs." if ok else f"{len(found)} kinds of problem, {sum(1 for x in found if x['fixable'])} fixable.")]
    lines += [f"{x['clause']} {x['text']}" + (f" (pages {', '.join(map(str, x['pages'][:10]))})" if x["pages"] else "") + ("" if x["fixable"] else " [cannot be fixed here]")
              for x in found]
    return "\n".join(lines), {"level": level, "conforms": ok, "issues": found, "claims": {"part": claims[0], "conformance": claims[1], "pdfx": claims[2]}}


def _srgb() -> bytes:
    from PIL import ImageCms

    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def _gen_ap(w: PdfWriter, a) -> None:
    x0, y0, x1, y1 = (float(v) for v in a.get("/Rect", [0, 0, 0, 0]))
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    sub = a.get("/Subtype")
    col = [float(v) for v in (_o(a.get("/C")) or [])]
    rgb = colour.to_rgb({1: "gray", 3: "rgb", 4: "cmyk"}.get(len(col), "rgb"), col) if col else (0.0, 0.0, 0.0)
    cs = f"{rgb[0]:.3f} {rgb[1]:.3f} {rgb[2]:.3f}"
    ops = []
    res = DictionaryObject()
    if sub in ("/Highlight", "/Underline", "/StrikeOut", "/Squiggly"):
        q = [float(v) for v in (_o(a.get("/QuadPoints")) or [])]
        for i in range(0, len(q) - 7, 8):
            xs, ys = q[i:i + 8:2], q[i + 1:i + 8:2]
            qx0, qx1, qy0, qy1 = min(xs), max(xs), min(ys), max(ys)
            if sub == "/Highlight":
                ops.append(f"{cs} rg {qx0:.2f} {qy0:.2f} {qx1 - qx0:.2f} {qy1 - qy0:.2f} re f")
            else:
                yy = qy0 + (qy1 - qy0) * (0.45 if sub == "/StrikeOut" else 0.08)
                ops.append(f"{cs} RG 1 w {qx0:.2f} {yy:.2f} m {qx1:.2f} {yy:.2f} l S")
        if sub == "/Highlight":
            res[NameObject("/ExtGState")] = DictionaryObject({NameObject("/M"): DictionaryObject({NameObject("/BM"): NameObject("/Multiply")})})
            ops.insert(0, "/M gs")
    elif sub in ("/Square", "/Circle"):
        bw = float(_o(_o(a.get("/BS") or DictionaryObject()).get("/W", 1)) or 1)
        ic = [float(v) for v in (_o(a.get("/IC")) or [])]
        fill = colour.to_rgb({1: "gray", 3: "rgb", 4: "cmyk"}.get(len(ic), "rgb"), ic) if ic else None
        rx0, ry0, rw, rh = x0 + bw / 2, y0 + bw / 2, max(0.1, x1 - x0 - bw), max(0.1, y1 - y0 - bw)
        if sub == "/Square":
            path = f"{rx0:.2f} {ry0:.2f} {rw:.2f} {rh:.2f} re"
        else:
            k = 0.5523
            cx, cy, ax, ay = rx0 + rw / 2, ry0 + rh / 2, rw / 2, rh / 2
            path = (f"{cx + ax:.2f} {cy:.2f} m {cx + ax:.2f} {cy + k * ay:.2f} {cx + k * ax:.2f} {cy + ay:.2f} {cx:.2f} {cy + ay:.2f} c "
                    f"{cx - k * ax:.2f} {cy + ay:.2f} {cx - ax:.2f} {cy + k * ay:.2f} {cx - ax:.2f} {cy:.2f} c "
                    f"{cx - ax:.2f} {cy - k * ay:.2f} {cx - k * ax:.2f} {cy - ay:.2f} {cx:.2f} {cy - ay:.2f} c "
                    f"{cx + k * ax:.2f} {cy - ay:.2f} {cx + ax:.2f} {cy - k * ay:.2f} {cx + ax:.2f} {cy:.2f} c h")
        ops.append(f"{bw:.2f} w {cs} RG" + (f" {fill[0]:.3f} {fill[1]:.3f} {fill[2]:.3f} rg {path} B" if fill else f" {path} S"))
    elif sub == "/Line":
        lx = [float(v) for v in (_o(a.get("/L")) or [x0, y0, x1, y1])]
        ops.append(f"1 w {cs} RG {lx[0]:.2f} {lx[1]:.2f} m {lx[2]:.2f} {lx[3]:.2f} l S")
    elif sub == "/Ink":
        for path in _o(a.get("/InkList")) or []:
            p = [float(v) for v in _o(path)]
            if len(p) >= 4:
                ops.append(f"1 w 1 J 1 j {cs} RG {p[0]:.2f} {p[1]:.2f} m " + " ".join(f"{p[i]:.2f} {p[i + 1]:.2f} l" for i in range(2, len(p) - 1, 2)) + " S")
    elif sub == "/Text":
        ops.append(f"{cs} rg 0 G 0.5 w {x0 + 1:.2f} {y1 - 17:.2f} 16 16 re B")
    s = DecodedStreamObject()
    s[NameObject("/Type")] = NameObject("/XObject")
    s[NameObject("/Subtype")] = NameObject("/Form")
    s[NameObject("/BBox")] = ArrayObject(FloatObject(v) for v in (x0, y0, x1, y1))
    s[NameObject("/Resources")] = res
    s.set_data(("q\n" + "\n".join(ops) + "\nQ\n").encode())
    a[NameObject("/AP")] = DictionaryObject({NameObject("/N"): w._add_object(s)})


def _strip_actions(node) -> None:
    node = _o(node)
    if not isinstance(node, DictionaryObject):
        return
    if "/AA" in node:
        del node["/AA"]
    if "/A" in node and _action_bad(node.get("/A")):
        del node["/A"]


def _meta(w: PdfWriter, src_info) -> dict:
    info = src_info or {}
    now = datetime.datetime.now().astimezone().replace(microsecond=0)
    created = _pdf_date(info.get("/CreationDate")) or now
    return {"title": str(info.get("/Title") or "") or None, "author": str(info.get("/Author") or "") or None,
            "subject": str(info.get("/Subject") or "") or None, "keywords": str(info.get("/Keywords") or "") or None,
            "creator": str(info.get("/Creator") or "") or None, "producer": "formpdf", "created": _iso(created), "modified": _iso(now),
            "created_pdf": _pdfd(created), "modified_pdf": _pdfd(now), "doc": uuid.uuid4()}


def _set_meta(w: PdfWriter, meta: dict, part, conf, pdfx: str | None = None, extra: dict | None = None) -> None:
    root = w._root_object
    xmp = DecodedStreamObject()
    xmp[NameObject("/Type")] = NameObject("/Metadata")
    xmp[NameObject("/Subtype")] = NameObject("/XML")
    xmp.set_data(_xmp(meta, part, conf, pdfx))
    root[NameObject("/Metadata")] = w._add_object(xmp)
    new = DictionaryObject()
    for key, k in (("/Title", "title"), ("/Author", "author"), ("/Subject", "subject"), ("/Keywords", "keywords"), ("/Creator", "creator"),
                   ("/Producer", "producer")):
        if meta.get(k):
            new[NameObject(key)] = TextStringObject(meta[k])
    new[NameObject("/CreationDate")] = TextStringObject(meta["created_pdf"])
    new[NameObject("/ModDate")] = TextStringObject(meta["modified_pdf"])
    for k, v in (extra or {}).items():
        new[NameObject(k)] = v
    w._info = new


def fix_common(w: PdfWriter, part: int, conf: str, done: dict, keep_files: bool = False) -> None:
    root = w._root_object
    names = _o(root.get("/Names"))
    if isinstance(names, DictionaryObject) and "/JavaScript" in names:
        del names["/JavaScript"]
        done["scripts"] = done.get("scripts", 0) + 1
    if "/AA" in root:
        del root["/AA"]
    if root.get("/OpenAction") is not None and _action_bad(root.get("/OpenAction")):
        del root["/OpenAction"]
    form = _o(root.get("/AcroForm"))
    if isinstance(form, DictionaryObject):
        if "/XFA" in form:
            del form["/XFA"]
        if form.get("/NeedAppearances"):
            try:
                for page in w.pages:
                    if _o(page.get("/Annots")):
                        w.update_page_form_field_values(page, {}, auto_regenerate=False)
            except Exception:
                pass
            del form["/NeedAppearances"]
        for f in _o(form.get("/Fields")) or []:
            stack = [f]
            while stack:
                node = _o(stack.pop())
                _strip_actions(node)
                stack += list(_o(node.get("/Kids")) or [])
    if isinstance(names, DictionaryObject) and "/EmbeddedFiles" in names:
        if not keep_files:
            del names["/EmbeddedFiles"]
            done["attachments"] = done.get("attachments", 0) + 1
    ocp = _o(root.get("/OCProperties"))
    if isinstance(ocp, DictionaryObject):
        for i, c in enumerate([_o(ocp.get("/D"))] + [_o(c) for c in (_o(ocp.get("/Configs")) or [])]):
            if isinstance(c, DictionaryObject):
                if c.get("/Name") is None:
                    c[NameObject("/Name")] = TextStringObject("Default" if i == 0 else f"Configuration {i}")
                if "/AS" in c:
                    del c["/AS"]
    for page in w.pages:
        if "/AA" in page:
            del page["/AA"]
        keep = ArrayObject()
        for ref in _o(page.get("/Annots")) or []:
            a = _o(ref)
            if not isinstance(a, DictionaryObject):
                continue
            sub = a.get("/Subtype")
            flags = int(_o(a.get("/F", 0)) or 0)
            if sub in BAD_ANNOTS or (sub == "/FileAttachment" and not keep_files) or (sub != "/Popup" and flags & (1 | 2 | 32 | 256) and sub != "/Widget"):
                done["annotations removed"] = done.get("annotations removed", 0) + 1
                continue
            if sub != "/Popup":
                a[NameObject("/F")] = NumberObject((flags | 4) & ~(1 | 2 | 32 | 256))
            _strip_actions(a)
            rect = [float(v) for v in a.get("/Rect", [0, 0, 0, 0])]
            zero = abs(rect[2] - rect[0]) < 1e-6 and abs(rect[3] - rect[1]) < 1e-6
            if sub not in ("/Popup", "/Link") and not zero and not isinstance(_o(a.get("/AP")), DictionaryObject):
                _gen_ap(w, a)
                done["appearances"] = done.get("appearances", 0) + 1
            ap = _o(a.get("/AP"))
            if isinstance(ap, DictionaryObject) and sub != "/Widget":
                for k in [k for k in ap.keys() if k != "/N"]:
                    del ap[k]
            keep.append(ref)
        if "/Annots" in page:
            page[NameObject("/Annots")] = keep
    for kind, _pi, obj in walk(w):
        if kind == "xobject":
            for k in ("/Interpolate", "/Alternates", "/OPI"):
                if k in obj:
                    del obj[k]
        elif kind == "res":
            for _n, gs in (_o(obj.get("/ExtGState")) or {}).items():
                g = _o(gs)
                if isinstance(g, DictionaryObject):
                    for k in ("/TR",):
                        if k in g:
                            del g[k]
                    if g.get("/TR2") not in (None, "/Default"):
                        g[NameObject("/TR2")] = NameObject("/Default")
    for _i, obj in enumerate(list(w._objects)):
        if isinstance(obj, StreamObject):
            filt = _o(obj.get("/Filter"))
            names_f = list(map(str, filt)) if isinstance(filt, ArrayObject) else [str(filt)]
            if "/LZWDecode" in names_f:
                try:
                    data = obj.get_data()
                except Exception:
                    continue
                for k in ("/Filter", "/DecodeParms"):
                    if k in obj:
                        del obj[k]
                obj._data = data
                obj[NameObject("/Length")] = NumberObject(len(data))
                done["lzw"] = done.get("lzw", 0) + 1


def fix_fonts(w: PdfWriter, unicode: bool, done: dict) -> list[str]:
    notes = []
    for _pi, _ref, f in fonts(w):
        if not embedded(f):
            sub = substitute(f)
            if sub is not None:
                notes.append(_embed(w, f, sub))
                done["fonts embedded"] = done.get("fonts embedded", 0) + 1
        d = _desc(f)
        if d is not None:
            for k in ("/CIDSet", "/CharSet"):
                if k in d:
                    del d[k]
        if unicode and (f.get("/ToUnicode") is None or _tu_gap(f)) and _tounicode(w, f):
            done["text mappings"] = done.get("text mappings", 0) + 1
    return notes


def _intent(w: PdfWriter, subtype: str, profile: bytes, n: int, condition: str, info: str = "") -> None:
    p = DecodedStreamObject()
    p[NameObject("/N")] = NumberObject(n)
    p.set_data(profile)
    oi = DictionaryObject({NameObject("/Type"): NameObject("/OutputIntent"), NameObject("/S"): NameObject(subtype),
                           NameObject("/OutputConditionIdentifier"): TextStringObject(condition), NameObject("/Info"): TextStringObject(info or condition),
                           NameObject("/DestOutputProfile"): w._add_object(p.flate_encode())})
    w._root_object[NameObject("/OutputIntents")] = ArrayObject([w._add_object(oi)])


def convert(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    level = str(args.get("level") or "2b").lower()
    if level not in LEVELS:
        raise ValueError(f"level is one of {', '.join(LEVELS)}")
    part, conf = LEVELS[level]
    r = core.reader(src, passwords)
    if core.signed(r):
        raise ValueError("Converting to PDF/A rewrites the file, which would break its signatures. Convert before signing.")
    w = PdfWriter(clone_from=r)
    done: dict = {}
    used, _where = _uses_device_colour(w)
    if "cmyk" in used:
        got = colour.convert(w, "rgb")
        done["colours converted to RGB"] = got["colours"] + got["images"]
    fix_common(w, part, conf, done, keep_files=part == 3)
    if part == 3:
        names = _o(w._root_object.get("/Names"))
        ef = _o(names.get("/EmbeddedFiles")) if isinstance(names, DictionaryObject) else None
        specs = []
        stack = [ef] if ef is not None else []
        while stack:
            node = _o(stack.pop())
            arr = _o(node.get("/Names")) or []
            for i in range(1, len(arr), 2):
                spec = _o(arr[i])
                if isinstance(spec, DictionaryObject):
                    spec[NameObject("/AFRelationship")] = spec.get("/AFRelationship") or NameObject("/Unspecified")
                    specs.append(arr[i])
            stack += list(_o(node.get("/Kids")) or [])
        if specs:
            w._root_object[NameObject("/AF")] = ArrayObject(specs)
    notes = fix_fonts(w, conf == "U", done)
    _intent(w, "/GTS_PDFA1", _srgb(), 3, "sRGB IEC61966-2.1", "sRGB IEC61966-2.1 (generated by LittleCMS)")
    _set_meta(w, _meta(w, r.metadata), part, conf)
    w.pdf_header = b"%PDF-1.7"
    if not getattr(w, "_ID", None):
        w.generate_file_identifiers()
    with open(out, "wb") as fh:
        w.write(fh)
    _text, again = check(out, args={"level": level})
    return {"pages": len(w.pages), "level": level, "fixed": done, "fonts": notes, "conforms": again["conforms"], "remaining": again["issues"]}


def pdfx(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    version = str(args.get("version") or "X-4").upper().removeprefix("PDF/")
    if version not in ("X-4", "X-6"):
        raise ValueError("version is X-4 or X-6")
    label = f"PDF/{version}"
    prof_path = str(args.get("profile") or "").strip()
    if not prof_path:
        raise ValueError(f"{label} needs the ICC profile of the printing condition (for example the one your printer sent); give its path as profile")
    p = Path(prof_path).expanduser()
    if not p.is_file():
        raise ValueError(f"No ICC profile at {prof_path}")
    profile = p.read_bytes()
    if len(profile) < 132 or profile[36:40] != b"acsp":
        raise ValueError("That file is not an ICC profile")
    space = profile[16:20]
    n = {b"CMYK": 4, b"RGB ": 3, b"GRAY": 1}.get(space)
    if n is None:
        raise ValueError("The profile's colour space must be CMYK, RGB or gray")
    if profile[12:16] != b"prtr":
        raise ValueError("PDF/X needs an output (printer) profile; this one describes a screen or another device")
    condition = str(args.get("condition") or p.stem)[:120]
    r = core.reader(src, passwords)
    if core.signed(r):
        raise ValueError("Converting to PDF/X rewrites the file, which would break its signatures.")
    w = PdfWriter(clone_from=r)
    done: dict = {}
    fix_common(w, 2, "B", done)
    notes = fix_fonts(w, False, done)
    if n == 4:
        srgb = DecodedStreamObject()
        srgb[NameObject("/N")] = NumberObject(3)
        srgb.set_data(_srgb())
        icc = ArrayObject([NameObject("/ICCBased"), w._add_object(srgb.flate_encode())])
        icc_ref = w._add_object(icc)
        for kind, _pi, obj in walk(w):
            if kind == "res":
                cs = _o(obj.get("/ColorSpace"))
                if not isinstance(cs, DictionaryObject):
                    cs = DictionaryObject()
                    obj[NameObject("/ColorSpace")] = cs
                cs[NameObject("/DefaultRGB")] = icc_ref
        done["DefaultRGB"] = 1
    elif n == 3:
        used, _w = _uses_device_colour(w)
        if "cmyk" in used:
            got = colour.convert(w, "rgb")
            done["colours converted to RGB"] = got["colours"] + got["images"]
    for page in w.pages:
        if "/TrimBox" not in page and "/ArtBox" not in page:
            x0, y0, x1, y1 = core.view_box(page)
            page[NameObject("/TrimBox")] = ArrayObject(FloatObject(v) for v in (x0, y0, x1, y1))
    _intent(w, "/GTS_PDFX", profile, n, condition)
    _set_meta(w, _meta(w, r.metadata), None, None, label, {"/GTS_PDFXVersion": TextStringObject(label), "/Trapped": NameObject("/False")})
    if version == "X-6":
        w._info = DictionaryObject({k: v for k, v in w._info.items() if k in ("/CreationDate", "/ModDate", "/Trapped", "/GTS_PDFXVersion")})
        for page in w.pages:
            res = _o(page.get("/Resources"))
            if isinstance(res, DictionaryObject) and "/ProcSet" in res:
                del res["/ProcSet"]
    w.pdf_header = b"%PDF-2.0" if version == "X-6" else b"%PDF-1.6"
    if not getattr(w, "_ID", None):
        w.generate_file_identifiers()
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "version": label, "condition": condition, "fixed": done, "fonts": notes}


actions.register(actions.Action("pdfa_check", "read", "Check PDF/A", words=("pdf/a", "archive", "validate", "iso 19005"), run=check))
actions.register(actions.Action("pdfa", "change", "Convert to PDF/A", "pdfa", ("pdf/a", "archive", "long-term", "iso 19005"),
                                fields=(actions.Field("level", "Level", "select", "2b", tuple(LEVELS)),), run=convert))
actions.register(actions.Action("pdfx", "change", "Convert to PDF/X-4 or PDF/X-6", "pdfx", ("pdf/x", "pdf/x-4", "pdf/x-6", "press", "print production", "output intent"),
                                fields=(actions.Field("version", "Version", "select", "X-4", ("X-4", "X-6")),), run=pdfx))
