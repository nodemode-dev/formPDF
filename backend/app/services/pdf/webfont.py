import io
from functools import lru_cache

from fontTools.agl import UV2AGL
from fontTools.cffLib import CFFFontSet
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont, newTable
from pypdf.generic import DictionaryObject

from . import core
from .content.fonts import FontInfo

MAX_PAGES = 60


def _fonts(res, seen: set, depth: int = 0):
    res = res.get_object() if res is not None else None
    if not isinstance(res, DictionaryObject) or depth > 4:
        return
    fd = res.get("/Font")
    if fd is not None:
        for k, v in fd.get_object().items():
            yield str(k), v
    xo = res.get("/XObject")
    if xo is None:
        return
    for v in xo.get_object().values():
        ref = getattr(v, "idnum", None)
        o = v.get_object()
        if ref in seen or not isinstance(o, DictionaryObject) or o.get("/Subtype") != "/Form":
            continue
        if ref is not None:
            seen.add(ref)
        yield from _fonts(o.get("/Resources"), seen, depth + 1)


def find(reader, page: int, name: str) -> FontInfo | None:
    n = len(reader.pages)
    first = min(max(page, 1), n) - 1
    for i in [first] + [i for i in range(n) if i != first][:MAX_PAGES]:
        for key, ref in _fonts(reader.pages[i].get("/Resources"), set()):
            try:
                fi = FontInfo(ref, key)
            except Exception:
                continue
            if fi.plain == name or fi.base == name:
                return fi
    return None


def _program(fi: FontInfo):
    d = fi.desc
    for k in ("/FontFile2", "/FontFile3"):
        if k in d:
            s = d[k].get_object()
            return k, str(s.get("/Subtype", "")), s.get_data()
    return None


def _cid_to_gid(fi: FontInfo) -> dict[int, int] | None:
    kids = fi.font.get("/DescendantFonts")
    if kids is None:
        return None
    m = kids.get_object()[0].get_object().get("/CIDToGIDMap")
    m = m.get_object() if m is not None else None
    if m is None or not hasattr(m, "get_data"):
        return None
    b = m.get_data()
    return {i: int.from_bytes(b[2 * i:2 * i + 2], "big") for i in range(len(b) // 2)}


def _glyph(fi: FontInfo, tt, top, order: list[str], names: set, c2g, code: int, ch: str) -> str | None:
    if fi.type0:
        cid = fi.cid(code)
        if top is not None and hasattr(top, "ROS"):
            g = f"cid{cid:05d}"
            return g if g in names else None
        gid = c2g.get(cid, cid) if c2g is not None else cid
        return order[gid] if 0 <= gid < len(order) else None
    g = fi.names.get(code, "").lstrip("/")
    if g in names:
        return g
    if tt is not None and "cmap" in tt:
        for t in tt["cmap"].tables:
            keys = (0xF000 + code, code) if (t.platformID, t.platEncID) == (3, 0) else (ord(ch),) if t.isUnicode() else (code,)
            for k in keys:
                if k in t.cmap:
                    return t.cmap[k]
    enc = getattr(top, "Encoding", None) if top is not None else None
    if isinstance(enc, list) and 0 <= code < len(enc) and enc[code] in names and enc[code] != ".notdef":
        return enc[code]
    g = UV2AGL.get(ord(ch), "")
    return g if g in names else None


def _names(fb: FontBuilder, fi: FontInfo) -> None:
    fb.setupNameTable({"familyName": "FormpdfDoc", "styleName": "Regular", "psName": "FormpdfDoc-Regular", "uniqueFontIdentifier": f"formpdf-{fi.plain[:40]}"})


def build(fi: FontInfo) -> bytes | None:
    prog = _program(fi)
    if prog is None or fi.type3:
        return None
    kind, sub, data = prog
    tt = top = None
    if kind == "/FontFile2" or sub == "/OpenType":
        tt = TTFont(io.BytesIO(data), lazy=False)
        if "CFF " in tt:
            top = tt["CFF "].cff.topDictIndex[0]
        order = tt.getGlyphOrder()
    elif sub in ("/Type1C", "/CIDFontType0C"):
        cff = CFFFontSet()
        cff.decompile(io.BytesIO(data), None)
        top = cff.topDictIndex[0]
        order = list(top.charset)
    else:
        return None
    names = set(order)
    c2g = _cid_to_gid(fi) if fi.type0 else None
    cmap: dict[int, str] = {}
    widths: dict[str, float] = {}
    for ch, code in fi.reverse.items():
        if len(ch) != 1 or ord(ch) in cmap:
            continue
        g = _glyph(fi, tt, top, order, names, c2g, code, ch)
        if g and g != ".notdef":
            cmap[ord(ch)] = g
            w = fi.width(code)
            if w > 0:
                widths.setdefault(g, w)
    if not cmap:
        return None
    upem = 1000
    if tt is not None:
        fb = FontBuilder(font=tt)
        upem = tt["head"].unitsPerEm if "head" in tt else 1000
        if "cmap" in tt:
            del tt["cmap"]
        fb.setupCharacterMap(cmap)
        if "hmtx" in tt:
            hm = tt["hmtx"].metrics
            for g, w in widths.items():
                if g in hm:
                    hm[g] = (round(w * upem), hm[g][1])
        _names(fb, fi)
        if "OS/2" not in tt:
            fb.setupOS2(sTypoAscender=round(fi.ascent * upem), sTypoDescender=round(fi.descent * upem), usWinAscent=round(fi.ascent * upem), usWinDescent=round(-fi.descent * upem))
        if "post" not in tt:
            fb.setupPost()
        font = fb.font
    else:
        fm = getattr(top, "FontMatrix", None) or [0.001]
        upem = round(1 / fm[0]) if fm[0] else 1000
        fb = FontBuilder(upem, isTTF=False)
        fb.setupGlyphOrder(order)
        fb.setupCharacterMap(cmap)
        css = top.CharStrings
        metrics = {}
        for g in order:
            c = css[g]
            pen = BoundsPen(css)
            c.draw(pen)
            metrics[g] = (round(widths[g] * upem) if g in widths else round(c.width), round(pen.bounds[0]) if pen.bounds else 0)
        table = newTable("CFF ")
        table.cff = cff
        fb.font["CFF "] = table
        fb.setupHorizontalMetrics(metrics)
        fb.setupHorizontalHeader(ascent=round(fi.ascent * upem), descent=round(fi.descent * upem))
        _names(fb, fi)
        fb.setupOS2(sTypoAscender=round(fi.ascent * upem), sTypoDescender=round(fi.descent * upem), usWinAscent=round(fi.ascent * upem), usWinDescent=round(-fi.descent * upem))
        fb.setupPost()
        fb.setupMaxp()
        font = fb.font
    out = io.BytesIO()
    font.save(out)
    data = out.getvalue()
    TTFont(io.BytesIO(data))
    return data


@lru_cache(maxsize=64)
def webfont(path: str, page: int, name: str, passwords: tuple = ()) -> bytes | None:
    fi = find(core.reader(path, list(passwords) or None), page, name)
    if fi is None:
        return None
    try:
        return build(fi)
    except Exception:
        return None
