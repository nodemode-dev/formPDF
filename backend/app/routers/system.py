import platform
import sys

from fastapi import APIRouter

from app.core import config
from app.services import session
from app.services.pdf import fontkit, ocr, spell

router = APIRouter()
NETWORK = [
    {"id": "engine", "name": "The engine and this window", "state": "local", "note": "They talk only on this computer, at 127.0.0.1. PDFs never leave it."},
    {"id": "updates", "name": "Update check (desktop app)", "state": "off", "note": "This build has no update key, so it never checks. When one is set, formpdf asks before checking."},
    {"id": "ocr", "name": "Text recognition (OCR)", "state": "local", "note": "Runs on this computer with models installed alongside formpdf. Nothing is uploaded or downloaded."},
    {"id": "scanners", "name": "Scanners", "state": "local", "note": "Only when you use Scan: formpdf looks for scanners on your local network and talks to the one you pick. Nothing goes past your network."},
]


def _available(module: str) -> bool:
    try:
        __import__(module)
        return True
    except Exception:
        return False


@router.get("/health")
def health() -> dict:
    return {"ok": True, "app": config.APP_NAME, "version": config.VERSION}


@router.get("/version")
def version() -> dict:
    return {"app": config.APP_NAME, "version": config.VERSION, "python": sys.version.split()[0], "platform": platform.system().lower()}


@router.get("/fonts/{name}")
def font_file(name: str):
    from fastapi import HTTPException
    from fastapi.responses import FileResponse

    allowed = {p.name: p for p in config.fonts_dir().glob("*.ttf")}
    if name not in allowed:
        raise HTTPException(404, "No such font")
    return FileResponse(allowed[name], media_type="font/ttf", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/capabilities")
def capabilities() -> dict:
    return {
        "pptx": _available("pptx"),
        "pdf": _available("pypdf") and _available("pypdfium2"),
        "pdfTables": _available("pdfplumber"),
        "docx": _available("docx"),
        "xlsx": _available("openpyxl"),
        "pdfCompose": _available("reportlab"),
        "desktop": config.is_desktop(),
        "dataDir": str(config.data_dir()),
        "port": config.port(),
        "fonts": sum(len(f["styles"]) for f in fontkit.available()),
        "spellLanguages": spell.languages(),
        "ocr": ocr.status(),
        "network": NETWORK,
    }


@router.get("/session")
def get_session() -> dict:
    return session.read()


@router.post("/session/dismiss")
def dismiss_session() -> dict:
    session.clear()
    return {"ok": True}


@router.get("/settings")
def get_settings() -> dict:
    return config.read_settings()


@router.post("/settings")
def set_settings(patch: dict) -> dict:
    allowed = {k: v for k, v in patch.items() if k in {"agentsAllowed", "author", "units", "spellLang"}}
    if isinstance(patch.get("dictionary"), list):
        allowed["dictionary"] = sorted({str(w).strip()[:64] for w in patch["dictionary"] if str(w).strip()})[:5000]
    if "spellLang" in allowed:
        allowed["spellLang"] = str(allowed["spellLang"] or "")[:24]
    return config.write_settings(allowed)
