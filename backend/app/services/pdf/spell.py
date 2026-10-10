import io
import re
import threading
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, TextStringObject

from app.core import config

from . import actions, annot, core

DEFAULT_LANG = "en_US"
MAX_ISSUES = 2000
MAX_SUGGEST = 400
MAX_DEEP = 40
MAX_TEXT = 200_000
TOKEN = re.compile(r"[\w'’]+")
SKIP = re.compile(r"(?:https?://|www\.)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b[\w-]+\.(?:com|org|net|io|gov|edu|pdf|docx?|xlsx?|png|jpe?g)\b", re.I)
_lock = threading.Lock()
_cache: dict[str, "Dictionary"] = {}


def _roots() -> list[Path]:
    return [config.dict_dir(), config.data_dir() / "dictionaries"]


def languages() -> list[str]:
    found: set[str] = set()
    for root in _roots():
        if root.is_dir():
            for d in root.iterdir():
                if (d / f"{d.name}.dic").is_file() and (d / f"{d.name}.aff").is_file():
                    found.add(d.name)
    return sorted(found)


def _norm_lang(lang: str | None) -> str:
    raw = str(lang or "").replace("-", "_").strip()
    have = languages()
    if raw in have:
        return raw
    base = raw.split("_")[0].lower()
    for h in have:
        if h.split("_")[0].lower() == base and base:
            return h
    return DEFAULT_LANG if DEFAULT_LANG in have else (have[0] if have else DEFAULT_LANG)


