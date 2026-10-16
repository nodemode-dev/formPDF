import io
import re
import shutil
import subprocess
import threading
import zlib
from functools import lru_cache
from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

from app.core import config

FAMILIES = {"sans": ("Inter", "Inter"), "serif": ("NotoSerif", "Noto Serif"), "mono": ("JetBrainsMono", "JetBrains Mono")}
FALLBACK = {"sans": "Helvetica", "serif": "Times-Roman", "mono": "Courier"}
_STYLE = {(False, False): "Regular", (True, False): "Bold", (False, True): "Italic", (True, True): "BoldItalic"}
_STD_STYLE = {"Helvetica": ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"),
              "Times-Roman": ("Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"),
              "Courier": ("Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique")}


SYS = "sys:"
_PLAIN = re.compile(r"bold|italic|oblique|regular|normal|book|roman|[\s_-]")


def _style_of(sub: str) -> tuple[bool, bool] | None:
    """(bold, italic) for a face's style name, or None for weights and widths the four styles do not cover."""
    s = sub.lower()
    if _PLAIN.sub("", s):
        return None
    return "bold" in s, "italic" in s or "oblique" in s


def _font_files() -> set[str]:
    from .fontreport import _font_dirs
    files: set[str] = set()
    if shutil.which("fc-list"):
        try:
            out = subprocess.run(["fc-list", ":", "file"], capture_output=True, text=True, timeout=20).stdout
            files |= {line.split(":")[0].strip() for line in out.splitlines() if line.strip()}
        except (OSError, subprocess.SubprocessError):
            pass
    for d in _font_dirs():
        if d.is_dir():
            files |= {str(p) for p in d.rglob("*") if p.suffix.lower() in _EXT}
    return {f for f in files if f.lower().endswith(_EXT)}


_EXT = (".ttf", ".otf", ".ttc", ".otc")
Face = tuple[str, int, bool]  # file, face number in a collection, PostScript (CFF) outlines


def _scan(f: str) -> list[tuple[str, str, Face]]:
    """(family, style, face) for each embeddable face in one font file, read from its tables without loading outlines."""
    from fontTools.ttLib import TTCollection, TTFont as FtFont

    rows: list[tuple[str, str, Face]] = []
    holder = TTCollection(f, lazy=True) if f.lower().endswith((".ttc", ".otc")) else FtFont(f, lazy=True)
    try:
        for idx, ft in enumerate(holder.fonts if hasattr(holder, "fonts") else [holder]):
            try:
                if "glyf" in ft:
                    cff = False
                elif "CFF " in ft:
                    cff = True
                else:
                    continue  # CFF2 variable fonts and bitmap-only faces
                fs = ft["OS/2"].fsType if "OS/2" in ft else 0
                if fs == 0x0002 or fs & 0x0300:
                    continue  # the same licence rule reportlab applies when it embeds
                name = ft["name"]
                rows.append(((name.getDebugName(1) or "").strip(), name.getDebugName(2) or "", (f, idx, cff)))
            except Exception:
                continue
    finally:
        holder.close()
    return rows


@lru_cache(maxsize=1)
def system_families() -> dict[str, dict[tuple[bool, bool], Face]]:
    """Installed families that may be embedded, each with the face of its regular, bold and italic styles.

    TrueType, OpenType CFF and collection files all count; a TrueType face wins when a family has both.
    """
    out: dict[str, dict[tuple[bool, bool], Face]] = {}
    for f in sorted(_font_files()):
        try:
            rows = _scan(f)
        except Exception:
            continue
        for fam, sub, face in rows:
            st = _style_of(sub)
            if fam and st is not None and len(fam) <= 80:
                faces = out.setdefault(fam, {})
                if st not in faces or (faces[st][2] and not face[2]):
                    faces[st] = face
    return {k: v for k, v in sorted(out.items(), key=lambda kv: kv[0].lower()) if (False, False) in v}


def _face(fam: str, bold: bool, italic: bool) -> Face:
    faces = system_families()[fam[len(SYS):]]
    return faces.get((bool(bold), bool(italic))) or faces[(False, False)]


@lru_cache(maxsize=None)
def _register(name: str, file: str, index: int = 0) -> str | None:
    try:
        pdfmetrics.getFont(name)
        return name
    except KeyError:
        pass
    try:
        pdfmetrics.registerFont(TTFont(name, file, subfontIndex=index))
        return name
    except Exception:
        return None


# PostScript outlined faces are embedded as TrueType built from a subset: reportlab only embeds TrueType, and
# converting a whole CJK face takes most of a minute, while a subset of the characters in use takes under one second.
_BASE = frozenset([*range(0x20, 0x7F), *range(0xA0, 0x100), *range(0x2010, 0x2028), 0x20AC, 0x2122])
_LOCK = threading.Lock()
_SUBSETS: dict[tuple[Face, str], tuple[frozenset[int], str]] = {}


@lru_cache(maxsize=256)
def _cmap(face: Face) -> frozenset[int]:
    from fontTools.ttLib import TTFont as FtFont

    ft = FtFont(face[0], fontNumber=face[1], lazy=True)
    try:
        return frozenset(ft.getBestCmap() or {})
    finally:
        ft.close()


