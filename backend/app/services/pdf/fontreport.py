import os
import re
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

from . import actions, core, pdfa

FONT_EXT = (".ttf", ".otf", ".ttc", ".otc", ".pfb", ".dfont")


def _key(name: str) -> str:
    name = re.sub(r"^[A-Z]{6}\+", "", name)
    name = re.sub(r"(PSMT|MT|PS)$", "", name.split(",")[0])
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _family_key(name: str) -> str:
    return re.split(r"(bold|italic|oblique|regular|light|medium|semibold|black|condensed|roman|book)", _key(name))[0]


def _font_dirs() -> list[Path]:
    home = Path.home()
    if sys.platform == "darwin":
        return [home / "Library/Fonts", Path("/Library/Fonts"), Path("/System/Library/Fonts"), Path("/System/Library/Fonts/Supplemental")]
    if os.name == "nt":
        return [Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts", home / "AppData/Local/Microsoft/Windows/Fonts"]
    return [home / ".fonts", home / ".local/share/fonts", Path("/usr/share/fonts"), Path("/usr/local/share/fonts")]


@lru_cache(maxsize=1)
def installed() -> frozenset[str]:
    names: set[str] = set()
    if shutil.which("fc-list"):
        try:
            out = subprocess.run(["fc-list", ":", "family", "postscriptname", "fullname"], capture_output=True, text=True, timeout=20).stdout
            for line in out.splitlines():
                for part in re.split(r"[:,]", line):
                    part = part.strip().removeprefix("postscriptname=").removeprefix("fullname=")
                    if part:
                        names.add(_key(part))
        except (OSError, subprocess.SubprocessError):
            pass
    for d in _font_dirs():
        if not d.is_dir():
            continue
        for p in d.rglob("*"):
            if p.suffix.lower() in FONT_EXT:
                names.add(_key(p.stem))
    names.discard("")
    return frozenset(names)


def report(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    doc = core.reader(path, passwords)
    have = installed()
    families = {_family_key(n) for n in have}
    rows: dict[str, dict] = {}
    for pi, _ref, f in pdfa.fonts(doc):
        raw = str(f.get("/BaseFont") or "").lstrip("/") or "(unnamed)"
        base = re.sub(r"^[A-Z]{6}\+", "", raw)
        row = rows.setdefault(base, {"name": base, "type": str(f.get("/Subtype") or "").lstrip("/"), "embedded": False, "subset": False,
                                     "pages": set(), "installed": False, "familyInstalled": False})
        row["embedded"] = row["embedded"] or pdfa.embedded(f)
        row["subset"] = row["subset"] or raw != base
        if pi is not None:
            row["pages"].add(int(pi) + 1)
        row["installed"] = _key(base) in have
        row["familyInstalled"] = row["installed"] or _family_key(base) in families
    out = []
    for row in sorted(rows.values(), key=lambda r: r["name"].lower()):
        row["pages"] = sorted(row["pages"])
        row["standard"] = row["name"] in pdfa.BASE14
        row["editable"] = row["installed"] or row["type"] == "Type3"
        row["state"] = ("embedded subset" if row["subset"] else "embedded") if row["embedded"] else "standard 14, supplied by readers" if row["standard"] else "not embedded"
        out.append(row)
    missing = [r["name"] for r in out if not r["embedded"] and not r["familyInstalled"] and not r["standard"]]
    lines = [f"{r['name']} · {r['type']} · {r['state']} · {'installed' if r['installed'] else 'family installed' if r['familyInstalled'] else 'not installed'}"
             f" · pages {','.join(map(str, r['pages'][:12]))}{'...' if len(r['pages']) > 12 else ''}" for r in out]
    head = f"{len(out)} fonts; {sum(1 for r in out if not r['embedded'])} not embedded; {len(missing)} neither embedded nor installed."
    return head + ("\n" + "\n".join(lines) if lines else ""), {"fonts": out, "missing": missing}


actions.register(actions.Action("fonts", "read", "Fonts used: embedded, subset and installed", words=("fonts", "font report", "missing fonts", "embedded fonts", "preflight fonts"),
                                run=report))
