"""An outside opinion: veraPDF, the reference validator for PDF/A and PDF/UA, run on the file when it is installed.

formpdf's own checks say what it can fix; veraPDF says whether the file meets the standard by the official test suite.
formpdf does not ship it (it is Java); it looks for the verapdf command on the PATH, in the data folder's tools folder,
or at the path in the FORMPDF_VERAPDF environment variable."""
import os
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

from . import actions
from app.core import config

FLAVOURS = {"1a", "1b", "2a", "2b", "2u", "3a", "3b", "3u", "4", "4e", "4f", "ua1", "ua2", "wcag2"}
TIMEOUT = 600


def find() -> str | None:
    env = os.environ.get("FORMPDF_VERAPDF", "").strip()
    if env and Path(env).is_file():
        return env
    for d in (config.data_dir() / "tools" / "verapdf", config.data_dir() / "tools"):
        for name in ("verapdf", "verapdf.bat"):
            p = d / name
            if p.is_file():
                return str(p)
    return shutil.which("verapdf")


def _flavour(args: dict, path) -> str:
    f = str(args.get("flavour") or args.get("profile") or "").strip().lower().replace("pdf/a-", "").replace("pdf/ua-", "ua").replace("-", "")
    if f:
        if f not in FLAVOURS:
            raise ValueError(f"flavour is one of {', '.join(sorted(FLAVOURS))}")
        return f
    from . import core, pdfa

    root = core.reader(path).trailer["/Root"]
    part, conf, _x = pdfa._xmp_part(root)
    meta = root.get("/Metadata")
    text = ""
    try:
        text = meta.get_object().get_data().decode("utf-8", "replace") if meta is not None else ""
    except Exception:
        text = ""
    if pdfa.claims_ua(text):  # a file that claims both is checked for PDF/UA; ask for the PDF/A part by flavour
        return "ua1"
    if part:
        return f"{part}{(conf or 'b').lower()}"
    raise ValueError("The file claims neither PDF/A nor PDF/UA; say which to check as flavour, such as 2b or ua1")


def validate(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    args = args or {}
    exe = find()
    if not exe:
        raise ValueError("The veraPDF validator is not installed. formpdf uses it when it finds the verapdf command (from verapdf.org) "
                         "on the PATH or in the data folder's tools folder.")
    flavour = _flavour(args, path)
    try:
        got = subprocess.run([exe, "--flavour", flavour, "--format", "mrr", "--maxfailuresdisplayed", "5", str(path)],
                             capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        raise ValueError("The veraPDF check took longer than ten minutes and was stopped") from None
    except OSError as e:
        raise ValueError(f"The veraPDF validator could not run: {e}") from None
    xml = got.stdout[got.stdout.find("<"):] if "<" in got.stdout else ""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        raise ValueError(f"The veraPDF validator gave no report: {(got.stderr or got.stdout).strip()[:300]}") from None
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    report = root.find(".//validationReport")
    if report is None:
        raise ValueError("The veraPDF validator could not read the file")
    ok = report.get("isCompliant") == "true"
    profile = report.get("profileName") or flavour
    rules = []
    for rule in report.iter("rule"):
        if rule.get("status") != "failed":
            continue
        pages_ = sorted({int(m.group(1)) + 1 for c in rule.iter("check") for m in [re.search(r"pages\[(\d+)\]", c.findtext("context") or "")] if m})
        rules.append({"clause": rule.get("clause"), "test": rule.get("testNumber"), "failed": int(rule.get("failedChecks") or 0),
                      "text": (rule.findtext("description") or "").strip(), "pages": pages_[:50]})
    version = ""
    rel = root.find(".//buildInformation/releaseDetails[@id='core']")
    if rel is not None:
        version = rel.get("version") or ""
    n = len(rules)
    head = (f"veraPDF {version} finds that the file meets {profile}." if ok else
            f"veraPDF {version} finds that the file does not meet {profile}: {n} rule fails." if n == 1 else
            f"veraPDF {version} finds that the file does not meet {profile}: {n} rules fail.")
    lines = [f"- {r['clause']}-{r['test']}: {r['text'][:200]}" + (f" (pages {', '.join(map(str, r['pages'][:12]))})" if r["pages"] else "") for r in rules[:40]]
    return head + ("\n" + "\n".join(lines) if lines else ""), {"compliant": ok, "flavour": flavour, "profile": profile, "version": version, "rules": rules}


def installed(path=None, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    exe = find()
    return (f"veraPDF is at {exe}." if exe else "The veraPDF validator is not installed."), {"installed": bool(exe), "path": exe}


actions.register(actions.Action("verapdf", "read", "Validate with veraPDF", words=("verapdf", "validate pdf/a", "validate pdf/ua", "outside validator", "conformance"),
                                fields=(actions.Field("flavour", "Standard", "select", "", ("", "1a", "1b", "2a", "2b", "2u", "3a", "3b", "3u", "ua1", "ua2")),),
                                run=validate))
actions.register(actions.Action("verapdf_status", "read", "Is veraPDF installed", words=("verapdf",), run=installed))
