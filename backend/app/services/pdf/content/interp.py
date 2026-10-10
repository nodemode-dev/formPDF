from dataclasses import dataclass, field

from pypdf.generic import ContentStream, DictionaryObject, NameObject

from .fonts import FontInfo

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
PAINT = {b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"n"}
MAX_DEPTH = 8
MAX_OPS = 4_000_000


def mult(m, n) -> tuple:
    a, b, c, d, e, f = m
    p, q, r, s, t, u = n
    return (a * p + b * r, a * q + b * s, c * p + d * r, c * q + d * s, e * p + f * r + t, e * q + f * s + u)


def apply(m, x: float, y: float) -> tuple[float, float]:
    return x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]


def box_of(m, x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
    pts = [apply(m, x, y) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _f(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


@dataclass
class Glyph:
    where: tuple
    op: int
    seq: int
    code: int
    raw: bytes
    text: str
    font: str
    size: float
    box: tuple
    origin: tuple
    advance: float
    render: int
    mcid: int | None
    artifact: bool
    color: tuple = ()


@dataclass
class Draw:
    where: tuple
    op: int
    kind: str
    name: str
    ctm: tuple
    box: tuple | None
    paint: str = ""
    clip: bool = False
    mcid: int | None = None
    artifact: bool = False
    points: tuple = ()


@dataclass
class Stream:
    where: tuple
    operations: list
    resources: object
    ctm: tuple
    xobject: object = None


@dataclass
class PageContent:
    glyphs: list[Glyph] = field(default_factory=list)
    draws: list[Draw] = field(default_factory=list)
    streams: dict = field(default_factory=dict)
    fonts: dict = field(default_factory=dict)
    truncated: bool = False

    def text(self) -> str:
        return "".join(g.text for g in self.glyphs)

    def within(self, box, *, min_overlap: float = 0.2) -> list[Glyph]:
        bx0, by0, bx1, by1 = box
        out = []
        for g in self.glyphs:
            x0, y0, x1, y1 = g.box
            ox, oy = min(x1, bx1) - max(x0, bx0), min(y1, by1) - max(y0, by0)
            w, h = max(x1 - x0, 1e-6), max(y1 - y0, 1e-6)
            if (w <= 1e-6 or h <= 1e-6) and bx0 <= g.origin[0] <= bx1 and by0 <= g.origin[1] <= by1:
                out.append(g)
            elif ox > min(w * min_overlap, 1.0) and oy > min(h * min_overlap, 1.0):
                out.append(g)
        return out


class _State:
    __slots__ = ("ctm", "tc", "tw", "tz", "tl", "font", "size", "rise", "tr", "fill")

    def __init__(self):
        self.ctm = IDENTITY
        self.tc = self.tw = self.tl = self.rise = 0.0
        self.tz = 1.0
        self.font: FontInfo | None = None
        self.size = 0.0
        self.tr = 0
        self.fill: tuple = (0.0,)

    def copy(self) -> "_State":
        s = _State()
        for k in self.__slots__:
            setattr(s, k, getattr(self, k))
        return s


def _get(d, key):
    if d is None:
        return None
    d = d.get_object() if hasattr(d, "get_object") else d
    v = d.get(key) if isinstance(d, (dict, DictionaryObject)) else None
    return v.get_object() if v is not None and hasattr(v, "get_object") else v


class Interpreter:
    def __init__(self, pdf, *, forms: bool = True):
        self.pdf = pdf
        self.forms = forms
        self.out = PageContent()
        self.count = 0
        self._fonts: dict[int, FontInfo] = {}

    def font(self, resources, name: str) -> FontInfo | None:
        fdict = _get(_get(resources, "/Font"), name)
        if fdict is None:
            return None
        key = id(fdict)
        info = self._fonts.get(key)
        if info is None:
            info = self._fonts[key] = FontInfo(fdict, name.lstrip("/"))
            self.out.fonts[name] = info
        return info

    def run(self, operations: list, resources, ctm, where: tuple, depth: int, seen: set) -> None:
        st = _State()
        st.ctm = ctm
        stack: list[_State] = []
        tm = tlm = IDENTITY
        marks: list[tuple[str, int | None]] = []
        path: list[tuple[float, float]] = []
        subs: list[list[tuple[float, float]]] = []
        clip_pending = False
        for i, (operands, op) in enumerate(operations):
            self.count += 1
            if self.count > MAX_OPS:
                self.out.truncated = True
                return
            if op == b"q":
                stack.append(st.copy())
            elif op == b"Q":
                if stack:
                    st = stack.pop()
            elif op == b"cm" and len(operands) == 6:
                st.ctm = mult(tuple(_f(v) for v in operands), st.ctm)
            elif op == b"BT":
                tm = tlm = IDENTITY
            elif op == b"Tc" and operands:
                st.tc = _f(operands[0])
            elif op == b"Tw" and operands:
                st.tw = _f(operands[0])
            elif op == b"Tz" and operands:
                st.tz = _f(operands[0], 100.0) / 100
            elif op == b"TL" and operands:
                st.tl = _f(operands[0])
            elif op == b"Ts" and operands:
                st.rise = _f(operands[0])
            elif op == b"Tr" and operands:
                st.tr = int(_f(operands[0]))
            elif op == b"Tf" and len(operands) == 2:
                st.font = self.font(resources, str(operands[0]))
                st.size = _f(operands[1])
            elif op == b"Td" and len(operands) == 2:
                tlm = mult((1, 0, 0, 1, _f(operands[0]), _f(operands[1])), tlm)
                tm = tlm
            elif op == b"TD" and len(operands) == 2:
                st.tl = -_f(operands[1])
                tlm = mult((1, 0, 0, 1, _f(operands[0]), _f(operands[1])), tlm)
                tm = tlm
            elif op == b"Tm" and len(operands) == 6:
                tm = tlm = tuple(_f(v) for v in operands)
            elif op == b"T*":
                tlm = mult((1, 0, 0, 1, 0, -st.tl), tlm)
                tm = tlm
            elif op in (b"Tj", b"TJ", b"'", b'"'):
                if op in (b"'", b'"'):
                    if op == b'"' and len(operands) == 3:
                        st.tw, st.tc = _f(operands[0]), _f(operands[1])
                    tlm = mult((1, 0, 0, 1, 0, -st.tl), tlm)
                    tm = tlm
                items = operands[0] if op == b"TJ" and operands else operands[-1:]
                seq = 0
                for item in items:
                    if isinstance(item, (int, float)) or type(item).__name__ in ("NumberObject", "FloatObject"):
                        tm = mult((1, 0, 0, 1, -_f(item) / 1000 * st.size * st.tz, 0), tm)
                        continue
                    data = item.original_bytes if hasattr(item, "original_bytes") else bytes(str(item), "latin-1")
                    tm, seq = self._show(data, st, tm, where, i, seq, marks)
            elif op == b"Do" and operands:
                self._do(str(operands[0]), resources, st, where, i, depth, seen, marks)
            elif op == b"INLINE IMAGE":
                self.out.draws.append(Draw(where, i, "inline", "", st.ctm, box_of(st.ctm, 0, 0, 1, 1), **self._mark(marks)))
            elif op in (b"m", b"l") and len(operands) >= 2:
                pt = apply(st.ctm, _f(operands[0]), _f(operands[1]))
                path.append(pt)
                if op == b"m" or not subs:
                    subs.append([pt])
                else:
                    subs[-1].append(pt)
            elif op in (b"c", b"v", b"y"):
                vals = [_f(v) for v in operands]
                pts = [apply(st.ctm, vals[k], vals[k + 1]) for k in range(0, len(vals) - 1, 2)]
                path.extend(pts)
                if pts and not subs:
                    subs.append([])
                if pts:
                    subs[-1].append(pts[-1])
            elif op == b"re" and len(operands) == 4:
                x, y, w, h = (_f(v) for v in operands)
                pts = [apply(st.ctm, px, py) for px, py in ((x, y), (x + w, y), (x + w, y + h), (x, y + h))]
                path.extend(pts)
                subs.append(pts + pts[:1])
            elif op == b"h" and subs and len(subs[-1]) > 1:
                subs[-1].append(subs[-1][0])
            elif op in (b"W", b"W*"):
                clip_pending = True
            elif op in PAINT:
                box = (min(p[0] for p in path), min(p[1] for p in path), max(p[0] for p in path), max(p[1] for p in path)) if path else None
                kind = "path" if op != b"n" else ("clip" if clip_pending else "nop")
                self.out.draws.append(Draw(where, i, kind, "", st.ctm, box, op.decode(), clip_pending, **self._mark(marks),
                                           points=tuple(tuple(s) for s in subs) if kind == "path" else ()))
                path, subs, clip_pending = [], [], False
            elif op == b"sh" and operands:
                self.out.draws.append(Draw(where, i, "shading", str(operands[0]), st.ctm, None, **self._mark(marks)))
            elif op in (b"sc", b"scn", b"g", b"rg", b"k"):
                st.fill = tuple(_f(v) for v in operands if not isinstance(v, NameObject))
            elif op == b"BMC" and operands:
                marks.append((str(operands[0]), None))
            elif op == b"BDC" and operands:
                props = operands[1] if len(operands) > 1 else None
                if isinstance(props, NameObject):
                    props = _get(_get(resources, "/Properties"), str(props))
                mcid = props.get("/MCID") if isinstance(props, (dict, DictionaryObject)) else None
                marks.append((str(operands[0]), int(mcid) if mcid is not None else None))
            elif op == b"EMC":
                if marks:
                    marks.pop()

    def _mark(self, marks) -> dict:
        mcid = next((m for _, m in reversed(marks) if m is not None), None)
        return {"mcid": mcid, "artifact": any(t == "/Artifact" for t, _ in marks)}

    def _show(self, data: bytes, st: _State, tm, where, op_index: int, seq: int, marks) -> tuple:
        f = st.font
        if f is None:
            return tm, seq
        trm_base = (st.size * st.tz, 0, 0, st.size, 0, st.rise)
        mark = self._mark(marks)
        for code, raw in f.codes(data):
            w0 = f.width(code)
            trm = mult(mult(trm_base, tm), st.ctm)
            box = box_of(trm, 0, f.descent, w0, f.ascent)
            origin = apply(trm, 0, 0)
            space = st.tw if (len(raw) == 1 and raw == b" ") else 0.0
            tx = (w0 * st.size + st.tc + space) * st.tz
            self.out.glyphs.append(Glyph(where, op_index, seq, code, raw, f.unicode(code), f.key, st.size, box, origin, tx, st.tr,
                                         mark["mcid"], mark["artifact"], st.fill))
            seq += 1
            tm = mult((1, 0, 0, 1, tx, 0), tm)
        return tm, seq

    def _do(self, name: str, resources, st: _State, where, op_index: int, depth: int, seen: set, marks) -> None:
        xo = _get(_get(resources, "/XObject"), name)
        if xo is None:
            return
        sub = str(xo.get("/Subtype", ""))
        mark = self._mark(marks)
        if sub == "/Image":
            self.out.draws.append(Draw(where, op_index, "image", name, st.ctm, box_of(st.ctm, 0, 0, 1, 1), **mark))
            return
        if sub != "/Form":
            return
        matrix = tuple(_f(v) for v in xo.get("/Matrix", IDENTITY)) if xo.get("/Matrix") is not None else IDENTITY
        ctm = mult(matrix, st.ctm)
        bb = [_f(v) for v in xo.get("/BBox", [0, 0, 0, 0])]
        self.out.draws.append(Draw(where, op_index, "form", name, ctm, box_of(ctm, *bb) if len(bb) == 4 else None, **mark))
        key = id(xo)
        if not self.forms or depth >= MAX_DEPTH or key in seen:
            return
        try:
            ops = ContentStream(xo, self.pdf).operations
        except Exception:
            return
        sub_where = where + (op_index,)
        res = xo.get("/Resources")
        res = res.get_object() if res is not None else resources
        self.out.streams[sub_where] = Stream(sub_where, ops, res, ctm, xo)
        self.run(ops, res, ctm, sub_where, depth + 1, seen | {key})


def page_operations(page, pdf) -> list:
    contents = page.get_contents()
    if contents is None:
        return []
    return ContentStream(contents, pdf).operations if not isinstance(contents, ContentStream) else contents.operations


def walk(page, pdf, *, forms: bool = True) -> PageContent:
    it = Interpreter(pdf, forms=forms)
    ops = page_operations(page, pdf)
    res = page.get("/Resources")
    res = res.get_object() if res is not None else DictionaryObject()
    it.out.streams[()] = Stream((), ops, res, IDENTITY)
    it.run(ops, res, IDENTITY, (), 0, set())
    return it.out
