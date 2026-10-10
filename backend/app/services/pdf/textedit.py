import math
from collections import Counter
from dataclasses import dataclass, field

from pypdf.generic import ContentStream, DecodedStreamObject, NameObject

from . import core, items
from .content import interp
from .content.fonts import FontInfo
from .redact import _text_op

ANGLE_TOL = 0.02
BULLETS = "•▪◦·‣∙●"
MAX_PARAS = 600


@dataclass
class _G:
    g: object
    a: float
    size: float
    u0: float
    u1: float
    v: float


@dataclass
class _Line:
    a: float
    size: float
    v: float
    u0: float
    u1: float
    glyphs: list = field(default_factory=list)
    shadows: list = field(default_factory=list)


def _hex(color: tuple) -> str:
    c = [max(0.0, min(1.0, float(v))) for v in color] if color else [0.0]
    if len(c) == 1:
        r = g = b = c[0]
    elif len(c) == 3:
        r, g, b = c
    elif len(c) == 4:
        k = c[3]
        r, g, b = ((1 - c[0]) * (1 - k), (1 - c[1]) * (1 - k), (1 - c[2]) * (1 - k))
    else:
        r = g = b = 0.0
    return "#" + "".join(f"{round(v * 255):02X}" for v in (r, g, b))


def _prep(glyphs) -> list[_G]:
    out = []
    for g in glyphs:
        m = g.m
        if not m or g.where != ():
            continue
        sx, size = math.hypot(m[0], m[1]), math.hypot(m[2], m[3])
        if size < 0.5 or sx < 1e-6:
            continue
        a = math.atan2(m[1], m[0])
        c, s = math.cos(a), math.sin(a)
        ox, oy = g.origin
        u0 = ox * c + oy * s
        v = -ox * s + oy * c
        adv = g.advance * sx / ((g.size or 1.0) * (g.tz or 1.0))
        out.append(_G(g, a, size, u0, u0 + max(adv, 0.0), v))
    return out


def walls(draws) -> list[tuple[float, float, float]]:
    out = []
    for d in draws:
        if d.kind != "path" or d.paint in ("n",):
            continue
        for sub in d.points:
            for (x0, y0), (x1, y1) in zip(sub, sub[1:]):
                if abs(x1 - x0) < 0.5 and abs(y1 - y0) > 2:
                    out.append((x0, min(y0, y1), max(y0, y1)))
    return out


def _walled(a: float, v: float, u_left: float, u_right: float, ws) -> bool:
    if not ws or abs(a) >= ANGLE_TOL or u_right <= u_left:
        return False
    return any(u_left < x < u_right and y0 <= v <= y1 for x, y0, y1 in ws)


def _lines(gs: list[_G], ws=()) -> list[_Line]:
    runs: list[_Line] = []
    for x in gs:
        r = runs[-1] if runs else None
        if (r is not None and abs(x.a - r.a) < ANGLE_TOL and abs(x.v - r.v) < 0.3 * max(r.size, x.size)
                and -0.5 * r.size <= x.u0 - r.u1 <= (1.5 if x.g.op == r.glyphs[-1].g.op else 0.6) * r.size
                and not _walled(x.a, x.v, r.u1, x.u0, ws)):
            r.glyphs.append(x)
            r.u1 = max(r.u1, x.u1)
            r.size = max(r.size, x.size) if x.g.text.strip() else r.size
        else:
            runs.append(_Line(x.a, x.size, x.v, x.u0, x.u1, [x]))
    runs.sort(key=lambda r: (round(r.a, 2), -r.v, r.u0))
    lines: list[_Line] = []
    for r in runs:
        best = None
        for ln in reversed(lines[-12:]):
            if abs(ln.a - r.a) >= ANGLE_TOL or abs(ln.v - r.v) >= 0.3 * max(ln.size, r.size):
                continue
            if r.u0 - ln.u1 > 0.6 * ln.size or ln.u0 - r.u1 > 0.6 * ln.size:
                continue
            if _walled(r.a, r.v, ln.u1, r.u0, ws) or _walled(r.a, r.v, r.u1, ln.u0, ws):
                continue
            best = ln
            break
        if best is None:
            lines.append(r)
            continue
        overlap = min(best.u1, r.u1) - max(best.u0, r.u0)
        text_r = "".join(x.g.text for x in r.glyphs).strip()
        if overlap > 0.6 * (r.u1 - r.u0) and text_r and text_r in "".join(x.g.text for x in best.glyphs):
            best.shadows.extend(r.glyphs)
            continue
        if overlap > 0.3 * min(best.size, r.size):
            lines.append(r)
            continue
        best.glyphs.extend(r.glyphs)
        best.u0, best.u1 = min(best.u0, r.u0), max(best.u1, r.u1)
        best.size = max(best.size, r.size)
    for ln in lines:
        ln.glyphs.sort(key=lambda x: x.u0)
    return [ln for ln in lines if any(x.g.text.strip() for x in ln.glyphs)]


