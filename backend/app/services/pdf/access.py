import datetime
import html
import re
from collections import Counter

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, ContentStream, DecodedStreamObject, DictionaryObject, FloatObject, IndirectObject,
                           NameObject, NullObject, NumberObject, StreamObject, TextStringObject)

from app.core import config

from . import actions, contrast, core, frame, layout, sanitize
from .content import interp

STANDARD = {"/Document", "/DocumentFragment", "/Part", "/Art", "/Sect", "/Div", "/BlockQuote", "/Caption", "/TOC", "/TOCI", "/Index", "/NonStruct",
            "/Private", "/Aside", "/Title", "/FENote", "/Sub", "/P", "/H", "/H1", "/H2", "/H3", "/H4", "/H5", "/H6", "/L", "/LI", "/Lbl", "/LBody",
            "/Table", "/TR", "/TH", "/TD", "/THead", "/TBody", "/TFoot", "/Span", "/Quote", "/Note", "/Reference", "/BibEntry", "/Code", "/Link",
            "/Annot", "/Ruby", "/RB", "/RT", "/RP", "/Warichu", "/WT", "/WP", "/Figure", "/Formula", "/Form", "/Em", "/Strong", "/Artifact"}
GROUPS = {"/Document", "/DocumentFragment", "/Part", "/Art", "/Sect", "/Div", "/NonStruct", "/Private", "/Aside", "/StructTreeRoot"}
HEADS = {"/H", "/H1", "/H2", "/H3", "/H4", "/H5", "/H6"}
RETAG = ("P", "H1", "H2", "H3", "H4", "H5", "H6", "BlockQuote", "Caption", "Note", "Code", "Formula", "Figure", "Span")
GROUP_NAMES = ("Document", "Page content", "Forms", "Alternate text", "Tables", "Lists", "Headings", "Tag correctness")
FIXES = ("tag", "title", "lang", "tabs", "annotations", "descriptions", "summaries", "bookmarks", "headings", "spans", "rtl")
MAX_NODES = 200_000
MAX_DEPTH = 256
TEXT_OPS = {b"Tj", b"TJ", b"'", b'"'}
BUILD = {b"m", b"l", b"c", b"v", b"y", b"h", b"re", b"W", b"W*"}
BOUNDS = {b"BT", b"ET", b"q", b"Q"}
MEDIA = {"/Screen", "/Movie", "/Sound", "/RichMedia", "/3D"}


