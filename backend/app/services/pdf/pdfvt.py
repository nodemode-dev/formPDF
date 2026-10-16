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


def _outline_kids(w: PdfWriter) -> dict[int, list[tuple[int, str]]]:
    """Each top-level bookmark's start page, with the start pages and titles of the bookmarks directly under it."""
    out: dict[int, list[tuple[int, str]]] = {}
    last = None
    for item in w.outline:
        if isinstance(item, list):
            if last is None:
                continue
            for kid in item:
                if isinstance(kid, list):
                    continue
                try:
                    n = w.get_destination_page_number(kid)
                except Exception:
                    continue
                if n is not None and n >= 0:
                    out.setdefault(last, []).append((n + 1, str(kid.get("/Title") or "")))
            continue
        try:
            n = w.get_destination_page_number(item)
        except Exception:
            n = None
        last = n + 1 if n is not None and n >= 0 else None
    return out


def _sections(w: PdfWriter, recs: list[tuple[int, int, str]], args: dict) -> list[list[tuple[int, int, str]]] | None:
    """The sections of each record (a letter, then its statement pages), or None when records are not divided."""
    names = [str(x)[:200] for x in args.get("section_names") or []]
    if args.get("sections") == "bookmarks":
        kids = _outline_kids(w)
        out = []
        for s, e, _name in recs:
            starts = sorted({p: t for p, t in kids.get(s, []) if s <= p <= e}.items())
            if not starts or starts[0][0] != s:
                starts = [(s, "")] + starts
            row = []
            for i, (a, title) in enumerate(starts):
                b = starts[i + 1][0] - 1 if i + 1 < len(starts) else e
                row.append((a, b, title or (names[i] if i < len(names) else f"Section {i + 1}")))
            out.append(row)
        return out
    sizes = args.get("section_pages")
    if not sizes:
        return None
    try:
        sizes = [int(x) for x in sizes]
    except (TypeError, ValueError):
        raise ValueError("section_pages is a list of page counts, such as [1, 2]")
    if any(x < 1 for x in sizes):
        raise ValueError("Every section has at least one page")
    out = []
    for n, (s, e, _name) in enumerate(recs, 1):
        if sum(sizes) != e - s + 1:
            raise ValueError(f"The sections add up to {sum(sizes)} pages but record {n} has {e - s + 1}")
        row, a = [], s
        for i, size in enumerate(sizes):
            row.append((a, a + size - 1, names[i] if i < len(names) else f"Section {i + 1}"))
            a += size
        out.append(row)
    return out


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
    """Marks records with a DPartRoot: a root part (the document) whose kids are one part per record. A record is a leaf
    naming its first and last page, or, when records are divided into sections, a node whose kids are the section leaves."""
    args = args or {}
    r = core.reader(src, passwords)
    claim = pdfx._claim(r)
    if "PDF/X-4" not in claim and "PDF/X-5" not in claim:
        raise ValueError("PDF/VT builds on PDF/X-4: convert to PDF/X-4 first (Print > Convert to PDF/X)")
    if core.signed(r):
        raise ValueError("Making PDF/VT rewrites the file, which would break its signatures.")
    w = PdfWriter(clone_from=r)
    recs = _records(w, args)
    secs = _sections(w, recs, args)
    root_node = DictionaryObject({NameObject("/Type"): NameObject("/DPart")})
    root_ref = w._add_object(root_node)

    def leaf(parent, s: int, e: int, dpm: DictionaryObject):
        # a leaf names its pages; a node with kids does not (the two are exclusive in ISO 16612-2 and PDF 2.0)
        ref = w._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/DPart"), NameObject("/Parent"): parent,
            NameObject("/Start"): w.pages[s - 1].indirect_reference, NameObject("/End"): w.pages[e - 1].indirect_reference,
            NameObject("/DPM"): dpm,
        }))
        for n in range(s, e + 1):
            w.pages[n - 1][NameObject("/DPart")] = ref
        return ref

    def meta(level: str, name: str, number: int) -> DictionaryObject:
        return DictionaryObject({NameObject(f"/{level}"): DictionaryObject({
            NameObject("/Name"): TextStringObject(name), NameObject("/Number"): NumberObject(number)})})

    kids = ArrayObject()
    for i, (s, e, name) in enumerate(recs):
        if secs is None:
            kids.append(leaf(root_ref, s, e, meta("Record", name, i + 1)))
            continue
        node = DictionaryObject({NameObject("/Type"): NameObject("/DPart"), NameObject("/Parent"): root_ref,
                                 NameObject("/DPM"): meta("Record", name, i + 1)})
        ref = w._add_object(node)
        node[NameObject("/Kids")] = ArrayObject(leaf(ref, a, b, meta("Section", sname, j + 1)) for j, (a, b, sname) in enumerate(secs[i]))
        kids.append(ref)
    root_node[NameObject("/Kids")] = kids
    levels = [NameObject("/Document"), NameObject("/Record")] + ([NameObject("/Section")] if secs is not None else [])
    w._root_object[NameObject("/DPartRoot")] = w._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/DPartRoot"), NameObject("/DPartRootNode"): root_ref,
        NameObject("/RecordLevel"): NumberObject(1),
        NameObject("/NodeNameList"): ArrayObject(levels),
    }))
    _claim_vt(w)
    w.pdf_header = b"%PDF-1.6"
    if not getattr(w, "_ID", None):
        w.generate_file_identifiers()
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "records": len(recs), "sections": sum(len(x) for x in secs) if secs is not None else 0,
            "first": [{"name": n, "start": s, "end": e, "sections": [{"name": sn, "start": a, "end": b} for a, b, sn in secs[i]] if secs is not None else []}
                      for i, (s, e, n) in enumerate(recs[:20])]}


actions.register(actions.Action("pdfvt", "change", "Make PDF/VT records", "pdfvt", ("pdf/vt", "variable data", "records", "mail merge", "personalised print"),
                                fields=(actions.Field("pages_per_record", "Pages per record", "number", "1"),), run=make))
