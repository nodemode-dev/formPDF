import os
import re
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

import json

from pypdf import PdfWriter
from pypdf.generic import NameObject, TextStringObject

from . import actions, core, fontkit, pdfa

FONT_EXT = (".ttf", ".otf", ".ttc", ".otc", ".pfb", ".dfont")
MAP_KEY = NameObject("/FormpdfFontMap")
FAMILIES = ("sans", "serif", "mono")


def font_map(doc) -> dict[str, str]:
    root = doc.root_object
    try:
        raw = json.loads(str(root.get(MAP_KEY, "{}")))
    except ValueError:
        return {}
    return {str(k)[:120]: v for k, v in raw.items() if fontkit.known(v)} if isinstance(raw, dict) else {}


def change_map(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    w = PdfWriter(clone_from=core.reader(src, passwords))
    current = font_map(w)
    asked = (args or {}).get("map") or {}
    if not isinstance(asked, dict) or not asked:
        raise ValueError("map is {font name: sans | serif | mono | sys:<installed family> | null}; null goes back to the font itself")
    for name, fam in asked.items():
        name = re.sub(r"^[A-Z]{6}\+", "", str(name))[:120]
        if fontkit.known(fam):
            current[name] = fam
        elif fam in (None, "", "keep"):
            current.pop(name, None)
        else:
            raise ValueError(f"{fam} is not sans, serif, mono or an installed font family (see font_families)")
    w.root_object[MAP_KEY] = TextStringObject(json.dumps(current, ensure_ascii=False, separators=(",", ":")))
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "map": current, "fonts": len(current)}


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
    mapped = font_map(doc)
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
        row["editWith"] = mapped.get(row["name"], "")
        row["editable"] = row["installed"] or row["type"] == "Type3"
        row["state"] = ("embedded subset" if row["subset"] else "embedded") if row["embedded"] else "standard 14, supplied by readers" if row["standard"] else "not embedded"
        out.append(row)
    missing = [r["name"] for r in out if not r["embedded"] and not r["familyInstalled"] and not r["standard"]]
    lines = [f"{r['name']} · {r['type']} · {r['state']} · {'installed' if r['installed'] else 'family installed' if r['familyInstalled'] else 'not installed'}"
             f"{' · edited as ' + r['editWith'] if r['editWith'] else ''} · pages {','.join(map(str, r['pages'][:12]))}{'...' if len(r['pages']) > 12 else ''}" for r in out]
    head = f"{len(out)} fonts; {sum(1 for r in out if not r['embedded'])} not embedded; {len(missing)} neither embedded nor installed."
    return head + ("\n" + "\n".join(lines) if lines else ""), {"fonts": out, "missing": missing, "map": mapped}


actions.register(actions.Action("fonts", "read", "Fonts used: embedded, subset and installed", words=("fonts", "font report", "missing fonts", "embedded fonts", "preflight fonts"),
                                run=report))
actions.register(actions.Action("font_map", "change", "Edit a font as another family", "fontmap", ("font map", "swap font", "replace font", "substitute font", "missing font"),
                                run=change_map))
actions.register(actions.Action("font_families", "read", "Font families for editing text: formpdf's and those installed on this computer",
                                words=("font families", "installed fonts", "system fonts", "choose font"), run=fontkit.families))
