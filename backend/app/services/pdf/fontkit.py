from functools import lru_cache

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

from app.core import config

FAMILIES = {"sans": ("Inter", "Inter"), "serif": ("NotoSerif", "Noto Serif"), "mono": ("JetBrainsMono", "JetBrains Mono")}
FALLBACK = {"sans": "Helvetica", "serif": "Times-Roman", "mono": "Courier"}
_STYLE = {(False, False): "Regular", (True, False): "Bold", (False, True): "Italic", (True, True): "BoldItalic"}
_STD_STYLE = {"Helvetica": ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"),
              "Times-Roman": ("Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"),
              "Courier": ("Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique")}


def _family(family: str) -> str:
    return family if family in FAMILIES else "sans"


def path(family: str, bold: bool = False, italic: bool = False):
    stem = FAMILIES[_family(family)][0]
    p = config.fonts_dir() / f"{stem}-{_STYLE[(bool(bold), bool(italic))]}.ttf"
    return p if p.is_file() else None


@lru_cache(maxsize=None)
def font_name(family: str, bold: bool = False, italic: bool = False) -> str:
    fam = _family(family)
    p = path(fam, bold, italic)
    if p is not None:
        name = f"Fk{FAMILIES[fam][0]}-{_STYLE[(bool(bold), bool(italic))]}"
        try:
            pdfmetrics.getFont(name)
        except KeyError:
            try:
                pdfmetrics.registerFont(TTFont(name, str(p)))
            except Exception:
                p = None
        if p is not None:
            return name
    return _STD_STYLE[FALLBACK[fam]][2 * bool(italic) + bool(bold)]


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
    order = [fam] + [f for f in FAMILIES if f != fam]
    for f in order:
        if covers(text, f, bold, italic):
            return f, font_name(f, bold, italic)
    return fam, font_name(fam, bold, italic)


def available() -> list[dict]:
    return [{"id": fam, "label": label, "styles": [s for (b, i), s in _STYLE.items() if path(fam, b, i)]} for fam, (_, label) in FAMILIES.items()]
