import re
import shutil
import subprocess
import zlib
from functools import lru_cache
from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont, TTFontFile

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
            files |= {str(p) for p in d.rglob("*") if p.suffix.lower() == ".ttf"}
    return {f for f in files if f.lower().endswith(".ttf")}


@lru_cache(maxsize=1)
def system_families() -> dict[str, dict[tuple[bool, bool], str]]:
    """Installed TrueType families that may be embedded, each with the files of its regular, bold and italic styles."""
    out: dict[str, dict[tuple[bool, bool], str]] = {}
    for f in sorted(_font_files()):
        try:
            tt = TTFontFile(f, validate=0)
        except Exception:
            continue
        fam = (tt.familyName or b"").decode("latin-1", "replace").strip() if isinstance(tt.familyName, bytes) else str(tt.familyName or "").strip()
        sub = tt.styleName.decode("latin-1", "replace") if isinstance(tt.styleName, bytes) else str(tt.styleName or "")
        st = _style_of(sub)
        if fam and st is not None and len(fam) <= 80:
            out.setdefault(fam, {}).setdefault(st, f)
    return {k: v for k, v in sorted(out.items(), key=lambda kv: kv[0].lower()) if (False, False) in v}


def known(family) -> bool:
    return isinstance(family, str) and (family in FAMILIES or (family.startswith(SYS) and family[len(SYS):] in system_families()))


def _family(family: str) -> str:
    return family if known(family) else "sans"


def path(family: str, bold: bool = False, italic: bool = False):
    fam = _family(family)
    if fam.startswith(SYS):
        faces = system_families()[fam[len(SYS):]]
        return Path(faces.get((bool(bold), bool(italic))) or faces[(False, False)])
    stem = FAMILIES[fam][0]
    p = config.fonts_dir() / f"{stem}-{_STYLE[(bool(bold), bool(italic))]}.ttf"
    return p if p.is_file() else None


@lru_cache(maxsize=None)
def font_name(family: str, bold: bool = False, italic: bool = False) -> str:
    fam = _family(family)
    p = path(fam, bold, italic)
    if p is not None:
        stem = f"Fs{zlib.crc32(fam.encode('utf-8')):08x}" if fam.startswith(SYS) else f"Fk{FAMILIES[fam][0]}"
        name = f"{stem}-{_STYLE[(bool(bold), bool(italic))]}"
        try:
            pdfmetrics.getFont(name)
        except KeyError:
            try:
                pdfmetrics.registerFont(TTFont(name, str(p)))
            except Exception:
                p = None
        if p is not None:
            return name
    return _STD_STYLE[FALLBACK.get(fam, "Helvetica")][2 * bool(italic) + bool(bold)]


def covers(text: str, family: str, bold: bool = False, italic: bool = False) -> bool:
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
            return f, font_name(f, bold, italic)
    return fam, font_name(fam, bold, italic)


def available(system: bool = False) -> list[dict]:
    kit = [{"id": fam, "label": label, "styles": [s for (b, i), s in _STYLE.items() if path(fam, b, i)]} for fam, (_, label) in FAMILIES.items()]
    if not system:
        return kit
    return kit + [{"id": SYS + name, "label": name, "styles": [_STYLE[k] for k in _STYLE if k in faces], "system": True} for name, faces in system_families().items()]


def families(path=None, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    rows = available(system=True)
    return f"{len(rows)} font families: " + ", ".join(r["label"] for r in rows[:60]) + (" and more" if len(rows) > 60 else ""), {"families": rows}