class Dictionary:
    def __init__(self, dic: Path, aff: Path):
        self.words: set[str] = set()
        self.by_lower: dict[str, str] = {}
        self.nosuggest: set[str] = set()
        self.rep: list[tuple[str, str]] = []
        self.try_chars = "esianrtolcdugmphbyfvkwz'"
        self.flag_mode = "char"
        self.sfx: dict[str, tuple[bool, list]] = {}
        self.pfx: dict[str, tuple[bool, list]] = {}
        self.special = {"nosuggest": None, "onlyincompound": None, "forbidden": None}
        self._aff(aff.read_text(encoding="utf-8", errors="replace"))
        self._dic(dic.read_text(encoding="utf-8", errors="replace"))

    def _flags(self, s: str) -> list[str]:
        if self.flag_mode == "long":
            return [s[i:i + 2] for i in range(0, len(s) - 1, 2)]
        if self.flag_mode == "num":
            return [x for x in s.split(",") if x]
        return list(s)

    def _aff(self, text: str) -> None:
        lines = [ln.split("#", 1)[0].rstrip() if not ln.lstrip().startswith("REP") else ln.rstrip() for ln in text.splitlines()]
        i = 0
        while i < len(lines):
            parts = lines[i].split()
            i += 1
            if not parts:
                continue
            key = parts[0]
            if key == "FLAG" and len(parts) > 1:
                self.flag_mode = {"long": "long", "num": "num"}.get(parts[1], "char")
            elif key == "TRY" and len(parts) > 1:
                self.try_chars = parts[1].lower()
            elif key in ("NOSUGGEST", "ONLYINCOMPOUND", "FORBIDDENWORD") and len(parts) > 1:
                self.special[{"NOSUGGEST": "nosuggest", "ONLYINCOMPOUND": "onlyincompound", "FORBIDDENWORD": "forbidden"}[key]] = parts[1]
            elif key == "REP" and len(parts) == 3:
                self.rep.append((parts[1].replace("_", " "), parts[2].replace("_", " ")))
            elif key in ("SFX", "PFX") and len(parts) == 4 and parts[3].isdigit():
                flag, cross, n = parts[1], parts[2] == "Y", int(parts[3])
                rules = []
                for _ in range(n):
                    if i >= len(lines):
                        break
                    rp = lines[i].split()
                    i += 1
                    if len(rp) < 4 or rp[0] != key:
                        continue
                    strip = "" if rp[2] == "0" else rp[2]
                    add = rp[3].split("/", 1)[0]
                    add = "" if add == "0" else add
                    cond = rp[4] if len(rp) > 4 else "."
                    try:
                        pat = re.compile((cond + "$") if key == "SFX" else ("^" + cond))
                    except re.error:
                        continue
                    rules.append((strip, add, pat))
                (self.sfx if key == "SFX" else self.pfx)[flag] = (cross, rules)

    def _add(self, w: str, quiet: bool) -> None:
        self.words.add(w)
        self.by_lower.setdefault(w.lower(), w)
        if quiet:
            self.nosuggest.add(w)

    def _dic(self, text: str) -> None:
        lines = text.splitlines()
        start = 1 if lines and lines[0].strip().isdigit() else 0
        sp = self.special
        for ln in lines[start:]:
            ln = ln.strip()
            if not ln or ln.startswith("#"):
                continue
            word, _, fl = ln.partition("/")
            word = word.split("\t", 1)[0].split(" ", 1)[0]
            flags = self._flags(fl.split()[0]) if fl else []
            if any(ch.isdigit() for ch in word) or (sp["onlyincompound"] and sp["onlyincompound"] in flags) or (sp["forbidden"] and sp["forbidden"] in flags):
                continue
            quiet = bool(sp["nosuggest"] and sp["nosuggest"] in flags)
            self._add(word, quiet)
            suffixed: list[tuple[str, bool]] = []
            for f in flags:
                if f in self.sfx:
                    cross, rules = self.sfx[f]
                    for strip, add, pat in rules:
                        if pat.search(word) and (not strip or word.endswith(strip)):
                            form = (word[: len(word) - len(strip)] if strip else word) + add
                            self._add(form, quiet)
                            suffixed.append((form, cross))
            for f in flags:
                if f in self.pfx:
                    cross, rules = self.pfx[f]
                    for strip, add, pat in rules:
                        bases = [word] + [s for s, c in suffixed if c and cross]
                        for base in bases:
                            if pat.search(base) and (not strip or base.startswith(strip)):
                                self._add(add + base[len(strip):], quiet)

    def known(self, w: str) -> bool:
        if w in self.words:
            return True
        if len(w) > 1 and w[0].isupper() and w[1:].islower() and w.lower() in self.words:
            return True
        if len(w) > 1 and w.isupper() and w.lower() in self.by_lower:
            return True
        return False

    def _cand(self, w: str) -> str | None:
        hit = self.by_lower.get(w)
        return hit if hit is not None and hit not in self.nosuggest else None

    def _edits1(self, w: str) -> dict[str, float]:
        letters = self.try_chars or "abcdefghijklmnopqrstuvwxyz"
        vowels = "aeiouy"
        out: dict[str, float] = {}

        def put(c: str, cost: float) -> None:
            if cost < out.get(c, 9):
                out[c] = cost

        for i in range(len(w) + 1):
            a, b = w[:i], w[i:]
            if b:
                doubled = (a and a[-1] == b[0]) or (len(b) > 1 and b[1] == b[0])
                put(a + b[1:], 0.5 if doubled else 1.0)
                for c in letters:
                    if c != b[0]:
                        put(a + c + b[1:], 0.6 if (c in vowels and b[0] in vowels) else 1.0)
            if len(b) > 1 and b[0] != b[1]:
                put(a + b[1] + b[0] + b[2:], 0.5)
            for c in letters:
                near = (a and a[-1] == c) or (b and b[0] == c)
                put(a + c + b, 0.5 if near else 0.8 if c in vowels else 1.0)
        return out

    def suggest(self, word: str, n: int = 6, deep: bool = True) -> list[str]:
        w = word.replace("’", "'")
        low = w.lower()
        scored: dict[str, float] = {}

        def put(c: str, cost: float) -> None:
            hit = self._cand(c)
            if not hit:
                return
            if hit.lower() == low:
                cost = -1.0 if hit != w else 9
            if hit[:1].isupper() and not w[:1].isupper():
                cost += 0.6
            if hit[:1].lower() != low[:1]:
                cost += 0.4
            cost += 0.05 * abs(len(hit) - len(low))
            if cost < scored.get(hit, 9):
                scored[hit] = cost

        put(low, 0)
        for a, b in self.rep:
            start = low.find(a)
            while start >= 0:
                cand = low[:start] + b + low[start + len(a):]
                if " " in cand:
                    if all(self._cand(p) for p in cand.split(" ")):
                        scored.setdefault(cand, 0.4)
                else:
                    put(cand, 0.4)
                start = low.find(a, start + 1)
        one = self._edits1(low)
        for c, cost in one.items():
            put(c, cost)
        for i in range(3, len(low) - 2):
            a, b = low[:i], low[i:]
            if a in self.words and b in self.words and a not in self.nosuggest and b not in self.nosuggest:
                scored.setdefault(f"{a} {b}", 1.5)
        if deep and len([c for c, s in scored.items() if s < 1.2]) < n and len(low) <= 14:
            for e, c1 in one.items():
                for c, c2 in self._edits1(e).items():
                    if c in self.by_lower:
                        put(c, 1.0 + c1 + c2)
        ranked = sorted((c for c in scored if scored[c] < 9), key=lambda c: scored[c])[:n]
        return [_recase(c, w) for c in ranked]


