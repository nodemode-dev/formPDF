import base64
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from app.core import config
from app.services.pdf import actions, core

PROVIDERS = ("off", "agent", "anthropic", "openai", "local")
DEFAULTS = {"anthropic": {"model": "claude-sonnet-5-5", "base": "https://api.anthropic.com"},
            "openai": {"model": "gpt-4.1-mini", "base": "https://api.openai.com/v1", "imageModel": "gpt-image-1"},
            "local": {"model": "llama3.1", "base": "http://127.0.0.1:11434/v1", "imageBase": "http://127.0.0.1:7860"}}
LABEL = {"off": "Off", "agent": "Your agent (Claude Code, Codex or Cursor)", "anthropic": "Anthropic", "openai": "OpenAI", "local": "A model on this computer"}
BUDGET = 150_000
TIMEOUT = 180
MAX_SLIDES = 30
NOT_SET = ("The AI tools are off. Choose a provider in Preferences > AI: your agent, Anthropic or OpenAI with your own key, "
           "or a model running on this computer.")
SYSTEM = ("You answer questions about one or more documents. The documents are given page by page between <page n=\"N\"> tags. "
          "Use only what the pages say. After every statement that comes from the documents, cite the page as [p. N]; when you quote, quote "
          "exactly, in double quotes, followed by its page, like \"quoted words\" [p. N]. If the pages do not answer the question, say so plainly. "
          "Write plain text without markdown headings.")
_lock = threading.Lock()
PENDING: dict[str, dict] = {}


def _keys_path() -> Path:
    return config.data_dir() / "ai-keys.json"


