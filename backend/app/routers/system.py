import platform
import sys

from fastapi import APIRouter

from app.core import config

router = APIRouter()


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
    }


@router.get("/settings")
def get_settings() -> dict:
    return config.read_settings()


@router.post("/settings")
def set_settings(patch: dict) -> dict:
    allowed = {k: v for k, v in patch.items() if k in {"agentsAllowed", "author", "units"}}
    return config.write_settings(allowed)
