"""The interface strings and their translations.

  python3 setup/i18n.py keys [--json]   every English string the page translator can match, read from the source
  python3 setup/i18n.py parity          per language: missing keys, keys no longer in the source, broken placeholders

English is the key; each language's table is frontend/src/ui/i18n/<code>.ts. es-MX and fr-CA hold only what
differs from es and fr, so they are checked for broken placeholders but not for missing keys.
"""
import ast
import glob
import html
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

TEXT = re.compile(r">((?:[^<>`]|(?<= )>(?= ))+)<")  # a > between spaces is a menu path in the text, not the end of a tag
TF = re.compile(r"\btf\('((?:[^'\\\n]|\\.)+)'")  # message templates the window builds with tf()
EXPR = re.compile(r"\$\{(?:[^{}]|\{[^{}]*\})*\}")
ATTR = re.compile(r'\b(?:title|aria-label|placeholder)="([^"$]+)"')
QUOTED = re.compile(r"'((?:[^'\\\n]|\\.){2,400})'")
CODEISH = re.compile(r"[\n{}=]|^;|;\s*$|;\s*[A-Za-z_$][\w$.]*\s*[=(.\[]|&&|\|\||\bthis\.|\bq\(|\)\.|=>|\bawait\b|\bconst\b|\breturn\b|Promise|\?:|: (string|number|boolean)\b|\.fs-|\bfs-|^[a-z]")
BACKEND = [ROOT / "backend" / "app" / "services" / "pdf" / "access.py", ROOT / "backend" / "app" / "services" / "pdf" / "preflight.py"]
RULE = re.compile(r'_rule\("[a-z_]+", [A-Z], "([^"]+)"|_check\("[a-z_]+", "([^"]+)"')


def clean(s: str) -> str | None:
    s = html.unescape(s.strip().replace("\\'", "'"))
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
        if "/i18n/" in f.replace("\\", "/") or f.endswith("i18n.ts") or f.endswith("command-meta.ts"):  # command-meta is for agents, never on screen
            continue
        src = Path(f).read_text(encoding="utf-8")
        for m in TEXT.finditer(src):
            if "${" not in m.group(1):
                if s := clean(m.group(1)):
                    found.add(s)
                continue
            # Text beside an expression (an icon before a button label, say) lands in its own text node on the page.
            for part in EXPR.split(m.group(1)):
                if "${" not in part and "}" not in part and re.match(r"\s*[A-Za-z]", part) and (s := clean(part)):
                    found.add(s)
        for m in TF.finditer(src):
            found.add(m.group(1))
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
    found |= set(patterns())
    found |= set(engine())
    return sorted(found)


def _templates(src: str):
    """Top-level template literals as (text parts, expressions), nested templates kept inside their expression."""
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c in "'\"":
            j = i + 1
            while j < n and src[j] != c and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            i = j + 1
            continue
        if src.startswith("//", i):
            i = src.find("\n", i)
            i = n if i < 0 else i
            continue
        if c != "`":
            i += 1
            continue
        parts, exprs, buf, j = [], [], "", i + 1
        while j < n and src[j] != "`":
            if src[j] == "\\":
                buf += src[j:j + 2]
                j += 2
            elif src.startswith("${", j):
                depth, k = 1, j + 2
                while k < n and depth:
                    if src[k] == "`":
                        k = src.find("`", k + 1) + 1 or n
                        continue
                    depth += 1 if src[k] == "{" else -1 if src[k] == "}" else 0
                    k += 1
                parts.append(buf)
                exprs.append(src[j + 2:k - 1])
                buf, j = "", k
            else:
                buf += src[j]
                j += 1
        parts.append(buf)
        yield parts, exprs
        i = j + 1


MARKUP = re.compile(r"icon\(|svg\(|\.map\(|\.join\(|Html|html|<|\bel\(|row\(|sec\(|btn|LOCAL\.|calc\(|style|class|\bnum\(|quad\(")