def _o(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def default_lang() -> str:
    raw = str(config.read_settings().get("spellLang") or "en_US")
    return raw.replace("_", "-") if re.fullmatch(r"[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*", raw) else "en-US"


def real_title(v) -> str:
    t = re.sub(r"\s+", " ", str(v or "")).strip()
    return "" if t.lower() in ("untitled", "untitled document", "anonymous", "document", "title") else t


def _role(s: str, rolemap) -> str:
    seen = set()
    while s not in STANDARD and rolemap is not None and s in rolemap and s not in seen:
        seen.add(s)
        s = str(_o(rolemap[s]))
    return s


class Marks:
    def __init__(self):
        self.boxes: dict[int, list[float]] = {}
        self.texts: dict[int, str] = {}
        self.sizes: dict[int, Counter] = {}
        self.untagged = Counter()
        self.glyphs = 0
        self.images = 0
        self.nouni = Counter()
        self.content = None
        self.drawn: dict[int, list[tuple]] = {}  # per id: (left, baseline, right, text, size) of each glyph, for reading order


def _grow(boxes: dict, key: int, b) -> None:
    cur = boxes.get(key)
    if cur is None:
        boxes[key] = [b[0], b[1], b[2], b[3]]
    else:
        cur[0], cur[1], cur[2], cur[3] = min(cur[0], b[0]), min(cur[1], b[1]), max(cur[2], b[2]), max(cur[3], b[3])


def page_marks(page, pdf) -> Marks:
    c = interp.walk(page, pdf)
    forms = {d.op: d for d in c.draws if not d.where and d.kind == "form"}

    def eff(where, mcid, art):
        if where:
            f = forms.get(where[0])
            if f is not None and (f.mcid is not None or f.artifact):
                return f.mcid, f.artifact, True
            return mcid, art, False
        return mcid, art, True

    m = Marks()
    m.content = c
    last: dict[int, tuple] = {}
    for g in c.glyphs:
        mcid, art, here = eff(g.where, g.mcid, g.artifact)
        if not g.text and not art:
            m.nouni[g.font] += 1
        if not g.text.strip():
            if g.text and mcid is not None and here and m.texts.get(mcid, " ")[-1:] != " ":
                m.texts[mcid] += " "
            continue
        m.glyphs += 1
        if mcid is None and not art:
            m.untagged["text"] += 1
        if mcid is None or not here:
            continue
        _grow(m.boxes, mcid, g.box)
        m.sizes.setdefault(mcid, Counter())[round((g.box[3] - g.box[1]) * 2) / 2] += 1
        t = m.texts.get(mcid, "")
        prev = last.get(mcid)
        rtl = bool(layout.RTL_RE.search(g.text))
        same_line = prev is not None and abs(g.origin[1] - prev[2]) <= g.size * 0.5
        # right-to-left text drawn in reading order steps left: the next glyph ends where the last one began
        leftward = same_line and rtl and prev[4] and g.origin[0] < prev[0] - 1 and abs(g.box[2] - prev[3]) <= g.size * 0.25
        if prev is not None and t and t[-1] != " " and not leftward and (g.origin[0] < prev[0] - 1 or g.origin[0] - prev[1] > g.size * 0.25
                                                                          or not same_line):
            t += " "
        m.texts[mcid] = t + g.text
        m.drawn.setdefault(mcid, []).append((g.box[0], g.origin[1], g.box[2], g.text, g.size))
        last[mcid] = (g.origin[0], g.box[2], g.origin[1], g.box[0], rtl)
    for d in c.draws:
        if d.kind in ("form", "nop", "clip"):
            continue
        mcid, art, here = eff(d.where, d.mcid, d.artifact)
        image = d.kind in ("image", "inline")
        m.images += 1 if image else 0
        if mcid is None and not art:
            m.untagged["images" if image else "paths"] += 1
        elif mcid is not None and here and d.box:
            _grow(m.boxes, mcid, d.box)
    return m


def reading_text(drawn: list[tuple]) -> str:
    """The words of some glyphs in reading order, whichever order they were drawn in: lines from the top, each line read
    off the page left to right and, where right-to-left letters lead, turned around word by word the way layout does."""
    lines: list[list[tuple]] = []
    for g in sorted(drawn, key=lambda g: -g[1]):
        if lines and abs(lines[-1][0][1] - g[1]) <= g[4] * 0.5:
            lines[-1].append(g)
        else:
            lines.append([g])
    out = []
    for line in lines:
        s, right = "", None
        for g in sorted(line, key=lambda g: g[0]):
            if right is not None and s and s[-1] != " " and g[0] - right > g[4] * 0.2:
                s += " "
            s += g[3]
            right = g[2]
        out.append(layout.reading_line([layout.logical(x) for x in s.split()]))
    return " ".join(x for x in out if x)


class Node:
    __slots__ =("obj", "ref", "parent", "type", "raw", "kids", "mcids", "objrs", "formmc", "page", "path")

    def __init__(self, obj, ref, parent, rolemap):
        self.obj, self.ref, self.parent = obj, ref, parent
        self.raw = str(obj.get("/S", "")) if obj is not None else "/StructTreeRoot"
        self.type = _role(self.raw, rolemap) if obj is not None else "/StructTreeRoot"
        self.kids: list[Node] = []
        self.mcids: list[tuple] = []
        self.objrs: list[tuple] = []
        self.formmc = 0
        self.page = None
        self.path = ""

    def walk(self):
        stack = [self]
        while stack:
            n = stack.pop()
            yield n
            stack.extend(reversed(n.kids))

    def text_of(self, key: str) -> str:
        v = self.obj.get(key) if self.obj is not None else None
        return str(v).strip() if v is not None else ""

    @property
    def alt(self) -> str:
        return self.text_of("/Alt")

    @property
    def described(self) -> bool:
        return bool(self.alt or self.text_of("/ActualText"))

    def has_content(self) -> bool:
        return any(n.mcids or n.objrs or n.formmc for n in self.walk())

    def first_page(self):
        for n in self.walk():
            for p, _ in n.mcids + n.objrs:
                if p is not None:
                    return p
        return self.page

    def attr(self, key: str):
        a = _o(self.obj.get("/A")) if self.obj is not None else None
        for d in (a if isinstance(a, ArrayObject) else [a]):
            d = _o(d)
            if isinstance(d, DictionaryObject) and key in d:
                return _o(d[key])
        return None


class Tree:
    def __init__(self, root, pages):
        self.st = _o(root.get("/StructTreeRoot"))
        self.pages = {p.indirect_reference.idnum: i for i, p in enumerate(pages) if p.indirect_reference is not None}
        self.rolemap = _o(self.st.get("/RoleMap")) if self.st is not None else None
        self.top = Node(None, None, None, None)
        self.top.obj = self.st
        self.by_path: dict[str, Node] = {}
        self.count = 0
        self.seen: set = set()
        if self.st is not None:
            self._fill(self.top, self.st.get("/K"), None, 0)

    def _pg(self, v):
        return self.pages.get(v.idnum) if isinstance(v, IndirectObject) else None

    def _fill(self, node: Node, k, pg, depth: int) -> None:
        k = _o(k)
        items = list(k) if isinstance(k, ArrayObject) else ([] if k is None else [k])
        idx = 0
        for it in items:
            o = _o(it)
            if _num(o):
                node.mcids.append((pg, int(o)))
            elif isinstance(o, DictionaryObject):
                t = o.get("/Type")
                if t == "/MCR":
                    p = self._pg(o.get("/Pg")) if "/Pg" in o else pg
                    if "/Stm" in o or o.get("/MCID") is None:
                        node.formmc += 1
                    else:
                        node.mcids.append((p, int(o["/MCID"])))
                elif t == "/OBJR":
                    node.objrs.append((self._pg(o.get("/Pg")) if "/Pg" in o else pg, o.get("/Obj")))
                else:
                    path = f"{node.path}.{idx}" if node.path else str(idx)
                    idx += 1
                    key = it.idnum if isinstance(it, IndirectObject) else id(o)
                    if key in self.seen or self.count >= MAX_NODES or depth >= MAX_DEPTH:
                        continue
                    self.seen.add(key)
                    self.count += 1
                    child = Node(o, it if isinstance(it, IndirectObject) else None, node, self.rolemap)
                    child.path = path
                    child.page = self._pg(o.get("/Pg")) if "/Pg" in o else pg
                    node.kids.append(child)
                    self.by_path[path] = child
                    self._fill(child, o.get("/K"), child.page, depth + 1)

    def nodes(self):
        for k in self.top.kids:
            yield from k.walk()


def _numtree(node, out: dict, depth: int = 0) -> dict:
    node = _o(node)
    if not isinstance(node, DictionaryObject) or depth > 32:
        return out
    nums = _o(node.get("/Nums"))
    if isinstance(nums, ArrayObject):
        for i in range(0, len(nums) - 1, 2):
            if _num(_o(nums[i])):
                out[int(_o(nums[i]))] = nums[i + 1]
    for kid in _o(node.get("/Kids")) or []:
        _numtree(kid, out, depth + 1)
    return out


def _rule(rid: str, group: str, name: str, status: str, say: str, findings=(), fix: str | None = None) -> dict:
    found = list(findings)
    return {"id": rid, "group": group, "name": name, "status": status, "say": say, "findings": found[:200], "more": max(0, len(found) - 200), "fix": fix}


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _on(pages: list[int]) -> str:
    ps = sorted(set(pages))
    return f"on page {ps[0]}" if len(ps) == 1 else f"on pages {_pages_text(ps)}"


def _pages_text(pages: list[int]) -> str:
    pages = sorted(set(pages))
    if len(pages) > 8:
        return f"{', '.join(str(p) for p in pages[:8])} and {len(pages) - 8} more"
    return ", ".join(str(p) for p in pages)


def _annots(page) -> list:
    out = []
    for ref in _o(page.get("/Annots")) or []:
        a = _o(ref)
        if isinstance(a, DictionaryObject) and a.get("/Subtype") != "/Popup":
            out.append((ref, a))
    return out


def _field_of(a):
    f = a
    while "/T" not in f and isinstance(_o(f.get("/Parent")), DictionaryObject):
        f = _o(f["/Parent"])
    return f


def _heading_level(t: str) -> int | None:
    return int(t[2]) if re.fullmatch(r"/H[1-6]", t) else None


SCRIPT_NAMES = (("ARABIC", "Arabic"), ("HEBREW", "Hebrew"), ("GREEK", "Greek"), ("CYRILLIC", "Cyrillic"), ("HIRAGANA", "Kana"), ("KATAKANA", "Kana"),
                ("CJK", "Han"), ("HANGUL", "Hangul"), ("THAI", "Thai"), ("DEVANAGARI", "Devanagari"), ("LATIN", "Latin"))
SCRIPT_LANG = {"Arabic": "ar", "Hebrew": "he", "Greek": "el", "Cyrillic": "ru", "Han": "zh", "Kana": "ja", "Hangul": "ko", "Thai": "th", "Devanagari": "hi"}
LANG_SCRIPT = {"ar": "Arabic", "fa": "Arabic", "ur": "Arabic", "ps": "Arabic", "he": "Hebrew", "yi": "Hebrew", "el": "Greek", "ru": "Cyrillic", "uk": "Cyrillic",
               "bg": "Cyrillic", "be": "Cyrillic", "mk": "Cyrillic", "kk": "Cyrillic", "mn": "Cyrillic", "zh": "Han", "ja": "Kana", "ko": "Hangul", "th": "Thai",
               "hi": "Devanagari", "mr": "Devanagari", "ne": "Devanagari", "sa": "Devanagari"}
LANG_RE = re.compile(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*")
PLACEHOLDER_ALT = re.compile(r"(?i)(.*\.(png|jpe?g|gif|tiff?|bmp|webp|svg|emf|wmf)|(an?\s+)?(image|picture|photo|figure|graphic|img|alt|alt text|chart|logo|icon|"
                             r"diagram|illustration|untitled|placeholder|description)(\s*[-_#]?\s*\d+)?|[\W\d_]{0,3})")


def script_of(text: str) -> str | None:
    import unicodedata

    seen = Counter()
    for ch in text[:2000]:
        if not ch.isalpha():
            continue
        name = unicodedata.name(ch, "")
        for key, script in SCRIPT_NAMES:
            if name.startswith(key):
                seen[script] += 1
                break
    if sum(seen.values()) < 3:
        return None
    if seen["Kana"] and seen["Kana"] + seen["Han"] >= sum(seen.values()) / 2:
        return "Kana"
    return seen.most_common(1)[0][0]


def lang_script(lang: str) -> str:
    return LANG_SCRIPT.get(lang.split("-")[0].lower(), "Latin")


def _fits(script: str, lang: str) -> bool:
    want = lang_script(lang)
    return script == want or (want == "Kana" and script == "Han")


def _node_lang(x: "Node", doc_lang: str) -> str:
    n = x
    while n is not None and n.obj is not None:
        v = str(n.obj.get("/Lang") or "").strip()
        if v:
            return v
        n = n.parent
    return doc_lang


def _own(x: "Node", marks: list) -> tuple[str, Counter, list]:
    text, sizes, boxes = [], Counter(), []
    for y in x.walk():
        for pg, mc in y.mcids:
            if pg is None or pg >= len(marks):
                continue
            m = marks[pg]
            if mc in m.texts:
                text.append(m.texts[mc])
            sizes.update(m.sizes.get(mc, {}))
            if mc in m.boxes:
                boxes.append((pg, m.boxes[mc]))
    return re.sub(r"\s+", " ", " ".join(text)).strip(), sizes, boxes


def _size(c: Counter) -> float | None:
    return c.most_common(1)[0][0] if c else None


def validate(nodes: list, marks: list, doc_lang: str, where) -> list[dict]:
    V = GROUP_NAMES[7]
    rules = []
    heads, paras, body = [], [], Counter()
    for x in nodes:
        lv = _heading_level(x.type)
        if lv is None and x.type != "/P":
            continue
        text, sizes, _ = _own(x, marks)
        size = _size(sizes)
        if size is None or not text:
            continue
        if lv is not None:
            heads.append((x, lv, size, text))
        else:
            paras.append((x, size, text))
            body.update(sizes)
    wrong = []
    for x, lv, size, text in heads:
        above = [(l2, s2) for _y, l2, s2, _t in heads if l2 < lv]
        if above:
            l2, s2 = min(above, key=lambda a: a[1])
            if size > s2 * 1.15:
                wrong.append(where(x, f"H{lv} \"{text[:40]}\" is set larger ({size:g} pt) than an H{l2} ({s2:g} pt)"))
                continue
        same = sorted(s for _y, l2, s, _t in heads if l2 == lv)
        mid = same[len(same) // 2]
        if len(same) >= 3 and abs(size - mid) > mid * 0.3:
            wrong.append(where(x, f"H{lv} \"{text[:40]}\" is {size:g} pt where most H{lv} headings are {mid:g} pt"))
    rules.append(_rule("heading_levels", V, "Heading levels match the page", "failed" if wrong else "passed",
                       (f"{len(wrong)} heading has a level that does not match how it is set on the page; a sighted reader and a screen reader would see a different outline."
                        if len(wrong) == 1 else
                        f"{len(wrong)} headings have a level that does not match how they are set on the page; a sighted reader and a screen reader would see a different outline.")
                       if wrong else ("Heading levels follow their size on the page." if heads else "There are no numbered headings to compare."), wrong,
                       fix="headings" if wrong else None))
    base = _size(body)
    looks = []
    if base:
        for x, size, text in paras:
            if size >= base * 1.3 and 2 <= len(text) <= 120 and not text.endswith((".", ",", ";", ":")) and not re.fullmatch(r"[\d\W]+", text):
                looks.append(where(x, f"\"{text[:50]}\" is {size:g} pt (body text is {base:g} pt) but tagged as a paragraph"))
    rules.append(_rule("heading_like", V, "Headings tagged as paragraphs", "failed" if looks else "passed",
                       (f"{len(looks)} line looks like a heading but is tagged as a paragraph, so screen reader users cannot jump to it. "
                        "Retag in Accessibility > Reading order." if len(looks) == 1 else
                        f"{len(looks)} lines look like a heading but are tagged as a paragraph, so screen reader users cannot jump to them. "
                        "Retag in Accessibility > Reading order.") if looks else "No paragraph is set like a heading.", looks))
    jumps, last = [], {}
    for x in nodes:
        if not x.mcids or x.type in ("/Figure", "/Artifact"):
            continue
        text, _sizes, boxes = _own(x, marks)
        if not boxes or not text:
            continue
        pg = boxes[0][0]
        b = [min(v[1][0] for v in boxes if v[0] == pg), min(v[1][1] for v in boxes if v[0] == pg),
             max(v[1][2] for v in boxes if v[0] == pg), max(v[1][3] for v in boxes if v[0] == pg)]
        a = last.get(pg)
        last[pg] = b
        if a is None:
            continue
        ov = min(a[2], b[2]) - max(a[0], b[0])
        narrow = max(1.0, min(a[2] - a[0], b[2] - b[0]))
        if ov >= narrow * 0.5 and b[3] > a[3] + max(24.0, (a[3] - a[1]) * 0.5) and b[1] > a[3] - 2:
            jumps.append(where(x, f"\"{text[:40]}\" is read after text below it"))
    rules.append(_rule("visual_order", V, "Reading order follows the page", "failed" if jumps else "passed",
                       ("The tags go back up the same column once; screen readers will read that part out of order. "
                        "Fix the order in Accessibility > Reading order." if len(jumps) == 1 else
                        f"The tags go back up the same column {len(jumps)} times; screen readers will read those parts out of order. "
                        "Fix the order in Accessibility > Reading order.") if jumps else "Within each column, the tags read from top to bottom.", jumps))
    alts = Counter(x.alt.strip().lower() for x in nodes if x.type == "/Figure" and x.alt)
    poor = [where(x, f"Alternate text \"{x.alt[:40]}\" " + ("is used for several figures" if alts[x.alt.strip().lower()] >= 3 else "says nothing about the picture"))
            for x in nodes if x.type == "/Figure" and x.alt and (PLACEHOLDER_ALT.fullmatch(x.alt.strip()) or alts[x.alt.strip().lower()] >= 3)]
    rules.append(_rule("alt_quality", V, "Alternate text says something", "failed" if poor else "passed",
                       (f"{len(poor)} figure has alternate text that is a file name, a placeholder or repeated; it passes a presence check but tells a listener nothing."
                        if len(poor) == 1 else
                        f"{len(poor)} figures have alternate text that is a file name, a placeholder or repeated; it passes a presence check but tells a listener nothing.")
                       if poor else "No figure has placeholder or repeated alternate text.", poor))
    bad_lang, spans = [], []
    for x in nodes:
        v = str(x.obj.get("/Lang") or "").strip() if x.obj is not None else ""
        if v and not LANG_RE.fullmatch(v):
            bad_lang.append(where(x, f"Language \"{v[:20]}\" is not a language code"))
        if x.kids and any(k.mcids for k in x.kids):
            continue
        text, _s, _b = _own(x, marks)
        sc = script_of(text) if text else None
        lang = _node_lang(x, doc_lang)
        if sc and lang and not _fits(sc, lang):
            spans.append(where(x, f"{sc} text \"{text[:30]}\" is marked as {lang}"))
    if doc_lang and not LANG_RE.fullmatch(doc_lang):
        bad_lang.insert(0, {"page": None, "id": "", "text": f"The document language \"{doc_lang[:20]}\" is not a language code"})
    rules.append(_rule("language_spans", V, "Language of each part", "failed" if spans or bad_lang else "passed",
                       ((f"{len(spans)} part is written in another script than the document language and has no language of its own, "
                         "so a screen reader reads it with the wrong voice. " if len(spans) == 1 else
                         f"{len(spans)} parts are written in another script than the document language and have no language of their own, "
                         "so a screen reader reads them with the wrong voice. ") if spans else "")
                       + ((f"{len(bad_lang)} language value is not a valid code." if len(bad_lang) == 1 else f"{len(bad_lang)} language values are not valid codes.") if bad_lang else "")
                       if spans or bad_lang else "Every part's script matches its language.", bad_lang + spans, fix="spans" if spans else None))
    seen_rtl, visual = False, []
    for x, text in visual_rtl(nodes, marks):
        if x is None:
            seen_rtl = True
            continue
        visual.append(where(x, f"\"{text[:40]}\" is drawn in visual order"))
    rules.append(_rule("rtl_order", V, "Right-to-left reading order", "failed" if visual else "passed",
                       (f"{len(visual)} part with right-to-left text is drawn in visual order and has no ActualText, so a screen reader reads its letters backwards."
                        if len(visual) == 1 else
                        f"{len(visual)} parts with right-to-left text are drawn in visual order and have no ActualText, so a screen reader reads their letters backwards.")
                       if visual else ("Right-to-left text is drawn in reading order or gives its reading order as ActualText." if seen_rtl
                                       else "There is no right-to-left text."), visual, fix="rtl" if visual else None))
    return rules


def visual_rtl(nodes, marks):
    """Leaf elements whose right-to-left text the page draws in visual order with no ActualText on them or above them,
    each with its text in reading order; (None, "") stands for one that is fine, so callers know there was some."""
    for x in nodes:
        if not x.mcids or (x.kids and any(k.mcids for k in x.kids)):
            continue
        drawn = []
        for pg, mc in x.mcids:
            if pg is not None and pg < len(marks):
                drawn += marks[pg].drawn.get(mc, [])
        # steps from one right-to-left glyph to the next on its line, in drawing order: rightward is visual order
        right = left = 0
        for a, b in zip(drawn, drawn[1:]):
            if layout.RTL_RE.search(a[3]) and layout.RTL_RE.search(b[3]) and abs(a[1] - b[1]) <= b[4] * 0.5:
                if b[0] > a[0] + 0.5:
                    right += 1
                elif b[0] < a[0] - 0.5:
                    left += 1
        if not right and not left:
            continue
        y, said = x, False
        while y is not None and not said:
            said = bool(y.text_of("/ActualText"))
            y = y.parent
        if said or left >= right:
            yield None, ""
            continue
        yield x, reading_text(drawn)


def check(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    r = core.reader(path, passwords)
    root = r.trailer["/Root"]
    n = len(r.pages)
    tree = Tree(root, r.pages) if "/StructTreeRoot" in root else None
    marks = [page_marks(p, r) for p in r.pages]
    rules = []
    D, P, F, A, T, L, H, V = GROUP_NAMES

    allowed = True
    if r.is_encrypted:
        try:
            allowed = bool(int(_o(r.trailer["/Encrypt"]).get("/P", -1)) & 512)
        except (TypeError, ValueError):
            allowed = True
    rules.append(_rule("permission", D, "Accessibility permission flag", "passed" if allowed else "failed",
                       "Assistive technology may read the text." if allowed else
                       "The security settings stop assistive technology from reading the text. Remove the password or allow text access for accessibility."))
    pictures = [i + 1 for i, m in enumerate(marks) if m.glyphs == 0 and m.images > 0]
    rules.append(_rule("image_only", D, "Image-only PDF", "failed" if pictures else "passed",
                       (f"{len(pictures)} page is a picture with no text ({_on(pictures)}); run Convert > Make searchable (OCR), then tag again." if len(pictures) == 1 else
                        f"{len(pictures)} pages are pictures with no text ({_on(pictures)}); run Convert > Make searchable (OCR), then tag again.")
                       if pictures else "Every page with pictures also has text.", [{"page": p, "text": "No text on this page"} for p in pictures]))
    mark_info = _o(root.get("/MarkInfo"))
    marked = bool(isinstance(mark_info, DictionaryObject) and mark_info.get("/Marked"))
    tagged = tree is not None and tree.st is not None and marked
    rules.append(_rule("tagged", D, "Tagged PDF", "passed" if tagged else "failed",
                       "The PDF has tags." if tagged else ("The PDF has tags but does not say so (MarkInfo)." if tree is not None and tree.st is not None
                                                          else "The PDF has no tags, so screen readers guess the reading order."),
                       fix="tag" if not tagged else None))
    rules.append(_rule("reading_order", D, "Logical reading order", "manual",
                       "Check the order in Accessibility > Reading order, or listen with a screen reader."))
    lang = str(root.get("/Lang") or "").strip()
    rules.append(_rule("language", D, "Primary language", "passed" if lang else "failed",
                       f"The language is {lang}." if lang else "No language is set, so screen readers may pronounce the text wrongly.",
                       fix=None if lang else "lang"))
    info = r.metadata or {}
    title = real_title(info.get("/Title"))
    prefs = _o(root.get("/ViewerPreferences"))
    shows = bool(isinstance(prefs, DictionaryObject) and prefs.get("/DisplayDocTitle"))
    ok = bool(title) and shows
    rules.append(_rule("title", D, "Title", "passed" if ok else "failed",
                       f"The title is \"{title[:80]}\"." if ok else ("The title is set but the window shows the file name instead." if title
                                                                      else "The PDF has no title."), fix=None if ok else "title"))
    outline = sanitize._outline_count(root)
    heads = [x for x in tree.nodes() if x.type in HEADS] if tree else []
    if n <= 20 or outline:
        rules.append(_rule("bookmarks", D, "Bookmarks", "passed", "Bookmarks are present." if outline else "Bookmarks are needed only above 20 pages."))
    else:
        rules.append(_rule("bookmarks", D, "Bookmarks", "failed", f"{n} pages and no bookmarks." + (" They can be made from the headings." if heads else ""),
                           fix="bookmarks" if heads else None))
    try:
        low, measured = contrast.low_contrast(path, passwords)
    except Exception:
        low, measured = [], 0
    if not measured:
        rules.append(_rule("contrast", D, "Colour contrast", "manual", "Check that text stands out from its background (4.5 to 1 for body text)."))
    else:
        pages_low = sorted({f["page"] for f in low})
        rules.append(_rule("contrast", D, "Colour contrast", "failed" if low else "passed",
                           f"{len(low)} of {measured} text runs measured on the rendered pages are below 4.5 to 1 (3 to 1 for large text) ({_on(pages_low)}). "
                           "Text over pictures is not measured; check it by eye." if low else
                           f"All {measured} text runs measured on the rendered pages reach 4.5 to 1 (3 to 1 for large text). Text over pictures is not measured; check it by eye.",
                           [{k: f[k] for k in ("page", "text", "box")} for f in low]))

    untagged = [(i + 1, m.untagged) for i, m in enumerate(marks) if sum(m.untagged.values())]
    rules.append(_rule("tagged_content", P, "Tagged content", "failed" if untagged else "passed",
                       f"Content {_on([p for p, _ in untagged])} is neither tagged nor marked as background."
                       + (" Tag the PDF again in Accessibility > Tags to include it." if tagged else "")
                       if untagged else "All page content is tagged or marked as background.",
                       [{"page": p, "text": ", ".join(f"{v} {k}" for k, v in c.items() if v)} for p, c in untagged],
                       fix="tag" if untagged and not tagged else None))
    ptree = _numtree(tree.st.get("/ParentTree"), {}) if tree and tree.st is not None else {}
    loose, widgets_loose, untabbed, media, links = [], [], [], [], 0
    for i, page in enumerate(r.pages):
        ann = _annots(page)
        if ann and page.get("/Tabs") != "/S":
            untabbed.append(i + 1)
        for _ref, a in ann:
            sub = a.get("/Subtype")
            links += sub == "/Link"
            sp = a.get("/StructParent")
            good = sp is not None and _num(_o(sp)) and isinstance(_o(ptree.get(int(_o(sp)))), DictionaryObject)
            if sub in MEDIA:
                media.append((i + 1, good))
            if not good:
                (widgets_loose if sub == "/Widget" else loose).append(i + 1)
    fix_ann = "annotations" if tagged else "tag"
    rules.append(_rule("annotations", P, "Tagged annotations", "failed" if loose else "passed",
                       (f"{len(loose)} comment or link is not in the tags ({_on(loose)})." if len(loose) == 1 else
                        f"{len(loose)} comments or links are not in the tags ({_on(loose)}).") if loose else "Every comment and link is in the tags.",
                       [{"page": p, "text": "Annotation not tagged"} for p in loose], fix=fix_ann if loose else None))
    rules.append(_rule("tab_order", P, "Tab order", "failed" if untabbed else "passed",
                       f"Tab does not move through links and fields in reading order {_on(untabbed)}." if untabbed else "Tab order follows the tags.",
                       [{"page": p, "text": "Tab order not set to structure"} for p in untabbed], fix="tabs" if untabbed else None))
    nouni = Counter()
    nouni_pages = []
    for i, m in enumerate(marks):
        if m.nouni:
            nouni.update(m.nouni)
            nouni_pages.append(i + 1)
    rules.append(_rule("encoding", P, "Character encoding", "failed" if nouni else "passed",
                       (f"{sum(nouni.values())} character" if sum(nouni.values()) == 1 else f"{sum(nouni.values())} characters")
                       + (f" in {len(nouni)} font cannot be turned into text ({', '.join(list(nouni)[:4])}); "
                          "screen readers skip them. Making the pages searchable with OCR or retyping the text fixes it." if len(nouni) == 1 else
                          f" in {len(nouni)} fonts cannot be turned into text ({', '.join(list(nouni)[:4])}); "
                          "screen readers skip them. Making the pages searchable with OCR or retyping the text fixes it.") if nouni else "Every character maps to text.",
                       [{"page": p, "text": "Characters without text"} for p in nouni_pages]))
    bad_media = [p for p, good in media if not good]
    rules.append(_rule("multimedia", P, "Tagged multimedia", "failed" if bad_media else "passed",
                       f"Multimedia {_on(bad_media)} is not tagged." if bad_media else
                       ("Multimedia is tagged." if media else "There is no multimedia.")))
    hidden = {h["key"]: h["count"] for h in sanitize.scan(path, passwords)}
    scripts = hidden.get("javascript", 0) > 0
    rules.append(_rule("flicker", P, "Screen flicker", "manual" if scripts or media else "passed",
                       "Check that nothing flashes more than three times a second." if scripts or media else "Nothing in the PDF can animate."))
    rules.append(_rule("scripts", P, "Scripts", "manual" if scripts else "passed",
                       "The PDF has scripts; check they work with the keyboard and a screen reader." if scripts else "There are no scripts."))
    rules.append(_rule("timed", P, "Timed responses", "manual" if scripts else "passed",
                       "Check that no script requires an answer within a time limit." if scripts else "There are no scripts, so nothing is timed."))
    rules.append(_rule("links", P, "Navigation links", "manual" if links else "passed",
                       "Check that each link's text says where it goes." if links else "There are no links."))

    fields_total, undescribed = 0, []
    seen_fields = set()
    for i, page in enumerate(r.pages):
        for _ref, a in _annots(page):
            if a.get("/Subtype") != "/Widget":
                continue
            f = _field_of(a)
            key = id(f)
            if key in seen_fields:
                continue
            seen_fields.add(key)
            fields_total += 1
            if not str(f.get("/TU") or "").strip():
                undescribed.append({"page": i + 1, "text": f"Field {f.get('/T') or ''} has no description"})
    rules.append(_rule("form_tags", F, "Tagged form fields", "failed" if widgets_loose else "passed",
                       (f"{len(widgets_loose)} form field is not in the tags ({_on(widgets_loose)})." if len(widgets_loose) == 1 else
                        f"{len(widgets_loose)} form fields are not in the tags ({_on(widgets_loose)}).") if widgets_loose else
                       ("Every form field is in the tags." if fields_total else "There are no form fields."),
                       [{"page": p, "text": "Field not tagged"} for p in widgets_loose], fix=fix_ann if widgets_loose else None))
    rules.append(_rule("field_descriptions", F, "Field descriptions", "failed" if undescribed else "passed",
                       (f"{len(undescribed)} field has no description (tooltip) for screen readers to announce." if len(undescribed) == 1 else
                        f"{len(undescribed)} fields have no description (tooltip) for screen readers to announce.") if undescribed else
                       ("Every field has a description." if fields_total else "There are no form fields."), undescribed,
                       fix="descriptions" if undescribed else None))

    nodes = list(tree.nodes()) if tree else []
    if not tree:
        for rid, g, name in (("figures_alt", A, "Figures alternate text"), ("nested_alt", A, "Nested alternate text"),
                             ("alt_content", A, "Associated with content"), ("alt_annotation", A, "Hides annotation"),
                             ("other_alt", A, "Other elements alternate text"), ("table_rows", T, "Rows"), ("table_cells", T, "TH and TD"),
                             ("table_headers", T, "Headers"), ("table_regular", T, "Regularity"), ("table_summary", T, "Summary"),
                             ("list_items", L, "List items"), ("list_parts", L, "Lbl and LBody"), ("heading_nesting", H, "Appropriate nesting"),
                             ("heading_levels", V, "Heading levels match the page"), ("heading_like", V, "Headings tagged as paragraphs"),
                             ("visual_order", V, "Reading order follows the page"), ("alt_quality", V, "Alternate text says something"),
                             ("language_spans", V, "Language of each part")):
            rules.append(_rule(rid, g, name, "skipped", "Needs tags first."))
    else:
        def where(x: Node, text: str) -> dict:
            p = x.first_page()
            return {"page": (p + 1) if p is not None else None, "id": x.path, "text": text}

        figs = [x for x in nodes if x.type == "/Figure"]
        nofig = [where(x, "Figure without alternate text") for x in figs if not x.described]
        rules.append(_rule("figures_alt", A, "Figures alternate text", "failed" if nofig else "passed",
                           (f"{len(nofig)} figure has no alternate text. Add it in Accessibility > Alternate text, or mark the figure as decorative." if len(nofig) == 1 else
                            f"{len(nofig)} figures have no alternate text. Add it in Accessibility > Alternate text, or mark a figure as decorative.")
                           if nofig else ("Every figure has alternate text." if figs else "There are no figures."), nofig))
        nested = [where(x, f"{x.type[1:]} has alternate text inside another element's") for x in nodes
                  if x.alt and any(y.alt for y in x.walk() if y is not x)]
        rules.append(_rule("nested_alt", A, "Nested alternate text", "failed" if nested else "passed",
                           "Alternate text inside alternate text is never read." if nested else "No alternate text is hidden inside another.", nested))
        empty_alt = [where(x, f"{x.type[1:]} has alternate text but no content") for x in nodes if x.alt and not x.has_content()]
        rules.append(_rule("alt_content", A, "Associated with content", "failed" if empty_alt else "passed",
                           "Alternate text must belong to something on the page." if empty_alt else "All alternate text belongs to page content.", empty_alt))
        hides = [where(x, f"{x.type[1:]} alternate text hides a link or comment") for x in nodes
                 if x.alt and x.type not in ("/Link", "/Annot", "/Form") and any(y.objrs for y in x.walk())]
        rules.append(_rule("alt_annotation", A, "Hides annotation", "failed" if hides else "passed",
                           "Alternate text on an element stops screen readers reaching the link or comment inside it." if hides else
                           "No alternate text hides a link or comment.", hides))
        formulas = [where(x, "Formula without alternate text") for x in nodes if x.type == "/Formula" and not x.described]
        rules.append(_rule("other_alt", A, "Other elements alternate text", "failed" if formulas else "passed",
                           (f"{len(formulas)} formula has no alternate text." if len(formulas) == 1 else f"{len(formulas)} formulas have no alternate text.") if formulas else "Elements that need alternate text have it.", formulas))

        tables = [x for x in nodes if x.type == "/Table"]
        sections = {"/THead", "/TBody", "/TFoot"}
        bad_rows = [where(x, "Row outside a table") for x in nodes if x.type == "/TR" and (x.parent is None or x.parent.type not in {"/Table"} | sections)]
        bad_cells = [where(x, f"{x.type[1:]} outside a row") for x in nodes if x.type in ("/TH", "/TD") and (x.parent is None or x.parent.type != "/TR")]
        no_head = [where(x, "Table without header cells") for x in tables if not any(y.type == "/TH" or y.attr("/Headers") is not None for y in x.walk())]
        irregular, no_summary = [], []
        for x in tables:
            widths = []
            for row in (y for y in x.walk() if y.type == "/TR"):
                width = 0
                for cell in row.kids:
                    if cell.type in ("/TH", "/TD"):
                        span = cell.attr("/ColSpan")
                        width += int(span) if _num(span) and int(span) > 0 else 1
                widths.append(width)
            if widths and len(set(widths)) > 1:
                irregular.append(where(x, f"Rows have {min(widths)} to {max(widths)} cells"))
            if not (x.attr("/Summary") or x.described):
                no_summary.append(where(x, "Table without a summary"))
        rules.append(_rule("table_rows", T, "Rows", "failed" if bad_rows else "passed", "Every row is inside a table." if not bad_rows else
                           "Rows must sit inside a table, table head, body or foot.", bad_rows))
        rules.append(_rule("table_cells", T, "TH and TD", "failed" if bad_cells else "passed", "Every cell is inside a row." if not bad_cells else
                           "Header and data cells must sit inside a row.", bad_cells))
        rules.append(_rule("table_headers", T, "Headers", "failed" if no_head else "passed",
                           (f"{len(no_head)} table has no header cells." if len(no_head) == 1 else f"{len(no_head)} tables have no header cells.") if no_head else ("Every table has headers." if tables else "There are no tables."),
                           no_head))
        rules.append(_rule("table_regular", T, "Regularity", "failed" if irregular else "passed",
                           "Every row of a table should have the same number of cells." if irregular else
                           ("Tables are regular." if tables else "There are no tables."), irregular))
        rules.append(_rule("table_summary", T, "Summary", "failed" if no_summary else "passed",
                           (f"{len(no_summary)} table has no summary." if len(no_summary) == 1 else f"{len(no_summary)} tables have no summary.") if no_summary else ("Every table has a summary." if tables else "There are no tables."),
                           no_summary, fix="summaries" if no_summary else None))
        bad_li = [where(x, "List item outside a list") for x in nodes if x.type == "/LI" and (x.parent is None or x.parent.type != "/L")]
        bad_li += [where(k, f"{k.type[1:]} directly inside a list") for x in nodes if x.type == "/L" for k in x.kids if k.type not in ("/LI", "/L", "/Caption")]
        bad_parts = [where(k, f"{k.type[1:]} inside a list item") for x in nodes if x.type == "/LI" for k in x.kids if k.type not in ("/Lbl", "/LBody")]
        lists = any(x.type == "/L" for x in nodes)
        rules.append(_rule("list_items", L, "List items", "failed" if bad_li else "passed",
                           "Lists must hold list items, and list items must sit in lists." if bad_li else ("Lists are well formed." if lists else "There are no lists."),
                           bad_li))
        rules.append(_rule("list_parts", L, "Lbl and LBody", "failed" if bad_parts else "passed",
                           "A list item holds a label and a body." if bad_parts else ("List items are well formed." if lists else "There are no lists."), bad_parts))
        jumps, prev = [], 0
        for x in nodes:
            lv = _heading_level(x.type)
            if lv is None:
                continue
            if lv > prev + 1:
                jumps.append(where(x, f"H{lv} follows {'H' + str(prev) if prev else 'the start'}"))
            prev = lv
        rules.append(_rule("heading_nesting", H, "Appropriate nesting", "failed" if jumps else "passed",
                           "Heading levels skip a level; screen reader users move by headings." if jumps else
                           ("Headings go down one level at a time." if any(_heading_level(x.type) for x in nodes) else "There are no numbered headings."), jumps))
        rules += validate(nodes, marks, lang, where)

    counts = Counter(x["status"] for x in rules)
    summary = {"passed": counts["passed"], "failed": counts["failed"], "manual": counts["manual"], "skipped": counts["skipped"]}
    lines = [f"Accessibility: {summary['failed']} failed, {summary['manual']} need a manual check, {summary['passed']} passed, {summary['skipped']} skipped."]
    for x in rules:
        if x["status"] in ("failed", "manual"):
            lines.append(f"{x['status']} · {x['group']} · {x['name']}: {x['say']}" + (f" (fix: {x['fix']})" if x["fix"] else ""))
    groups = [{"name": g, "rules": [x for x in rules if x["group"] == g]} for g in GROUP_NAMES]
    return "\n".join(lines), {"summary": summary, "groups": groups, "tagged": tagged, "pages": n, "title": title, "lang": lang,
                              "fixes": sorted({x["fix"] for x in rules if x["fix"]})}


def _cells(plp) -> list[dict]:
    out = []
    try:
        found = plp.find_tables()
    except Exception:
        return out
    ox, oy = float(plp.bbox[0]), float(plp.bbox[1])
    for t in found:
        x0, top, x1, bottom = t.bbox
        rows = [[(c[0] - ox, c[1] - oy, c[2] - ox, c[3] - oy) if c else None for c in row.cells] for row in t.rows]
        out.append({"bbox": (x0 - ox, top - oy, x1 - ox, bottom - oy), "rows": rows})
    return out


def _el(kind: str, box=None, **extra) -> dict:
    return {"S": kind, "box": box, "kids": [], "mc": [], "objr": [], **extra}


def _union(boxes) -> tuple | None:
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)


def _streams(page) -> list:
    raw = page.raw_get("/Contents") if "/Contents" in page else None
    if raw is None:
        return []
    obj = _o(raw)
    return list(obj) if isinstance(obj, ArrayObject) else [raw]


def _new_stream(w: PdfWriter, src, ops: list):
    cs = ContentStream(None, w)
    cs.operations = ops
    s = DecodedStreamObject()
    for k, v in _o(src).items():
        if k not in ("/Length", "/Filter", "/DecodeParms"):
            s[NameObject(k)] = v
    s.set_data(cs.get_data())
    try:
        s = s.flate_encode()
    except Exception:
        pass
    return w._add_object(s)


def _write_streams(w: PdfWriter, page, parts: list[list]) -> None:
    refs = _streams(page)
    if not refs:
        return
    new = [_new_stream(w, ref, ops) for ref, ops in zip(refs, parts)]
    page[NameObject("/Contents")] = ArrayObject(new) if len(new) > 1 or isinstance(_o(page.raw_get("/Contents")), ArrayObject) else new[0]


def _split_ops(w: PdfWriter, page) -> list[list] | None:
    refs = _streams(page)
    parts = []
    for ref in refs:
        try:
            parts.append(list(ContentStream(_o(ref), w).operations))
        except Exception:
            return None
    return parts


def _untag(w: PdfWriter) -> None:
    root = w._root_object
    for k in ("/StructTreeRoot", "/MarkInfo"):
        if k in root:
            del root[k]
    for page in w.pages:
        if "/StructParents" in page:
            del page["/StructParents"]
        for _ref, a in _annots(page):
            if "/StructParent" in a:
                del a["/StructParent"]


def _assign(page, c, got, cells, shapes, heads: dict) -> tuple[list[dict], dict, list]:
    H = float(got["height"])
    mb = page.mediabox
    mx0, my1 = float(min(mb.left, mb.right)), float(max(mb.top, mb.bottom))
    elements: list[dict] = []
    leaves: list[dict] = []
    arts: list[tuple] = []
    figure_ops: dict[int, dict] = {}
    open_list = None
    for b in got["blocks"]:
        kind = b.get("kind")
        box = (b["x0"], b["top"], b["x1"], b["bottom"]) if "x0" in b else None
        if kind in ("para", "heading"):
            if layout.is_running(b, H, shapes):
                arts.append(box)
                continue
            if b.get("list"):
                body = _el("/LBody", box)
                leaves.append(body)
                li = _el("/LI", box, kids=[body])
                if open_list is None:
                    open_list = _el("/L", box)
                    elements.append(open_list)
                open_list["kids"].append(li)
                continue
            open_list = None
            kind_s = "/P"
            if kind == "heading":
                lv = min(heads["map"].get(b["level"], 1), heads["prev"] + 1)
                heads["prev"] = lv
                kind_s = f"/H{lv}"
            leaf = _el(kind_s, box, text=b.get("text", ""))
            leaves.append(leaf)
            elements.append(leaf)
        elif kind == "table":
            open_list = None
            match = next((t for t in cells if all(abs(t["bbox"][i] - box[i]) < 1.5 for i in range(4))), None)
            if match is None:
                leaf = _el("/P", box)
                leaves.append(leaf)
                elements.append(leaf)
                continue
            table = _el("/Table", box)
            for ri, row in enumerate(match["rows"]):
                tr = _el("/TR", _union(row))
                for cell in row:
                    if cell is None:
                        continue
                    td = _el("/TH" if ri == 0 else "/TD", cell, keep=True)
                    leaves.append(td)
                    tr["kids"].append(td)
                if tr["kids"]:
                    table["kids"].append(tr)
            elements.append(table)
        elif kind == "image":
            open_list = None
            leaf = _el("/Figure", box, pdfbox=b.get("pdfbox"))
            leaves.append(leaf)
            elements.append(leaf)
            figure_ops[b["op"]] = leaf

    def center(bx) -> tuple[float, float]:
        return (bx[0] + bx[2]) / 2 - mx0, my1 - (bx[1] + bx[3]) / 2

    def inside(pt, bx, pad: float) -> bool:
        return bx is not None and bx[0] - pad <= pt[0] <= bx[2] + pad and bx[1] - pad <= pt[1] <= bx[3] + pad

    text_leaves = [x for x in leaves if x["S"] != "/Figure" and x["box"]]
    votes: dict[int, Counter] = {}
    stray: dict[int, list] = {}
    for g in c.glyphs:
        if not g.text.strip():
            continue
        op = g.where[0] if g.where else g.op
        pt = center(g.box)
        if any(inside(pt, a, 1.0) for a in arts if a):
            votes.setdefault(op, Counter())["P"] += 1
            continue
        hit = [x for x in text_leaves if inside(pt, x["box"], 1.5)]
        if hit:
            best = min(hit, key=lambda x: (x["box"][2] - x["box"][0]) * (x["box"][3] - x["box"][1]))
        else:
            near = None
            for x in text_leaves:
                bx = x["box"]
                dx = max(bx[0] - pt[0], 0, pt[0] - bx[2])
                dy = max(bx[1] - pt[1], 0, pt[1] - bx[3])
                dist = (dx * dx + dy * dy) ** 0.5
                if near is None or dist < near[0]:
                    near = (dist, x)
            if near is None or near[0] > max(12.0, g.size * 1.5):
                stray.setdefault(op, []).append(g.box)
                continue
            best = near[1]
        votes.setdefault(op, Counter())[id(best)] += 1
    by_id = {id(x): x for x in leaves}
    for op, boxes in stray.items():
        if op in votes:
            continue
        x0, y0, x1, y1 = _union(boxes)
        leaf = _el("/P", (x0 - mx0, my1 - y1, x1 - mx0, my1 - y0))
        leaves.append(leaf)
        elements.append(leaf)
        by_id[id(leaf)] = leaf
        votes[op] = Counter({id(leaf): 1})
    target: dict[int, object] = {}
    for op, v in votes.items():
        key, _n = v.most_common(1)[0]
        target[op] = "P" if key == "P" else by_id[key]
    for d in c.draws:
        op = d.where[0] if d.where else d.op
        if d.kind in ("image", "inline"):
            fig = figure_ops.get(op)
            if fig is not None and (op not in target or target[op] in ("A", "P")):
                target[op] = fig
            elif op not in target:
                target[op] = "A"
        elif d.kind in ("path", "shading") and not d.where:
            target.setdefault(op, "A")
        elif d.kind == "form" and not d.where:
            target.setdefault(op, "A")
    return elements, target, leaves


def _emit(w: PdfWriter, page, parts: list[list], target: dict) -> tuple[list, int]:
    mcid = 0
    owners: list = []
    flat = [op for part in parts for _, op in part]
    build_target: dict[int, object] = {}
    i = 0
    while i < len(flat):
        if flat[i] in BUILD:
            j = i
            while j < len(flat) and flat[j] in BUILD:
                j += 1
            t = target.get(j) if j < len(flat) and flat[j] in interp.PAINT and flat[j] != b"n" else None
            for k in range(i, j):
                build_target[k] = t
            i = j
        else:
            i += 1
    out_parts = []
    g = 0
    for part in parts:
        out: list = []
        open_t = None
        keep: list[bool] = []

        def close():
            nonlocal open_t
            if open_t is not None:
                out.append(([], b"EMC"))
                open_t = None

        for operands, op in part:
            gi = g
            g += 1
            if op in (b"BDC", b"BMC"):
                kept = op == b"BDC" and bool(operands) and str(operands[0]) == "/OC"
                keep.append(kept)
                if kept:
                    close()
                    out.append((operands, op))
                continue
            if op == b"EMC":
                if keep and keep.pop():
                    close()
                    out.append((operands, op))
                continue
            if op in BOUNDS:
                close()
                out.append((operands, op))
                continue
            if op in BUILD:
                t = build_target.get(gi)
            elif op in TEXT_OPS:
                t = target.get(gi, "join")
            elif op in interp.PAINT and op != b"n" or op in (b"Do", b"sh", b"INLINE IMAGE"):
                t = target.get(gi, "A")
            else:
                t = None
            if t is None:
                out.append((operands, op))
                continue
            if t == "join":
                if open_t is None:
                    out.append(([NameObject("/Artifact")], b"BMC"))
                    open_t = "A"
                out.append((operands, op))
                continue
            if not (t is open_t or isinstance(t, str) and t == open_t):
                close()
                if t == "A":
                    out.append(([NameObject("/Artifact")], b"BMC"))
                elif t == "P":
                    out.append(([NameObject("/Artifact"), DictionaryObject({NameObject("/Type"): NameObject("/Pagination")})], b"BDC"))
                else:
                    t["mc"].append(mcid)
                    owners.append(t)
                    out.append(([NameObject(t["S"]), DictionaryObject({NameObject("/MCID"): NumberObject(mcid)})], b"BDC"))
                    mcid += 1
                open_t = t
            out.append((operands, op))
        close()
        out_parts.append(out)
    _write_streams(w, page, out_parts)
    return owners, mcid


def _prune(el: dict) -> bool:
    el["kids"] = [k for k in el["kids"] if _prune(k)]
    return bool(el["mc"] or el["kids"] or el["objr"] or el.get("keep"))


def _make(w: PdfWriter, el: dict, parent_ref, page_ref, page_box, refs: dict):
    d = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject(el["S"]), NameObject("/P"): parent_ref,
                          NameObject("/Pg"): page_ref})
    ref = w._add_object(d)
    refs[id(el)] = ref
    kids = ArrayObject(NumberObject(m) for m in el["mc"])
    for k in el["kids"]:
        kids.append(_make(w, k, ref, page_ref, page_box, refs))
    for a in el["objr"]:
        kids.append(DictionaryObject({NameObject("/Type"): NameObject("/OBJR"), NameObject("/Obj"): a, NameObject("/Pg"): page_ref}))
    d[NameObject("/K")] = kids
    if el["S"] == "/Figure" and el.get("pdfbox"):
        d[NameObject("/A")] = DictionaryObject({NameObject("/O"): NameObject("/Layout"),
                                                NameObject("/BBox"): ArrayObject(FloatObject(round(v, 2)) for v in el["pdfbox"])})
    if el["S"] == "/TH":
        d[NameObject("/A")] = DictionaryObject({NameObject("/O"): NameObject("/Table"), NameObject("/Scope"): NameObject("/Column")})
    if el.get("lang"):
        d[NameObject("/Lang")] = TextStringObject(el["lang"])
    if el["mc"] and el.get("text") and layout.RTL_RE.search(el["text"]):
        # the page draws right-to-left text in visual order; the element says what it reads in logical order
        d[NameObject("/ActualText")] = TextStringObject(el["text"][:4000])
    return ref


def _mark_scripts(el: dict, doc_lang: str) -> None:
    sc = script_of(el.get("text") or "")
    if sc and sc in SCRIPT_LANG and not _fits(sc, doc_lang):
        el["lang"] = SCRIPT_LANG[sc]
        return
    for k in el["kids"]:
        _mark_scripts(k, doc_lang)


def _link_text(a, glyphs) -> str:
    """What a link says: the text drawn inside its box, else where it goes. PDF/UA wants it in the link's Contents."""
    r = [float(v) for v in a.get("/Rect", [0, 0, 0, 0])]
    x0, y0, x1, y1 = min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])
    text = "".join(g.text for g in glyphs or [] if g.box and x0 - 1 <= (g.box[0] + g.box[2]) / 2 <= x1 + 1 and y0 - 1 <= (g.box[1] + g.box[3]) / 2 <= y1 + 1)
    text = re.sub(r"\s+", " ", text).strip()
    if text:
        return text[:300]
    act = _o(a.get("/A"))
    uri = str(_o(act.get("/URI")) or "") if isinstance(act, DictionaryObject) else ""
    return f"Link to {uri[:280]}" if uri else "Link to another place in this document"