def _quadratic(ft) -> None:
    """Replace a font's cubic CFF outlines with quadratic glyf outlines, in place."""
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.ttLib import newTable

    order = ft.getGlyphOrder()
    glyphs = ft.getGlyphSet()
    out = {}
    for g in order:
        pen = TTGlyphPen(glyphs)
        glyphs[g].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))  # within 1 unit of 1000 per em
        out[g] = pen.glyph()
    ft["loca"] = newTable("loca")
    glyf = ft["glyf"] = newTable("glyf")
    glyf.glyphOrder, glyf.glyphs = order, out
    for tag in ("CFF ", "VORG"):
        if tag in ft:
            del ft[tag]
    maxp = ft["maxp"]
    maxp.tableVersion = 0x00010000
    for attr in ("maxTwilightPoints", "maxStorage", "maxFunctionDefs", "maxInstructionDefs", "maxStackElements",
                 "maxSizeOfInstructions", "maxComponentElements", "maxComponentDepth"):
        setattr(maxp, attr, 0)
    maxp.maxZones = 1
    ft["head"].glyphDataFormat = 0
    ft["post"].formatType = 3.0
    ft.sfntVersion = "\x00\x01\x00\x00"


def _truetype(face: Face, chars: frozenset[int], tag: str) -> io.BytesIO:
    from fontTools import subset
    from fontTools.ttLib import TTFont as FtFont

    ft = FtFont(face[0], fontNumber=face[1])
    try:
        opts = subset.Options(layout_features=[], name_IDs=["*"], name_languages=["*"], notdef_outline=True,
                              glyph_names=False, hinting=False, desubroutinize=True)
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=sorted(chars))
        sub.subset(ft)
        _quadratic(ft)
        # reportlab shares one font object between registrations with the same PostScript name, so each subset
        # (and the kit's own Inter, which an installed Inter shares a name with) needs a name of its own
        names = ft["name"]
        ps = re.sub(r"[^A-Za-z0-9-]", "", names.getDebugName(6) or "Font")[:30]
        names.removeNames(nameID=6)
        names.setName(f"{ps}-{tag}", 6, 3, 1, 0x409)
        names.setName(f"{ps}-{tag}", 6, 1, 0, 0)
        buf = io.BytesIO()
        ft.save(buf)
    finally:
        ft.close()
    buf.seek(0)
    return buf


def _cff_name(face: Face, stem: str, text: str) -> str | None:
    """A registered font covering the face's characters in use so far plus the text; it grows under a new name."""
    have = _cmap(face)
    want = (_BASE | {ord(c) for c in text}) & have
    with _LOCK:
        cur = _SUBSETS.get((face, stem))
        if cur is not None and want <= cur[0]:
            return cur[1]
        chars = want | (cur[0] if cur is not None else frozenset())
        name = f"{stem}-v{len(chars)}"
        try:
            pdfmetrics.getFont(name)
        except KeyError:
            try:
                pdfmetrics.registerFont(TTFont(name, _truetype(face, chars, name)))
            except Exception:
                return cur[1] if cur is not None else None
        _SUBSETS[(face, stem)] = (chars, name)
        return name


def known(family) -> bool:
    return isinstance(family, str) and (family in FAMILIES or (family.startswith(SYS) and family[len(SYS):] in system_families()))


def _family(family: str) -> str:
    return family if known(family) else "sans"


def path(family: str, bold: bool = False, italic: bool = False):
    fam = _family(family)
    if fam.startswith(SYS):
        return Path(_face(fam, bold, italic)[0])
    stem = FAMILIES[fam][0]
    p = config.fonts_dir() / f"{stem}-{_STYLE[(bool(bold), bool(italic))]}.ttf"
    return p if p.is_file() else None


def font_name(family: str, bold: bool = False, italic: bool = False, text: str = "") -> str:
    """The registered font for a family and style; for a PostScript outlined face it covers text as well."""
    fam = _family(family)
    style = _STYLE[(bool(bold), bool(italic))]
    name = None
    if fam.startswith(SYS):
        face = _face(fam, bold, italic)
        stem = f"Fs{zlib.crc32(fam.encode('utf-8')):08x}-{style}"
        name = _cff_name(face, stem, text) if face[2] else _register(stem, face[0], face[1])
    else:
        p = path(fam, bold, italic)
        if p is not None:
            name = _register(f"Fk{FAMILIES[fam][0]}-{style}", str(p))
    return name or _STD_STYLE[FALLBACK.get(fam, "Helvetica")][2 * bool(italic) + bool(bold)]


def covers(text: str, family: str, bold: bool = False, italic: bool = False) -> bool:
    fam = _family(family)
    if fam.startswith(SYS):
        face = _face(fam, bold, italic)
        if face[2]:
            have = _cmap(face)
            return all(ch.isspace() or ord(ch) in have for ch in text)
    name = font_name(family, bold, italic)
    font = pdfmetrics.getFont(name)
    face = getattr(font, "face", None)
    table = getattr(face, "charToGlyph", None)
    if table is not None:
        return all(ch.isspace() or ord(ch) in table for ch in text)
    try:
        text.encode("cp1252")
        return True
    except UnicodeEncodeError:
        return False


def pick(text: str, family: str = "sans", bold: bool = False, italic: bool = False) -> tuple[str, str]:
    fam = _family(family)
    order = [fam] + [f for f in FAMILIES if f != fam]  # a system family falls back to the kit for characters it lacks
    for f in order:
        if covers(text, f, bold, italic):
            return f, font_name(f, bold, italic, text)
    return fam, font_name(fam, bold, italic, text)


def available(system: bool = False) -> list[dict]:
    kit = [{"id": fam, "label": label, "styles": [s for (b, i), s in _STYLE.items() if path(fam, b, i)]} for fam, (_, label) in FAMILIES.items()]
    if not system:
        return kit
    return kit + [{"id": SYS + name, "label": name, "styles": [_STYLE[k] for k in _STYLE if k in faces], "system": True} for name, faces in system_families().items()]


def families(path=None, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    rows = available(system=True)
    return f"{len(rows)} font families: " + ", ".join(r["label"] for r in rows[:60]) + (" and more" if len(rows) > 60 else ""), {"families": rows}
