import json
import logging
import os
import sys
from pathlib import Path

if sys.stdin is None:
    sys.stdin = open(os.devnull, encoding="utf-8")
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

MODULES = ("PIL", "fastapi", "uvicorn", "pptx", "pypdf", "pypdfium2", "pdfplumber", "docx", "openpyxl", "reportlab", "pyhanko")


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
    from app.services.pdf import fontkit

    info["fonts"] = sum(len(f["styles"]) for f in fontkit.available())
    from app.services.pdf import ocr

    info["ocr"] = ocr.status()["available"]
    print(json.dumps(info))
    return 1 if missing else 0


def watch_shell(data) -> None:
    from app.core import runtime, startup

    shell = startup.shell_pid()
    if shell <= 1:
        return

    def leave() -> None:
        logging.getLogger("formpdf").info("the app that started this engine is gone (process %s), stopping", shell)
        runtime.release(data)
        os._exit(0)

    startup.watch(shell, leave)


def run(data) -> int:
    import signal

    import uvicorn

    from app.core import runtime
    from app.main import app as fastapi_app

    port = int(os.environ.get("FORMPDF_PORT", "0") or 0)
    if port == 0:
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
    os.environ["FORMPDF_PORT"] = str(port)
    from app.core import window_key

    if window_key.stdout_mode():
        print(window_key.LINE + window_key.KEY, flush=True)

    def leave(_signum, _frame) -> None:
        runtime.release(data)
        os._exit(0)

    signal.signal(signal.SIGTERM, leave)
    uvicorn.run(fastapi_app, host="127.0.0.1", port=port, log_level="info")
    return 0


def serve() -> int:
    bundled = os.path.join(resource_dir(), "frontend_dist")
    if os.path.isdir(bundled):
        os.environ.setdefault("FORMPDF_DIST", bundled)
    os.environ.setdefault("FORMPDF_DESKTOP", "1")
    from app.core import config, runtime, startup

    try:
        data = config.data_dir()
        logs = runtime.start_logging(data).parent
    except OSError as err:
        print(f"formpdf cannot use its data folder: {err}", file=sys.stderr)
        return 5
    startup.keep_errors(logs)
    log = logging.getLogger("formpdf")
    if startup.alone():
        beside = startup.app_beside(Path(sys.executable))
        if beside is not None and startup.open_app(beside):
            log.info("started without its app, so it opened %s and stopped", beside)
            return 0
        log.error("started without its app, and no app program was found near %s", sys.executable)
        print("formpdf-engine is a part of FormPDF and serves nothing on its own. Open FormPDF instead.", file=sys.stderr)
        return 4
    try:
        runtime.claim(data)
    except runtime.AlreadyRunning as err:
        log.error("%s", err)
        print(err, file=sys.stderr)
        return 2
    watch_shell(data)
    try:
        return run(data)
    finally:
        runtime.release(data)


def main() -> int:
    if "--selfcheck" in sys.argv:
        return selfcheck()
    try:
        return serve()
    except Exception:
        logging.getLogger("formpdf").exception("the engine stopped on an error")
        raise


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    sys.exit(main())
