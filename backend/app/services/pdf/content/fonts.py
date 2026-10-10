import re

from pypdf.generic import ArrayObject, DictionaryObject
from reportlab.pdfbase import _fontdata

try:
    from pypdf._codecs import adobe_glyphs as _GLYPHS, charset_encoding as _ENCODINGS
except ImportError:
    _GLYPHS, _ENCODINGS = {}, {}

STANDARD = {name: name for name in _fontdata.widthsByFontGlyph}
STANDARD.update({"Arial": "Helvetica", "Arial,Bold": "Helvetica-Bold", "Arial,Italic": "Helvetica-Oblique", "Arial,BoldItalic": "Helvetica-BoldOblique",
                 "ArialMT": "Helvetica", "Arial-BoldMT": "Helvetica-Bold", "Arial-ItalicMT": "Helvetica-Oblique", "Arial-BoldItalicMT": "Helvetica-BoldOblique",
                 "TimesNewRoman": "Times-Roman", "TimesNewRomanPSMT": "Times-Roman", "TimesNewRoman,Bold": "Times-Bold", "TimesNewRomanPS-BoldMT": "Times-Bold",
                 "TimesNewRoman,Italic": "Times-Italic", "TimesNewRomanPS-ItalicMT": "Times-Italic", "CourierNew": "Courier", "CourierNewPSMT": "Courier"})
_HEX = re.compile(rb"<([0-9A-Fa-f\s]*)>")
_NAMES: dict[str, str] = {}