def _annot_elements(page, elements: list[dict], leaves: list[dict], mx0: float, my1: float, glyphs=None) -> list:
    pending = []
    for ref, a in _annots(page):
        sub = a.get("/Subtype")
        if sub == "/Link" and not str(a.get("/Contents") or "").strip():
            a[NameObject("/Contents")] = TextStringObject(_link_text(a, glyphs))
        rect = [float(v) for v in a.get("/Rect", [0, 0, 0, 0])]
        top = (min(rect[0], rect[2]) - mx0, my1 - max(rect[1], rect[3]), max(rect[0], rect[2]) - mx0, my1 - min(rect[1], rect[3]))
        el = _el("/Link" if sub == "/Link" else "/Form" if sub == "/Widget" else "/Annot", top, objr=[ref])
        pending.append((a, el))
        if sub == "/Link":
            best, area = None, 0.0
            for x in leaves:
                bx = x["box"]
                if not bx or x["S"] == "/Figure":
                    continue
                ov = max(0.0, min(bx[2], top[2]) - max(bx[0], top[0])) * max(0.0, min(bx[3], top[3]) - max(bx[1], top[1]))
                if ov > area:
                    best, area = x, ov
            if best is not None:
                best["kids"].append(el)
                continue
        mid = (top[1] + top[3]) / 2
        at = next((i for i, x in enumerate(elements) if x["box"] and x["box"][1] > mid), len(elements))
        elements.insert(at, el)
    return pending


