"""PDF/VT-1 from a PDF/X-4 file: a document part hierarchy that marks each record, the PDF/VT claim in the XMP metadata."""
import datetime
import re

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, StreamObject, TextStringObject

from . import actions, core, pdfx

MAX_RECORDS = 100000
VT_NS = "http://www.npes.org/pdfvt/ns/id/"


def _o(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _starts_from_outline(w: PdfWriter) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for item in w.outline:
        if isinstance(item, list):
            continue
        try:
            n = w.get_destination_page_number(item)
        except Exception:
            continue
        if n is not None and n >= 0:
            out.append((n + 1, str(item.get("/Title") or "")))
    return sorted({n: t for n, t in out}.items())


def _records(w: PdfWriter, args: dict) -> list[tuple[int, int, str]]:
    total = len(w.pages)
    if args.get("by") == "bookmarks":
        starts = _starts_from_outline(w)
        if not starts:
            raise ValueError("The PDF has no top-level bookmarks to start records at")
        if starts[0][0] != 1:
            starts = [(1, "")] + starts
    elif args.get("starts"):
        nums = sorted({int(s) for s in args["starts"] if 1 <= int(s) <= total} | {1})
        starts = [(n, "") for n in nums]
    else:
        per = int(args.get("pages_per_record") or 0)
        if not 1 <= per <= total:
            raise ValueError(f"pages_per_record is between 1 and {total}")
        if total % per:
            raise ValueError(f"{total} pages do not divide into records of {per} pages")
        starts = [(n, "") for n in range(1, total + 1, per)]
    if len(starts) > MAX_RECORDS:
        raise ValueError(f"A PDF/VT file here can have at most {MAX_RECORDS} records")
    names = [str(x)[:200] for x in args.get("names") or []]
    out = []
    for i, (s, title) in enumerate(starts):
        end = starts[i + 1][0] - 1 if i + 1 < len(starts) else total
        out.append((s, end, names[i] if i < len(names) else title or f"Record {i + 1}"))
    return out


def _claim_vt(w: PdfWriter) -> None:
    meta = _o(w._root_object.get("/Metadata"))
    if not isinstance(meta, StreamObject):
        raise ValueError("The PDF/X file has no XMP metadata to add the PDF/VT claim to")
    text = meta.get_data().decode("utf-8", "replace")
    now = datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds")
    text = re.sub(r"<pdfvtid:[^>]*>[^<]*</pdfvtid:[^>]*>", "", text)
    rows = f"<pdfvtid:GTS_PDFVTVersion>PDF/VT-1</pdfvtid:GTS_PDFVTVersion><pdfvtid:GTS_PDFVTModDate>{now}</pdfvtid:GTS_PDFVTModDate>"
    if "</rdf:Description>" not in text:
        raise ValueError("The XMP metadata has no description to add the PDF/VT claim to")
    if VT_NS not in text:
        text = text.replace("<rdf:Description ", f'<rdf:Description xmlns:pdfvtid="{VT_NS}" ', 1)
    text = text.replace("</rdf:Description>", rows + "</rdf:Description>", 1)
    xmp = DecodedStreamObject()
    xmp[NameObject("/Type")] = NameObject("/Metadata")
    xmp[NameObject("/Subtype")] = NameObject("/XML")
    xmp.set_data(text.encode("utf-8"))
    w._root_object[NameObject("/Metadata")] = w._add_object(xmp)


def make(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    """Marks records with a DPartRoot: a root part (the document) whose kids are one leaf part per record, each naming its first and last page."""
    args = args or {}
    r = core.reader(src, passwords)
    claim = pdfx._claim(r)
    if "PDF/X-4" not in claim and "PDF/X-5" not in claim:
        raise ValueError("PDF/VT builds on PDF/X-4: convert to PDF/X-4 first (Print > Convert to PDF/X)")
    if core.signed(r):
        raise ValueError("Making PDF/VT rewrites the file, which would break its signatures.")
    w = PdfWriter(clone_from=r)
    recs = _records(w, args)
    root_node = DictionaryObject({NameObject("/Type"): NameObject("/DPart")})
    root_ref = w._add_object(root_node)
    kids = ArrayObject()
    for i, (s, e, name) in enumerate(recs):
        leaf = DictionaryObject({
            NameObject("/Type"): NameObject("/DPart"), NameObject("/Parent"): root_ref,
            NameObject("/Start"): w.pages[s - 1].indirect_reference, NameObject("/End"): w.pages[e - 1].indirect_reference,
            NameObject("/DPM"): DictionaryObject({NameObject("/Record"): DictionaryObject({
                NameObject("/Name"): TextStringObject(name), NameObject("/Number"): NumberObject(i + 1)})}),
        })
        ref = w._add_object(leaf)
        kids.append(ref)
        for n in range(s, e + 1):
            w.pages[n - 1][NameObject("/DPart")] = ref
    root_node[NameObject("/Kids")] = kids
    w._root_object[NameObject("/DPartRoot")] = w._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/DPartRoot"), NameObject("/DPartRootNode"): root_ref,
        NameObject("/RecordLevel"): NumberObject(1),
        NameObject("/NodeNameList"): ArrayObject([NameObject("/Document"), NameObject("/Record")]),
    }))
    _claim_vt(w)
    w.pdf_header = b"%PDF-1.6"
    if not getattr(w, "_ID", None):
        w.generate_file_identifiers()
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "records": len(recs), "first": [{"name": n, "start": s, "end": e} for s, e, n in recs[:20]]}


actions.register(actions.Action("pdfvt", "change", "Make PDF/VT records", "pdfvt", ("pdf/vt", "variable data", "records", "mail merge", "personalised print"),
                                fields=(actions.Field("pages_per_record", "Pages per record", "number", "1"),), run=make))