def patterns(hints: dict | None = None) -> list[str]:
    """Run-time text built from a template: each ${...} that holds a value becomes {0}, {1}... in order."""
    found: set[str] = set()
    for f in glob.glob(str(SRC / "**" / "*.ts"), recursive=True):
        if "/i18n/" in f.replace("\\", "/") or f.endswith("i18n.ts"):
            continue
        for parts, exprs in _templates(Path(f).read_text(encoding="utf-8")):
            if not exprs:
                continue
            text = parts[0]
            for e, p in zip(exprs, parts[1:]):
                text += ("\x00" if MARKUP.search(e) else "\x01") + p
            values = [e for e in exprs if not MARKUP.search(e)]
            used = 0
            for seg in re.split(r"<[^>]*>|\x00", text):
                if "\x01" not in seg:
                    continue
                mine = values[used:used + seg.count("\x01")]
                used += seg.count("\x01")
                if hints is not None:
                    hints.setdefault(seg.strip().replace("\x01", "{}"), mine)
                k = 0
                out = ""
                for ch in seg:
                    if ch == "\x01":
                        out += "{" + str(k) + "}"
                        k += 1
                    else:
                        out += ch
                s = out.strip()
                words = re.sub(r"\{\d+\}", " ", s)
                if (len(re.findall(r"[A-Za-z]{2,}", words)) < 2 or re.search(r"[\n=]|^;|;\s*$|=>|\bfs-|\$|\\|[{}](?!\d)|(?<!\d)}", re.sub(r"\{\d+\}", "", s))
                        or not re.match(r"[A-Z\"(]|\{\d+\}\s?[A-Za-z]", s) or len(s) > 400 or re.fullmatch(r"[\w./:-]*\{\d+\}[\w./:-]*", s)):
                    continue
                found.add(s)
                if hints is not None:
                    hints[s] = mine
    return sorted(found)


def table(code: str) -> dict[str, str]:
    f = TABLES / f"{code}.ts"
    if not f.is_file():
        return {}
    body = f.read_text(encoding="utf-8")
    start, end = body.find("{"), body.rfind("}")
    return json.loads(body[start:end + 1])


EXC = {"ValueError", "PermissionError", "FileNotFoundError", "RuntimeError", "LookupError", "HTTPException", "KeyError", "TypeError"}


def _py_texts(node):
    """The strings an expression can produce, with each formatted value as {0}, {1}... (and the code that fills it)."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        yield node.value, []
    elif isinstance(node, ast.JoinedStr):
        out, code = "", []
        for v in node.values:
            if isinstance(v, ast.Constant):
                out += str(v.value)
            else:
                out += "{%d}" % len(code)
                code.append(ast.unparse(v.value))
        yield out, code
    elif isinstance(node, ast.IfExp):
        yield from _py_texts(node.body)
        yield from _py_texts(node.orelse)
    elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = list(_py_texts(node.left)), list(_py_texts(node.right))
        if len(left) * len(right) <= 4:
            for a, ca in left:
                for b, cb in right:
                    yield a + re.sub(r"\{(\d+)\}", lambda m, k=len(ca): "{%d}" % (int(m.group(1)) + k), b), ca + cb


def engine(hints: dict | None = None) -> list[str]:
    """Messages the engine sends the window: errors it raises and the sentences preflight reports, as keys or patterns."""
    found: set[str] = set()
    for f in sorted(glob.glob(str(ROOT / "backend" / "app" / "**" / "*.py"), recursive=True)):
        for n in ast.walk(ast.parse(Path(f).read_text(encoding="utf-8"))):
            args = []
            if isinstance(n, ast.Raise) and isinstance(n.exc, ast.Call) and getattr(n.exc.func, "id", getattr(n.exc.func, "attr", "")) in EXC:
                args = n.exc.args[:1] + [k.value for k in n.exc.keywords if k.arg == "detail"]
            elif isinstance(n, ast.Call) and getattr(n.func, "id", "") == "_check" and len(n.args) >= 4:
                args = [n.args[3]]
            for a in args:
                for s, code in _py_texts(a):
                    s = s.strip()
                    bare = re.sub(r"\{\d+\}", "", s)
                    if len(re.findall(r"[A-Za-z]{2,}", bare)) < 2 or not re.match(r"[A-Z{(\"]", s) or re.search(r"[{}=\[\]]|\b[a-z]+_[a-z_]+\b|\\n|\n", bare):
                        continue
                    found.add(s)
                    if hints is not None:
                        hints[s] = code
    return sorted(found)


def holes(s: str) -> list[str]:
    return sorted(re.findall(r"\{[a-z0-9_]+\}|%[sd]|\$\{[^}]*\}|<<?[^<>]+>>?", s))


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
        broken = [k for k, v in t.items() if not str(v).strip() or (not set(holes(v)) <= set(holes(k)) if re.search(r"\{\d+\}", k) else holes(k) != holes(v))]
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