def _keys() -> dict:
    try:
        got = json.loads(_keys_path().read_text(encoding="utf-8"))
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def set_key(provider: str, key: str | None) -> None:
    if provider not in ("anthropic", "openai", "local"):
        raise ValueError("Only Anthropic, OpenAI and a local server take a key")
    with _lock:
        keys = _keys()
        if key:
            keys[provider] = str(key).strip()[:400]
        else:
            keys.pop(provider, None)
        p = _keys_path()
        tmp = p.with_suffix(".tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(keys, fh)
        tmp.replace(p)
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass


def settings() -> dict:
    s = config.read_settings().get("ai")
    s = s if isinstance(s, dict) else {}
    provider = s.get("provider") if s.get("provider") in PROVIDERS else "off"
    d = DEFAULTS.get(provider, {})
    keys = _keys()
    return {"provider": provider, "model": str(s.get("model") or d.get("model", "")), "base": str(s.get("base") or d.get("base", "")),
            "imageModel": str(s.get("imageModel") or d.get("imageModel", "")), "imageBase": str(s.get("imageBase") or d.get("imageBase", "")),
            "keys": {p: bool(keys.get(p)) for p in ("anthropic", "openai", "local")}, "label": LABEL[provider], "defaults": DEFAULTS}


def save_settings(patch: dict) -> dict:
    cur = config.read_settings().get("ai")
    cur = dict(cur) if isinstance(cur, dict) else {}
    if "provider" in patch:
        if patch["provider"] not in PROVIDERS:
            raise ValueError("The provider is off, agent, anthropic, openai or local")
        if patch["provider"] != cur.get("provider"):
            for k in ("model", "base", "imageModel", "imageBase"):
                cur.pop(k, None)
        cur["provider"] = patch["provider"]
    for k in ("model", "base", "imageModel", "imageBase"):
        if k in patch:
            v = str(patch[k] or "").strip()[:300]
            if v and k in ("base", "imageBase") and not re.match(r"https?://", v):
                raise ValueError("A server address starts with https:// or http://")
            if v:
                cur[k] = v
            else:
                cur.pop(k, None)
    config.write_settings({"ai": cur})
    if "key" in patch and cur.get("provider") in ("anthropic", "openai", "local"):
        set_key(cur["provider"], patch.get("key") or None)
    return settings()


def network_entry() -> dict:
    s = settings()
    p = s["provider"]
    if p == "off":
        return {"id": "ai", "name": "AI tools", "state": "off", "note": "Off. When you choose a provider in Preferences > AI, the pages you ask about are sent to it."}
    if p == "agent":
        return {"id": "ai", "name": "AI tools (your agent)", "state": "local", "note": "Questions wait in formpdf until your agent answers them through MCP; formpdf itself sends nothing."}
    host = re.sub(r"^https?://([^/]+).*$", r"\1", s["base"])
    local = bool(re.match(r"(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$", host))
    return {"id": "ai", "name": f"AI tools ({LABEL[p]})", "state": "local" if local else "on",
            "note": f"Only when you use an AI tool: the text of the pages you ask about goes to {host}{' on this computer' if local else ''}."}


def _post(url: str, body: dict, headers: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": f"formpdf/{config.VERSION}", **headers})
    host = url.split("/")[2] if "//" in url else ""
    direct = bool(re.match(r"(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$", host))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if direct else urllib.request.build_opener()
    try:
        with opener.open(req, timeout=TIMEOUT) as res:
            raw = res.read().decode("utf-8", "replace")
        try:
            return json.loads(raw)
        except ValueError:
            raise ValueError(f"The AI provider at {host} answered with something other than JSON") from None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        try:
            j = json.loads(detail)
            detail = str((j.get("error") or {}).get("message") or j.get("message") or detail) if isinstance(j, dict) else detail
        except ValueError:
            pass
        raise ValueError(f"The AI provider refused the request ({e.code}): {detail[:300]}") from None
    except urllib.error.URLError as e:
        raise ValueError(f"Could not reach the AI provider at {url.split('/')[2]}: {e.reason}") from None
    except TimeoutError:
        raise ValueError(f"The AI provider did not answer within {TIMEOUT} seconds") from None


def chat(prompt: str, *, system: str = SYSTEM, max_tokens: int = 2000) -> str:
    s = settings()
    p = s["provider"]
    key = _keys().get(p, "")
    if p == "off":
        raise ValueError(NOT_SET)
    if p == "agent":
        raise ValueError("The AI provider is your agent; ask from the Assistant tab and your agent answers there")
    if p == "anthropic":
        if not key:
            raise ValueError("Add your Anthropic API key in Preferences > AI")
        j = _post(s["base"].rstrip("/") + "/v1/messages", {"model": s["model"], "max_tokens": max_tokens, "system": system,
                                                            "messages": [{"role": "user", "content": prompt}]},
                  {"x-api-key": key, "anthropic-version": "2023-06-01"})
        return "".join(part.get("text", "") for part in j.get("content") or [] if part.get("type") == "text").strip()
    if p == "openai" and not key:
        raise ValueError("Add your OpenAI API key in Preferences > AI")
    j = _post(s["base"].rstrip("/") + "/chat/completions", {"model": s["model"], "max_tokens": max_tokens,
                                                            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]},
              {"Authorization": f"Bearer {key}"} if key else {})
    try:
        return str(j["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError):
        raise ValueError("The AI provider answered in a form formpdf does not read") from None


def image(prompt: str, width: int = 1024, height: int = 1024) -> bytes:
    s = settings()
    p = s["provider"]
    if p == "openai":
        key = _keys().get("openai", "")
        if not key:
            raise ValueError("Add your OpenAI API key in Preferences > AI")
        size = "1024x1024" if abs(width - height) < 100 else ("1536x1024" if width > height else "1024x1536")
        j = _post(s["base"].rstrip("/") + "/images/generations", {"model": s["imageModel"] or "gpt-image-1", "prompt": prompt, "n": 1, "size": size},
                  {"Authorization": f"Bearer {key}"})
        item = (j.get("data") or [{}])[0]
        if item.get("b64_json"):
            return base64.b64decode(item["b64_json"])
        raise ValueError("The AI provider returned no picture")
    if p == "local":
        base = s["imageBase"] or DEFAULTS["local"]["imageBase"]
        j = _post(base.rstrip("/") + "/sdapi/v1/txt2img", {"prompt": prompt, "width": int(width) // 64 * 64, "height": int(height) // 64 * 64, "steps": 25}, {})
        imgs = j.get("images") or []
        if not imgs:
            raise ValueError("The picture server returned no picture")
        return base64.b64decode(str(imgs[0]).split(",")[-1])
    if p == "off":
        raise ValueError(NOT_SET)
    raise ValueError(f"{LABEL[p]} does not make pictures here. Choose OpenAI, or a picture server on this computer (AUTOMATIC1111 or a compatible one), in Preferences > AI")


def pages_text(path, pages=None, passwords: list[str] | None = None, budget: int = BUDGET, label: str = "") -> tuple[str, list[dict]]:
    got = core.extract_text(path, pages, passwords)
    parts, used = [], 0
    for p in got:
        t = re.sub(r"\n{3,}", "\n\n", p["text"])
        if used + len(t) > budget:
            t = t[:max(0, budget - used)]
        used += len(t)
        parts.append(f"<page n=\"{p['page']}\"{f' doc=' + json.dumps(label) if label else ''}>\n{t}\n</page>")
        if used >= budget:
            break
    if not any(p["text"].strip() for p in got):
        raise ValueError("This PDF has no text to read. Make it searchable first (Convert > Make searchable)")
    return "\n".join(parts), got


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[‘’]", "'", re.sub(r"[“”]", '"', s))).strip().lower()


def citations(answer: str, texts: list[dict]) -> list[dict]:
    by_page = {p["page"]: _norm(p["text"]) for p in texts}
    out = []
    for m in re.finditer(r"(?:[\"“]([^\"”]{3,400})[\"”]\s*)?\[p(?:p)?\.?\s*(\d+)(?:\s*[-–]\s*(\d+))?\]", answer):
        page = int(m.group(2))
        quote = (m.group(1) or "").strip()
        ok = page in by_page and (not quote or _norm(quote) in by_page[page])
        if quote and not ok:
            hit = next((n for n, t in by_page.items() if _norm(quote) in t), None)
            if hit is not None:
                page, ok = hit, True
        out.append({"page": page, "quote": quote, "verified": ok, "at": m.start(), "end": m.end()})
    return out


def ask(src, out=None, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    args = args or {}
    q = re.sub(r"\s+", " ", str(args.get("question") or "")).strip()[:4000]
    if not q:
        raise ValueError("Ask a question")
    body, texts = pages_text(src, pages, passwords)
    answer = chat(f"{body}\n\nQuestion: {q}")
    cites = citations(answer, texts)
    return answer, {"answer": answer, "citations": cites, "provider": settings()["provider"]}


LENGTHS = {"short": "in three to five sentences", "medium": "in about two paragraphs followed by up to eight key points", "long": "section by section, with key points under each"}


def summary(src, out=None, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    args = args or {}
    how = LENGTHS.get(str(args.get("length") or "medium"), LENGTHS["medium"])
    body, texts = pages_text(src, pages, passwords)
    answer = chat(f"{body}\n\nSummarise these pages {how}. Cite pages for each point.", max_tokens=3000)
    return answer, {"answer": answer, "citations": citations(answer, texts), "provider": settings()["provider"]}


def _sources(src, args: dict, passwords) -> tuple[str, list[str]]:
    from app.services import office

    parts, names = [], []
    paths = [src] if src else []
    paths += [Path(str(p)).expanduser() for p in (args.get("paths") or [])][:10]
    budget = BUDGET // max(1, len(paths))
    for i, p in enumerate(paths):
        name = Path(str(p)).name
        data_path = p
        tmp = None
        if office.is_office(name):
            tmp = config.data_dir() / f".ai-{uuid.uuid4().hex[:8]}.pdf"
            tmp.write_bytes(office.convert(Path(p).read_bytes(), name))
            data_path = tmp
        elif str(p).lower().endswith((".txt", ".md")):
            text = Path(p).read_text(encoding="utf-8", errors="replace")[:budget]
            parts.append(f"<page n=\"1\" doc={json.dumps(name)}>\n{text}\n</page>")
            names.append(name)
            continue
        try:
            body, _ = pages_text(data_path, None, passwords if i == 0 else None, budget, name)
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)
        parts.append(body)
        names.append(name)
    return "\n".join(parts), names


def outline(src, out=None, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    args = args or {}
    n = max(3, min(MAX_SLIDES, int(args.get("slides") or 8)))
    brief = re.sub(r"\s+", " ", str(args.get("brief") or "")).strip()[:2000]
    body, names = _sources(src, args, passwords)
    prompt = (f"{body}\n\nDraft a presentation of about {n} slides from these documents{f' for this brief: {brief}' if brief else ''}. "
              "Answer with JSON only, no other text: {\"title\": string, \"subtitle\": string, \"slides\": [{\"title\": string, \"bullets\": [string, at most 6, "
              "each under 18 words], \"notes\": string, \"sources\": [{\"doc\": string, \"page\": number}]}]}.")
    raw = chat(prompt, system="You draft clear, factual presentation outlines from documents. You answer with valid JSON only.", max_tokens=6000)
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        data = json.loads(m.group(0) if m else raw)
    except ValueError:
        raise ValueError("The AI provider did not return an outline formpdf can read; try again") from None
    clean = clean_outline(data)
    lines = [clean["title"]] + [f"{i + 1}. {s['title']}" for i, s in enumerate(clean["slides"])]
    return "\n".join(lines), {"outline": clean, "sources": names}


def clean_outline(data) -> dict:
    data = data if isinstance(data, dict) else {}
    slides = []
    for s in (data.get("slides") or [])[:MAX_SLIDES]:
        if not isinstance(s, dict):
            continue
        title = re.sub(r"\s+", " ", str(s.get("title") or "")).strip()[:200]
        bullets = [re.sub(r"\s+", " ", str(b)).strip()[:300] for b in (s.get("bullets") or []) if str(b).strip()][:8]
        if not title and not bullets:
            continue
        srcs = []
        for r in (s.get("sources") or [])[:6]:
            if isinstance(r, dict):
                try:
                    srcs.append({"doc": str(r.get("doc") or "")[:200], "page": int(r.get("page"))})
                except (TypeError, ValueError):
                    continue
        slides.append({"title": title, "bullets": bullets, "notes": str(s.get("notes") or "")[:3000], "sources": srcs})
    if not slides:
        raise ValueError("The outline has no slides")
    return {"title": str(data.get("title") or "Presentation")[:200], "subtitle": str(data.get("subtitle") or "")[:300], "slides": slides}


def deck(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    from pptx import Presentation
    from pptx.util import Emu, Pt

    args = args or {}
    data = clean_outline(args["outline"]) if isinstance(args.get("outline"), dict) else outline(src, args=args, passwords=passwords)[1]["outline"]
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(12192000), Emu(6858000)
    first = prs.slides.add_slide(prs.slide_layouts[0])
    first.shapes.title.text = data["title"]
    if len(first.placeholders) > 1:
        first.placeholders[1].text = data["subtitle"]
    for s in data["slides"]:
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = s["title"]
        body = slide.placeholders[1].text_frame
        body.clear()
        for k, b in enumerate(s["bullets"]):
            para = body.paragraphs[0] if k == 0 else body.add_paragraph()
            para.text = b
            para.font.size = Pt(22 if len(s["bullets"]) <= 4 else 18)
        notes = s["notes"]
        if s["sources"]:
            notes = (notes + "\n\n" if notes else "") + "Sources: " + "; ".join(f"{r['doc'] or 'document'} p. {r['page']}" for r in s["sources"])
        if notes:
            slide.notes_slide.notes_text_frame.text = notes
    prs.core_properties.title = data["title"]
    prs.save(str(out))
    return {"slides": len(data["slides"]) + 1}


def picture(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    args = args or {}
    prompt = re.sub(r"\s+", " ", str(args.get("prompt") or "")).strip()[:3000]
    if not prompt:
        raise ValueError("Describe the picture to make")
    r = core.reader(src, passwords)
    page = max(1, min(len(r.pages), int(args.get("page") or 1)))
    x0, y0, x1, y1 = core.view_box(r.pages[page - 1])
    W, H = x1 - x0, y1 - y0
    w = float(args.get("w") or W * 0.5)
    h = float(args.get("h") or w)
    data = image(prompt, 1024 if w >= h else 768, 1024 if h >= w else 768)
    x = float(args.get("x") if args.get("x") is not None else (W - w) / 2)
    y = float(args.get("y") if args.get("y") is not None else (H - h) / 2)
    item = {"kind": "picture", "page": page, "x": x, "y": y, "w": w, "h": h, "data": "data:image/png;base64," + base64.b64encode(data).decode("ascii")}
    res = actions.get("edit_items").run(src, out, args={"add": [item]}, passwords=passwords)
    return {**(res if isinstance(res, dict) else {}), "pages": core.page_count(out), "prompt": prompt}


def post_question(doc_id: str, name: str, question: str, kind: str = "ask") -> dict:
    qid = uuid.uuid4().hex[:10]
    item = {"id": qid, "doc": doc_id, "name": name, "question": question[:4000], "kind": kind, "at": time.time(), "answer": None}
    with _lock:
        for k in [k for k, v in PENDING.items() if time.time() - v["at"] > 3600]:
            PENDING.pop(k, None)
        PENDING[qid] = item
    return item


def waiting() -> list[dict]:
    with _lock:
        return [dict(v) for v in PENDING.values() if v["answer"] is None]


def give_answer(qid: str, text: str, texts: list[dict] | None = None) -> dict:
    with _lock:
        item = PENDING.get(qid)
        if item is None:
            raise ValueError("There is no waiting question with that id")
        item["answer"] = text
    return {**item, "citations": citations(text, texts or [])}


actions.register(actions.Action("ai_ask", "read", "Ask about this PDF (AI)", words=("ai assistant", "ask", "question", "chat with pdf"),
                                fields=(actions.Field("question", "Question"),), run=ask))
actions.register(actions.Action("ai_summary", "read", "Summarise (AI)", words=("ai summary", "summarise", "summarize", "tl;dr"),
                                fields=(actions.Field("length", "Length", "select", "medium", ("short", "medium", "long")),), run=summary))
actions.register(actions.Action("ai_outline", "read", "Draft a presentation outline (AI)", words=("ai presentation", "outline", "deck"),
                                fields=(actions.Field("slides", "Slides", "number", 8), actions.Field("brief", "Brief")), run=outline))
actions.register(actions.Action("ai_deck", "export", "Generate a presentation (AI)", ext=".pptx", words=("ai presentation", "generate deck", "pdf spaces"),
                                fields=(actions.Field("slides", "Slides", "number", 8), actions.Field("brief", "Brief")), run=deck))
actions.register(actions.Action("ai_picture", "change", "Generate a picture (AI)", "picture", ("ai image", "generate image", "generate picture"),
                                fields=(actions.Field("prompt", "Describe the picture"), actions.Field("page", "Page", "number", 1)), run=picture))
