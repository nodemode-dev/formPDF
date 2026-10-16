import datetime
import html
import io
import re

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, ContentStream, DecodedStreamObject, DictionaryObject, EncodedStreamObject, FloatObject, IndirectObject,
                           NameObject, NumberObject, StreamObject)

from . import actions, colour, core, pdfa, sanitize
from .content import interp

PROFILES = {"print": "Commercial print", "screen": "Screen and email", "office": "Office printer"}
FIXES = ("embed_fonts", "hairlines", "trim_box", "scripts", "downsample", "gray")
HAIRLINE = 0.25


def _o(v):
    return v.get_object() if hasattr(v, "get_object") else v


def _check(cid: str, name: str, status: str, say: str, findings=(), fix: str | None = None) -> dict:
    found = list(findings)
    return {"id": cid, "name": name, "status": status, "say": say, "findings": found[:200], "more": max(0, len(found) - 200), "fix": fix}


def _view(page, box) -> dict:
    vx0, _vy0, _vx1, vy1 = core.view_box(page)
    x0, y0, x1, y1 = box
    return {"x": round(x0 - vx0, 2), "y": round(vy1 - y1, 2), "w": round(x1 - x0, 2), "h": round(y1 - y0, 2)}


def _op_boxes(c) -> dict:
    """The box each painting operator covers, keyed by (stream, operator index): draws as they are, text as the union of its glyphs."""
    out = {(d.where, d.op): d.box for d in c.draws if d.box}
    for g in c.glyphs:
        k, b = (g.where, g.op), g.box
        if not b:
            continue
        o = out.get(k)
        out[k] = b if o is None else (min(o[0], b[0]), min(o[1], b[1]), max(o[2], b[2]), max(o[3], b[3]))
    return out


def _pages(pages: set) -> str:
    ps = sorted(pages)
    if not ps:
        return ""
    head = ", ".join(str(p) for p in ps[:8])
    return f" (page {head})" if len(ps) == 1 else f" (pages {head}{' and more' if len(ps) > 8 else ''})"


def images(doc) -> list[dict]:
    out = []
    for pi, page in enumerate(doc.pages):
        core.lean(doc)
        try:
            c = interp.walk(page, doc)
        except Exception:
            continue
        for d in c.draws:
            if d.kind != "image" or not d.box:
                continue
            st = c.streams.get(d.where)
            res = _o(st.resources) if st is not None else None
            xo = _o((_o(res.get("/XObject")) or {}).get(d.name)) if isinstance(res, DictionaryObject) else None
            if not isinstance(xo, StreamObject) or xo.get("/ImageMask"):
                continue
            pw, ph = int(_o(xo.get("/Width", 0)) or 0), int(_o(xo.get("/Height", 0)) or 0)
            a, b, cc, dd = d.ctm[:4]
            wpt, hpt = (a * a + b * b) ** 0.5, (cc * cc + dd * dd) ** 0.5
            if wpt < 4 or hpt < 4 or not pw or not ph:
                continue
            ppi = min(pw / (wpt / 72), ph / (hpt / 72))
            out.append({"page": pi + 1, "ppi": round(ppi), "px": (pw, ph), "pt": (round(wpt, 1), round(hpt, 1)), "ref": (st, d.name), "box": _view(page, d.box)})
    return out


def _transparency(doc) -> set:
    pages = set()
    for kind, pi, obj in pdfa.walk(doc):
        if pi is None:
            continue
        if kind == "res":
            for _n, gs in (_o(obj.get("/ExtGState")) or {}).items():
                g = _o(gs)
                if not isinstance(g, DictionaryObject):
                    continue
                ca = [float(_o(g.get(k))) for k in ("/ca", "/CA") if g.get(k) is not None]
                sm = g.get("/SMask")
                bm = g.get("/BM")
                if any(v < 0.999 for v in ca) or (sm is not None and sm != "/None") or (bm is not None and str(_o(bm)) not in ("/Normal", "/Compatible")):
                    pages.add(pi + 1)
        elif kind == "xobject":
            grp = _o(obj.get("/Group"))
            if obj.get("/SMask") is not None or (isinstance(grp, DictionaryObject) and grp.get("/S") == "/Transparency"):
                pages.add(pi + 1)
    return pages


