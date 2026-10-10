import json
import os
import sys
from pathlib import Path

from app import __version__

APP_NAME = "formpdf"
VERSION = __version__
FRONTEND_PORT = 5198
BACKEND_PORT = 8198
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = BACKEND_DIR.parent


def _load_env_file() -> None:
    env = BACKEND_DIR / ".env"
    if not env.is_file():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if value.strip():
            os.environ.setdefault(key.strip(), value.strip())


_load_env_file()


def _ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def data_dir() -> Path:
    raw = os.environ.get("FORMPDF_DATA_DIR")
    return _ensure(Path(raw).expanduser() if raw else Path.home() / "Formpdf")


def pdf_dir() -> Path:
    return _ensure(data_dir() / "Pdf")


def media_dir() -> Path:
    return _ensure(data_dir() / "Media")


def exports_dir() -> Path:
    return _ensure(data_dir() / "Exports")


def settings_path() -> Path:
    return data_dir() / "settings.json"


def discovery_path() -> Path:
    return data_dir() / "engine.json"


def port() -> int:
    return int(os.environ.get("FORMPDF_PORT") or BACKEND_PORT)


def resource_dir() -> Path:
    return Path(getattr(sys, "_MEIPASS", BACKEND_DIR))


def fonts_dir() -> Path:
    bundled = resource_dir() / "fonts"
    return bundled if bundled.is_dir() else BACKEND_DIR / "app" / "fonts"


def is_desktop() -> bool:
    return os.environ.get("FORMPDF_DESKTOP") == "1"


def cors_origins() -> list[str]:
    raw = os.environ.get("FORMPDF_CORS_ORIGINS")
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    return [f"http://localhost:{FRONTEND_PORT}", f"http://127.0.0.1:{FRONTEND_PORT}", f"http://localhost:{FRONTEND_PORT + 1}", "tauri://localhost", "http://tauri.localhost"]


def dist_dir() -> Path | None:
    raw = os.environ.get("FORMPDF_DIST")
    if raw and (Path(raw) / "index.html").is_file():
        return Path(raw)
    return None


def read_settings() -> dict:
    try:
        return json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_settings(patch: dict) -> dict:
    merged = {**read_settings(), **patch}
    tmp = settings_path().with_suffix(".tmp")
    tmp.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    tmp.replace(settings_path())
    return merged
