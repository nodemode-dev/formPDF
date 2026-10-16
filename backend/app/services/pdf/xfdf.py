import base64
import io
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

from pypdf import PdfReader
from pypdf.generic import ArrayObject, BooleanObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject
from reportlab.pdfgen import canvas as rlcanvas

from . import actions, annot, core

NS = "http://ns.adobe.com/xfdf/"
MAX_BYTES = 20 * 1024 * 1024
MAX_ANNOTS = 5000
ELEMENT = {"/Text": "text", "/FreeText": "freetext", "/Line": "line", "/Square": "square", "/Circle": "circle", "/Polygon": "polygon",
           "/PolyLine": "polyline", "/Highlight": "highlight", "/Underline": "underline", "/Squiggly": "squiggly", "/StrikeOut": "strikeout",
           "/Stamp": "stamp", "/Caret": "caret", "/Ink": "ink"}
SUBTYPE = {v: k for k, v in ELEMENT.items()}
FLAGS = ("invisible", "hidden", "print", "nozoom", "norotate", "noview", "readonly", "locked", "togglenoview", "lockedcontents")
ENDINGS = ("Square", "Circle", "Diamond", "OpenArrow", "ClosedArrow", "None", "Butt", "ROpenArrow", "RClosedArrow", "Slash")


def _num(v) -> str:
    return f"{float(v):.4f}".rstrip("0").rstrip(".")


def _nums(vals) -> str:
    return ",".join(_num(v) for v in vals)


def _hex(arr) -> str:
    vals = [float(v) for v in list(arr or [])]
    if len(vals) == 1:
        vals = vals * 3
    elif len(vals) == 4:
        c, m, y, k = vals
        vals = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
    if len(vals) != 3:
        return ""
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02X}" for v in vals)


def _flags(f: int) -> str:
    return ",".join(name for bit, name in enumerate(FLAGS) if f & (1 << bit))


def _str(v) -> str:
    v = v.get_object() if hasattr(v, "get_object") else v
    return str(v or "")


def _name_of(a, pi: int, k: int) -> str:
    nm = _str(a.get("/NM")).strip()
    return nm or f"fs-p{pi + 1}-a{k}"