PAINT_FILL = {b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*"}
PAINT_ANY = PAINT_FILL | {b"S", b"s", b"Do", b"sh", b"Tj", b"TJ", b"'", b"\""}
TAC_LIMIT = 300.0


def _nums(operands) -> list[float]:
    out = []
    for v in operands:
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            return []
    return out


def _press(doc, limit: float = TAC_LIMIT) -> dict:
    found = {"tac": {}, "overprint": set(), "edge": {}, "boxes": {"tac": {}, "overprint": {}, "rgb": {}}}
    for pi, page in enumerate(doc.pages):
        n = pi + 1
        core.lean(doc)
        try:
            c = interp.walk(page, doc)
        except Exception:
            continue
        boxes = _op_boxes(c)
        for st in c.streams.values():
            res = _o(st.resources) if st.resources is not None else None
            gstates = _o(res.get("/ExtGState")) if isinstance(res, DictionaryObject) else None
            state = {"fcs": "gray", "fill": [0.0], "scs": "gray", "stroke": [0.0], "op": False}
            stack = []
            for i, (operands, op) in enumerate(st.operations):
                if op == b"q":
                    stack.append(dict(state))
                elif op == b"Q" and stack:
                    state = stack.pop()
                elif op in (b"g", b"G"):
                    k = "fcs" if op == b"g" else "scs"
                    state[k], state["fill" if op == b"g" else "stroke"] = "gray", _nums(operands)
                elif op in (b"rg", b"RG"):
                    state["fcs" if op == b"rg" else "scs"], state["fill" if op == b"rg" else "stroke"] = "rgb", _nums(operands)
                elif op in (b"k", b"K"):
                    state["fcs" if op == b"k" else "scs"], state["fill" if op == b"k" else "stroke"] = "cmyk", _nums(operands)
                elif op in (b"cs", b"CS") and operands:
                    state["fcs" if op == b"cs" else "scs"] = colour.space_kind(operands[0], res) or "other"
                elif op in (b"sc", b"scn", b"SC", b"SCN"):
                    state["fill" if op in (b"sc", b"scn") else "stroke"] = _nums(operands)
                elif op == b"gs" and operands and isinstance(gstates, DictionaryObject):
                    g = _o(gstates.get(str(operands[0])))
                    if isinstance(g, DictionaryObject):
                        fop = g.get("/op", g.get("/OP"))
                        if fop is not None:
                            state["op"] = bool(_o(fop))
                elif op in PAINT_ANY:
                    for which in ("fill", "stroke") if op not in PAINT_FILL else ("fill",):
                        cs, vals = state["fcs" if which == "fill" else "scs"], state[which]
                        if cs == "cmyk" and len(vals) == 4:
                            total = sum(vals) * 100
                            if total > limit + 0.5:
                                if total > found["tac"].get(n, 0.0) and boxes.get((st.where, i)):
                                    found["boxes"]["tac"][n] = _view(page, boxes[(st.where, i)])
                                found["tac"][n] = max(found["tac"].get(n, 0.0), total)
                    if op != b"Do" and n not in found["boxes"]["rgb"] and boxes.get((st.where, i)):
                        fills = op in PAINT_FILL or op in (b"Tj", b"TJ", b"'", b"\"", b"B", b"B*", b"b", b"b*")
                        strokes = op in (b"S", b"s", b"B", b"B*", b"b", b"b*")
                        if (fills and state["fcs"] == "rgb") or (strokes and state["scs"] == "rgb"):
                            found["boxes"]["rgb"][n] = _view(page, boxes[(st.where, i)])
                    cs, vals = state["fcs"], state["fill"]
                    white =(cs == "cmyk" and len(vals) == 4 and sum(vals) < 0.001) or (cs == "gray" and vals and vals[0] > 0.999) or (cs == "rgb" and len(vals) == 3 and min(vals) > 0.999)
                    if state["op"] and white and op in PAINT_FILL | {b"Tj", b"TJ", b"'", b"\""}:
                        found["overprint"].add(n)
                        if boxes.get((st.where, i)):
                            found["boxes"]["overprint"].setdefault(n, _view(page, boxes[(st.where, i)]))
        trim = page.trimbox
        bleed = page.bleedbox
        no_bleed = abs(float(bleed.left) - float(trim.left)) < 0.5 and abs(float(bleed.right) - float(trim.right)) < 0.5 \
            and abs(float(bleed.bottom) - float(trim.bottom)) < 0.5 and abs(float(bleed.top) - float(trim.top)) < 0.5
        if no_bleed:
            tx0, ty0, tx1, ty1 = float(trim.left), float(trim.bottom), float(trim.right), float(trim.top)
            for d in c.draws:
                if d.kind not in ("path", "image", "shading") or d.box is None:
                    continue
                x0, y0, x1, y1 = d.box
                if (x1 - x0) * (y1 - y0) < 4:
                    continue
                if x0 <= tx0 + 0.5 or y0 <= ty0 + 0.5 or x1 >= tx1 - 0.5 or y1 >= ty1 - 0.5:
                    found["edge"][n] = _view(page, d.box)
                    break
    for im in images(doc):
        core.lean(doc)
        try:
            st, name = im["ref"]
            obj = _o(_o(_o(st.resources).get("/XObject")).raw_get(name))
            kind = colour.space_kind(obj.get("/ColorSpace"), _o(st.resources))
            if kind == "rgb":
                found["boxes"]["rgb"].setdefault(im["page"], im["box"])
            if kind != "cmyk":
                continue
            pil = obj.decode_as_image()
            if pil.mode != "CMYK":
                continue
            pil.thumbnail((256, 256))
            total = max((sum(px) for px in pil.getdata()), default=0) * 100 / 255
            if total > limit + 0.5:
                if total > found["tac"].get(im["page"], 0.0):
                    found["boxes"]["tac"][im["page"]] = im["box"]
                found["tac"][im["page"]] = max(found["tac"].get(im["page"], 0.0), total)
        except Exception:
            continue
    return found


def _hairlines(doc) -> dict:
    """Pages with a line thinner than HAIRLINE, each with the box of its first one (or None)."""
    pages: dict = {}
    for pi, page in enumerate(doc.pages):
        core.lean(doc)
        try:
            c = interp.walk(page, doc)
        except Exception:
            continue
        boxes = _op_boxes(c)
        for st in c.streams.values():
            width = 1.0
            for i, (operands, op) in enumerate(st.operations):
                if op == b"w" and operands:
                    try:
                        width = float(operands[0])
                    except (TypeError, ValueError):
                        continue
                elif op in (b"S", b"s", b"B", b"B*", b"b", b"b*") and width < HAIRLINE:
                    b = boxes.get((st.where, i))
                    if pages.get(pi + 1) is None:
                        pages[pi + 1] = _view(page, b) if b else None
                    break
    return pages


def check(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    profile = str((args or {}).get("profile") or "print")
    if profile not in PROFILES:
        raise ValueError(f"profile is one of {', '.join(PROFILES)}")
    r = core.reader(path, passwords)
    out = []
    loose = {}
    for pi, _ref, f in pdfa.fonts(r):
        if not pdfa.embedded(f):
            loose.setdefault(pdfa._base(f) or "unnamed", set()).add(pi + 1 if pi is not None else 0)
    fixable = all(pdfa.substitute(f) is not None for _pi, _r, f in pdfa.fonts(r) if not pdfa.embedded(f))
    out.append(_check("fonts", "Fonts embedded", ("fail" if profile == "print" else "warn") if loose else "pass",
                      (f"{len(loose)} font{'s are' if len(loose) != 1 else ' is'} not embedded: {', '.join(list(loose)[:6])}. The printer or reader substitutes them."
                       + ("" if fixable else " Some have no matching font to embed.")) if loose else "Every font is embedded.",
                      [{"page": min(p) or None, "text": f"{k} not embedded"} for k, p in loose.items()], "embed_fonts" if loose else None))
    imgs = images(r)
    low = [i for i in imgs if i["ppi"] < (225 if profile == "print" else 96)]
    bad = [i for i in low if i["ppi"] < (150 if profile == "print" else 72)]
    if profile == "screen":
        high = [i for i in imgs if i["ppi"] > 225]
        out.append(_check("resolution", "Picture resolution", "warn" if high else "pass",
                          f"{len(high)} picture{'s are' if len(high) != 1 else ' is'} sharper than a screen needs (over 225 ppi){_pages({i['page'] for i in high})}; downsampling to 150 ppi makes the file smaller."
                          if high else "Pictures are not larger than a screen needs.",
                          [{"page": i["page"], "text": f"{i['ppi']} ppi ({i['px'][0]} x {i['px'][1]} px at {i['pt'][0]} x {i['pt'][1]} pt)", "box": i["box"]} for i in high],
                          "downsample" if high else None))
    else:
        out.append(_check("resolution", "Picture resolution", "fail" if bad else "warn" if low else "pass",
                          f"{len(low)} picture{'s are' if len(low) != 1 else ' is'} below {225 if profile == 'print' else 96} ppi at the size they print{_pages({i['page'] for i in low})}, so they print soft or blocky."
                          if low else ("Every picture has enough resolution for its printed size." if imgs else "There are no pictures."),
                          [{"page": i["page"], "text": f"{i['ppi']} ppi ({i['px'][0]} x {i['px'][1]} px at {i['pt'][0]} x {i['pt'][1]} pt)", "box": i["box"]} for i in low]))
    sc = colour.scan(r)
    kinds = set(sc.used)
    press = _press(r, float((args or {}).get("tac") or TAC_LIMIT)) if profile == "print" else None
    if press is not None:
        rgb = sorted(sc.where.get("rgb", set()))
        out.append(_check("colour", "Colour spaces", "warn" if rgb else "pass",
                          f"RGB colour is used{_pages(set(rgb))}; a press converts it to CMYK with its own settings, so colours can shift." if rgb else
                          "Colour is CMYK or gray, ready for a press.", [{"page": p, "text": "RGB colour", "box": press["boxes"]["rgb"].get(p)} for p in rgb[:200]],
                          "gray" if rgb else None))
        spots = sorted({k for k in kinds if k in ("separation", "devicen")})
        out.append(_check("spots", "Spot colours", "info" if spots else "pass", f"Spot colours are used ({', '.join(spots)}); check they match the press inks." if spots else "There are no spot colours."))
    elif profile == "office":
        out.append(_check("colour", "Colour spaces", "pass", "Office printers take any colour space."))
    tr = _transparency(r)
    out.append(_check("transparency", "Transparency", ("warn" if profile == "print" else "info") if tr else "pass",
                      f"Transparency is used{_pages(tr)}; older press workflows may flatten it badly. PDF/X-4 keeps it live." if tr else "There is no transparency.",
                      [{"page": p, "text": "Transparency"} for p in sorted(tr)]))
    if profile != "screen":
        hl = _hairlines(r)
        out.append(_check("hairlines", "Hairlines", "warn" if hl else "pass", f"Lines thinner than {HAIRLINE} pt{_pages(hl)} may not print or may vanish." if hl else "No line is thinner than a press can print.",
                          [{"page": p, "text": "Hairline", "box": hl[p]} for p in sorted(hl)], "hairlines" if hl else None))
    if press is not None:
        limit = float((args or {}).get("tac") or TAC_LIMIT)
        tac = press["tac"]
        out.append(_check("ink", "Total ink coverage", "warn" if tac else "pass",
                          f"Ink coverage goes above {limit:.0f} percent{_pages(set(tac))}, up to {max(tac.values()):.0f} percent; heavy ink smears and dries slowly." if tac
                          else f"Ink coverage stays within {limit:.0f} percent.", [{"page": p, "text": f"{v:.0f} percent ink", "box": press["boxes"]["tac"].get(p)} for p, v in sorted(tac.items())]))
        ov = press["overprint"]
        out.append(_check("overprint", "White set to overprint", "fail" if ov else "pass",
                          f"White is painted with overprint on{_pages(ov)}; on press it disappears, so whatever is under it shows through." if ov else "Nothing white is set to overprint.",
                          [{"page": p, "text": "White overprints", "box": press["boxes"]["overprint"].get(p)} for p in sorted(ov)]))
        edge = press["edge"]
        out.append(_check("bleed", "Bleed", "warn" if edge else "pass",
                          f"Artwork reaches the trimmed edge but there is no bleed{_pages(edge)}; a thin white line can show after cutting. Add bleed in Page boxes and bleed." if edge
                          else "Nothing runs to the trimmed edge without bleed.", [{"page": p, "text": "Artwork at the edge, no bleed", "box": b} for p, b in sorted(edge.items())]))
        no_trim = [i + 1 for i, p in enumerate(r.pages) if "/TrimBox" not in p and "/ArtBox" not in p]
        out.append(_check("trim", "Trim box", "info" if no_trim else "pass", "Pages have no trim box, so the finished size is the page size." if no_trim else "Every page has a trim box.",
                          fix="trim_box" if no_trim else None))
    js = next((h["count"] for h in sanitize.scan(path, passwords) if h["key"] == "javascript"), 0)
    out.append(_check("scripts", "Scripts", "warn" if js else "pass", "The PDF has scripts or actions that run on their own; printers and archives ignore or refuse them." if js else "There are no scripts.",
                      fix="scripts" if js else None))
    counts = {s: sum(1 for x in out if x["status"] == s) for s in ("fail", "warn", "info", "pass")}
    lines = [f"Preflight ({PROFILES[profile]}): {counts['fail']} failed, {counts['warn']} warnings, {counts['info']} notes, {counts['pass']} passed."]
    lines += [f"{x['status']} · {x['name']}: {x['say']}" + (f" (fix: {x['fix']})" if x["fix"] else "") for x in out if x["status"] != "pass"]
    return "\n".join(lines), {"profile": profile, "checks": out, "summary": counts, "fixes": sorted({x["fix"] for x in out if x["fix"]})}


def _rewrite(w: PdfWriter, fn) -> int:
    seen: set = set()
    changed = 0

    def run(ref, res):
        nonlocal changed
        obj = _o(ref)
        key = ref.idnum if isinstance(ref, IndirectObject) else id(obj)
        if key in seen:
            return ref
        seen.add(key)
        try:
            ops = list(ContentStream(obj, w).operations)
        except Exception:
            return ref
        new, dirty = fn(ops)
        for _n, xo in (_o((res or {}).get("/XObject")) or {}).items():
            x = _o(xo)
            if isinstance(x, StreamObject) and x.get("/Subtype") == "/Form":
                run(xo if isinstance(xo, IndirectObject) else x, _o(x.get("/Resources")))
        if not dirty:
            return ref
        changed += 1
        cs = ContentStream(None, w)
        cs.operations = new
        return colour._replace_stream(w, ref, obj, cs.get_data())

    for page in w.pages:
        res = _o(page.get("/Resources"))
        raw = page.raw_get("/Contents") if "/Contents" in page else None
        if raw is None:
            continue
        arr = _o(raw)
        refs = list(arr) if isinstance(arr, ArrayObject) else [raw]
        new = [run(r, res) for r in refs]
        if new != refs:
            page[NameObject("/Contents")] = ArrayObject(new) if isinstance(arr, ArrayObject) else new[0]
    return changed


def _thicken(ops):
    dirty = False
    out = []
    for operands, op in ops:
        if op == b"w" and operands:
            try:
                v = float(operands[0])
            except (TypeError, ValueError):
                v = 1.0
            if v < HAIRLINE:
                out.append(([FloatObject(HAIRLINE)], op))
                dirty = True
                continue
        out.append((operands, op))
    return out, dirty


def _downsample(w: PdfWriter, target: int) -> int:
    from PIL import Image

    n = 0
    done = set()
    for im in images(w):
        if im["ppi"] <= target * 1.5:
            continue
        st, name = im["ref"]
        xo = _o(st.resources).get("/XObject")
        ref = _o(xo).raw_get(name)
        key = ref.idnum if isinstance(ref, IndirectObject) else None
        if key is None or key in done:
            continue
        done.add(key)
        obj = _o(ref)
        try:
            pil = obj.decode_as_image()
        except Exception:
            continue
        k = target / im["ppi"]
        size = (max(1, round(pil.width * k)), max(1, round(pil.height * k)))
        mode = "L" if pil.mode in ("L", "1", "LA") else "RGB"
        small = pil.convert(mode).resize(size, Image.LANCZOS)
        buf = io.BytesIO()
        small.save(buf, "JPEG", quality=85)
        s = EncodedStreamObject()
        for kk, v in obj.items():
            if kk not in ("/Length", "/Filter", "/DecodeParms", "/ColorSpace", "/BitsPerComponent", "/Decode", "/Width", "/Height", "/Mask"):
                s[NameObject(kk)] = v
        s[NameObject("/Filter")] = NameObject("/DCTDecode")
        s[NameObject("/ColorSpace")] = NameObject("/DeviceGray" if mode == "L" else "/DeviceRGB")
        s[NameObject("/BitsPerComponent")] = NumberObject(8)
        s[NameObject("/Width")] = NumberObject(size[0])
        s[NameObject("/Height")] = NumberObject(size[1])
        smask = _o(obj.get("/SMask"))
        if isinstance(smask, StreamObject):
            try:
                m = smask.decode_as_image().convert("L").resize(size, Image.LANCZOS)
                ms = DecodedStreamObject()
                ms.set_data(m.tobytes())
                for kk, v in ((("/Type", NameObject("/XObject")), ("/Subtype", NameObject("/Image")), ("/Width", NumberObject(size[0])),
                               ("/Height", NumberObject(size[1])), ("/ColorSpace", NameObject("/DeviceGray")), ("/BitsPerComponent", NumberObject(8)))):
                    ms[NameObject(kk)] = v
                s[NameObject("/SMask")] = w._add_object(ms.flate_encode())
            except Exception:
                pass
        s._data = buf.getvalue()
        w._objects[ref.idnum - 1] = s
        s.indirect_reference = ref
        n += 1
    return n


def fix(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    want = [str(f) for f in (args.get("fixes") or [])]
    if not want:
        raise ValueError(f"Choose fixes from {', '.join(FIXES)}")
    bad = [f for f in want if f not in FIXES]
    if bad:
        raise ValueError(f"Unknown fix {bad[0]}; fixes are {', '.join(FIXES)}")
    r = core.reader(src, passwords)
    if core.signed(r):
        raise ValueError("These fixes rewrite the file, which would break its signatures.")
    w = PdfWriter(clone_from=r)
    done: dict = {}
    if "embed_fonts" in want:
        notes = pdfa.fix_fonts(w, False, done)
        if notes:
            done["substitutions"] = notes
    if "hairlines" in want:
        done["hairline streams"] = _rewrite(w, _thicken)
    if "trim_box" in want:
        n = 0
        for page in w.pages:
            if "/TrimBox" not in page and "/ArtBox" not in page:
                page[NameObject("/TrimBox")] = ArrayObject(FloatObject(v) for v in core.view_box(page))
                n += 1
        done["trim boxes"] = n
    if "scripts" in want:
        pdfa.fix_common(w, 2, "B", done, keep_files=True)
    if "downsample" in want:
        done["pictures downsampled"] = _downsample(w, int(args.get("ppi") or 150))
    if "gray" in want:
        got = colour.convert(w, "gray")
        done["colours to gray"] = got["colours"] + got["images"]
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "fixed": done}


STATUS = {"fail": "Failed", "warn": "Warning", "info": "Note", "pass": "Passed"}


def report(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    _t, data = check(src, args=args, passwords=passwords)
    e = html.escape
    name = str((args or {}).get("name") or "PDF")
    rows = []
    for x in data["checks"]:
        found = "".join(f"<li>{'Page ' + str(f['page']) + ': ' if f.get('page') else ''}{e(f['text'])}</li>" for f in x["findings"][:60])
        rows.append(f"<tr class=\"{x['status']}\"><th scope=\"row\">{e(x['name'])}</th><td>{STATUS[x['status']]}</td><td>{e(x['say'])}{'<ul>' + found + '</ul>' if found else ''}</td></tr>")
    s = data["summary"]
    doc = f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preflight report: {e(name)}</title>
<style>body{{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}}table{{border-collapse:collapse;width:100%}}
th,td{{text-align:left;vertical-align:top;border-bottom:1px solid #ddd;padding:.4rem .5rem}}tr.fail td:nth-child(2){{color:#b00020;font-weight:600}}
tr.warn td:nth-child(2){{color:#8a5a00}}tr.pass td:nth-child(2){{color:#1b6e2a}}ul{{margin:.3rem 0 0;padding-left:1.2rem}}</style></head>
<body>
<h1>Preflight report</h1>
<p>{e(name)} · profile {e(PROFILES[data['profile']])} · checked by formpdf on {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}</p>
<p>{s['fail']} failed, {s['warn']} warnings, {s['info']} notes, {s['pass']} passed.</p>
<table>
<thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
<tbody>
{chr(10).join(rows)}
</tbody>
</table>
</body>
</html>
"""
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(doc)
    return {"pages": 0, "filename": f"{re.sub(r'[^A-Za-z0-9 _.-]+', '', name)[:80] or 'PDF'} preflight report.html"}


actions.register(actions.Action("preflight", "read", "Preflight", words=("preflight", "print check", "press ready", "resolution"), run=check))
actions.register(actions.Action("preflight_fix", "change", "Preflight fixups", "fixed", ("fixups", "embed fonts", "hairlines", "downsample"),
                                fields=(actions.Field("fixes", "Fixups", "multi", ["embed_fonts", "hairlines"], FIXES),), run=fix))
actions.register(actions.Action("preflight_report", "export", "Preflight report", ext=".html", words=("preflight report",), run=report))