def _title_from(elements: list[dict]) -> str:
    for want in ("/H1", "/H2", "/H3", "/P"):
        for e in elements:
            if e["S"] == want and e.get("text"):
                return re.sub(r"\s+", " ", e["text"]).strip()[:160]
    return ""


def _xmp_title(w: PdfWriter, title: str) -> None:
    """The title in XMP metadata too, as PDF/UA asks (ISO 14289-1 7.1): a new packet when the file has none, else a
    dc:title added to (or replaced in) the one it has, leaving everything else in it as written."""
    import html

    from . import pdfa

    root = w._root_object
    meta = _o(root.get("/Metadata"))
    if not isinstance(meta, StreamObject):
        m = pdfa._meta(w, w.metadata)
        m["title"] = title
        pdfa._set_meta(w, m, None, None)
        return
    try:
        text = meta.get_data().decode("utf-8")
    except Exception:
        return
    row = f'<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Alt><rdf:li xml:lang="x-default">{html.escape(title)}</rdf:li></rdf:Alt></dc:title>'
    if re.search(r"<dc:title[\s>]", text):
        text = re.sub(r"<dc:title[\s>].*?</dc:title>", lambda _m: row, text, count=1, flags=re.S)
    elif "</rdf:Description>" in text:
        text = text.replace("</rdf:Description>", row + "</rdf:Description>", 1)
    else:
        return
    xmp = DecodedStreamObject()
    xmp[NameObject("/Type")] = NameObject("/Metadata")
    xmp[NameObject("/Subtype")] = NameObject("/XML")
    xmp.set_data(text.encode("utf-8"))
    root[NameObject("/Metadata")] = w._add_object(xmp)