def _line_runs(ln: _Line, fonts: dict) -> list[dict]:
    runs: list[dict] = []
    prev = None
    for x in ln.glyphs:
        t = x.g.text
        if not t:
            t = "�"
        f = fonts.get(x.g.font)
        style = (bool(f and f.bold), bool(f and f.italic), _hex(x.g.color))
        if prev is not None and t != " " and x.u0 - prev.u1 > 0.15 * ln.size and runs and not runs[-1]["t"].endswith(" "):
            runs[-1]["t"] += " "
        if t == " " and runs and runs[-1]["t"].endswith(" "):
            prev = x
            continue
        if runs and runs[-1]["_s"] == style:
            runs[-1]["t"] += t
        elif t.strip() == "" and runs:
            runs[-1]["t"] += t
        else:
            runs.append({"t": t, "_s": style})
        prev = x
    if runs:
        runs[0]["t"] = runs[0]["t"].lstrip()
        runs[-1]["t"] = runs[-1]["t"].rstrip()
    return [r for r in runs if r["t"]]


def _same_para(p: list[_Line], ln: _Line) -> bool:
    last = p[-1]
    if abs(ln.a - last.a) >= ANGLE_TOL:
        return False
    size = last.size
    if not 0.93 <= ln.size / size <= 1.07:
        return False
    gap = last.v - ln.v
    if not 0.9 * size <= gap <= 1.75 * size:
        return False
    if len(p) > 1 and abs(gap - (p[0].v - p[1].v)) > 0.15 * (p[0].v - p[1].v):
        return False
    overlap = min(last.u1, ln.u1) - max(last.u0, ln.u0)
    if overlap < 0.3 * min(last.u1 - last.u0, ln.u1 - ln.u0):
        return False
    if abs(ln.u0 - p[0].u0) < 0.5 * size:
        return True
    tol = 0.3 * size
    return abs(ln.u1 - last.u1) < tol or abs((ln.u0 + ln.u1) / 2 - (last.u0 + last.u1) / 2) < tol


def _align(p: list[_Line]) -> str:
    if len(p) < 2:
        return "left"
    tol = max(1.0, 0.25 * p[0].size)
    lefts = all(abs(ln.u0 - p[0].u0) < tol for ln in p)
    rights = all(abs(ln.u1 - p[0].u1) < tol for ln in p[:-1])
    if lefts and rights and len(p) > 2:
        return "justify"
    if lefts:
        return "left"
    if all(abs(ln.u1 - p[0].u1) < tol for ln in p):
        return "right"
    if all(abs((ln.u0 + ln.u1) / 2 - (p[0].u0 + p[0].u1) / 2) < tol for ln in p):
        return "center"
    return "left"


def _join(lines_runs: list[list[dict]]) -> list[dict]:
    out: list[dict] = []
    for runs in lines_runs:
        if not runs:
            continue
        if out:
            tail = out[-1]["t"]
            head = runs[0]["t"]
            if tail.endswith("-") and len(tail) > 1 and tail[-2].isalpha() and head[:1].islower():
                out[-1]["t"] = tail[:-1]
            elif not tail.endswith(" "):
                out[-1]["t"] = tail + " "
        for r in runs:
            if out and out[-1]["_s"] == r["_s"]:
                out[-1]["t"] += r["t"]
            else:
                out.append(dict(r))
    return out