def _recase(cand: str, like: str) -> str:
    if len(like) > 1 and like.isupper():
        return cand.upper()
    if like[:1].isupper() and not cand[:1].isupper():
        return cand[:1].upper() + cand[1:]
    return cand


def dictionary(lang: str | None = None) -> Dictionary:
    code = _norm_lang(lang)
    with _lock:
        got = _cache.get(code)
        if got is None:
            for root in _roots():
                d = root / code
                if (d / f"{code}.dic").is_file() and (d / f"{code}.aff").is_file():
                    got = Dictionary(d / f"{code}.dic", d / f"{code}.aff")
                    break
            if got is None:
                raise ValueError(f"No {code} dictionary is installed")
            _cache[code] = got
    return got


def user_words() -> set[str]:
    raw = config.read_settings().get("dictionary") or []
    return {str(w).strip() for w in raw if str(w).strip()} if isinstance(raw, list) else set()


def check(text: str, d: Dictionary, extra: set[str], caps: bool = True) -> list[tuple[int, str]]:
    text = (text or "")[:MAX_TEXT]
    masked = SKIP.sub(lambda m: " " * len(m.group(0)), text)
    extra_low = {w.lower() for w in extra}
    out = []
    for m in TOKEN.finditer(masked):
        tok, off = m.group(0), m.start()
        lead = len(tok) - len(tok.lstrip("'’"))
        tok = tok.strip("'’")
        off += lead
        if len(tok) < 2 or any(ch.isdigit() or ch == "_" for ch in tok):
            continue
        if caps and tok.isupper():
            continue
        if tok.lower() in extra_low:
            continue
        norm = tok.replace("’", "'")
        if d.known(norm):
            continue
        if norm.lower().endswith("'s") and d.known(norm[:-2]):
            continue
        if any(ch.isupper() for ch in norm[1:]) and not norm.isupper():
            continue
        out.append((off, tok))
    return out


def _sources(path, args: dict, passwords) -> list[dict]:
    scope = args.get("scope") or (["comments", "fields"] if not args.get("texts") else [])
    if isinstance(scope, str):
        scope = [s.strip() for s in scope.split(",") if s.strip()]
    out: list[dict] = []
    for t in args.get("texts") or []:
        if isinstance(t, dict) and str(t.get("text") or "").strip():
            out.append({"where": "text", "id": str(t.get("id") or ""), "text": str(t["text"])})
    if "comments" in scope:
        for c in annot.comments(path, passwords):
            if c["text"].strip():
                out.append({"where": "comment", "page": c["page"], "index": c["index"], "nm": c["nm"], "kind": c["kind"], "rect": c["rect"], "text": c["text"]})
    if "fields" in scope:
        from .edit import read_fields

        try:
            fields = read_fields(path, passwords)
        except ValueError:
            fields = []
        for f in fields:
            if f["type"] == "text" and str(f.get("value") or "").strip() and not f.get("readonly"):
                out.append({"where": "field", "name": f["name"], "page": f["page"], "rect": {k: f[k] for k in ("x", "y", "w", "h")}, "text": str(f["value"])})
    if "pages" in scope:
        for p in core.extract_text(path, args.get("pages"), passwords)[:500]:
            if p["text"].strip():
                out.append({"where": "page", "page": p["page"], "text": p["text"]})
    return out


