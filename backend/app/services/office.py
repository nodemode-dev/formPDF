import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from app.core import config

WORD = (".doc", ".docx", ".docm", ".dot", ".dotx", ".odt", ".ott", ".rtf", ".txt", ".wpd", ".pages")
SLIDES = (".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".pot", ".potx", ".odp", ".otp", ".key")
SHEETS = (".xls", ".xlsx", ".xlsm", ".xlsb", ".ods", ".ots", ".csv", ".numbers")
OFFICE = WORD + SLIDES + SHEETS
TIMEOUT = 300
MISSING = ("Office files need LibreOffice, which formpdf uses but does not include. Install it from libreoffice.org "
           "(free, MPL-2.0), then try again; formpdf finds it on its own.")
_lock = threading.Lock()
_found: dict = {}

PROFILE = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Setup/Office"><prop oor:name="ooSetupInstCompleted" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
"""


def _candidates() -> list[Path]:
    out = []
    env = os.environ.get("FORMPDF_SOFFICE")
    if env:
        out.append(Path(env))
    for name in ("soffice", "libreoffice"):
        p = shutil.which(name)
        if p:
            out.append(Path(p))
    home = Path.home()
    out += [Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"), home / "Applications/LibreOffice.app/Contents/MacOS/soffice",
            Path("/usr/lib/libreoffice/program/soffice"), Path("/usr/lib64/libreoffice/program/soffice"), Path("/snap/bin/libreoffice")]
    out += sorted(Path("/opt").glob("libreoffice*/program/soffice"), reverse=True)
    for var in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
        base = os.environ.get(var)
        if base:
            out.append(Path(base) / "LibreOffice" / "program" / "soffice.exe")
    return out


def find() -> Path | None:
    if "path" in _found:
        p = _found["path"]
        if p is None or p.is_file():
            return p
    hit = next((p for p in _candidates() if p.is_file() and os.access(p, os.X_OK)), None)
    _found["path"] = hit
    return hit


def status() -> dict:
    _found.pop("path", None)
    p = find()
    if p is None:
        return {"available": False, "reason": MISSING, "path": ""}
    return {"available": True, "reason": "", "path": str(p)}


def is_office(name: str) -> bool:
    return str(name).lower().endswith(OFFICE)


def _profile() -> Path:
    d = config.data_dir() / "office-profile"
    user = d / "user"
    user.mkdir(parents=True, exist_ok=True)
    reg = user / "registrymodifications.xcu"
    if not reg.is_file():
        reg.write_text(PROFILE, encoding="utf-8")
    return d


def convert(data: bytes, name: str) -> bytes:
    exe = find()
    if exe is None:
        raise ValueError(MISSING)
    suffix = Path(name).suffix.lower()
    if suffix not in OFFICE:
        raise ValueError(f"{name} is not an Office file formpdf can convert")
    filt = "writer_pdf_Export" if suffix in WORD else "impress_pdf_Export" if suffix in SLIDES else "calc_pdf_Export"
    with _lock, tempfile.TemporaryDirectory(prefix="formpdf-office-") as tmp:
        work = Path(tmp)
        src = work / f"in{suffix}"
        src.write_bytes(data)
        outdir = work / "out"
        outdir.mkdir()
        cmd = [str(exe), f"-env:UserInstallation={_profile().resolve().as_uri()}", "--headless", "--invisible", "--nologo", "--norestore",
               "--nolockcheck", "--nodefault", "--convert-to", f"pdf:{filt}", "--outdir", str(outdir), str(src)]
        env = {**os.environ, "SAL_USE_VCLPLUGIN": "svp"}
        try:
            run = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT, env=env, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise ValueError(f"LibreOffice took longer than {TIMEOUT // 60} minutes on {name} and was stopped") from None
        except OSError as e:
            raise ValueError(f"LibreOffice could not start: {e}") from None
        got = outdir / "in.pdf"
        if not got.is_file() or got.stat().st_size < 64:
            why = re.sub(r"\s+", " ", (run.stderr or run.stdout or b"").decode("utf-8", "replace")).strip()[:200]
            raise ValueError(f"LibreOffice could not convert {name}{': ' + why if why else ''}")
        return got.read_bytes()