def export(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    r = core.reader(src, passwords)
    idx = set(core.parse_pages(pages, len(r.pages))) if pages else None
    names: dict[int, str] = {}
    rows = []
    for pi, page in enumerate(r.pages):
        arr = page.get("/Annots")
        if arr is None:
            continue
        for k, ref in enumerate(arr.get_object()):
            a = ref.get_object()
            if not isinstance(a, DictionaryObject) or str(a.get("/Subtype")) not in ELEMENT:
                continue
            if getattr(ref, "idnum", None) is not None:
                names[ref.idnum] = _name_of(a, pi, k)
            if idx is None or pi + 1 in idx:
                rows.append((pi, k, a))
    parts = []
    counts = {"comments": 0, "replies": 0}
    for pi, k, a in rows:
        sub = str(a["/Subtype"])
        tag = ELEMENT[sub]
        attrs = {"page": str(pi), "name": _name_of(a, pi, k)}
        rect = [float(v) for v in (a.get("/Rect") or [0, 0, 0, 0])]
        attrs["rect"] = _nums([min(rect[0], rect[2]), min(rect[1], rect[3]), max(rect[0], rect[2]), max(rect[1], rect[3])])
        for key, attr in (("/T", "title"), ("/M", "date"), ("/CreationDate", "creationdate"), ("/Subj", "subject")):
            if a.get(key) is not None:
                attrs[attr] = _str(a[key])
        if a.get("/C"):
            attrs["color"] = _hex(a["/C"])
        if a.get("/IC"):
            attrs["interior-color"] = _hex(a["/IC"])
        if a.get("/CA") is not None:
            attrs["opacity"] = _num(a["/CA"])
        f = int(a.get("/F", 0) or 0)
        if f:
            attrs["flags"] = _flags(f)
        if a.get("/Name") is not None:
            attrs["icon"] = str(a["/Name"])[1:]
        bs = a.get("/BS")
        if bs is not None and bs.get_object().get("/W") is not None:
            attrs["width"] = _num(bs.get_object()["/W"])
        irt = a.raw_get("/IRT") if "/IRT" in a else None
        if irt is not None:
            parent = names.get(getattr(irt, "idnum", -1))
            if parent:
                attrs["inreplyto"] = parent
                attrs["replyType"] = "group" if str(a.get("/RT") or "/R") == "/Group" else "reply"
        if "/State" in a:
            attrs["state"] = str(a["/State"])[1:]
            attrs["statemodel"] = str(a.get("/StateModel") or "/Review")[1:]
        if a.get("/QuadPoints"):
            attrs["coords"] = _nums(a["/QuadPoints"])
        if sub == "/Line" and a.get("/L"):
            ln = [float(v) for v in a["/L"]]
            attrs["start"], attrs["end"] = _nums(ln[:2]), _nums(ln[2:4])
            le = list(a.get("/LE") or [])
            if len(le) == 2:
                attrs["head"], attrs["tail"] = str(le[0])[1:], str(le[1])[1:]
        if sub == "/FreeText" and a.get("/DA") is not None:
            attrs["defaultappearance"] = _str(a["/DA"])
        if "/Open" in a:
            attrs["open"] = "yes" if getattr(a["/Open"], "value", a["/Open"]) is True else "no"
        inner = []
        contents = _str(a.get("/Contents"))
        if contents:
            inner.append(f"<contents>{escape(contents)}</contents>")
        if sub in ("/Polygon", "/PolyLine") and a.get("/Vertices"):
            inner.append(f"<vertices>{_nums(a['/Vertices'])}</vertices>")
        if sub == "/Ink" and a.get("/InkList"):
            gestures = []
            for path in a["/InkList"]:
                pts = [float(v) for v in path]
                gestures.append("<gesture>" + ";".join(f"{_num(pts[i])},{_num(pts[i + 1])}" for i in range(0, len(pts) - 1, 2)) + "</gesture>")
            inner.append("<inklist>" + "".join(gestures) + "</inklist>")
        attr_text = " ".join(f"{k}={quoteattr(v)}" for k, v in attrs.items())
        parts.append(f"<{tag} {attr_text}>{''.join(inner)}</{tag}>")
        counts["replies" if "inreplyto" in attrs else "comments"] += 1
    href = Path(str((args or {}).get("name") or Path(str(src)).name)).name
    if not href.lower().endswith(".pdf"):
        href += ".pdf"
    ids = ""
    tid = r.trailer.get("/ID")
    if tid and len(tid) == 2:
        # an ID read as text (as some writers' hex strings are) still has its bytes
        raw = [v.original_bytes if hasattr(v, "original_bytes") else bytes(v) for v in (tid[0], tid[1])]
        ids = f'<ids original="{raw[0].hex().upper()}" modified="{raw[1].hex().upper()}"/>'
    doc = (f'<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="{NS}" xml:space="preserve">\n<annots>\n' + "\n".join(parts)
           + f"\n</annots>\n<f href={quoteattr(href)}/>\n{ids}\n</xfdf>\n")
    Path(out).write_text(doc, encoding="utf-8")
    return {"comments": counts["comments"], "replies": counts["replies"]}


def _alike(pi: int, a) -> tuple:
    r = [float(v) for v in (a.get("/Rect") or [0, 0, 0, 0])]
    return (pi, str(a.get("/Subtype")), round((r[0] + r[2]) / 16), round((r[1] + r[3]) / 16), _str(a.get("/Contents")).strip()[:200])


def _alike_el(pi: int, el: ET.Element) -> tuple:
    r = _floats(el.get("rect"), 4)
    return (pi, SUBTYPE.get(el.tag, ""), round((r[0] + r[2]) / 16), round((r[1] + r[3]) / 16), (el.findtext("contents") or "").strip()[:200])


def _floats(s, n: int | None = None) -> list[float]:
    vals = [float(x) for x in re.split(r"[\s,;]+", str(s or "").strip()) if x]
    if n is not None and len(vals) < n:
        raise ValueError
    return vals


def _rgb(s):
    s = str(s or "").strip()
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", s):
        return None
    return [int(s[i:i + 2], 16) / 255 for i in (1, 3, 5)]


def _parse(data: str | bytes) -> list[ET.Element]:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    if len(raw) > MAX_BYTES:
        raise ValueError("The XFDF file is larger than 20 MB")
    if b"<!DOCTYPE" in raw[:4096] or b"<!ENTITY" in raw:
        raise ValueError("XFDF files with a document type or entities are not accepted")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        raise ValueError(f"This is not a readable XFDF file ({e})") from None
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    if root.tag != "xfdf":
        raise ValueError("This is not an XFDF file (no xfdf element)")
    annots = root.find("annots")
    items = [el for el in (list(annots) if annots is not None else []) if el.tag in SUBTYPE]
    if len(items) > MAX_ANNOTS:
        raise ValueError(f"An XFDF file can bring in at most {MAX_ANNOTS} comments at a time")
    return items


def _window(el: ET.Element, kind: str, page: int, geo, rect, width: float) -> dict | None:
    llx, lly, W, H = geo

    def P(x: float, y: float) -> list[float]:
        return [x - llx, lly + H - y]

    a: dict = {"kind": kind, "page": page, "color": el.get("color") or None, "width": width, "text": (el.findtext("contents") or "")}
    if el.get("opacity"):
        a["opacity"] = float(el.get("opacity"))
    if kind in ("rect", "ellipse", "freetext", "note", "stamp"):
        x0, y0, x1, y1 = rect
        pad = width / 2 if kind in ("rect", "ellipse") else 0
        a.update(x=x0 + pad - llx, y=lly + H - y1 + pad, w=max(1.0, x1 - x0 - 2 * pad), h=max(1.0, y1 - y0 - 2 * pad))
        if kind in ("rect", "ellipse") and _rgb(el.get("interior-color")):
            a["fill"] = el.get("interior-color")
        if kind == "freetext":
            m = re.search(r"([\d.]+)\s+Tf", el.get("defaultappearance") or "")
            a["size"] = float(m.group(1)) if m else 12
            col = re.search(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg", el.get("defaultappearance") or "")
            if col:
                a["color"] = "#" + "".join(f"{max(0, min(255, round(float(col.group(i)) * 255))):02X}" for i in (1, 2, 3))
        if kind == "stamp":
            icon = re.sub(r"^(SB|SH)", "", el.get("icon") or "Stamp")
            label = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", icon).strip() or "Stamp"
            a["stamp"] = {"label": label.upper(), "shape": "box", "name": el.get("icon") or "Stamp"}
            a["text"] = a["text"] or label
    elif kind in ("highlight", "underline", "strikeout"):
        q = _floats(el.get("coords"), 8)
        rects = []
        for i in range(0, len(q) - 7, 8):
            xs, ys = q[i:i + 8:2], q[i + 1:i + 8:2]
            tl = P(min(xs), max(ys))
            rects.append([tl[0], tl[1], max(xs) - min(xs), max(ys) - min(ys)])
        a["rects"] = rects
    elif kind in ("line", "arrow"):
        a["points"] = [P(*_floats(el.get("start"), 2)[:2]), P(*_floats(el.get("end"), 2)[:2])]
    elif kind == "ink":
        paths = []
        for g in el.iter("gesture"):
            pts = [_floats(p, 2)[:2] for p in (g.text or "").split(";") if p.strip()]
            if pts:
                paths.append([P(*p) for p in pts])
        if not paths:
            return None
        a["paths"] = paths
    else:
        return None
    return a


def _kind(el: ET.Element) -> str | None:
    tag = el.tag
    if tag == "line":
        return "arrow" if "Arrow" in (el.get("tail") or "") or "Arrow" in (el.get("head") or "") else "line"
    return {"text": "note", "freetext": "freetext", "square": "rect", "circle": "ellipse", "highlight": "highlight", "underline": "underline",
            "strikeout": "strikeout", "ink": "ink", "stamp": "stamp"}.get(tag)


def _base(el: ET.Element, rect: list[float]) -> DictionaryObject:
    d = DictionaryObject({NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject(SUBTYPE[el.tag]),
                          NameObject("/Rect"): annot._arr(rect)})
    for attr, key in (("name", "/NM"), ("title", "/T"), ("date", "/M"), ("creationdate", "/CreationDate"), ("subject", "/Subj")):
        if el.get(attr):
            d[NameObject(key)] = TextStringObject(el.get(attr)[:2000])
    text = el.findtext("contents")
    if text:
        d[NameObject("/Contents")] = TextStringObject(text[:20000])
    c = _rgb(el.get("color"))
    if c:
        d[NameObject("/C")] = annot._arr(c)
    ic = _rgb(el.get("interior-color"))
    if ic:
        d[NameObject("/IC")] = annot._arr(ic)
    if el.get("opacity"):
        d[NameObject("/CA")] = FloatObject(max(0.0, min(1.0, float(el.get("opacity")))))
    flags = {f.strip().lower() for f in (el.get("flags") or "").split(",") if f.strip()}
    if flags:
        d[NameObject("/F")] = NumberObject(sum(1 << i for i, name in enumerate(FLAGS) if name in flags))
    if el.get("icon") and re.fullmatch(r"[A-Za-z0-9]{1,60}", el.get("icon")):
        d[NameObject("/Name")] = NameObject("/" + el.get("icon"))
    if el.get("width"):
        d[NameObject("/BS")] = DictionaryObject({NameObject("/W"): FloatObject(float(el.get("width"))), NameObject("/S"): NameObject("/S")})
    if el.get("state") and re.fullmatch(r"[A-Za-z]{1,40}", el.get("state")):
        d[NameObject("/State")] = NameObject("/" + el.get("state"))
        d[NameObject("/StateModel")] = NameObject("/" + (el.get("statemodel") if re.fullmatch(r"[A-Za-z]{1,40}", el.get("statemodel") or "") else "Review"))
    if el.get("coords"):
        d[NameObject("/QuadPoints")] = annot._arr(_floats(el.get("coords"), 8))
    if el.tag == "line" and el.get("start") and el.get("end"):
        d[NameObject("/L")] = annot._arr(_floats(el.get("start"), 2)[:2] + _floats(el.get("end"), 2)[:2])
        le = [e if e in ENDINGS else "None" for e in (el.get("head") or "None", el.get("tail") or "None")]
        d[NameObject("/LE")] = ArrayObject([NameObject("/" + e) for e in le])
    if el.tag == "freetext" and el.get("defaultappearance"):
        d[NameObject("/DA")] = TextStringObject(el.get("defaultappearance")[:400])
    if el.get("open"):
        d[NameObject("/Open")] = BooleanObject(el.get("open") == "yes")
    vt = el.findtext("vertices")
    if el.tag in ("polygon", "polyline") and vt:
        d[NameObject("/Vertices")] = annot._arr(_floats(vt))
    if el.tag == "ink":
        paths = []
        for g in el.iter("gesture"):
            pts = [v for p in (g.text or "").split(";") if p.strip() for v in _floats(p, 2)[:2]]
            if pts:
                paths.append(annot._arr(pts))
        if paths:
            d[NameObject("/InkList")] = ArrayObject(paths)
    return d


def import_(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    if args.get("data"):
        data = str(args["data"])
        if not data.lstrip().startswith("<"):
            try:
                data = base64.b64decode(data).decode("utf-8")
            except Exception:
                raise ValueError("data is the XFDF text") from None
    elif args.get("xfdf"):
        p = Path(str(args["xfdf"])).expanduser()
        if not p.is_file():
            raise ValueError(f"{p} is not a file")
        data = p.read_bytes()
    else:
        raise ValueError("Give the XFDF file as xfdf (a path) or data (its text)")
    items = _parse(data)
    w = core.writer(src, passwords)
    geo = []
    for page in w.pages:
        x0, y0, x1, y1 = core.view_box(page)
        geo.append((x0, y0, x1 - x0, y1 - y0))
    known: dict[str, object] = {}
    where: dict[int, int] = {}
    alike: dict[tuple, object] = {}
    status: dict[int, tuple[str, str]] = {}
    for pi, page in enumerate(w.pages):
        arr = page.get("/Annots")
        for k, ref in enumerate(arr.get_object() if arr is not None else []):
            a = ref.get_object()
            if not isinstance(a, DictionaryObject) or not hasattr(ref, "idnum"):
                continue
            known[_name_of(a, pi, k)] = ref
            where[ref.idnum] = pi
            alike.setdefault(_alike(pi, a), ref)
            irt = a.raw_get("/IRT") if "/IRT" in a else None
            if irt is not None and "/State" in a and str(a.get("/StateModel") or "/Review") == "/Review":
                when = _str(a.get("/M") or a.get("/CreationDate"))
                pid = getattr(irt, "idnum", -1)
                if pid not in status or when >= status[pid][1]:
                    status[pid] = (str(a["/State"])[1:].lower(), when)
    idx = set(core.parse_pages(pages, len(w.pages))) if pages else None
    tops = [el for el in items if not el.get("inreplyto")]
    replies = [el for el in items if el.get("inreplyto")]
    counts = {"comments": 0, "replies": 0, "skipped": 0, "drawn": 0, "duplicates": 0, "outside": 0, "statuses": 0}
    blank = None
    touched: set[int] = set()
    drawn: list[tuple[int, dict, DictionaryObject]] = []
    pending = tops + replies
    for _round in range(8):
        later = []
        for el in pending:
            nm = el.get("name") or ""
            try:
                epi = int(el.get("page", "0"))
            except ValueError:
                epi = -1
            if idx is not None and epi + 1 not in idx:
                counts["outside"] += 1
                continue
            same = known.get(nm) if nm else None
            if same is None and not el.get("inreplyto") and 0 <= epi < len(w.pages):
                try:
                    same = alike.get(_alike_el(epi, el))
                except ValueError:
                    same = None
                if same is not None:
                    counts["duplicates"] += 1
                    if nm:
                        known[nm] = same
            if same is not None:
                a = same.get_object()
                state = (el.get("state") or "").strip()
                before = counts["statuses"]
                if state.lower() in annot.STATES and str(el.get("statemodel") or "Review") == "Review":
                    spi = where.get(same.idnum, max(0, epi))
                    if el.get("inreplyto"):
                        if str(a.get("/State") or "")[1:].lower() != state.lower():
                            a[NameObject("/State")] = NameObject(annot.STATES[state.lower()])
                            if el.get("date"):
                                a[NameObject("/M")] = TextStringObject(el.get("date")[:60])
                            counts["statuses"] += 1
                            touched.add(spi)
                    elif status.get(same.idnum, ("none", ""))[0] != state.lower():
                        blank = blank or annot._blank_ap(w)
                        annot._thread(w, spi, same, [], state.lower(), (el.get("title") or "Reviewer")[:200], blank)
                        status[same.idnum] = (state.lower(), "")
                        counts["statuses"] += 1
                        touched.add(spi)
                if counts["statuses"] == before:
                    counts["skipped"] += 1
                continue
            try:
                pi = int(el.get("page", "0"))
                rect = _floats(el.get("rect"), 4)[:4]
            except ValueError:
                counts["skipped"] += 1
                continue
            if not 0 <= pi < len(w.pages):
                counts["skipped"] += 1
                continue
            rect = [min(rect[0], rect[2]), min(rect[1], rect[3]), max(rect[0], rect[2]), max(rect[1], rect[3])]
            parent = None
            if el.get("inreplyto"):
                parent = known.get(el.get("inreplyto"))
                if parent is None:
                    later.append(el)
                    continue
            try:
                d = _base(el, rect)
            except ValueError:
                counts["skipped"] += 1
                continue
            if parent is not None:
                d[NameObject("/IRT")] = parent
                if el.get("replyType") == "group":
                    d[NameObject("/RT")] = NameObject("/Group")
                if "/F" not in d:
                    d[NameObject("/F")] = NumberObject(30 if "/State" in d else 28)
                blank = blank or annot._blank_ap(w)
                d[NameObject("/AP")] = DictionaryObject({NameObject("/N"): blank})
                added = w.add_annotation(pi, d)
                counts["replies"] += 1
            else:
                kind = _kind(el)
                width = float(el.get("width") or 1)
                spec = None
                if kind:
                    try:
                        win = _window(el, kind, pi + 1, geo[pi], rect, width)
                        spec = annot.normalize(win, [(g[2], g[3]) for g in geo]) if win else None
                    except (ValueError, TypeError, KeyError, IndexError):
                        spec = None
                if "/F" not in d:
                    d[NameObject("/F")] = NumberObject(4)
                added = w.add_annotation(pi, d)
                if spec is not None:
                    drawn.append((pi, spec, added))
                counts["comments"] += 1
            if nm:
                known[nm] = added.indirect_reference
            touched.add(pi)
        if not later or len(later) == len(pending):
            counts["skipped"] += len(later)
            break
        pending = later
    if drawn:
        buf = io.BytesIO()
        c = rlcanvas.Canvas(buf)
        for pi, spec, _ in drawn:
            _, _, W, H = geo[pi]
            c.setPageSize((W, H))
            annot.draw(c, spec, H, False)
            c.showPage()
        c.save()
        ov = PdfReader(io.BytesIO(buf.getvalue()))
        for k, (pi, spec, d) in enumerate(drawn):
            llx, lly, W, H = geo[pi]
            x0, y0, x1, y1 = annot.bbox(spec)
            bb = [x0, H - y1, x1, H - y0]
            d[NameObject("/AP")] = DictionaryObject({NameObject("/N"): annot._form(w, ov.pages[k], bb)})
            d[NameObject("/Rect")] = annot._arr([llx + bb[0], lly + bb[1], llx + bb[2], lly + bb[3]])
            counts["drawn"] += 1
    if not counts["comments"] and not counts["replies"] and not counts["statuses"]:
        raise ValueError(f"Nothing to bring in: {counts['skipped']} comment{'s' if counts['skipped'] != 1 else ''} already in this PDF or not readable"
                         if counts["skipped"] else "The XFDF file has no comments")
    core.keep_pages(w, touched)
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "comments": counts["comments"], "replies": counts["replies"], "skipped": counts["skipped"],
            "duplicates": counts["duplicates"], "statuses": counts["statuses"], "outside": counts["outside"]}


actions.register(actions.Action("export_xfdf", "export", "Export comments (XFDF)", ext=".xfdf", words=("xfdf", "export comments", "share review", "fdf"),
                                run=export))
actions.register(actions.Action("import_xfdf", "change", "Import comments (XFDF)", "comments", ("xfdf", "import comments", "merge review", "fdf"),
                                fields=(actions.Field("xfdf", "XFDF file", hint="Path of an .xfdf file exported from formpdf, Acrobat or another reader"),),
                                run=import_))