def _finish(w: PdfWriter, args: dict, guess: str = "") -> None:
    root = w._root_object
    root[NameObject("/MarkInfo")] = DictionaryObject({NameObject("/Marked"): BooleanObject(True)})
    lang = str(args.get("lang") or root.get("/Lang") or default_lang()).strip()[:35]
    root[NameObject("/Lang")] = TextStringObject(lang)
    title = str(args.get("title") or real_title((w.metadata or {}).get("/Title")) or guess or "Untitled").strip()[:300]
    w.add_metadata({"/Title": title})
    _xmp_title(w, title)
    prefs = _o(root.get("/ViewerPreferences"))
    if not isinstance(prefs, DictionaryObject):
        prefs = DictionaryObject()
        root[NameObject("/ViewerPreferences")] = prefs
    prefs[NameObject("/DisplayDocTitle")] = BooleanObject(True)
    for page in w.pages:
        if _annots(page):
            page[NameObject("/Tabs")] = NameObject("/S")


def _tag(w: PdfWriter, src, passwords, args: dict) -> dict:
    import pdfplumber

    _untag(w)
    pw = next(iter(passwords or []), "")
    st = DictionaryObject({NameObject("/Type"): NameObject("/StructTreeRoot")})
    st_ref = w._add_object(st)
    doc = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Document"), NameObject("/P"): st_ref})
    doc_ref = w._add_object(doc)
    st[NameObject("/K")] = doc_ref
    doc_kids = ArrayObject()
    nums = ArrayObject()
    annot_nums = []
    counts = Counter()
    guess = ""
    with pdfplumber.open(str(src), password=pw) as pl:
        sample = []
        for p in pl.pages[:4]:
            try:
                sample += p.extract_words(extra_attrs=["size"])
            except Exception:
                continue
        base = layout.body_size(sample) if sample else None
        doc_lang = str(args.get("lang") or w._root_object.get("/Lang") or "").strip()
        if not doc_lang:
            sc = script_of(" ".join(str(s.get("text", "")) for s in sample[:600]))
            doc_lang = SCRIPT_LANG.get(sc or "", "") or default_lang()
        args = {**args, "lang": doc_lang}
        analysed = []
        for i, page in enumerate(w.pages):
            c = interp.walk(page, w)
            plp = pl.pages[i]
            mb = page.mediabox
            mx0, my0, my1 = float(min(mb.left, mb.right)), float(min(mb.bottom, mb.top)), float(max(mb.top, mb.bottom))
            area = abs(float(mb.right) - float(mb.left)) * (my1 - my0)
            glyph_pts = [((g.box[0] + g.box[2]) / 2, (g.box[1] + g.box[3]) / 2) for g in c.glyphs if g.text.strip()]
            imgs = []
            for d in c.draws:
                if d.kind not in ("image", "inline") or not d.box:
                    continue
                x0, y0, x1, y1 = d.box
                if x1 - x0 < 8 or y1 - y0 < 8:
                    continue
                if (x1 - x0) * (y1 - y0) > area * 0.6 and any(x0 <= px <= x1 and y0 <= py <= y1 for px, py in glyph_pts[:400]):
                    continue
                imgs.append({"x0": x0 - mx0, "x1": x1 - mx0, "top": my1 - y1, "bottom": my1 - y0, "op": d.where[0] if d.where else d.op, "pdfbox": d.box})
            try:
                got = layout.page_blocks(plp, body=base, images=imgs)
            except Exception:
                got = {"width": 0, "height": my1 - my0, "body": base or 11, "blocks": [], "margins": None}
            cells = _cells(plp)
            plp.close()
            analysed.append((page, c, got, cells))
        shapes = layout.running([a[2] for a in analysed])
        used_levels = sorted({b["level"] for a in analysed for b in a[2]["blocks"] if b.get("kind") == "heading"
                              and not layout.is_running(b, float(a[2]["height"]), shapes)})
        heads = {"map": {lv: k + 1 for k, lv in enumerate(used_levels)}, "prev": 0}
        for i, (page, c, got, cells) in enumerate(analysed):
            parts = _split_ops(w, page)
            flat_n = sum(len(p) for p in parts) if parts is not None else -1
            if parts is None or flat_n != len(c.streams[()].operations):
                ops = list(c.streams[()].operations)
                parts = [ops]
                cs = ContentStream(None, w)
                cs.operations = ops
                page.replace_contents(cs)
            elements, target, leaves = _assign(page, c, got, cells, shapes, heads)
            owners, used = _emit(w, page, parts, target)
            mb = page.mediabox
            mx0, my1 = float(min(mb.left, mb.right)), float(max(mb.top, mb.bottom))
            pending = _annot_elements(page, elements, leaves, mx0, my1, c.glyphs)
            if not guess:
                guess = _title_from(elements)
            refs: dict[int, object] = {}
            page_ref = page.indirect_reference
            for el in elements:
                if _prune(el):
                    _mark_scripts(el, doc_lang)
                    doc_kids.append(_make(w, el, doc_ref, page_ref, None, refs))
                    counts[el["S"]] += 1
            if used:
                page[NameObject("/StructParents")] = NumberObject(i)
                nums.append(NumberObject(i))
                nums.append(ArrayObject(refs.get(id(o), NullObject()) for o in owners))
            for a, el in pending:
                if id(el) in refs:
                    annot_nums.append((a, refs[id(el)]))
            counts["figures"] += sum(1 for x in leaves if x["S"] == "/Figure" and x["mc"])
    key = len(w.pages)
    for a, ref in annot_nums:
        a[NameObject("/StructParent")] = NumberObject(key)
        nums.append(NumberObject(key))
        nums.append(ref)
        key += 1
    doc[NameObject("/K")] = doc_kids
    st[NameObject("/ParentTree")] = w._add_object(DictionaryObject({NameObject("/Nums"): nums}))
    st[NameObject("/ParentTreeNextKey")] = NumberObject(key)
    w._root_object[NameObject("/StructTreeRoot")] = st_ref
    _finish(w, args, guess)
    return {"elements": len(doc_kids), "headings": sum(v for k, v in counts.items() if k.startswith("/H")), "tables": counts["/Table"],
            "lists": counts["/L"], "figures": counts["figures"], "annotations": len(annot_nums)}