def _family(f: FontInfo | None) -> str:
    if f is None:
        return "sans"
    return "mono" if f.mono else "serif" if f.serif else "sans"


def _usable(f: FontInfo | None, text: str) -> bool:
    if f is None or f.type3 or f.approx or not (f.embedded or f.standard):
        return False
    return f.encode("".join(ch for ch in text if not ch.isspace())) is not None


def detect(page, w, content=None) -> list[dict]:
    content = content or interp.walk(page, w, forms=False)
    fonts = {f.key: f for f in content.fonts.values()}
    gs = _prep(content.glyphs)
    lines = _lines([x for x in gs if x.g.render != 3], walls(content.draws))
    hidden = _lines([x for x in gs if x.g.render == 3])
    order = sorted(lines, key=lambda ln: (round(ln.a, 2), -ln.v, ln.u0))
    paras: list[list[_Line]] = []
    for ln in order:
        for p in reversed(paras[-6:]):
            if _same_para(p, ln):
                p.append(ln)
                break
        else:
            paras.append([ln])
    vx0, _, _, vy1 = core.view_box(page)
    out = []
    for p in paras[:MAX_PARAS]:
        glyphs = [x for ln in p for x in ln.glyphs]
        counts = Counter(x.g.font for x in glyphs if x.g.text.strip())
        key_font = counts.most_common(1)[0][0] if counts else glyphs[0].g.font
        f = fonts.get(key_font)
        size = Counter(round(x.size, 1) for x in glyphs if x.g.text.strip()).most_common(1)[0][0]
        color = Counter(_hex(x.g.color) for x in glyphs if x.g.text.strip()).most_common(1)[0][0]
        runs = _join([_line_runs(ln, fonts) for ln in p])
        bullet = bool(runs) and runs[0]["t"][:1] in BULLETS and len("".join(r["t"] for r in runs).strip()) > 1
        if bullet:
            runs[0]["t"] = runs[0]["t"][1:].lstrip()
            runs = [r for r in runs if r["t"]]
        text = "".join(r["t"] for r in runs)
        editable = "�" not in text
        ob = (bool(f and f.bold), bool(f and f.italic))
        orig = _usable(f, text) and editable
        lh = round(max(0.8, min(4.0, (p[0].v - p[1].v) / size)), 3) if len(p) > 1 else 1.2
        if bullet:
            start = next((x.u0 for x in p[0].glyphs if x.g.text.strip() and x.g.text not in BULLETS), p[0].u0 + 1.6 * size)
        para = {"align": _align(p), "list": "bullet" if bullet else "none", "level": 0,
                **({"hang": round(max(0.3, (start - p[0].u0) / size), 3)} if bullet else {}),
                "runs": [{"t": r["t"], **({"b": True} if r["_s"][0] else {}), **({"i": True} if r["_s"][1] else {}),
                          **({"color": r["_s"][2]} if r["_s"][2] != color else {})} for r in runs]}
        font = {"family": _family(f), "size": size, "color": color, "lineHeight": lh}
        alpha = min(x.g.alpha for x in glyphs)
        if alpha < 0.999:
            font["opacity"] = round(alpha, 3)
        if orig:
            font["orig"] = {"name": f.plain[:80], "b": ob[0], "i": ob[1]}
        a = p[0].a
        c, s = math.cos(a), math.sin(a)
        left, right = min(ln.u0 for ln in p), max(ln.u1 for ln in p)
        wd = right - left + 0.02 * size
        probe = {"font": font, "_fi": f if orig else None}
        base = items.baseline(probe)
        h = len(p) * lh * size
        vt = p[0].v + base
        uc, vc = left + wd / 2, vt - h / 2
        cx, cy = uc * c - vc * s, uc * s + vc * c
        first = min(glyphs, key=lambda x: (x.g.op, x.g.seq))
        shadow = [x for ln in p for x in ln.shadows]
        for hl in hidden:
            if any(abs(hl.a - ln.a) < ANGLE_TOL and abs(hl.v - ln.v) < 0.5 * ln.size
                   and min(hl.u1, ln.u1) - max(hl.u0, ln.u0) > 0.5 * min(hl.u1 - hl.u0, ln.u1 - ln.u0) for ln in p):
                shadow += hl.glyphs + hl.shadows
        out.append({
            "key": f"{first.g.op}.{first.g.seq}", "page": None, "text": text, "editable": editable,
            "x": round(cx - vx0 - wd / 2, 3), "y": round(vy1 - cy - h / 2, 3), "w": round(wd, 3), "h": round(h, 3),
            "rot": round((-math.degrees(a) + 180) % 360 - 180, 3), "font": font, "paras": [para],
            "fontName": f.plain if f else "", "fit": len(p) == 1 and para["align"] == "left", "_glyphs": glyphs + shadow, "_font": key_font, "_lines": len(p),
        })
    return out