def read(path, *, args: dict, pages=None, passwords: list[str] | None = None):
    args = dict(args or {})
    if pages and not args.get("pages"):
        args["pages"] = pages
    d = dictionary(args.get("lang") or config.read_settings().get("spellLang"))
    extra = user_words() | {str(w) for w in (args.get("ignore") or []) if str(w).strip()}
    caps = bool(args.get("skip_caps", True))
    want = bool(args.get("suggest", True))
    issues: list[dict] = []
    words = 0
    deep_left = MAX_DEEP
    memo: dict[str, list[str]] = {}
    for src in _sources(path, args, passwords):
        text = src.pop("text")
        words += len(TOKEN.findall(text))
        for off, word in check(text, d, extra, caps):
            if len(issues) >= MAX_ISSUES:
                break
            item = {**src, "word": word, "offset": off, "context": text[max(0, off - 30): off + len(word) + 30].replace("\n", " ")}
            if want and len(issues) < MAX_SUGGEST:
                if word not in memo:
                    memo[word] = d.suggest(word, deep=deep_left > 0)
                    deep_left -= 1
                item["suggestions"] = memo[word]
            issues.append(item)
    lang = _norm_lang(args.get("lang") or config.read_settings().get("spellLang"))
    lines = [f"{i['where']} {i.get('name') or i.get('id') or ('p' + str(i.get('page')) + (' #' + str(i['index']) if 'index' in i else ''))}: {i['word']}"
             + (f" -> {', '.join(i.get('suggestions', [])[:3])}" if i.get("suggestions") else "") for i in issues[:200]]
    head = f"{len(issues)} possible misspelling{'s' if len(issues) != 1 else ''} in {words} words ({lang})."
    return "\n".join([head, *lines]), {"issues": issues, "count": len(issues), "words": words, "lang": lang, "languages": languages()}


def _swap(text: str, fix: dict) -> str:
    word, to = str(fix.get("word") or ""), str(fix.get("to") if fix.get("to") is not None else "")
    if not word:
        raise ValueError("Each fix needs the word it replaces")
    try:
        off = int(fix.get("offset"))
    except (TypeError, ValueError):
        off = -1
    if not (0 <= off and text[off: off + len(word)] == word):
        found = [m.start() for m in re.finditer(rf"(?<![\w']){re.escape(word)}(?![\w'])", text)]
        if not found:
            raise ValueError(f"\"{word}\" is no longer there")
        off = min(found, key=lambda x: abs(x - off)) if off >= 0 else found[0]
    return text[:off] + to + text[off + len(word):]