def tag(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    r = core.reader(src, passwords)
    if core.signed(r):
        raise ValueError("Tagging rewrites every page, which would break this PDF's signatures. Tag it before it is signed.")
    w = PdfWriter(clone_from=r)
    got = _tag(w, src, passwords, args)
    try:
        w.compress_identical_objects(remove_identicals=False, remove_orphans=True)
    except Exception:
        pass
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), **got}


def _parent_tree_add(w: PdfWriter, st, value) -> int:
    pt = _o(st.get("/ParentTree"))
    if not isinstance(pt, DictionaryObject):
        pt = DictionaryObject({NameObject("/Nums"): ArrayObject()})
        st[NameObject("/ParentTree")] = w._add_object(pt)
    have = _numtree(pt, {})
    nk = st.get("/ParentTreeNextKey")
    key = max(int(_o(nk)) if _num(_o(nk)) else 0, (max(have) + 1) if have else 0)
    nums = _o(pt.get("/Nums"))
    if isinstance(nums, ArrayObject):
        nums.append(NumberObject(key))
        nums.append(value)
    else:
        kids = _o(pt.get("/Kids"))
        if not isinstance(kids, ArrayObject):
            kids = ArrayObject()
            pt[NameObject("/Kids")] = kids
        kids.append(w._add_object(DictionaryObject({NameObject("/Limits"): ArrayObject([NumberObject(key), NumberObject(key)]),
                                                    NameObject("/Nums"): ArrayObject([NumberObject(key), value])})))
    st[NameObject("/ParentTreeNextKey")] = NumberObject(key + 1)
    return key


def _doc_elem(w: PdfWriter, tree: Tree):
    for k in tree.top.kids:
        if k.type == "/Document" and k.ref is not None:
            return k.obj, k.ref
    st_ref = w._root_object.raw_get("/StructTreeRoot")
    return tree.st, st_ref


def _append_kid(holder, ref) -> None:
    k = holder.get("/K")
    ko = _o(k)
    if isinstance(ko, ArrayObject):
        ko.append(ref)
    elif k is None:
        holder[NameObject("/K")] = ArrayObject([ref])
    else:
        holder[NameObject("/K")] = ArrayObject([k, ref])


def _label(page_content, rect) -> str:
    x0, y0, x1, y1 = min(rect[0], rect[2]), min(rect[1], rect[3]), max(rect[0], rect[2]), max(rect[1], rect[3])
    left = [g for g in page_content.glyphs if g.text and x0 - 260 <= g.box[2] <= x0 + 2 and y0 - 2 <= (g.box[1] + g.box[3]) / 2 <= y1 + 2]
    if not left:
        left = [g for g in page_content.glyphs if g.text and y1 - 2 <= g.box[1] <= y1 + 26 and g.box[0] < x1 and g.box[2] > x0 - 4]
        if left:
            low = min(g.box[1] for g in left)
            left = [g for g in left if g.box[1] <= low + 4]
    left.sort(key=lambda g: (round(-g.origin[1] / 4), g.origin[0]))
    t, prev = "", None
    for g in left:
        if prev is not None and g.origin[0] - prev > g.size * 0.25:
            t += " "
        t += g.text
        prev = g.box[2]
    t = re.sub(r"\s+", " ", t).strip().rstrip(":*").strip()
    return t[:120]


