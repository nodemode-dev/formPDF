import platform
import sys

from fastapi import APIRouter

from app.core import config
from app.services import session
from app.services.pdf import fontkit

router = APIRouter()
NETWORK = [
    {"id": "engine", "name": "The engine and this window", "state": "local", "note": "They talk only on this computer, at 127.0.0.1. PDFs never leave it."},
    {"id": "updates", "name": "Update check (desktop app)", "state": "off", "note": "This build has no update key, so it never checks. When one is set, formpdf asks before checking."},
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
    allowed = {k: v for k, v in patch.items() if k in {"agentsAllowed", "author", "units"}}
    return config.write_settings(allowed)
