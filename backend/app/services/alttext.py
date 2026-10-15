import io
import json
import re

from app.services import ai
from app.services.pdf import access, actions, core

MAX_FIGURES = 40
SYSTEM = ("You write alternate text for figures in documents, for people using screen readers. Say what the figure shows and, from the "
          "context, why it is there, in one or two plain sentences under 200 characters. Do not start with 'Image of' or 'Picture of'. Read out "
          "any words that matter in the figure. If the figure is purely decorative (a rule, a background, an ornament), answer DECORATIVE.")


def _clean(text: str) -> tuple[str, bool]:
    t = re.sub(r"\s+", " ", str(text or "")).strip().strip('"').strip()
    if re.fullmatch(r"(?i)decorative\.?", t):
        return "", True
    t = re.sub(r"(?i)^(an?\s+)?(image|picture|photo|graphic)\s+(of|showing)\s+", "", t)
    return (t[:1].upper() + t[1:])[:400], False


@core.serial
def _crops(path, figs: list[dict], passwords) -> dict[str, bytes]:
    doc = core.pdfium_doc(path, passwords)
    out = {}
    try:
        for f in figs:
            b = f["box"]
            scale = max(0.5, min(4.0, 768 / max(1.0, b["w"], b["h"])))
            img = core.render_pil(doc[f["page"] - 1], scale)
            x0, y0 = int(b["x"] * scale), int(b["y"] * scale)
            crop = img.crop((max(0, x0), max(0, y0), min(img.width, x0 + int(b["w"] * scale) + 1), min(img.height, y0 + int(b["h"] * scale) + 1)))
            buf = io.BytesIO()
            crop.convert("RGB").save(buf, "PNG")
            out[f["id"]] = buf.getvalue()
    finally:
        doc.close()
    return out


@core.serial
def _context(path, figs: list[dict], passwords) -> dict[str, str]:
    doc = core.pdfium_doc(path, passwords)
    r = core.reader(path, passwords)
    out = {}
    try:
        for f in figs:
            b = f["box"]
            vx0, _vy0, _vx1, vy1 = core.view_box(r.pages[f["page"] - 1])
            tp = doc[f["page"] - 1].get_textpage()
            left, right = vx0 + b["x"] - 40, vx0 + b["x"] + b["w"] + 40
            top, bottom = vy1 - b["y"] + 90, vy1 - b["y"] - b["h"] - 90
            try:
                t = tp.get_text_bounded(left=left, bottom=bottom, right=right, top=top)
            except Exception:
                t = ""
            out[f["id"]] = re.sub(r"\s+", " ", t).strip()[:600]
    finally:
        doc.close()
    return out


def drafts(src, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    args = args or {}
    _text, got = access.structure(src, passwords=passwords, args={"only": "figures"})
    if not got.get("tagged"):
        raise ValueError("Tag the PDF first (Accessibility > Tags); figures are found while tagging")
    want = {str(i) for i in args.get("ids") or []}
    figs = [f for f in got["figures"] if f.get("box") and (str(f["id"]) in want if want else not f.get("alt"))][:MAX_FIGURES]
    if not figs:
        return "Every figure already has alternate text.", {"drafts": [], "waiting": False}
    context = _context(src, figs, passwords)
    s = ai.settings()
    if s["provider"] == "agent":
        listing = "\n".join(f"- figure {f['id']}: page {f['page']}, at x {round(f['box']['x'])} y {round(f['box']['y'])} pt from the top left, "
                            f"{round(f['box']['w'])} by {round(f['box']['h'])} pt; text around it: {context.get(f['id'], '')[:240]!r}" for f in figs)
        question = (f"ALT TEXT. Write alternate text for {len(figs)} figure{'s' if len(figs) != 1 else ''}. Look at each one (render_pages shows the page), "
                    "then answer_question with JSON only, mapping each figure id to its alternate text (one or two sentences under 200 characters, "
                    "no 'image of') or to DECORATIVE, like {\"0.3\": \"Bar chart of ...\"}.\n" + listing)
        return question[:300], {"waiting": True, "question": question[:4000], "figures": [{"id": f["id"], "page": f["page"]} for f in figs]}
    crops = _crops(src, figs, passwords)
    out = []
    for f in figs:
        ctx = context.get(f["id"], "")
        prompt = f"Write the alternate text for this figure from page {f['page']}." + (f" Text near it on the page: {ctx}" if ctx else "")
        alt, deco = _clean(ai.describe(crops[f["id"]], prompt, system=SYSTEM))
        out.append({"id": f["id"], "page": f["page"], "alt": alt, "decorative": deco})
    lines = [f"{len(out)} draft{'s' if len(out) != 1 else ''} from {s['label']}; review each before saving."] + [
        f"figure {d['id']} (p{d['page']}): {'decorative' if d['decorative'] else d['alt']}" for d in out]
    return "\n".join(lines), {"drafts": out, "waiting": False, "provider": s["provider"]}


def parse_answer(answer: str) -> list[dict]:
    m = re.search(r"\{.*\}", answer or "", re.S)
    try:
        data = json.loads(m.group(0) if m else answer)
    except ValueError:
        raise ValueError("Your agent's answer is not the JSON formpdf asked for") from None
    out = []
    for k, v in (data.items() if isinstance(data, dict) else []):
        alt, deco = _clean(str(v))
        out.append({"id": str(k), "alt": alt, "decorative": deco})
    return out


actions.register(actions.Action("alt_drafts", "read", "Draft alternate text for figures (AI)", words=("alt text", "describe pictures", "ai alt text", "image descriptions"),
                                fields=(actions.Field("ids", "Figure ids", hint="Leave empty for every figure without alternate text"),), run=drafts))