def _pretty(name: str) -> str:
    leaf = re.split(r"[.]", name)[-1]
    leaf = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", re.sub(r"[_\-]+", " ", leaf)).strip()
    return leaf[:1].upper() + leaf[1:].lower() if leaf else name


def _summary(table: Node, texts) -> str:
    rows = [x for x in table.walk() if x.type == "/TR"]
    cols = max((sum(1 for k in r.kids if k.type in ("/TH", "/TD")) for r in rows), default=0)
    heads = []
    for x in table.walk():
        if x.type == "/TH":
            t = " ".join(texts(y) for y in x.walk()).strip()
            if t:
                heads.append(re.sub(r"\s+", " ", t)[:40])
    say = f"Table with {_plural(cols, 'column')} and {_plural(len(rows), 'row')}"
    if heads:
        say += f"; headers: {', '.join(heads[:8])}"
    return say + "."


class _TextCache:
    def __init__(self, w):
        self.w = w
        self.pages: dict[int, Marks] = {}

    def marks(self, i: int) -> Marks:
        if i not in self.pages:
            self.pages[i] = page_marks(self.w.pages[i], self.w)
        return self.pages[i]

    def node_text(self, n: Node) -> str:
        return " ".join(self.marks(p).texts.get(m, "") for p, m in n.mcids if p is not None).strip()


def fix(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    want = [str(f) for f in (args.get("fixes") or [f for f in FIXES if f != "headings"])]
    bad = [f for f in want if f not in FIXES]
    if bad:
        raise ValueError(f"Unknown fix {bad[0]}; fixes are {', '.join(FIXES)}")
    r = core.reader(src, passwords)
    w = PdfWriter(clone_from=r)
    done: list[str] = []
    root = w._root_object
    if "tag" in want and "/StructTreeRoot" not in root:
        if core.signed(r):
            raise ValueError("Tagging rewrites every page, which would break this PDF's signatures. Tag it before it is signed.")
        _tag(w, src, passwords, args)
        done.append("tag")
    tree = Tree(root, w.pages) if "/StructTreeRoot" in root else None
    cache = _TextCache(w)
    if "title" in want:
        title = real_title((w.metadata or {}).get("/Title"))
        guess = ""
        if not title and tree:
            for n in tree.nodes():
                if n.type in HEADS or n.type == "/P":
                    guess = cache.node_text(n)[:160]
                    if guess:
                        break
        if not title and not guess and len(w.pages):
            guess = re.sub(r"\s+", " ", cache.marks(0).content.text()).strip()[:80]
        new = str(args.get("title") or title or guess or "Untitled").strip()[:300]
        w.add_metadata({"/Title": new})
        prefs = _o(root.get("/ViewerPreferences"))
        if not isinstance(prefs, DictionaryObject):
            prefs = DictionaryObject()
            root[NameObject("/ViewerPreferences")] = prefs
        prefs[NameObject("/DisplayDocTitle")] = BooleanObject(True)
        done.append("title")
    if "lang" in want and (args.get("lang") or not str(root.get("/Lang") or "").strip()):
        root[NameObject("/Lang")] = TextStringObject(str(args.get("lang") or default_lang()).strip()[:35])
        done.append("lang")
    if ("headings" in want or "spans" in want or "rtl" in want) and tree:
        ml = [cache.marks(i) for i in range(len(w.pages))]
        doc_lang = str(root.get("/Lang") or "").strip()
        if "headings" in want:
            heads = []
            for x in tree.nodes():
                lv = _heading_level(x.type)
                size = _size(_own(x, ml)[1]) if lv is not None and x.raw == x.type else None
                if size:
                    heads.append((x, size))
            steps: list[float] = []
            for s in sorted({s for _x, s in heads}, reverse=True):
                if not steps or s < steps[-1] / 1.1:
                    steps.append(s)
            moved = 0
            for x, size in heads:
                lv = min(6, 1 + next(i for i, s in enumerate(steps) if size >= s / 1.1))
                if f"/H{lv}" != x.type:
                    x.obj[NameObject("/S")] = NameObject(f"/H{lv}")
                    moved += 1
            if moved:
                done.append("headings")
        if "spans" in want:
            marked = 0
            for x in list(tree.nodes()):
                if x.kids and any(k.mcids for k in x.kids):
                    continue
                text = _own(x, ml)[0]
                sc = script_of(text) if text else None
                if sc and sc in SCRIPT_LANG and not _fits(sc, _node_lang(x, doc_lang)):
                    x.obj[NameObject("/Lang")] = TextStringObject(SCRIPT_LANG[sc])
                    marked += 1
            if marked:
                done.append("spans")
        if "rtl" in want:
            said = 0
            for x, text in list(visual_rtl(list(tree.nodes()), ml)):
                if x is not None and text:
                    x.obj[NameObject("/ActualText")] = TextStringObject(text[:4000])  # what it reads, in reading order
                    said += 1
            if said:
                done.append("rtl")
    if "tabs" in want:
        n = 0
        for page in w.pages:
            if _annots(page) and page.get("/Tabs") != "/S":
                page[NameObject("/Tabs")] = NameObject("/S")
                n += 1
        if n:
            done.append("tabs")
    if tree and tree.st is not None and "/MarkInfo" not in root:
        root[NameObject("/MarkInfo")] = DictionaryObject({NameObject("/Marked"): BooleanObject(True)})
    if "annotations" in want and tree and tree.st is not None:
        ptree = _numtree(tree.st.get("/ParentTree"), {})
        holder, holder_ref = _doc_elem(w, tree)
        added = 0
        for page in w.pages:
            glyphs = None
            for ref, a in _annots(page):
                if a.get("/Subtype") == "/Link" and not str(a.get("/Contents") or "").strip():
                    if glyphs is None:
                        try:
                            glyphs = interp.walk(page, w).glyphs
                        except Exception:
                            glyphs = []
                    a[NameObject("/Contents")] = TextStringObject(_link_text(a, glyphs))  # PDF/UA 7.18.5: a link says what it is
                    added += 1
                sp = a.get("/StructParent")
                if sp is not None and _num(_o(sp)) and isinstance(_o(ptree.get(int(_o(sp)))), DictionaryObject):
                    continue
                sub = a.get("/Subtype")
                el = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"),
                                       NameObject("/S"): NameObject("/Link" if sub == "/Link" else "/Form" if sub == "/Widget" else "/Annot"),
                                       NameObject("/P"): holder_ref, NameObject("/Pg"): page.indirect_reference})
                el_ref = w._add_object(el)
                el[NameObject("/K")] = ArrayObject([DictionaryObject({NameObject("/Type"): NameObject("/OBJR"), NameObject("/Obj"): ref,
                                                                      NameObject("/Pg"): page.indirect_reference})])
                _append_kid(holder, el_ref)
                a[NameObject("/StructParent")] = NumberObject(_parent_tree_add(w, tree.st, el_ref))
                added += 1
        if added:
            done.append("annotations")
    if "descriptions" in want:
        n = 0
        seen = set()
        for i, page in enumerate(w.pages):
            for _ref, a in _annots(page):
                if a.get("/Subtype") != "/Widget":
                    continue
                f = _field_of(a)
                if id(f) in seen or str(f.get("/TU") or "").strip():
                    continue
                seen.add(id(f))
                label = _label(cache.marks(i).content, [float(v) for v in a.get("/Rect", [0, 0, 0, 0])]) or _pretty(str(f.get("/T") or "Field"))
                f[NameObject("/TU")] = TextStringObject(label)
                n += 1
        if n:
            done.append("descriptions")
    if "summaries" in want and tree:
        n = 0
        for t in [x for x in tree.nodes() if x.type == "/Table"]:
            if t.attr("/Summary") or t.described:
                continue
            a = _o(t.obj.get("/A"))
            say = TextStringObject(_summary(t, cache.node_text))
            if isinstance(a, DictionaryObject) and a.get("/O") == "/Table":
                a[NameObject("/Summary")] = say
            else:
                entry = DictionaryObject({NameObject("/O"): NameObject("/Table"), NameObject("/Summary"): say})
                if isinstance(a, ArrayObject):
                    a.append(entry)
                elif a is not None:
                    t.obj[NameObject("/A")] = ArrayObject([t.obj["/A"], entry])
                else:
                    t.obj[NameObject("/A")] = entry
            n += 1
        if n:
            done.append("summaries")
    if "bookmarks" in want and tree and not sanitize._outline_count(root):
        parents: list = [None] * 8
        n = 0
        for x in tree.nodes():
            lv = _heading_level(x.type) or (1 if x.type == "/H" else None)
            p = x.first_page()
            if lv is None or p is None:
                continue
            t = re.sub(r"\s+", " ", cache.node_text(x)).strip()[:120]
            if not t:
                continue
            parent = next((parents[k] for k in range(lv - 1, 0, -1) if parents[k] is not None), None)
            item = w.add_outline_item(t, p, parent=parent)
            parents[lv] = item
            for k in range(lv + 1, 8):
                parents[k] = None
            n += 1
        if n:
            done.append("bookmarks")
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "fixed": done}


def _region_of(n: Node) -> bool:
    return n.type not in GROUPS


def _regions(tree: Tree) -> list[Node]:
    out = []
    stack = list(reversed(tree.top.kids))
    while stack:
        n = stack.pop()
        if _region_of(n):
            out.append(n)
        else:
            stack.extend(reversed(n.kids))
    return out


