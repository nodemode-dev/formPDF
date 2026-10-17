from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, NameObject, NumberObject, TextStringObject

from . import actions, core

OPS = ("add", "rename", "delete", "dest", "up", "down", "indent", "outdent")


def _root(w: PdfWriter) -> IndirectObject:
    cat = w._root_object
    ref = cat.get("/Outlines")
    if ref is None or not isinstance(ref, IndirectObject):
        node = DictionaryObject({NameObject("/Type"): NameObject("/Outlines"), NameObject("/Count"): NumberObject(0)})
        ref = w._add_object(node)
        cat[NameObject("/Outlines")] = ref
    return ref


def _kids(parent_ref: IndirectObject) -> list[IndirectObject]:
    out, ref, seen = [], parent_ref.get_object().get("/First"), set()
    while isinstance(ref, IndirectObject) and ref.idnum not in seen:
        seen.add(ref.idnum)
        out.append(ref)
        ref = ref.get_object().get("/Next")
    return out


def _listed(root: IndirectObject) -> list[tuple[IndirectObject, IndirectObject]]:
    out: list[tuple[IndirectObject, IndirectObject]] = []

    def walk(parent: IndirectObject, depth: int) -> None:
        if depth > 32:
            return
        for ref in _kids(parent):
            if str(ref.get_object().get("/Title", "") or "").strip():
                out.append((ref, parent))
            walk(ref, depth + 1)

    walk(root, 0)
    return out


def _unlink(ref: IndirectObject, parent: IndirectObject) -> None:
    node, par = ref.get_object(), parent.get_object()
    prev, nxt = node.get("/Prev"), node.get("/Next")
    if prev is not None:
        if nxt is not None:
            prev.get_object()[NameObject("/Next")] = nxt
        else:
            prev.get_object().pop("/Next", None)
    elif nxt is not None:
        par[NameObject("/First")] = nxt
    else:
        par.pop("/First", None)
    if nxt is not None:
        if prev is not None:
            nxt.get_object()[NameObject("/Prev")] = prev
        else:
            nxt.get_object().pop("/Prev", None)
    elif prev is not None:
        par[NameObject("/Last")] = prev
    else:
        par.pop("/Last", None)
    node.pop("/Prev", None)
    node.pop("/Next", None)


def _insert(ref: IndirectObject, parent: IndirectObject, before: IndirectObject | None) -> None:
    node, par = ref.get_object(), parent.get_object()
    node[NameObject("/Parent")] = parent
    if before is None:
        last = par.get("/Last")
        if last is not None:
            last.get_object()[NameObject("/Next")] = ref
            node[NameObject("/Prev")] = last
        else:
            par[NameObject("/First")] = ref
        par[NameObject("/Last")] = ref
        return
    b = before.get_object()
    prev = b.get("/Prev")
    node[NameObject("/Next")] = before
    b[NameObject("/Prev")] = ref
    if prev is not None:
        prev.get_object()[NameObject("/Next")] = ref
        node[NameObject("/Prev")] = prev
    else:
        par[NameObject("/First")] = ref


def _recount(ref: IndirectObject, root: bool = False) -> int:
    node = ref.get_object()
    kids = _kids(ref)
    shown = 0
    for k in kids:
        inner = _recount(k)
        shown += 1 + (inner if k.get_object().get("/Count", 0) >= 0 else 0)
    if root:
        node[NameObject("/Count")] = NumberObject(shown)
    elif not kids:
        node.pop("/Count", None)
    else:
        closed = node.get("/Count", 0) < 0
        node[NameObject("/Count")] = NumberObject(-shown if closed else shown)
    return shown


def _dest(w: PdfWriter, page: int) -> ArrayObject:
    if not 1 <= page <= len(w.pages):
        raise ValueError(f"Page {page} is out of range (1 to {len(w.pages)})")
    return ArrayObject([w.pages[page - 1].indirect_reference, NameObject("/Fit")])


def _new(w: PdfWriter, title: str, page: int) -> IndirectObject:
    return w._add_object(DictionaryObject({NameObject("/Title"): TextStringObject(title), NameObject("/Dest"): _dest(w, page)}))


def _title(op: dict) -> str:
    t = str(op.get("title") or "").strip()
    if not t:
        raise ValueError("A bookmark needs a title")
    return t[:500]


def apply(w: PdfWriter, ops: list[dict]) -> int:
    root = _root(w)
    done = 0
    for op in ops:
        kind = op.get("op")
        if kind not in OPS:
            raise ValueError(f"op is one of {', '.join(OPS)}")
        listed = _listed(root)
        i = op.get("index")
        if kind == "add" and i is None:
            _insert(_new(w, _title(op), int(op.get("page") or 1)), root, None)
            done += 1
            continue
        if not isinstance(i, int) or not 0 <= i < len(listed):
            raise ValueError(f"index is a bookmark's position in the outline list, 0 to {len(listed) - 1}")
        ref, parent = listed[i]
        node = ref.get_object()
        if kind == "add":
            _insert(_new(w, _title(op), int(op.get("page") or 1)), parent, node.get("/Next"))
        elif kind == "rename":
            node[NameObject("/Title")] = TextStringObject(_title(op))
        elif kind == "delete":
            _unlink(ref, parent)
        elif kind == "dest":
            node.pop("/A", None)
            node[NameObject("/Dest")] = _dest(w, int(op.get("page") or 1))
        elif kind == "up":
            prev = node.get("/Prev")
            if prev is None:
                continue
            _unlink(ref, parent)
            _insert(ref, parent, prev)
        elif kind == "down":
            nxt = node.get("/Next")
            if nxt is None:
                continue
            after = nxt.get_object().get("/Next")
            _unlink(ref, parent)
            _insert(ref, parent, after)
        elif kind == "indent":
            prev = node.get("/Prev")
            if prev is None:
                continue
            _unlink(ref, parent)
            _insert(ref, prev, None)
        elif kind == "outdent":
            if parent.idnum == root.idnum:
                continue
            grand = parent.get_object().get("/Parent")
            if not isinstance(grand, IndirectObject):
                continue
            after = parent.get_object().get("/Next")
            _unlink(ref, parent)
            _insert(ref, grand, after)
        done += 1
    _recount(root, True)
    return done


def change(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    ops = (args or {}).get("ops")
    if not isinstance(ops, list) or not ops:
        raise ValueError("Give ops: a list of {op, index, title, page}; op is " + ", ".join(OPS))
    w = PdfWriter(clone_from=core.reader(src, passwords))
    done = apply(w, ops)
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "changed": done}


actions.register(actions.Action("edit_outline", "change", "Add, rename, move and delete bookmarks", "bookmarks",
                                ("bookmarks", "outline", "add bookmark", "rename bookmark", "delete bookmark", "nest bookmark", "table of contents"), run=change))
