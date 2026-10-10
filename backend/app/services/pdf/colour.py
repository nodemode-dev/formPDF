import io
from collections import Counter

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, ContentStream, DecodedStreamObject, DictionaryObject, EncodedStreamObject, FloatObject, IndirectObject,
                           NameObject, NumberObject, StreamObject)

KINDS = ("gray", "rgb", "cmyk")
DEVICE = {"/DeviceGray": "gray", "/DeviceRGB": "rgb", "/DeviceCMYK": "cmyk", "/G": "gray", "/RGB": "rgb", "/CMYK": "cmyk"}
TARGET_SPACE = {"gray": NameObject("/DeviceGray"), "rgb": NameObject("/DeviceRGB")}
MAX_STREAMS = 20_000


def _o(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def to_rgb(kind: str, vals: list[float]) -> tuple[float, float, float]:
    if kind == "gray":
        g = vals[0] if vals else 0.0
        return g, g, g
    if kind == "cmyk":
        c, m, y, k = (vals + [0.0] * 4)[:4]
        return (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)
    r, g, b = (vals + [0.0] * 3)[:3]
    return r, g, b


def convert_values(kind: str, vals: list[float], target: str) -> list[float]:
    r, g, b = to_rgb(kind, vals)
    if target == "gray":
        return [round(0.299 * r + 0.587 * g + 0.114 * b, 4)]
    return [round(r, 4), round(g, 4), round(b, 4)]


def space_kind(cs, resources) -> str | None:
    cs = _o(cs)
    if isinstance(cs, NameObject):
        name = str(cs)
        if name in DEVICE:
            return DEVICE[name]
        table = _o(resources.get("/ColorSpace")) if resources is not None else None
        named = _o(table.get(name)) if isinstance(table, DictionaryObject) else None
        return space_kind(named, None) if named is not None else None
    if isinstance(cs, ArrayObject) and cs:
        fam = str(_o(cs[0]))
        if fam in ("/CalGray",):
            return "gray"
        if fam in ("/CalRGB",):
            return "rgb"
        if fam == "/ICCBased" and len(cs) > 1:
            n = _o(cs[1]).get("/N")
            return {1: "gray", 3: "rgb", 4: "cmyk"}.get(int(_o(n)) if n is not None else 0)
        if fam in DEVICE:
            return DEVICE[fam]
    return None


def space_family(cs, resources) -> str:
    cs = _o(cs)
    if isinstance(cs, NameObject):
        name = str(cs)
        if name in DEVICE or name in ("/Pattern",):
            return name
        named = _o(resources.get("/ColorSpace")) if resources is not None else None
        target = _o(named.get(name)) if isinstance(named, DictionaryObject) else None
        return space_family(target, None) if target is not None else name
    if isinstance(cs, ArrayObject) and cs:
        return str(_o(cs[0]))
    return ""


def _replace_stream(w: PdfWriter, ref, obj, data: bytes):
    s = DecodedStreamObject()
    for k, v in obj.items():
        if k not in ("/Length", "/Filter", "/DecodeParms"):
            s[NameObject(k)] = v
    s.set_data(data)
    try:
        s = s.flate_encode()
    except Exception:
        pass
    if isinstance(ref, IndirectObject):
        w._objects[ref.idnum - 1] = s
        s.indirect_reference = ref
        return ref
    return w._add_object(s)


class Converter:
    def __init__(self, w: PdfWriter, target: str | None):
        self.w = w
        self.target = target
        self.seen: set = set()
        self.used = Counter()
        self.where: dict[str, set] = {}
        self.page = 0
        self.changed = Counter()
        self.left = Counter()

    def _note(self, kind: str) -> None:
        self.used[kind] += 1
        self.where.setdefault(kind, set()).add(self.page + 1)

    def page_all(self, i: int, page) -> None:
        self.page = i
        res = _o(page.get("/Resources")) or DictionaryObject()
        raw = page.raw_get("/Contents") if "/Contents" in page else None
        if raw is not None:
            arr = _o(raw)
            refs = list(arr) if isinstance(arr, ArrayObject) else [raw]
            new = []
            for ref in refs:
                new.append(self.stream(ref, res))
            if self.target and new != refs:
                page[NameObject("/Contents")] = ArrayObject(new) if isinstance(arr, ArrayObject) else new[0]
        for ref in _o(page.get("/Annots")) or []:
            a = _o(ref)
            ap = _o(a.get("/AP")) if isinstance(a, DictionaryObject) else None
            if not isinstance(ap, DictionaryObject):
                continue
            for key in ("/N", "/D", "/R"):
                v = ap.raw_get(key) if key in ap else None
                o = _o(v)
                if isinstance(o, StreamObject):
                    self.form(v)
                elif isinstance(o, DictionaryObject):
                    for st in list(o.keys()):
                        if isinstance(_o(o[st]), StreamObject):
                            self.form(o.raw_get(st))
        self.resources_extra(res)

    def resources_extra(self, res) -> None:
        for name, sh in (_o(res.get("/Shading")) or {}).items():
            k = space_kind(_o(sh).get("/ColorSpace"), None) if isinstance(_o(sh), DictionaryObject) else None
            if k:
                self._note(k)
                if self.target and k != self.target:
                    self.left["shading"] += 1

    def stream(self, ref, res):
        obj = _o(ref)
        key = ref.idnum if isinstance(ref, IndirectObject) else id(obj)
        if key in self.seen or len(self.seen) > MAX_STREAMS:
            return ref
        self.seen.add(key)
        try:
            ops = list(ContentStream(obj, self.w).operations)
        except Exception:
            return ref
        out, dirty = self.ops(ops, res)
        if self.target and dirty:
            cs = ContentStream(None, self.w)
            cs.operations = out
            return _replace_stream(self.w, ref, obj, cs.get_data())
        return ref

    def form(self, ref) -> None:
        obj = _o(ref)
        if not isinstance(obj, StreamObject):
            return
        res = _o(obj.get("/Resources")) or DictionaryObject()
        grp = _o(obj.get("/Group"))
        if isinstance(grp, DictionaryObject) and grp.get("/CS") is not None:
            k = space_kind(grp.get("/CS"), None)
            if k:
                self._note(k)
                if self.target and k != self.target:
                    grp[NameObject("/CS")] = TARGET_SPACE[self.target]
        self.stream(ref, res)
        self.resources_extra(res)

    def image(self, ref) -> None:
        obj = _o(ref)
        key = ref.idnum if isinstance(ref, IndirectObject) else id(obj)
        if key in self.seen:
            return
        self.seen.add(key)
        if obj.get("/ImageMask"):
            return
        smask = obj.raw_get("/SMask") if "/SMask" in obj else None
        kind = space_kind(obj.get("/ColorSpace"), None)
        fam = space_family(obj.get("/ColorSpace"), None)
        if kind is None and fam == "/Indexed":
            base = _o(obj.get("/ColorSpace"))[1]
            kind = space_kind(base, None)
        if kind is None:
            if fam:
                self._note(fam.lstrip("/").lower())
            return
        self._note(kind)
        if not self.target or kind == self.target or (self.target == "rgb" and kind == "gray" and fam != "/Indexed"):
            return
        try:
            pil = obj.decode_as_image()
        except Exception:
            self.left["image"] += 1
            return
        if pil is None:
            self.left["image"] += 1
            return
        mode = "L" if self.target == "gray" else "RGB"
        if pil.mode in ("RGBA", "LA", "PA"):
            pil = pil.convert(mode)
        pil = pil.convert(mode)
        jpeg = str(obj.get("/Filter")) in ("/DCTDecode", "[/DCTDecode]")
        new_keys = {k: v for k, v in obj.items() if k not in ("/Length", "/Filter", "/DecodeParms", "/ColorSpace", "/BitsPerComponent", "/Decode")}
        if "/Mask" in new_keys and isinstance(_o(new_keys["/Mask"]), ArrayObject):
            del new_keys["/Mask"]
        if jpeg:
            buf = io.BytesIO()
            pil.save(buf, "JPEG", quality=90)
            s = EncodedStreamObject()
            for k, v in new_keys.items():
                s[NameObject(k)] = v
            s[NameObject("/Filter")] = NameObject("/DCTDecode")
            s._data = buf.getvalue()
        else:
            d = DecodedStreamObject()
            for k, v in new_keys.items():
                d[NameObject(k)] = v
            d.set_data(pil.tobytes())
            s = d.flate_encode()
        s[NameObject("/ColorSpace")] = TARGET_SPACE[self.target]
        s[NameObject("/BitsPerComponent")] = NumberObject(8)
        s[NameObject("/Width")] = NumberObject(pil.width)
        s[NameObject("/Height")] = NumberObject(pil.height)
        if smask is not None:
            s[NameObject("/SMask")] = smask
        if isinstance(ref, IndirectObject):
            self.w._objects[ref.idnum - 1] = s
            s.indirect_reference = ref
        self.changed["images"] += 1

    def ops(self, ops: list, res) -> tuple[list, bool]:
        out = []
        dirty = False
        fill = stroke = "gray"
        fill_conv = stroke_conv = False
        stack = []
        t = self.target
        xobjects = _o(res.get("/XObject")) or DictionaryObject()
        for operands, op in ops:
            if op == b"q":
                stack.append((fill, stroke, fill_conv, stroke_conv))
            elif op == b"Q" and stack:
                fill, stroke, fill_conv, stroke_conv = stack.pop()
            if op in (b"rg", b"RG", b"k", b"K", b"g", b"G"):
                kind = {b"rg": "rgb", b"RG": "rgb", b"k": "cmyk", b"K": "cmyk", b"g": "gray", b"G": "gray"}[op]
                self._note(kind)
                if op in (b"rg", b"k", b"g"):
                    fill, fill_conv = kind, False
                else:
                    stroke, stroke_conv = kind, False
                if t and kind != t and not (t == "rgb" and kind == "gray"):
                    vals = convert_values(kind, [_f(v) for v in operands], t)
                    new_op = (b"g" if t == "gray" else b"rg") if op in (b"rg", b"k", b"g") else (b"G" if t == "gray" else b"RG")
                    out.append(([FloatObject(v) for v in vals], new_op))
                    self.changed["colours"] += 1
                    dirty = True
                    continue
            elif op in (b"cs", b"CS") and operands:
                kind = space_kind(operands[0], res)
                fam = space_family(operands[0], res)
                if kind:
                    self._note(kind)
                elif fam not in ("/Pattern", ""):
                    self._note(fam.lstrip("/").lower())
                conv = bool(t and kind and kind != t and not (t == "rgb" and kind == "gray"))
                if op == b"cs":
                    fill, fill_conv = kind or fam, conv
                else:
                    stroke, stroke_conv = kind or fam, conv
                if conv:
                    out.append(([TARGET_SPACE[t]], op))
                    dirty = True
                    continue
            elif op in (b"sc", b"scn", b"SC", b"SCN"):
                fill_side = op in (b"sc", b"scn")
                conv, kind = (fill_conv, fill) if fill_side else (stroke_conv, stroke)
                if conv and kind in KINDS:
                    nums = [_f(v) for v in operands if not isinstance(v, NameObject)]
                    out.append(([FloatObject(v) for v in convert_values(kind, nums, t)], op))
                    dirty = True
                    continue
            elif op == b"Do" and operands:
                ref = xobjects.raw_get(operands[0]) if operands[0] in xobjects else None
                xo = _o(ref)
                if isinstance(xo, StreamObject):
                    if xo.get("/Subtype") == "/Form":
                        self.form(ref)
                    elif xo.get("/Subtype") == "/Image":
                        self.image(ref)
            elif op == b"sh" and operands:
                sh = _o((_o(res.get("/Shading")) or {}).get(operands[0]))
                k = space_kind(sh.get("/ColorSpace"), None) if isinstance(sh, DictionaryObject) else None
                if k:
                    self._note(k)
                    if t and k != t:
                        self.left["shading"] += 1
            elif op == b"INLINE IMAGE":
                cs = operands[0].get("/CS", operands[0].get("/ColorSpace")) if operands and isinstance(operands[0], dict) else None
                k = space_kind(cs, res) if cs is not None else None
                if k:
                    self._note(k)
                    if t and k != t:
                        self.left["inline"] += 1
            out.append((operands, op))
        return out, dirty


def convert(w: PdfWriter, target: str) -> dict:
    c = Converter(w, target)
    for i, page in enumerate(w.pages):
        c.page_all(i, page)
    return {"colours": c.changed["colours"], "images": c.changed["images"], "left": dict(c.left)}


def scan(w, pages=None) -> Converter:
    c = Converter(w, None)
    for i, page in enumerate(w.pages):
        if pages is None or i in pages:
            c.page_all(i, page)
    return c