def structure(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    r = core.reader(path, passwords)
    root = r.trailer["/Root"]
    n = len(r.pages)
    want = set(core.parse_pages(pages, n)) if pages else None
    if "/StructTreeRoot" not in root:
        return "The PDF has no tags. Tag it first (autotag).", {"tagged": False, "regions": [], "figures": [], "types": list(RETAG)}
    tree = Tree(root, r.pages)
    cache: dict[int, Marks] = {}
    only = str((args or {}).get("only") or "")

    def marks(i: int) -> Marks:
        if i not in cache:
            cache[i] = page_marks(r.pages[i], r)
        return cache[i]

    out, figures, order = [], [], Counter()
    for x in _regions(tree):
        p = x.first_page()
        if p is None:
            continue
        order[p] += 1
        is_fig = x.type == "/Figure"
        if (want is not None and p + 1 not in want) and not is_fig or only == "figures" and not is_fig:
            continue
        m = marks(p)
        boxes = [m.boxes.get(mc) for y in x.walk() for pg, mc in y.mcids if pg == p]
        ub = _union([tuple(b) for b in boxes if b])
        if ub is None:
            for y in x.walk():
                for pg, a in y.objrs:
                    ao = _o(a)
                    if pg == p and isinstance(ao, DictionaryObject) and "/Rect" in ao:
                        ub = _union([ub, tuple(float(v) for v in ao["/Rect"])])
        if ub is None and is_fig:
            bb = x.attr("/BBox")
            if isinstance(bb, ArrayObject) and len(bb) == 4:
                ub = tuple(float(v) for v in bb)
        text = " ".join(m.texts.get(mc, "") for y in x.walk() for pg, mc in y.mcids if pg == p).strip()
        actual = x.obj.get("/ActualText") if x.obj is not None else None
        if actual is not None and str(actual).strip():
            text = str(actual)  # what the element says it reads, such as right-to-left text drawn in visual order
        page = r.pages[p]
        vb = core.view_box(page)
        item = {"id": x.path, "page": p + 1, "order": order[p], "type": x.type.lstrip("/"), "tag": x.raw.lstrip("/"), "text": re.sub(r"\s+", " ", text)[:160],
                "alt": x.alt, "weak": bool(x.alt and PLACEHOLDER_ALT.fullmatch(x.alt.strip())), "box": frame.from_pdf(page, ub) if ub else None, "pw": round(vb[2] - vb[0], 2), "ph": round(vb[3] - vb[1], 2)}
        if want is None or p + 1 in want:
            out.append(item)
        if is_fig:
            figures.append(item)
    lines = [f"{len(out)} tagged regions" + (f" on pages {pages}" if pages else ""), *(f"p{x['page']} #{x['order']} {x['type']} [{x['id']}] {x['text'][:60]}"
                                                                                         for x in out[:200])]
    return "\n".join(lines), {"tagged": True, "regions": out, "figures": figures, "types": list(RETAG)}


def _artifact_mcids(w: PdfWriter, page, mcids: set[int]) -> int:
    parts = _split_ops(w, page)
    if parts is None:
        return 0
    props = _o(_o(page.get("/Resources") or DictionaryObject()).get("/Properties")) or {}
    hit = 0
    out_parts = []
    for part in parts:
        out = []
        for operands, op in part:
            if op == b"BDC" and len(operands) > 1:
                p = _o(operands[1])
                if isinstance(p, NameObject):
                    p = _o(props.get(p)) if hasattr(props, "get") else None
                mc = p.get("/MCID") if isinstance(p, DictionaryObject) else None
                if mc is not None and int(_o(mc)) in mcids:
                    out.append(([NameObject("/Artifact")], b"BMC"))
                    hit += 1
                    continue
            out.append((operands, op))
        out_parts.append(out)
    if hit:
        _write_streams(w, page, out_parts)
    return hit


def _remove_kid(parent: Node, child: Node) -> None:
    holder = parent.obj
    k = holder.get("/K")
    ko = _o(k)
    if isinstance(ko, ArrayObject):
        for i, e in enumerate(list(ko)):
            if _o(e) is child.obj:
                del ko[i]
                return
    elif ko is child.obj:
        del holder["/K"]


def _move(parent: Node, child: Node, step: int) -> bool:
    ko = _o(parent.obj.get("/K"))
    if not isinstance(ko, ArrayObject):
        return False
    idx = next((i for i, e in enumerate(ko) if _o(e) is child.obj), None)
    if idx is None:
        return False
    j = idx + step
    while 0 <= j < len(ko):
        o = _o(ko[j])
        if isinstance(o, DictionaryObject) and o.get("/Type") not in ("/MCR", "/OBJR"):
            ko[idx], ko[j] = ko[j], ko[idx]
            return True
        j += step
    return False


def edit_structure(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    changes = args.get("changes")
    if not isinstance(changes, list) or not changes:
        raise ValueError("Give changes: [{id, type | alt | decorative | move}]")
    r = core.reader(src, passwords)
    w = PdfWriter(clone_from=r)
    root = w._root_object
    if "/StructTreeRoot" not in root:
        raise ValueError("The PDF has no tags. Tag it first.")
    tree = Tree(root, w.pages)
    ptree = _numtree(tree.st.get("/ParentTree"), {})
    done = Counter()
    targets = []
    for ch in changes[:500]:
        if not isinstance(ch, dict):
            continue
        node = tree.by_path.get(str(ch.get("id") or ""))
        if node is None:
            raise ValueError(f"No tagged element {ch.get('id')}; read the structure again")
        targets.append((node, ch))
    for node, ch in targets:
        if "alt" in ch:
            alt = re.sub(r"\s+", " ", str(ch.get("alt") or "")).strip()[:2000]
            if alt:
                node.obj[NameObject("/Alt")] = TextStringObject(alt)
            elif "/Alt" in node.obj:
                del node.obj["/Alt"]
            done["alt"] += 1
        if ch.get("type"):
            t = str(ch["type"]).lstrip("/")
            if t not in RETAG and t != "Artifact":
                raise ValueError(f"Type is one of {', '.join(RETAG)} or Artifact")
            if t == "Artifact":
                ch["decorative"] = True
            else:
                node.obj[NameObject("/S")] = NameObject("/" + t)
                done["type"] += 1
        if ch.get("move") in ("up", "down") and node.parent is not None and node.parent.obj is not None:
            if _move(node.parent, node, -1 if ch["move"] == "up" else 1):
                done["moved"] += 1
    for node, ch in targets:
        if not ch.get("decorative"):
            continue
        by_page: dict[int, set[int]] = {}
        for y in node.walk():
            for p, mc in y.mcids:
                if p is not None:
                    by_page.setdefault(p, set()).add(mc)
        for p, mcs in by_page.items():
            page = w.pages[p]
            _artifact_mcids(w, page, mcs)
            sp = page.get("/StructParents")
            arr = _o(ptree.get(int(_o(sp)))) if sp is not None and _num(_o(sp)) else None
            if isinstance(arr, ArrayObject):
                for mc in mcs:
                    if 0 <= mc < len(arr):
                        arr[mc] = NullObject()
        if node.parent is not None and node.parent.obj is not None:
            _remove_kid(node.parent, node)
        done["decorative"] += 1
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), **{k: v for k, v in done.items()}}


STATUS_WORD = {"passed": "Passed", "failed": "Failed", "manual": "Check by hand", "skipped": "Skipped"}


def report(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    _text, data = check(src, args=args, passwords=passwords)
    e = html.escape
    name = str((args or {}).get("name") or data.get("title") or "PDF")
    s = data["summary"]
    rows = []
    for g in data["groups"]:
        rows.append(f"<h2>{e(g['name'])}</h2>\n<table>\n<thead><tr><th scope=\"col\">Rule</th><th scope=\"col\">Status</th><th scope=\"col\">Detail</th></tr></thead>\n<tbody>")
        for x in g["rules"]:
            found = "".join(f"<li>{'Page ' + str(f['page']) + ': ' if f.get('page') else ''}{e(f['text'])}</li>" for f in x["findings"][:50])
            more = f"<li>and {x['more'] + max(0, len(x['findings']) - 50)} more</li>" if x["more"] or len(x["findings"]) > 50 else ""
            rows.append(f"<tr class=\"{x['status']}\"><th scope=\"row\">{e(x['name'])}</th><td>{STATUS_WORD[x['status']]}</td>"
                        f"<td>{e(x['say'])}{'<ul>' + found + more + '</ul>' if found else ''}</td></tr>")
        rows.append("</tbody>\n</table>")
    when = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    doc = f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accessibility report: {e(name)}</title>
<style>body{{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}}table{{border-collapse:collapse;width:100%}}
th,td{{text-align:left;vertical-align:top;border-bottom:1px solid #ddd;padding:.4rem .5rem}}tr.failed td:nth-child(2){{color:#b00020;font-weight:600}}
tr.manual td:nth-child(2){{color:#8a5a00}}tr.passed td:nth-child(2){{color:#1b6e2a}}ul{{margin:.3rem 0 0;padding-left:1.2rem}}</style></head>
<body>
<h1>Accessibility report</h1>
<p>{e(name)} · {data['pages']} page{'s' if data['pages'] != 1 else ''} · checked by formpdf on {when}</p>
<p>{s['failed']} failed, {s['manual']} to check by hand, {s['passed']} passed, {s['skipped']} skipped.</p>
{chr(10).join(rows)}
</body>
</html>
"""
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(doc)
    return {"pages": data["pages"], "filename": f"{re.sub(r'[^A-Za-z0-9 _.-]+', '', name)[:80] or 'PDF'} accessibility report.html"}


UA_NS = "http://www.aiim.org/pdfua/ns/id/"


def claim_ua(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    """Says in the XMP metadata that the file is PDF/UA-1 (ISO 14289-1 5), but only when that is true as far as formpdf
    can tell: the file is tagged, every font is embedded (formpdf embeds the ones it has a match for) and the
    accessibility check finds nothing failed. Figures without alternate text fail that check, so they come first."""
    from . import pdfa

    w = core.writer(src, passwords)
    root = w._root_object
    if "/StructTreeRoot" not in root:
        raise ValueError("PDF/UA needs tags: tag the PDF first (Accessibility > Tag the PDF)")
    done: dict = {}
    pdfa.fix_fonts(w, True, done)
    loose = sorted({pdfa._base(f) or "unnamed" for _pi, _ref, f in pdfa.fonts(w) if not pdfa.embedded(f)})
    if loose:
        raise ValueError(f"PDF/UA needs every font embedded, and formpdf has no matching font for {', '.join(loose[:4])}")
    title = real_title((w.metadata or {}).get("/Title")) or ""
    _xmp_title(w, title or "Untitled")
    meta = _o(root["/Metadata"])
    text = meta.get_data().decode("utf-8", "replace")
    row = f'<pdfuaid:part xmlns:pdfuaid="{UA_NS}">1</pdfuaid:part>'
    text = re.sub(r"<pdfuaid:part[^>]*>[^<]*</pdfuaid:part>", "", text)
    if "</rdf:Description>" not in text:
        raise ValueError("The XMP metadata has no description to add the PDF/UA claim to")
    text = pdfa.ua_extension(text.replace("</rdf:Description>", row + "</rdf:Description>", 1))
    xmp = DecodedStreamObject()
    xmp[NameObject("/Type")] = NameObject("/Metadata")
    xmp[NameObject("/Subtype")] = NameObject("/XML")
    xmp.set_data(text.encode("utf-8"))
    root[NameObject("/Metadata")] = w._add_object(xmp)
    with open(out, "wb") as fh:
        w.write(fh)
    _t, rep = check(out)
    failed = [r["name"] for g in rep.get("groups", []) for r in g.get("rules", []) if r.get("status") == "failed"]
    if failed:
        raise ValueError(f"PDF/UA is claimed only when the accessibility check has nothing failed; failing now: {', '.join(failed[:5])}")
    return {"pages": len(w.pages), "fonts_embedded": done.get("fonts embedded", 0)}


actions.register(actions.Action("claim_ua", "change", "Claim PDF/UA-1", "claimed", ("pdf/ua", "pdf/ua-1", "iso 14289", "claim pdf/ua", "accessible pdf"),
                                run=claim_ua))
actions.register(actions.Action("accessibility", "read", "Check accessibility", words=("accessibility checker", "a11y", "screen reader", "pdf/ua", "section 508", "wcag"),
                                run=check))
actions.register(actions.Action("structure", "read", "Read tags and reading order", words=("tags", "reading order", "alt text", "structure tree"), run=structure))
actions.register(actions.Action("autotag", "change", "Tag for accessibility", "tagged", ("autotag", "add tags", "make accessible", "tagged pdf"),
                                fields=(actions.Field("lang", "Language", hint="For example en-US"), actions.Field("title", "Title")), run=tag))
actions.register(actions.Action("fix_accessibility", "change", "Fix accessibility", "accessible", ("fix accessibility", "title", "language", "tab order"),
                                fields=(actions.Field("lang", "Language", hint="For example en-US"), actions.Field("title", "Title")), run=fix))
actions.register(actions.Action("edit_structure", "change", "Edit tags", "retagged", ("reading order", "alt text", "alternate text", "decorative", "retag"),
                                run=edit_structure))
actions.register(actions.Action("accessibility_report", "export", "Accessibility report", ext=".html", words=("accessibility report",), run=report))