def public(p: dict, n: int) -> dict:
    return {k: v for k, v in {**p, "page": n}.items() if not k.startswith("_")}


def listing(pg: items.Page) -> list[dict]:
    ops, _ = pg.base_ops()
    it = interp.Interpreter(pg.w, forms=False)
    it.run(ops, pg.res, interp.IDENTITY, (), 0, set())
    return [public(p, pg.n) for p in detect(pg.page, pg.w, it.out)]


def convert_many(pg: items.Page, keys: list[str]) -> tuple[dict[str, dict], dict[int, int]]:
    pg.prep()
    ops, spans = pg.base_ops()
    run = interp.Interpreter(pg.w, forms=False)
    run.run(ops, pg.res, interp.IDENTITY, (), 0, set())
    found = {p["key"]: p for p in detect(pg.page, pg.w, run.out)}
    chosen = []
    for key in dict.fromkeys(keys):
        para = found.get(key)
        if para is None:
            raise ValueError(f"There is no text at that place on page {pg.n}; list the page's text again")
        if not para["editable"]:
            raise ValueError("This text has no character mapping in the PDF, so it cannot be edited as text")
        chosen.append(para)
    by_op: dict[int, set[int]] = {}
    for para in chosen:
        for x in para["_glyphs"]:
            by_op.setdefault(x.g.op, set()).add(x.g.seq)
    per_op: dict[int, list] = {}
    for g in run.out.glyphs:
        if g.op in by_op:
            per_op.setdefault(g.op, []).append(g)
    shift: dict[int, int] = {}
    offset = 0
    for pos, start, n in spans:
        hit = [k for k in by_op if start <= k < start + n]
        if not hit:
            for k in range(start, start + n):
                shift[k] = k + offset
            continue
        frag = ops[start:start + n]
        new_ops: list = []
        for local, (operands, op) in enumerate(frag):
            k = start + local
            shift[k] = start + offset + len(new_ops)
            if k in by_op and op in (b"Tj", b"TJ", b"'", b'"'):
                new_ops.extend(_text_op(operands, op, sorted(per_op.get(k, []), key=lambda g: g.seq), by_op[k]))
            else:
                new_ops.append((operands, op))
        offset += len(new_ops) - n
        cs = ContentStream(None, pg.w)
        cs.operations = new_ops
        ref = pg.w._add_object(DecodedStreamObject())
        ref.get_object().set_data(cs.get_data())
        pg.arr[pos] = ref
    made: dict[str, dict] = {}
    fonts = pg.res.get("/Font")
    fonts = fonts.get_object() if fonts is not None else None
    for para in chosen:
        font_ref = None
        if para["font"].get("orig"):
            name = NameObject("/" + para["_font"])
            font_ref = fonts.raw_get(name) if fonts is not None and name in fonts else None
            if font_ref is None:
                para["font"].pop("orig")
        new = {"v": 1, "id": items._new_id(), "kind": "text", "page": pg.n, "x": para["x"], "y": para["y"], "w": para["w"], "h": para["h"],
               "rot": para["rot"], "auto": True, "font": para["font"], "paras": para["paras"]}
        if para["_lines"] == 1 and para["paras"][0]["align"] == "left":
            new["fit"] = True
        if font_ref is not None:
            new["_oref"] = font_ref
        pg.write(new)
        made[para["key"]] = new
    return made, shift


def convert(pg: items.Page, key: str) -> dict:
    return convert_many(pg, [key])[0][key]
