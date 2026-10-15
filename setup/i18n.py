"""The interface strings and their translations.

  python3 setup/i18n.py keys [--json]   every English string the page translator can match, read from the source
  python3 setup/i18n.py parity          per language: missing keys, keys no longer in the source, broken placeholders

English is the key; each language's table is frontend/src/ui/i18n/<code>.ts. es-MX and fr-CA hold only what
differs from es and fr, so they are checked for broken placeholders but not for missing keys.
"""
import glob
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "src"
TABLES = SRC / "ui" / "i18n"
CODES = ["es", "es-MX", "pt-BR", "fr", "fr-CA", "de", "it", "nl", "da", "fi", "nb", "sv", "ru", "pl", "cs", "hu", "uk", "tr", "zh-CN",
         "zh-TW", "ja", "ko", "id", "th", "vi"]
VARIANTS = {"es-MX": "es", "fr-CA": "fr"}
KEEP_ENGLISH = {"PDF", "PDF/A", "PDF/X", "PDF/UA", "XFDF", "JSON", "CSV", "PNG", "JPEG", "GIF", "TIFF", "SVG", "OCR", "MCP", "Ctrl", "Alt", "Shift",
                "Cmd", "Esc", "Tab", "Enter", "formpdf", "Claude Code", "Codex", "Cursor", "Anthropic", "OpenAI", "Ollama", "LM Studio", "Bates"}

TEXT = re.compile(r">([^<>`]+)<")
ATTR = re.compile(r'\b(?:title|aria-label|placeholder)="([^"$]+)"')
QUOTED = re.compile(r"'((?:[^'\\\n]|\\.){2,400})'")
CODEISH = re.compile(r"[\n;{}=]|&&|\|\||\bthis\.|\bq\(|\)\.|=>|\bawait\b|\bconst\b|\breturn\b|Promise|\?:|: (string|number|boolean)\b|\.fs-|\bfs-|^[a-z]")
BACKEND = [ROOT / "backend" / "app" / "services" / "pdf" / "access.py", ROOT / "backend" / "app" / "services" / "pdf" / "preflight.py"]
RULE = re.compile(r'_rule\("[a-z_]+", [A-Z], "([^"]+)"|_check\("[a-z_]+", "([^"]+)"')


def clean(s: str) -> str | None:
    s = s.strip().replace("\\'", "'")
    if s.endswith("…"):
        s = s[:-1].rstrip()
    if s.endswith(":") and not s.endswith("::"):
        s = s[:-1]
    if len(s) < 2 or len(s) > 400 or "${" in s or not re.search(r"[A-Za-z]{2}", s) or CODEISH.search(s) or s in KEEP_ENGLISH:
        return None
    if re.fullmatch(r"[A-Za-z0-9_.#:/%\-\[\]\"' >*(),+]+", s) and not re.search(r"[A-Z]", s):
        return None
    return s


def keys() -> list[str]:
    found: set[str] = set()
    for f in glob.glob(str(SRC / "**" / "*.ts"), recursive=True):
        if "/i18n/" in f.replace("\\", "/") or f.endswith("i18n.ts"):
            continue
        src = Path(f).read_text(encoding="utf-8")
        for m in TEXT.finditer(src):
            if "${" not in m.group(1) and (s := clean(m.group(1))):
                found.add(s)
        for m in ATTR.finditer(src):
            if s := clean(m.group(1)):
                found.add(s)
        for m in QUOTED.finditer(src):
            raw = m.group(1)
            if re.match(r"[A-Z]", raw) and (" " in raw or re.fullmatch(r"[A-Z][a-z]+", raw)) and (s := clean(raw)):
                found.add(s)
    for f in BACKEND:
        if f.is_file():
            for m in RULE.finditer(f.read_text(encoding="utf-8")):
                found.add(m.group(1) or m.group(2))
    return sorted(found)


def table(code: str) -> dict[str, str]:
    f = TABLES / f"{code}.ts"
    if not f.is_file():
        return {}
    body = f.read_text(encoding="utf-8")
    start, end = body.find("{"), body.rfind("}")
    return json.loads(body[start:end + 1])


def holes(s: str) -> list[str]:
    return sorted(re.findall(r"\{[a-z0-9_]+\}|%[sd]|\$\{[^}]*\}|<[^>]+>", s))


def parity() -> int:
    want = keys()
    bad = 0
    print(f"{len(want)} keys in the source")
    for code in CODES:
        t = table(code)
        if not t:
            print(f"{code:6} no table")
            bad += 1
            continue
        missing = [] if code in VARIANTS else [k for k in want if k not in t]
        stale = [k for k in t if k not in want]
        broken = [k for k, v in t.items() if holes(k) != holes(v) or not str(v).strip()]
        if missing or broken:
            bad += 1
        print(f"{code:6} {len(t):5} entries, {len(missing)} missing, {len(stale)} no longer in the source, {len(broken)} broken placeholders"
              + (f"; first missing: {missing[0]!r}" if missing else "") + (f"; first broken: {broken[0]!r}" if broken else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "parity"
    if cmd == "keys":
        k = keys()
        print(json.dumps(k, ensure_ascii=False, indent=0) if "--json" in sys.argv else "\n".join(k))
    else:
        sys.exit(parity())
