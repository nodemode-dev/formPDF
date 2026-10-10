import json
import os
import sys

MODULES = ("PIL", "fastapi", "uvicorn", "pptx", "pypdf", "pypdfium2", "pdfplumber", "docx", "openpyxl", "reportlab")


def resource_dir() -> str:
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def selfcheck() -> int:
    info = {"python": sys.version.split()[0]}
    missing = False
    for name in MODULES:
        try:
            module = __import__(name)
            info[name.lower()] = str(getattr(module, "__version__", "ok"))
        except Exception as exc:
            info[name.lower()] = f"missing: {exc}"
            missing = True
    from app import __version__

    info["formpdf"] = __version__
    info["dist_bundled"] = os.path.isdir(os.path.join(resource_dir(), "frontend_dist"))
    print(json.dumps(info))
    return 1 if missing else 0


def main() -> int:
    if "--selfcheck" in sys.argv:
        return selfcheck()
    bundled = os.path.join(resource_dir(), "frontend_dist")
    if os.path.isdir(bundled):
        os.environ.setdefault("FORMPDF_DIST", bundled)
    os.environ.setdefault("FORMPDF_DESKTOP", "1")
    import uvicorn

    from app.main import app as fastapi_app

    port = int(os.environ.get("FORMPDF_PORT", "0") or 0)
    if port == 0:
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
    os.environ["FORMPDF_PORT"] = str(port)
    uvicorn.run(fastapi_app, host="127.0.0.1", port=port, log_level="info")
    return 0


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    sys.exit(main())
