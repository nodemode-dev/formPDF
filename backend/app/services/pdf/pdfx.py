import re
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, TextStringObject

from . import actions, colour, core, pdfa, preflight

LEVELS = {
    "X-1a": {"max": "1.4", "rgb": False, "transparency": False, "names": ("PDF/X-1a",)},
    "X-3": {"max": "1.4", "rgb": True, "transparency": False, "names": ("PDF/X-3",)},
    "X-4": {"max": "1.6", "rgb": True, "transparency": True, "names": ("PDF/X-4",)},
    "X-6": {"max": "2.0", "rgb": True, "transparency": True, "names": ("PDF/X-6",)},
    "VT": {"max": "1.6", "rgb": True, "transparency": True, "names": ("PDF/X-4", "PDF/X-5")},
}


def _o(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _claim(r) -> str:
    _p, _c, x = pdfa._xmp_part(r.trailer["/Root"])
    info = r.trailer.get("/Info")
    info = _o(info) if info is not None else {}
    return (x or str(info.get("/GTS_PDFXVersion") or "")).strip()


def _detect(claim: str, root) -> str:
    if "/DPartRoot" in root:
        return "VT"
    for level in ("X-1a", "X-3", "X-4", "X-6"):
        if f"PDF/{level}" in claim:
            return level
    return "X-4"


def _version(raw: bytes) -> str:
    m = re.match(rb"%PDF-(\d\.\d)", raw[:16])
    return m.group(1).decode() if m else ""


def _inside(inner, outer, tol: float = 0.01) -> bool:
    return inner[0] >= outer[0] - tol and inner[1] >= outer[1] - tol and inner[2] <= outer[2] + tol and inner[3] <= outer[3] + tol


def _box(page, kind: str):
    r = getattr(page, f"{kind}box")
    return float(r.left), float(r.bottom), float(r.right), float(r.top)


def verify(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    raw = Path(path).read_bytes()
    r = core.reader(path, passwords)
    root = r.trailer["/Root"]
    claim = _claim(r)
    level = str((args or {}).get("level") or "").upper().removeprefix("PDF/") or _detect(claim, root)
    level = {"X-1A": "X-1a"}.get(level, level)
    if level not in LEVELS:
        raise ValueError(f"level is one of {', '.join(LEVELS)}")
    rule = LEVELS[level]
    issues: list[dict] = []

    def fail(code: str, text: str, pages_=None) -> None:
        issues.append({"id": code, "text": text, "pages": sorted(pages_ or [])[:200]})

    if not any(n in claim for n in rule["names"]):
        fail("claim", f"The file does not say it is {' or '.join(rule['names'])} (GTS_PDFXVersion is {claim or 'missing'})")
    ver = _version(raw)
    if not ver:
        fail("header", "The file header has no PDF version")
    elif level == "X-6" and ver != "2.0":
        fail("header", f"PDF/X-6 is PDF 2.0; this file is PDF {ver}")
    elif level != "X-6" and ver > rule["max"]:
        fail("header", f"{level} allows PDF up to {rule['max']}; this file is PDF {ver}")
    if r.is_encrypted:
        fail("encrypt", "The file is encrypted")
    intents = [_o(x) for x in (_o(root.get("/OutputIntents")) or [])]
    gts = [i for i in intents if str(i.get("/S")) == "/GTS_PDFX"]
    if not gts:
        fail("intent", "There is no PDF/X output intent (the printing condition)")
    else:
        oi = gts[0]
        if not str(oi.get("/OutputConditionIdentifier") or "").strip():
            fail("intent", "The output intent has no printing condition identifier")
        if oi.get("/DestOutputProfile") is None and level in ("X-1a", "X-3"):
            fail("intent", "The output intent does not embed the printer profile")
    if b"/ID" not in raw[-65536:] and "/ID" not in r.trailer:
        fail("id", "The file has no identifier (ID)")
    info = _o(r.trailer.get("/Info")) if r.trailer.get("/Info") is not None else DictionaryObject()
    trapped = str(info.get("/Trapped") or "")
    xmp_trapped = False
    meta = _o(root.get("/Metadata"))
    if meta is not None:
        try:
            xmp_trapped = bool(re.search(r"pdf:Trapped(?:>|=\")\s*(True|False)", meta.get_data().decode("utf-8", "replace")))
        except Exception:
            xmp_trapped = False
    if trapped not in ("/True", "/False") and not xmp_trapped and level != "X-6":
        fail("trapped", "Trapped is not set to True or False")
    names = _o(root.get("/Names"))
    if isinstance(names, DictionaryObject) and names.get("/JavaScript") is not None:
        fail("js", "The document has JavaScript")
    no_trim, bad_nest = set(), set()
    for n, page in enumerate(r.pages, 1):
        if "/TrimBox" not in page and "/ArtBox" not in page:
            no_trim.add(n)
        media, trim, bleed = _box(page, "media"), _box(page, "trim"), _box(page, "bleed")
        if not (_inside(trim, bleed) and _inside(bleed, media)):
            bad_nest.add(n)
    if no_trim:
        fail("trim", "Pages without a trim box (or art box)", no_trim)
    if bad_nest:
        fail("boxes", "The trim box must lie inside the bleed box and the bleed box inside the media box", bad_nest)
    loose = {pi + 1 for pi, _ref, f in pdfa.fonts(r) if not pdfa.embedded(f) and pi is not None}
    if loose:
        fail("fonts", "Fonts are not embedded", loose)
    sc = colour.scan(r)
    if not rule["rgb"] and "rgb" in sc.used:
        fail("rgb", f"{level} allows only CMYK, gray and spot colour; RGB is used", set(sc.where.get("rgb", set())))
    if not rule["transparency"]:
        tr = preflight._transparency(r)
        if tr:
            fail("transparency", f"{level} does not allow transparency", tr)
    if level == "VT" and "/DPartRoot" not in root:
        fail("dpart", "PDF/VT needs a document part hierarchy (DPartRoot) that marks each record")
    elif level == "VT":
        dpr = _o(root["/DPartRoot"])
        if _o(dpr.get("/DPartRootNode")) is None:
            fail("dpart", "The document part hierarchy has no root node")
        unmarked = {n for n, page in enumerate(r.pages, 1) if page.get("/DPart") is None}
        if unmarked:
            fail("dpart", "Pages that belong to no record (no DPart)", unmarked)
        xmp = ""
        if meta is not None:
            try:
                xmp = meta.get_data().decode("utf-8", "replace")
            except Exception:
                xmp = ""
        if not re.search(r"GTS_PDFVTVersion(?:>|=\")\s*PDF/VT", xmp):
            fail("claim", "The XMP metadata does not say the file is PDF/VT (pdfvtid:GTS_PDFVTVersion)")
    ok = not issues
    head = f"{'Conforms to' if ok else 'Does not conform to'} {level} by formpdf's checks ({len(issues)} finding{'s' if len(issues) != 1 else ''}); it is not an outside validator."
    lines = [f"- {i['text']}{' (pages ' + ', '.join(map(str, i['pages'][:12])) + ')' if i['pages'] else ''}" for i in issues]
    return head + ("\n" + "\n".join(lines) if lines else ""), {"level": level, "claim": claim, "version": ver, "conforms": ok, "issues": issues}


def pdf20(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    r = core.reader(src, passwords)
    if core.signed(r):
        raise ValueError("Writing PDF 2.0 rewrites the file, which would break its signatures.")
    w = PdfWriter(clone_from=r)
    _p, _c, claim = pdfa._xmp_part(w._root_object)
    meta = pdfa._meta(w, r.metadata)
    pdfa._set_meta(w, meta, None, None, claim or None)
    w._info = DictionaryObject({k: v for k, v in w._info.items() if k in ("/CreationDate", "/ModDate")})
    dropped = 0
    for page in w.pages:
        res = _o(page.get("/Resources"))
        if isinstance(res, DictionaryObject) and "/ProcSet" in res:
            del res["/ProcSet"]
            dropped += 1
    w.pdf_header = b"%PDF-2.0"
    if not getattr(w, "_ID", None):
        w.generate_file_identifiers()
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "version": "2.0", "procsets": dropped}


actions.register(actions.Action("pdfx_check", "read", "Check PDF/X-1a, X-3, X-4, X-6 or PDF/VT", words=("pdf/x", "verify pdf/x", "pdf/x-6", "pdf/vt", "press check", "conformance"),
                                fields=(actions.Field("level", "Level", "select", "", ("", "X-1a", "X-3", "X-4", "X-6", "VT")),), run=verify))
actions.register(actions.Action("pdf20", "change", "Save as PDF 2.0", "pdf20", ("pdf 2.0", "iso 32000-2", "pdf2", "newest pdf"), run=pdf20))
