import re

from pypdf import PdfWriter
from pypdf.annotations import Link
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, NumberObject

from . import actions, core, frame, search

URL = re.compile(r"(?i)(?<![\w@/.-])(?:https?://|www\.)[^\s<>\"'(){}\[\]]+|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?![\w-])")
TRAIL = ".,;:!?'\")]}"
MAX_AUTO = 2000


def target(raw) -> tuple[str, object]:
    s = str(raw or "").strip()
    if not s:
        raise ValueError("Say where the link goes: a web address, an email address or a page number")
    if re.fullmatch(r"(?:page\s*)?\d{1,5}", s, re.IGNORECASE):
        return "page", int(re.sub(r"\D", "", s))
    if re.fullmatch(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", s):
        return "uri", "mailto:" + s
    if s.lower().startswith("www."):
        s = "https://" + s
    if not re.match(r"(?i)^(https?://|mailto:)", s):
        if re.fullmatch(r"[\w-]+(\.[\w-]+)+(/\S*)?", s):
            s = "https://" + s
        else:
            raise ValueError(f"{s[:60]} is not a web address, an email address or a page number")
    try:
        s.encode("ascii")
    except UnicodeEncodeError:
        raise ValueError("Web addresses in links must be plain ASCII; use the punycode form for international names") from None
    return "uri", s


def _index(r) -> dict[int, int]:
    out = {}
    for i, p in enumerate(r.pages):
        ref = p.indirect_reference
        if ref is not None:
            out[ref.idnum] = i + 1
    return out


def _dest_page(r, dest, pages: dict[int, int]) -> int | None:
    try:
        if isinstance(dest, (str, bytes)) or hasattr(dest, "startswith"):
            d = r.named_destinations.get(str(dest))
            return r.get_destination_page_number(d) + 1 if d is not None else None
        arr = dest.get_object() if hasattr(dest, "get_object") else dest
        if isinstance(arr, DictionaryObject) and "/D" in arr:
            arr = arr["/D"]
        first = arr[0]
        if isinstance(first, int):
            return int(first) + 1
        return pages.get(first.idnum)
    except Exception:
        return None


def _links(r) -> list[dict]:
    pages = _index(r)
    out = []
    for pi, page in enumerate(r.pages):
        k = 0
        for ref in page.get("/Annots") or []:
            a = ref.get_object()
            if a.get("/Subtype") != "/Link" or "/Rect" not in a:
                continue
            item = {"page": pi + 1, "index": k, **frame.from_pdf(page, a["/Rect"]), "kind": "other", "target": ""}
            act = a.get("/A")
            act = act.get_object() if act is not None else None
            if act is not None and act.get("/S") == "/URI":
                item.update(kind="uri", target=str(act.get("/URI", "")))
            else:
                dest = a.get("/Dest") if "/Dest" in a else (act.get("/D") if act is not None and act.get("/S") == "/GoTo" else None)
                n = _dest_page(r, dest, pages) if dest is not None else None
                if n:
                    item.update(kind="page", target=str(n))
            out.append(item)
            k += 1
    return out


def read(path, *, args: dict, pages=None, passwords: list[str] | None = None):
    r = core.reader(path, passwords)
    got = _links(r)
    if pages:
        keep = set(core.parse_pages(pages, len(r.pages)))
        got = [x for x in got if x["page"] in keep]
    lines = [f"p{x['page']} #{x['index']} · {x['kind']} · {x['target'] or '(unknown action)'}" for x in got]
    return ("\n".join(lines) or "No links."), {"links": got, "count": len(got)}


def _link(rect, kind: str, value, border: bool, n: int) -> DictionaryObject:
    if kind == "page":
        if not 1 <= int(value) <= n:
            raise ValueError(f"Page {value} is out of range (1 to {n})")
        a = Link(rect=rect, target_page_index=int(value) - 1)
    else:
        a = Link(rect=rect, url=str(value))
    a[NameObject("/Border")] = ArrayObject([NumberObject(0), NumberObject(0), NumberObject(1 if border else 0)])
    if border:
        a[NameObject("/C")] = ArrayObject([FloatObject(0.15), FloatObject(0.39), FloatObject(0.92)])
    a[NameObject("/F")] = NumberObject(4)
    a[NameObject("/H")] = NameObject("/I")
    return a


def change(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    r = core.reader(src, passwords)
    w = PdfWriter(clone_from=r)
    n = len(w.pages)
    border = bool(args.get("border"))
    existing = _links(r)
    gone = {(int(x["page"]), int(x["index"])) for x in args.get("remove") or [] if isinstance(x, dict)}
    removed = 0
    if gone:
        for pi, page in enumerate(w.pages):
            annots = page.get("/Annots")
            if not annots:
                continue
            keep, k = ArrayObject(), 0
            for ref in annots.get_object():
                a = ref.get_object()
                if a.get("/Subtype") == "/Link" and "/Rect" in a:
                    if (pi + 1, k) in gone:
                        removed += 1
                        k += 1
                        continue
                    k += 1
                keep.append(ref)
            page[NameObject("/Annots")] = keep
    taken = [x for x in existing if (x["page"], x["index"]) not in gone]
    added = 0
    for item in args.get("add") or []:
        if not isinstance(item, dict):
            continue
        p = int(item.get("page") or 0)
        if not 1 <= p <= n:
            raise ValueError(f"Page {p} is out of range (1 to {n})")
        x, y, bw, bh = frame.box(item)
        if bw < 2 or bh < 2:
            raise ValueError("A link box must be at least 2 points wide and tall")
        kind, value = target(item.get("to") or item.get("url") or item.get("target"))
        w.add_annotation(p - 1, _link(frame.to_pdf(w.pages[p - 1], x, y, bw, bh), kind, value, border, n))
        taken.append({"page": p, "x": x, "y": y, "w": bw, "h": bh})
        added += 1
    if args.get("auto"):
        got = search.find(src, URL.pattern, regex=True, case_sensitive=True, pages=pages, passwords=passwords)
        for m in got["matches"][:MAX_AUTO]:
            text = m["text"].rstrip(TRAIL)
            if len(text) < 5:
                continue
            try:
                kind, value = target(text)
            except ValueError:
                continue
            for rc in m["rects"]:
                box = {"page": m["page"], "x": rc["x"], "y": rc["y"], "w": rc["w"], "h": rc["h"]}
                if any(t["page"] == box["page"] and frame.overlaps(t, box) for t in taken):
                    continue
                page = w.pages[m["page"] - 1]
                w.add_annotation(m["page"] - 1, _link(frame.to_pdf(page, rc["x"], rc["y"], rc["w"], rc["h"]), kind, value, border, n))
                taken.append(box)
                added += 1
    if not added and not removed:
        raise ValueError("No links to add or remove" + (": no web or email addresses were found in the text" if args.get("auto") else ""))
    with open(out, "wb") as f:
        w.write(f)
    return {"pages": n, "added": added, "deleted": removed}


actions.register(actions.Action("links", "read", "List links", words=("hyperlinks", "urls", "web links"), run=read))
actions.register(actions.Action("edit_links", "change", "Add or remove links", "linked", ("link", "hyperlink", "url", "web address", "mailto", "link to page"),
                                fields=(actions.Field("auto", "Link every web and email address in the text", "bool", True),
                                        actions.Field("border", "Show a thin blue border", "bool", False), actions.PAGES),
                                run=change))