def _freetext_ap(w: PdfWriter, page, a: DictionaryObject, text: str) -> None:
    x0, y0, x1, y1 = core.view_box(page)
    rx0, ry0, rx1, ry1 = (float(v) for v in (a.get("/Rect") or [0, 0, 0, 0]))
    rx0, rx1 = sorted((rx0, rx1))
    ry0, ry1 = sorted((ry0, ry1))
    da = str(a.get("/DA") or "")
    size = re.search(r"([\d.]+)\s+Tf", da)
    col = re.search(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg", da)
    color = "#%02X%02X%02X" % tuple(round(float(v) * 255) for v in col.groups()) if col else "#111111"
    W, H = x1 - x0, y1 - y0
    spec = {"kind": "freetext", "page": 1, "x": rx0 - x0, "y": y1 - ry1, "w": rx1 - rx0, "h": ry1 - ry0, "text": text,
            "size": float(size.group(1)) if size else 12, "color": color, "opacity": float(a.get("/CA", 1) or 1)}
    if "/IC" in a and len(a["/IC"]) >= 3:
        spec["fill"] = "#%02X%02X%02X" % tuple(round(float(v) * 255) for v in list(a["/IC"])[:3])
    n = annot.normalize(spec, [(W, H)])
    from reportlab.pdfgen import canvas as rlcanvas

    buf = io.BytesIO()
    c = rlcanvas.Canvas(buf, pagesize=(W, H))
    annot.draw(c, n, H, False)
    c.showPage()
    c.save()
    bx0, by0, bx1, by1 = annot.bbox(n)
    ap = annot._form(w, PdfReader(io.BytesIO(buf.getvalue())).pages[0], [bx0, H - by1, bx1, H - by0])
    a[NameObject("/AP")] = DictionaryObject({NameObject("/N"): ap})


def change(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    fixes = [f for f in (args or {}).get("fixes") or [] if isinstance(f, dict)]
    if not fixes:
        raise ValueError("There are no spelling fixes to apply")
    w = PdfWriter(clone_from=core.reader(src, passwords))
    done = {"comments": 0, "fields": 0}
    groups: dict[tuple, list[dict]] = {}
    for f in fixes:
        if f.get("where") == "comment":
            groups.setdefault(("c", int(f.get("page") or 0), int(f.get("index") if f.get("index") is not None else -1), str(f.get("nm") or "")), []).append(f)
        elif f.get("where") == "field":
            groups.setdefault(("f", str(f.get("name") or "")), []).append(f)
        else:
            raise ValueError("A fix is for a comment (page and index) or a form field (name)")
    values: dict[str, str] = {}
    current = None
    for key, items in groups.items():
        items.sort(key=lambda f: -int(f.get("offset") or 0))
        if key[0] == "c":
            req = {"page": key[1], "target": {"index": key[2], "nm": key[3]}}
            pi, ref = annot._target(w, req)
            a = ref.get_object()
            text = annot._text(a.get("/Contents"))
            for f in items:
                text = _swap(text, f)
            a[NameObject("/Contents")] = TextStringObject(text)
            a[NameObject("/M")] = TextStringObject(annot._pdf_date())
            if a.get("/Subtype") == "/FreeText":
                _freetext_ap(w, w.pages[pi], a, text)
            done["comments"] += 1
        else:
            if current is None:
                from .edit import read_fields

                current = {f["name"]: str(f.get("value") or "") for f in read_fields(src, passwords)}
            if key[1] not in current:
                raise ValueError(f"There is no form field named {key[1]}")
            text = current[key[1]]
            for f in items:
                text = _swap(text, f)
            values[key[1]] = text
            done["fields"] += 1
    if values:
        buf = io.BytesIO()
        w.write(buf)
        tmp = Path(str(out) + ".spell.pdf")
        tmp.write_bytes(buf.getvalue())
        try:
            from .edit import fill_fields

            fill_fields(tmp, out, values)
        finally:
            tmp.unlink(missing_ok=True)
    else:
        with open(out, "wb") as fh:
            w.write(fh)
    return {"pages": len(w.pages), "fixed": done["comments"] + done["fields"], **done}


actions.register(actions.Action("spell", "read", "Check spelling", words=("spelling", "spell check", "typos", "dictionary", "proofread"),
                                fields=(actions.Field("scope", "Check", "text", "comments,fields", hint="comments, fields, pages"),
                                        actions.Field("lang", "Language", "text", "", hint="en_US or a dictionary in Formpdf/dictionaries")),
                                run=read))
actions.register(actions.Action("spell_fix", "change", "Fix spelling", "spelling", ("spelling", "fix typos", "correct"), run=change))