def _num(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _hexint(tok: bytes) -> tuple[int, int]:
    h = re.sub(rb"\s", b"", tok)
    return (int(h, 16) if h else 0), max(1, len(h) // 2)


def _utf16(tok: bytes) -> str:
    h = re.sub(rb"\s", b"", tok)
    raw = bytes.fromhex(h.decode("ascii")) if h else b""
    try:
        return raw.decode("utf-16-be")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def _blocks(data: bytes, name: bytes) -> list[bytes]:
    return re.findall(rb"begin" + name + rb"(.*?)end" + name, data, re.S)


def parse_cmap(data: bytes) -> tuple[list[tuple[int, int, int]], dict[int, str], dict[int, int]]:
    space: list[tuple[int, int, int]] = []
    uni: dict[int, str] = {}
    cid: dict[int, int] = {}
    for blk in _blocks(data, b"codespacerange"):
        toks = _HEX.findall(blk)
        for lo, hi in zip(toks[0::2], toks[1::2]):
            a, n = _hexint(lo)
            b, _ = _hexint(hi)
            space.append((n, a, b))
    for blk in _blocks(data, b"bfchar"):
        toks = _HEX.findall(blk)
        for src, dst in zip(toks[0::2], toks[1::2]):
            uni[_hexint(src)[0]] = _utf16(dst)
    for blk in _blocks(data, b"bfrange"):
        for m in re.finditer(rb"<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>\s*(\[(.*?)\]|<([0-9A-Fa-f\s]*)>)", blk, re.S):
            lo, hi = _hexint(m.group(1))[0], _hexint(m.group(2))[0]
            if hi - lo > 65535:
                continue
            if m.group(4) is not None:
                for i, dst in enumerate(_HEX.findall(m.group(4))):
                    uni[lo + i] = _utf16(dst)
            else:
                base = _utf16(m.group(5))
                for i in range(hi - lo + 1):
                    uni[lo + i] = base[:-1] + chr(ord(base[-1]) + i) if base else ""
    for blk in _blocks(data, b"cidrange"):
        for m in re.finditer(rb"<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>\s*(\d+)", blk):
            lo, hi, start = _hexint(m.group(1))[0], _hexint(m.group(2))[0], int(m.group(3))
            if hi - lo <= 65535:
                for i in range(hi - lo + 1):
                    cid[lo + i] = start + i
    for blk in _blocks(data, b"cidchar"):
        for m in re.finditer(rb"<([0-9A-Fa-f\s]*)>\s*(\d+)", blk):
            cid[_hexint(m.group(1))[0]] = int(m.group(2))
    return space, uni, cid


def _glyph_unicode(name: str) -> str:
    base = name.lstrip("/").split(".", 1)[0]
    if "_" in base:
        return "".join(_glyph_unicode(part) for part in base.split("_"))
    if not base:
        return ""
    key = "/" + base
    if key in _GLYPHS:
        return _GLYPHS[key]
    m = re.fullmatch(r"/?uni([0-9A-Fa-f]{4,})", key)
    if m:
        h = m.group(1)
        return "".join(chr(int(h[i:i + 4], 16)) for i in range(0, len(h) - len(h) % 4, 4))
    m = re.fullmatch(r"/?u([0-9A-Fa-f]{4,6})", key)
    return chr(int(m.group(1), 16)) if m else ""


class FontInfo:
    def __init__(self, font, key: str = ""):
        f = font.get_object() if hasattr(font, "get_object") else font
        self.key = key
        self.font = f if isinstance(f, DictionaryObject) else DictionaryObject()
        self.subtype = str(self.font.get("/Subtype", "/Type1"))
        self.base = str(self.font.get("/BaseFont", key or "")).lstrip("/")
        self.plain = self.base.split("+", 1)[1] if re.match(r"^[A-Z]{6}\+", self.base) else self.base
        self.standard = STANDARD.get(self.plain) or STANDARD.get(self.plain.replace(" ", ""))
        self.type0 = self.subtype == "/Type0"
        self.type3 = self.subtype == "/Type3"
        self.matrix = [1 / 1000, 0, 0, 1 / 1000, 0, 0]
        self.space: list[tuple[int, int, int]] = []
        self.to_uni: dict[int, str] = {}
        self.cids: dict[int, int] = {}
        self.names: dict[int, str] = {}
        self.widths: dict[int, float] = {}
        self.listed: set[int] = set()
        self.default = 0.0
        self.approx = False
        desc = self.font.get("/FontDescriptor")
        if self.type0:
            kids = self.font.get("/DescendantFonts")
            kid = kids.get_object()[0].get_object() if kids else DictionaryObject()
            desc = kid.get("/FontDescriptor")
            self._cid_widths(kid)
            self._cid_encoding()
        else:
            self._simple(desc)
        self.desc = desc.get_object() if desc is not None else DictionaryObject()
        self.embedded = any(k in self.desc for k in ("/FontFile", "/FontFile2", "/FontFile3")) or self.type3
        self._metrics()
        tu = self.font.get("/ToUnicode")
        if tu is not None:
            try:
                space, uni, _ = parse_cmap(tu.get_object().get_data())
                self.to_uni.update(uni)
                if not self.space and space:
                    self.space = space
            except Exception:
                pass
        self.reverse: dict[str, int] = {}
        for code in sorted(self.to_uni, reverse=True):
            self.reverse[self.to_uni[code]] = code

    def _cid_widths(self, kid) -> None:
        self.default = _num(kid.get("/DW"), 1000.0) / 1000
        w = kid.get("/W")
        arr = list(w.get_object()) if w is not None else []
        i = 0
        while i < len(arr):
            first = int(_num(arr[i]))
            nxt = arr[i + 1].get_object() if i + 1 < len(arr) else None
            if isinstance(nxt, (list, ArrayObject)):
                for j, v in enumerate(nxt):
                    self.widths[first + j] = _num(v) / 1000
                    self.listed.add(first + j)
                i += 2
            elif i + 2 < len(arr):
                last, v = int(_num(nxt)), _num(arr[i + 2]) / 1000
                if last - first <= 65535:
                    for c in range(first, last + 1):
                        self.widths[c] = v
                        self.listed.add(c)
                i += 3
            else:
                break

    def _cid_encoding(self) -> None:
        enc = self.font.get("/Encoding")
        enc = enc.get_object() if enc is not None else None
        name = str(enc) if not hasattr(enc, "get_data") else ""
        if name in ("/Identity-H", "/Identity-V"):
            self.space = [(2, 0, 0xFFFF)]
            return
        if hasattr(enc, "get_data"):
            try:
                space, _, cids = parse_cmap(enc.get_data())
                self.space, self.cids = space or [(2, 0, 0xFFFF)], cids
                return
            except Exception:
                pass
        self.space = [(2, 0, 0xFFFF)]
        self.approx = True

    def _simple(self, desc) -> None:
        if self.type3:
            fm = self.font.get("/FontMatrix")
            if fm is not None:
                self.matrix = [_num(v) for v in fm.get_object()]
        first = int(_num(self.font.get("/FirstChar"), 0))
        ws = self.font.get("/Widths")
        scale = self.matrix[0] if self.type3 else 1 / 1000
        if ws is not None:
            for i, v in enumerate(ws.get_object()):
                self.widths[first + i] = _num(v) * scale
                self.listed.add(first + i)
        d = desc.get_object() if desc is not None else {}
        self.default = _num(d.get("/MissingWidth"), 0.0) * scale
        enc = self.font.get("/Encoding")
        enc = enc.get_object() if enc is not None else None
        base_name = "/StandardEncoding"
        if self.standard in ("Symbol", "ZapfDingbats"):
            base_name = "/" + self.standard if self.standard == "Symbol" else "/ZapfDingbats"
        elif self.subtype == "/TrueType" and enc is None:
            base_name = "/WinAnsiEncoding"
        diffs = None
        if isinstance(enc, DictionaryObject):
            base_name = str(enc.get("/BaseEncoding", base_name))
            diffs = enc.get("/Differences")
        elif enc is not None:
            base_name = str(enc)
        table = _ENCODINGS.get(base_name) or _ENCODINGS.get("/StandardEncoding") or [chr(i) for i in range(256)]
        for code, ch in enumerate(table):
            if ch and ch != "\x00":
                self.to_uni[code] = ch
        if base_name == "/WinAnsiEncoding":
            for code in (0x7F, 0x81, 0x8D, 0x8F, 0x90, 0x9D):
                self.to_uni[code] = "•"
        if diffs is not None:
            code = 0
            for item in diffs.get_object():
                if isinstance(item, (int, float)) or str(item).lstrip("-").isdigit():
                    code = int(item)
                    continue
                name = str(item)
                self.names[code] = name
                u = _glyph_unicode(name)
                if u:
                    self.to_uni[code] = u
                else:
                    self.to_uni.pop(code, None)
                code += 1
        self.space = [(1, 0, 255)]

    def _metrics(self) -> None:
        d = self.desc
        asc, dsc = _num(d.get("/Ascent")), _num(d.get("/Descent"))
        bbox = d.get("/FontBBox") or self.font.get("/FontBBox")
        if self.type3 and bbox is not None:
            b = [_num(v) for v in bbox.get_object()]
            self.ascent, self.descent = b[3] * self.matrix[3], b[1] * self.matrix[3]
        elif asc or dsc:
            self.ascent, self.descent = asc / 1000, dsc / 1000
        elif self.standard and self.standard in _fontdata.ascent_descent:
            a, b = _fontdata.ascent_descent[self.standard]
            self.ascent, self.descent = a / 1000, b / 1000
        elif bbox is not None:
            b = [_num(v) for v in bbox.get_object()]
            self.ascent, self.descent = b[3] / 1000, b[1] / 1000
        else:
            self.ascent, self.descent = 0.75, -0.25
        if self.descent > 0:
            self.descent = -self.descent
        if self.ascent <= self.descent:
            self.ascent, self.descent = 0.75, -0.25
        flags = int(_num(d.get("/Flags"), 0))
        low = self.plain.lower()
        self.bold = bool(flags & 262144) or _num(d.get("/FontWeight")) >= 600 or "bold" in low or "black" in low or "heavy" in low
        self.italic = bool(flags & 64) or _num(d.get("/ItalicAngle")) != 0 or "italic" in low or "oblique" in low
        self.serif = bool(flags & 2) or "times" in low or "serif" in low and "sans" not in low
        self.mono = bool(flags & 1) or "courier" in low or "mono" in low

    @property
    def two_byte(self) -> bool:
        return any(n > 1 for n, _, _ in self.space)

    def codes(self, data: bytes) -> list[tuple[int, bytes]]:
        if not self.type0:
            return [(b, bytes([b])) for b in data]
        out: list[tuple[int, bytes]] = []
        i = 0
        while i < len(data):
            hit = 0
            for n in sorted({n for n, _, _ in self.space}):
                if i + n > len(data):
                    continue
                v = int.from_bytes(data[i:i + n], "big")
                if any(nn == n and lo <= v <= hi for nn, lo, hi in self.space):
                    hit = n
                    break
            n = hit or (2 if self.two_byte and i + 1 < len(data) else 1)
            out.append((int.from_bytes(data[i:i + n], "big"), data[i:i + n]))
            i += n
        return out

    def cid(self, code: int) -> int:
        return self.cids.get(code, code)

    def width(self, code: int) -> float:
        key = self.cid(code) if self.type0 else code
        if key in self.widths:
            return self.widths[key]
        if self.standard and not self.type0:
            name = self.names.get(code, "").lstrip("/") or self._std_name(code)
            w = _fontdata.widthsByFontGlyph.get(self.standard, {}).get(name)
            if w is not None:
                return w / 1000
        return self.default

    def _std_name(self, code: int) -> str:
        if not _NAMES:
            for k, v in _GLYPHS.items():
                if k.lstrip("/") in _fontdata.widthsByFontGlyph["Helvetica"] or v not in _NAMES:
                    _NAMES[v] = k.lstrip("/")
        return _NAMES.get(self.to_uni.get(code, ""), "")

    def unicode(self, code: int) -> str:
        return self.to_uni.get(code, "")

    def has_glyph(self, code: int) -> bool:
        if self.type0:
            c = self.cid(code)
            return c in self.listed or not self.listed
        if self.listed:
            return code in self.listed and self.widths.get(code, 0) > 0
        return bool(self.standard) and bool(self.to_uni.get(code))

    def encode(self, text: str) -> bytes | None:
        out = bytearray()
        n = max((n for n, _, _ in self.space), default=1)
        for ch in text:
            code = self.reverse.get(ch)
            if code is None or not self.has_glyph(code):
                return None
            out += code.to_bytes(n, "big")
        return bytes(out)
