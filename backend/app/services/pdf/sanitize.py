import re

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, ContentStream, DecodedStreamObject, DictionaryObject, NameObject

from . import core

KEYS = ("metadata", "javascript", "attachments", "comments", "fields", "layers", "links", "bookmarks", "thumbnails", "private", "hidden_text")
LABELS = {"metadata": "Metadata", "javascript": "JavaScript and actions", "attachments": "Attached files", "comments": "Comments and markups",
          "fields": "Form fields", "layers": "Hidden layers", "links": "Links", "bookmarks": "Bookmarks", "thumbnails": "Page thumbnails",
          "private": "Private application data", "hidden_text": "Hidden text"}
RISKY = ("/JavaScript", "/Launch", "/SubmitForm", "/ImportData", "/ResetForm", "/Rendition", "/Movie", "/Sound", "/GoToE", "/Hide", "/SetOCGState")
TR3 = re.compile(rb"(?<![\w.\-])3\s+Tr\b")


def _obj(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _names(tree) -> int:
    tree = _obj(tree)
    if not isinstance(tree, DictionaryObject):
        return 0
    n = len(_obj(tree.get("/Names")) or []) // 2
    for kid in _obj(tree.get("/Kids")) or []:
        n += _names(kid)
    return n


def _risky(action) -> bool:
    a = _obj(action)
    if not isinstance(a, DictionaryObject):
        return False
    if str(a.get("/S")) in RISKY:
        return True
    nxt = _obj(a.get("/Next"))
    if isinstance(nxt, DictionaryObject):
        return _risky(nxt)
    if isinstance(nxt, ArrayObject):
        return any(_risky(x) for x in nxt)
    return False


def _annots(page) -> list:
    return [_obj(r) for r in (_obj(page.get("/Annots")) or [])]


def _outline_count(root) -> int:
    out = _obj(root.get("/Outlines"))
    if not isinstance(out, DictionaryObject):
        return 0
    n, seen, stack = 0, set(), [out.get("/First")]
    while stack:
        ref = stack.pop()
        while ref is not None:
            idn = getattr(ref, "idnum", id(ref))
            if idn in seen:
                break
            seen.add(idn)
            item = _obj(ref)
            n += 1
            if item.get("/First") is not None:
                stack.append(item.get("/First"))
            ref = item.get("/Next")
    return n


def _off_layers(root) -> tuple[int, set[int]]:
    ocp = _obj(root.get("/OCProperties"))
    if not isinstance(ocp, DictionaryObject):
        return 0, set()
    ocgs = [r for r in (_obj(ocp.get("/OCGs")) or [])]
    d = _obj(ocp.get("/D")) or DictionaryObject()
    ids = {getattr(r, "idnum", None) for r in ocgs}
    if str(d.get("/BaseState") or "/ON") == "/OFF":
        on = {getattr(r, "idnum", None) for r in (_obj(d.get("/ON")) or [])}
        off = ids - on
    else:
        off = {getattr(r, "idnum", None) for r in (_obj(d.get("/OFF")) or [])}
    return len(ocgs), {i for i in off if i is not None}


def _page_bytes(page) -> bytes:
    try:
        c = page.get_contents()
        return c.get_data() if c is not None else b""
    except Exception:
        return b""


def scan(path, passwords: list[str] | None = None) -> list[dict]:
    r = core.reader(path, passwords)
    root = r.trailer["/Root"]
    info = r.trailer.get("/Info")
    counts = dict.fromkeys(KEYS, 0)
    notes: dict[str, str] = {}
    counts["metadata"] = len(_obj(info) or {}) + (1 if "/Metadata" in root else 0)
    names = _obj(root.get("/Names")) or DictionaryObject()
    counts["javascript"] += _names(names.get("/JavaScript"))
    if _risky(root.get("/OpenAction")):
        counts["javascript"] += 1
    counts["javascript"] += len(_obj(root.get("/AA")) or {})
    counts["attachments"] = _names(names.get("/EmbeddedFiles")) + len(_obj(root.get("/AF")) or [])
    form = _obj(root.get("/AcroForm"))
    try:
        counts["fields"] = len(r.get_fields() or {}) if form is not None else 0
    except Exception:
        counts["fields"] = 0
    total, off = _off_layers(root)
    counts["layers"] = len(off) if total else 0
    if total:
        notes["layers"] = f"{total} layer{'s' if total != 1 else ''}, {len(off)} hidden"
    counts["bookmarks"] = _outline_count(root)
    counts["private"] = 1 if "/PieceInfo" in root else 0
    hidden_pages = 0
    for page in r.pages:
        counts["metadata"] += 1 if "/Metadata" in page else 0
        counts["javascript"] += len(_obj(page.get("/AA")) or {})
        counts["thumbnails"] += 1 if "/Thumb" in page else 0
        counts["private"] += 1 if "/PieceInfo" in page else 0
        for a in _annots(page):
            sub = str(a.get("/Subtype"))
            if "/AA" in a:
                counts["javascript"] += len(_obj(a["/AA"]) or {})
            if _risky(a.get("/A")):
                counts["javascript"] += 1
            if sub == "/Link":
                counts["links"] += 1
            elif sub == "/FileAttachment":
                counts["attachments"] += 1
            elif sub not in ("/Widget", "/Popup"):
                counts["comments"] += 1
        if TR3.search(_page_bytes(page)):
            hidden_pages += 1
    counts["hidden_text"] = hidden_pages
    if hidden_pages:
        notes["hidden_text"] = f"invisible text on {hidden_pages} page{'s' if hidden_pages != 1 else ''}; scanned pages use it for search"
    if form is not None and "/XFA" in form:
        notes["fields"] = "includes an XFA form"
    return [{"key": k, "label": LABELS[k], "count": counts[k], "note": notes.get(k, "")} for k in KEYS]


def _ap_stream(annot):
    ap = _obj(annot.get("/AP"))
    if not isinstance(ap, DictionaryObject):
        return None, None
    ref = ap.raw_get("/N") if "/N" in ap else None
    n = _obj(ref)
    if isinstance(n, DictionaryObject) and "/BBox" not in n:
        state = annot.get("/AS")
        if state is None or state not in n:
            return None, None
        ref = n.raw_get(state)
        n = _obj(ref)
    if n is None or "/BBox" not in n:
        return None, None
    return ref, n


def _matrix_bbox(stream) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = (float(v) for v in stream["/BBox"])
    a, b, c, d, e, f = (float(v) for v in (stream.get("/Matrix") or [1, 0, 0, 1, 0, 0]))
    pts = [(a * x + c * y + e, b * x + d * y + f) for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
    return min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)


def _append(w: PdfWriter, page, extra: bytes) -> None:
    body = b"q\n" + _page_bytes(page) + b"\nQ\n" + extra
    s = DecodedStreamObject()
    s.set_data(body)
    page.replace_contents(s.flate_encode())


def _xobjects(page) -> DictionaryObject:
    res = page.get("/Resources")
    if res is None:
        res = DictionaryObject()
        page[NameObject("/Resources")] = res
    res = _obj(res)
    xo = res.get("/XObject")
    if xo is None:
        xo = DictionaryObject()
        res[NameObject("/XObject")] = xo
    return _obj(xo)


def flatten_widgets(w: PdfWriter) -> int:
    done = 0
    for page in w.pages:
        arr = _obj(page.get("/Annots"))
        if not arr:
            continue
        keep, ops, n = ArrayObject(), [], 0
        xo = None
        for ref in arr:
            a = _obj(ref)
            if str(a.get("/Subtype")) != "/Widget":
                keep.append(ref)
                continue
            flags = int(a.get("/F", 0) or 0)
            ap_ref, stream = _ap_stream(a)
            if stream is None or flags & (2 | 32):
                continue
            try:
                rx0, ry0, rx1, ry1 = (float(v) for v in a["/Rect"])
                rx0, rx1 = sorted((rx0, rx1))
                ry0, ry1 = sorted((ry0, ry1))
                bx0, by0, bx1, by1 = _matrix_bbox(stream)
            except Exception:
                continue
            if bx1 - bx0 < 1e-6 or by1 - by0 < 1e-6:
                continue
            sx, sy = (rx1 - rx0) / (bx1 - bx0), (ry1 - ry0) / (by1 - by0)
            if xo is None:
                xo = _xobjects(page)
            n += 1
            name = f"/FsFlat{n}"
            while name in xo:
                n += 1
                name = f"/FsFlat{n}"
            xo[NameObject(name)] = ap_ref if hasattr(ap_ref, "idnum") else w._add_object(stream)
            ops.append(f"q {sx:.6f} 0 0 {sy:.6f} {rx0 - sx * bx0:.4f} {ry0 - sy * by0:.4f} cm {name} Do Q".encode())
            done += 1
        if ops:
            _append(w, page, b"\n".join(ops) + b"\n")
        if len(keep):
            page[NameObject("/Annots")] = keep
        elif "/Annots" in page:
            del page["/Annots"]
    if "/AcroForm" in w._root_object:
        del w._root_object["/AcroForm"]
    return done


def _filter_ops(w: PdfWriter, page, drop_layers: set[int], drop_hidden_text: bool) -> bool:
    try:
        contents = page.get_contents()
        if contents is None:
            return False
        cs = ContentStream(contents, w)
    except Exception:
        return False
    res = _obj(page.get("/Resources")) or DictionaryObject()
    props = _obj(res.get("/Properties")) or DictionaryObject()
    xobjs = _obj(res.get("/XObject")) or DictionaryObject()

    def hidden_oc(ref) -> bool:
        o = _obj(ref)
        if not isinstance(o, DictionaryObject):
            return False
        if str(o.get("/Type")) == "/OCMD":
            groups = _obj(o.get("/OCGs"))
            groups = groups if isinstance(groups, ArrayObject) else [o.get("/OCGs")] if o.get("/OCGs") is not None else []
            ids = [getattr(g, "idnum", None) for g in groups]
            return bool(ids) and all(i in drop_layers for i in ids)
        return getattr(ref, "idnum", None) in drop_layers

    out = []
    skip = 0
    depth_stack: list[bool] = []
    tr, tr_stack = 0, []
    changed = False
    for operands, op in cs.operations:
        if op in (b"BDC", b"BMC"):
            hide = False
            if drop_layers and op == b"BDC" and len(operands) >= 2 and str(operands[0]) == "/OC":
                prop = operands[1]
                ref = props.raw_get(prop) if isinstance(prop, NameObject) and prop in props else prop
                hide = hidden_oc(ref)
            depth_stack.append(hide)
            if hide or skip:
                skip += 1
                changed = True
                continue
            out.append((operands, op))
            continue
        if op == b"EMC":
            if depth_stack:
                depth_stack.pop()
            if skip:
                skip -= 1
                continue
            out.append((operands, op))
            continue
        if skip:
            continue
        if op == b"q":
            tr_stack.append(tr)
        elif op == b"Q":
            tr = tr_stack.pop() if tr_stack else 0
        elif op == b"Tr" and operands:
            try:
                tr = int(operands[0])
            except (TypeError, ValueError):
                tr = 0
            if drop_hidden_text and tr == 3:
                changed = True
                continue
        elif drop_layers and op == b"Do" and operands and operands[0] in xobjs:
            x = _obj(xobjs[operands[0]])
            if isinstance(x, DictionaryObject) and x.get("/OC") is not None and hidden_oc(x.raw_get("/OC")):
                changed = True
                continue
        if drop_hidden_text and tr == 3 and op in (b"Tj", b"TJ", b"'", b'"'):
            changed = True
            if op == b"'":
                out.append(([], b"T*"))
            elif op == b'"' and len(operands) >= 3:
                out += [([operands[0]], b"Tw"), ([operands[1]], b"Tc"), ([], b"T*")]
            continue
        out.append((operands, op))
    if changed:
        cs.operations = out
        page.replace_contents(cs)
    return changed


def _strip_actions(node) -> None:
    node = _obj(node)
    if not isinstance(node, DictionaryObject):
        return
    if "/AA" in node:
        del node["/AA"]
    if _risky(node.get("/A")):
        del node["/A"]


def _walk_fields(fields, fn) -> None:
    stack = list(_obj(fields) or [])
    seen: set[int] = set()
    while stack:
        ref = stack.pop()
        idn = getattr(ref, "idnum", None)
        if idn is not None:
            if idn in seen:
                continue
            seen.add(idn)
        f = _obj(ref)
        if not isinstance(f, DictionaryObject):
            continue
        fn(f)
        stack.extend(_obj(f.get("/Kids")) or [])


def sanitize(src, out, *, remove: list[str], passwords: list[str] | None = None) -> dict:
    want = [k for k in KEYS if k in set(remove or [])]
    if not want:
        raise ValueError("Tick at least one kind of hidden information to remove")
    w = PdfWriter(clone_from=core.reader(src, passwords))
    root = w._root_object
    _, off = _off_layers(root)
    if "layers" in want or "hidden_text" in want:
        for page in w.pages:
            _filter_ops(w, page, off if "layers" in want else set(), "hidden_text" in want)
        if "layers" in want:
            if "/OCProperties" in root:
                del root["/OCProperties"]
            for page in w.pages:
                arr = _obj(page.get("/Annots"))
                if arr:
                    page[NameObject("/Annots")] = ArrayObject([r for r in arr if getattr(_obj(r).get("/OC"), "idnum", None) not in off])
    flattened = flatten_widgets(w) if "fields" in want else 0
    names = _obj(root.get("/Names"))
    if "javascript" in want:
        if isinstance(names, DictionaryObject) and "/JavaScript" in names:
            del names["/JavaScript"]
        if _risky(root.get("/OpenAction")):
            del root["/OpenAction"]
        if "/AA" in root:
            del root["/AA"]
        form = _obj(root.get("/AcroForm"))
        if isinstance(form, DictionaryObject):
            _walk_fields(form.get("/Fields"), _strip_actions)
        out_root = _obj(root.get("/Outlines"))
        if isinstance(out_root, DictionaryObject):
            stack = [out_root.get("/First")]
            seen: set[int] = set()
            while stack:
                ref = stack.pop()
                while ref is not None and getattr(ref, "idnum", id(ref)) not in seen:
                    seen.add(getattr(ref, "idnum", id(ref)))
                    item = _obj(ref)
                    _strip_actions(item)
                    if item.get("/First") is not None:
                        stack.append(item.get("/First"))
                    ref = item.get("/Next")
    if "attachments" in want:
        if isinstance(names, DictionaryObject) and "/EmbeddedFiles" in names:
            del names["/EmbeddedFiles"]
        if "/AF" in root:
            del root["/AF"]
    if "bookmarks" in want:
        if "/Outlines" in root:
            del root["/Outlines"]
        if str(root.get("/PageMode")) == "/UseOutlines":
            root[NameObject("/PageMode")] = NameObject("/UseNone")
    if "private" in want and "/PieceInfo" in root:
        del root["/PieceInfo"]
    if "metadata" in want:
        if "/Metadata" in root:
            del root["/Metadata"]
        w.metadata = None
    for page in w.pages:
        if "javascript" in want:
            _strip_actions(page)
        if "thumbnails" in want and "/Thumb" in page:
            del page["/Thumb"]
        if "metadata" in want and "/Metadata" in page:
            del page["/Metadata"]
        if "attachments" in want and "/AF" in page:
            del page["/AF"]
        if "private" in want:
            if "/PieceInfo" in page:
                del page["/PieceInfo"]
            for x in (_obj(_obj(page.get("/Resources") or DictionaryObject()).get("/XObject")) or DictionaryObject()).values():
                x = _obj(x)
                if isinstance(x, DictionaryObject) and "/PieceInfo" in x:
                    del x["/PieceInfo"]
        arr = _obj(page.get("/Annots"))
        if not arr:
            continue
        keep = ArrayObject()
        for ref in arr:
            a = _obj(ref)
            sub = str(a.get("/Subtype"))
            if ("comments" in want and sub not in ("/Link", "/Widget", "/FileAttachment")) or ("links" in want and sub == "/Link") \
                    or ("attachments" in want and sub == "/FileAttachment"):
                continue
            if "javascript" in want:
                _strip_actions(a)
            keep.append(ref)
        if len(keep):
            page[NameObject("/Annots")] = keep
        else:
            del page["/Annots"]
    if names is not None and isinstance(names, DictionaryObject) and not len(names):
        del root["/Names"]
    core.drop_unreachable(w)
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "removed": want, "flattened": flattened}
