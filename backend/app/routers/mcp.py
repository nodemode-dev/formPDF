import asyncio
import base64
import json
import shutil
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response

from app.core import config
from app.routers import pdf as routes
from app.routers.live import local_origin
from app.services import bridge
from app.services import pdf as pdfsvc
from app.services.pdf import actions, docs

router = APIRouter()
VERSIONS = ["2026-07-28", "2025-11-25"]
LEGACY = ["2025-06-18", "2025-03-26", "2024-11-05"]
TURN_GAP = 90.0
SERVER = {"name": "formpdf", "title": "formpdf", "version": config.VERSION}
CAPS = {"tools": {}, "resources": {}, "prompts": {}}
INSTRUCTIONS = ("formpdf edits PDFs on this computer; the person watches the open PDF in the formpdf window. "
                "Workflow: get_context; open_pdf {path} to put a PDF in the window (or pass path to a pdf action to work on a file); "
                "pdf {action} for the job: without path it changes the open PDF live as your turn, with path it writes a new file; "
                "render_pages to look at the result; extract for text, tables or pictures; save {path} when the person wants a file; "
                "undo reverts your last turn. Actions and arguments: resource formpdf://guide.")
READ_ACTIONS = actions.READ
CHANGE_ACTIONS = actions.CHANGE
EXPORT_ACTIONS = actions.EXPORT
ACTIONS = actions.ALL
SUFFIX = actions.SUFFIX
LABEL = actions.LABEL
GUIDE = """# formpdf agent guide

## Loop
1. get_context: is the window open, which PDF it shows (id, pages, current page, unsaved changes), recent PDFs, consent.
2. open_pdf {path}: opens an absolute path in the window (and in the engine when no window is open). The PDF becomes "the open PDF".
3. pdf {action, ...}: the job. Where it works:
   - no path: on the open PDF (or doc: an id or key from get_context). Changing actions replace it with the result live in the window,
     labelled as your turn; the person can undo the whole turn. Nothing is written to disk until save.
   - path (absolute): on that file. Changing actions write [stem]-[action].pdf beside it unless out is given; the input never changes.
4. render_pages {pages}: a contact sheet picture of up to 12 pages. Look before you report.
5. extract {kind: text | tables | images, pages}: content out of the PDF.
6. save {path}: writes the open PDF's current version to a file. undo: reverts your last turn (calls under 90 s apart form one turn).

## Pages
pages is "3", "1-4", "2,5", "4-" (to the end); omit for every page. Coordinates are points from the top left of the page as shown.

## Actions (pdf tool)
Read: info, text, images (pictures to the media folder, ids and sizes), tables (markdown), find {query | preset: email, phone, card, date;
regex, caseSensitive, wholeWord}, comments (existing comments with replies and status), fields (form fields and values), hidden (hidden
information counts), compare {other: path, otherIsNewer, pictures}.
Change: header_footer {header: {left, center, right}, footer, tokens <<page>> <<pages>> <<date>> <<file>> <<bates>>, size, color, font,
margins, start, apply: all | odd | even, bates: {prefix, start, digits}}; page_numbers {position: bottom-center | bottom-right | bottom-left |
top-center | top-right | top-left, format: "{n}" | "Page {n} of {total}", start}; watermark {text, opacity 0..1, angle, size, color};
crop {margins: {l, t, r, b} | box: {x, y, w, h} | auto: true}; redact {query | preset | areas: [{page, x, y, w, h}]} (true redaction:
pages with a match become pictures); organize {order: [page numbers in the new order, pages left out are deleted], delete: [pages],
rotate: 90 | 180 | 270 (with pages, default all), blank: [positions after which a blank page goes]}; protect {password, owner, permissions:
{print, copy, modify, annotate, fill, assemble}}; unlock {password}; metadata {title, author, subject, keywords, strip}; compress {quality
10..95}; sanitize {remove: [metadata, javascript, attachments, comments, fields, layers, links, bookmarks, thumbnails, private, hidden_text]};
fill {values: {field name: value}, flatten}; annotate {annotations: [{page, kind: note | freetext | highlight | underline | strikeout |
rect | ellipse | line | arrow, text, color, x, y, w, h, rects, points}], highlight: query, flatten}; form {create: [{type: text | multiline |
checkbox | radio | dropdown | listbox | date | signature, page, x, y, w, h, name, options}], rename: {old: new}, delete: [names]};
merge {paths: [PDFs to append]} (with path and paths and out, merges files instead).
Export: split {ranges: ["1-3", "4-"], out: folder}; to_docx {out}; to_pptx {out, text: true} (one slide per page, words as text boxes).

## Tips
- Run find before redact and tell the person what will go. Crop hides, redact removes.
- Prefer one pdf call per job; render only the pages you changed.
- Leave the result open for the person to review; save only to the path they asked for.
"""
PROMPTS = [{"name": "pdf-job", "title": "Do a PDF job", "description": "Do a job on a PDF in formpdf and check the result by rendering it.",
            "arguments": [{"name": "path", "description": "Absolute path of the PDF", "required": False},
                          {"name": "job", "description": "What to do, in plain words", "required": False}]}]
RESOURCES = [{"uri": "formpdf://guide", "name": "guide", "title": "formpdf agent guide", "description": "The loop, page syntax and every pdf action.", "mimeType": "text/markdown"}]


class ToolError(Exception):
    pass


class Agent:
    def __init__(self, key: str, name: str):
        self.key = key
        self.name = name or "agent"
        self.turn: str | None = None
        self.last = 0.0


SESSIONS: dict[str, Agent] = {}
OPEN: dict[str, dict] = {}
_declined = [0.0]
_consent_lock: list = []


def _tool(name: str, description: str, props: dict, required: list[str] | None = None, read: bool = False, destructive: bool = False) -> dict:
    return {"name": name, "description": description, "inputSchema": {"type": "object", "properties": props, "required": required or []},
            "annotations": {"readOnlyHint": read, "destructiveHint": destructive, "openWorldHint": False}}


_S = {"type": "string"}
_PAGES = {"type": "string", "description": "1-based pages: 3, 1-4, 2,5, 4-; omit for all"}
_DOC = {"type": "string", "description": "An open PDF's id or key from get_context; omit for the PDF open in the window"}
_PATH = {"type": "string", "description": "Absolute path of a PDF file to work on instead of the open PDF"}
TOOLS = [
    _tool("get_context", "What formpdf has open: the window's PDF (id, key, name, pages, current page, unsaved changes), PDFs agents opened, recent PDFs and whether agents may edit.", {}, read=True),
    _tool("open_pdf", "Opens a PDF file (absolute path) in the formpdf window, or in the engine when no window is open, and makes it the open PDF.", {"path": _S}, ["path"]),
    _tool("pdf", "PDF actions. Read: " + ", ".join(READ_ACTIONS) + ". Change: " + ", ".join(CHANGE_ACTIONS) + " (on the open PDF: live in the window as your "
          "undoable turn; with path: a new file beside it). Export: " + ", ".join(EXPORT_ACTIONS) + ". Arguments per action: resource formpdf://guide.",
          {"action": {"type": "string", "enum": ACTIONS}, "doc": _DOC, "path": _PATH, "paths": {"type": "array", "items": _S}, "pages": _PAGES,
           "out": {"type": "string", "description": "Output file or folder"}, "ranges": {"type": "array", "items": _S},
           "header": {"type": "object"}, "footer": {"type": "object"}, "size": {"type": "number"}, "color": _S, "font": {"type": "string", "enum": ["sans", "serif", "mono"]},
           "margins": {"type": "object"}, "start": {"type": "integer"}, "apply": {"type": "string", "enum": ["all", "odd", "even"]}, "bates": {"type": "object"},
           "date": _S, "position": _S, "format": _S, "text": {"description": "watermark text; to_pptx: false for pictures only"}, "opacity": {"type": "number"},
           "angle": {"type": "number"}, "box": {"type": "object"}, "auto": {"type": "boolean"}, "query": _S, "regex": {"type": "boolean"},
           "preset": {"type": "string", "enum": ["email", "phone", "card", "date"]}, "caseSensitive": {"type": "boolean"}, "wholeWord": {"type": "boolean"},
           "areas": {"type": "array", "items": {"type": "object"}}, "order": {"type": "array", "items": {"type": "integer"}},
           "delete": {"description": "organize: pages to delete; form: field names to delete", "type": "array"}, "rotate": {"type": "integer"},
           "blank": {"type": "array", "items": {"type": "integer"}}, "password": _S, "owner": _S, "permissions": {"type": "object"},
           "title": _S, "author": _S, "subject": _S, "keywords": _S, "strip": {"type": "boolean"}, "quality": {"type": "integer"},
           "remove": {"type": "array", "items": _S}, "values": {"type": "object"}, "flatten": {"type": "boolean"},
           "annotations": {"type": "array", "items": {"type": "object"}}, "highlight": _S, "create": {"type": "array", "items": {"type": "object"}},
           "rename": {"type": "object"}, "other": _S, "otherIsNewer": {"type": "boolean"}, "pictures": {"type": "boolean"}},
          ["action"]),
    _tool("render_pages", "A contact sheet picture of up to 12 pages of the open PDF (or a file), each labelled with its page number.",
          {"doc": _DOC, "path": _PATH, "pages": _PAGES, "width": {"type": "integer", "description": "Sheet width in pixels (default 1600)"}}, read=True),
    _tool("extract", "Text, tables or pictures out of the open PDF (or a file).",
          {"kind": {"type": "string", "enum": ["text", "tables", "images"]}, "doc": _DOC, "path": _PATH, "pages": _PAGES}, ["kind"], read=True),
    _tool("save", "Writes the open PDF's current version to a file (absolute path; default the Exports folder in ~/Formpdf).", {"doc": _DOC, "path": _S}),
    _tool("undo", "Undoes your last turn on the open PDF (every change you made less than 90 seconds apart).", {"doc": _DOC}, destructive=True),
]
NAMES = {t["name"] for t in TOOLS}


def _ok(text: str, data: dict | None = None) -> dict:
    out = {"content": [{"type": "text", "text": text}]}
    if data is not None:
        out["structuredContent"] = data
    return out


def _fail(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": True}


def _clip(s: str, n: int) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "..."


def _mutating(name: str, args: dict) -> bool:
    if name in ("open_pdf", "save", "undo"):
        return True
    if name == "pdf":
        return args.get("action") in CHANGE_ACTIONS + EXPORT_ACTIONS
    return False


def _agent(request: Request, params: dict) -> Agent:
    sid = request.headers.get("mcp-session-id")
    info = (params.get("_meta") or {}).get("io.modelcontextprotocol/clientInfo") or {}
    key = sid or f"anon-{info.get('name') or 'agent'}"
    a = SESSIONS.get(key)
    if a is None:
        a = SESSIONS[key] = Agent(key, info.get("name") or "agent")
    return a


def _turn(a: Agent) -> str:
    now = time.monotonic()
    if not a.turn or now - a.last > TURN_GAP:
        a.turn = "u" + uuid.uuid4().hex[:8]
    a.last = now
    return a.turn


async def _consent(a: Agent) -> str | None:
    if config.read_settings().get("agentsAllowed") or any(c.agents for c in bridge.windows()):
        return None
    if not bridge.window_connected():
        return None
    if time.monotonic() < _declined[0]:
        return "The person did not allow agents to edit in formpdf just now. Ask them to allow it (the question in the formpdf window, or Preferences), then retry."
    if not _consent_lock:
        _consent_lock.append(asyncio.Lock())
    async with _consent_lock[0]:
        if config.read_settings().get("agentsAllowed"):
            return None
        res = await bridge.window_call("consent", {"agent": a.name}, 120)
        if res is None:
            return None
        if (res.get("structuredContent") or {}).get("allowed"):
            config.write_settings({"agentsAllowed": True})
            return None
        _declined[0] = time.monotonic() + 120
        return "The person did not allow agents to edit PDFs in formpdf. Ask them to allow it in the formpdf window, then retry."


def _abs(raw, must_exist: bool = True) -> Path:
    if not raw or not str(raw).strip():
        raise ToolError("Give an absolute path.")
    p = Path(str(raw)).expanduser()
    if not p.is_absolute():
        raise ToolError(f"{raw} is not an absolute path.")
    if must_exist and not p.exists():
        raise ToolError(f"{p} does not exist.")
    return p


def _pages(raw) -> list[int] | str | None:
    if raw in (None, "", []):
        return None
    if isinstance(raw, list):
        return [int(x) for x in raw]
    return str(raw).strip() or None


def _text_out(text: str, limit: int = 16000) -> str:
    return text[:limit] + ("\n... (cut: ask for fewer pages)" if len(text) > limit else "")


class Source:
    def __init__(self, path: Path, *, doc_id: str | None = None, key: str | None = None, name: str | None = None, window: bool = False):
        self.path = path
        self.id = doc_id
        self.key = key
        self.name = name or path.name
        self.window = window

    @property
    def live(self) -> bool:
        return self.id is not None

    @property
    def passwords(self) -> list[str]:
        return routes._pw(self.id) if self.id else []

    @property
    def stem(self) -> str:
        return Path(self.name).stem


def _source(args: dict) -> Source:
    if args.get("path"):
        p = _abs(args.get("path"))
        if not p.is_file():
            raise ToolError(f"{p} is not a file.")
        return Source(p)
    want = str(args.get("doc") or "").strip()
    win = bridge.window_doc()
    if win and (not want or want in (win.get("id"), win.get("key"))):
        return Source(docs.path_of(win["id"]), doc_id=win["id"], key=win.get("key") or win["id"], name=win.get("name"), window=True)
    if want:
        entry = OPEN.get(want) or next((e for e in OPEN.values() if e["id"] == want), None)
        doc_id = entry["id"] if entry else want
        try:
            path = docs.path_of(doc_id)
        except docs.NotFound:
            raise ToolError(f"There is no open PDF {want}. Call get_context for the ids, or pass path.") from None
        return Source(path, doc_id=doc_id, key=docs.meta(doc_id).get("root") or doc_id, name=docs.meta(doc_id).get("name"))
    if OPEN:
        entry = max(OPEN.values(), key=lambda e: e["at"])
        return Source(docs.path_of(entry["id"]), doc_id=entry["id"], key=entry["key"], name=entry["name"])
    raise ToolError("No PDF is open. Call open_pdf {path} first, or pass path to work on a file.")


def _track(key: str, doc_id: str, label: str, turn: str | None, name: str | None = None) -> dict:
    entry = OPEN.get(key)
    if entry is None:
        entry = OPEN[key] = {"key": key, "id": doc_id, "name": name or docs.meta(doc_id).get("name"), "history": [], "at": time.time()}
    entry["history"].append({"id": doc_id, "label": label, "turn": turn})
    entry["history"] = entry["history"][-200:]
    entry["id"] = doc_id
    entry["at"] = time.time()
    if name:
        entry["name"] = name
    return entry


async def _derive(src: Source, fn, *args, protect: bool = True, **kw) -> dict:
    try:
        return await routes._derive(src.id, fn, *args, protect=protect, **kw)
    except HTTPException as e:
        raise ToolError(str(e.detail)) from None


async def _land(a: Agent, src: Source, new_id: str, label: str, detail: str) -> dict:
    turn = _turn(a)
    info = await asyncio.to_thread(pdfsvc.info, docs.path_of(new_id), routes._pw(new_id))
    _track(src.key or new_id, new_id, label, turn, src.name)
    docs.remember(new_id, info.get("pages", 0))
    data = {"id": new_id, "key": src.key, "pages": info.get("pages", 0), "turn": turn}
    if src.window:
        res = await bridge.window_call("commit", {"from": src.id, "id": new_id, "label": f"Agent: {label}", "turn": turn, "agent": a.name}, 120)
        if res and res.get("isError"):
            return _fail(f"{label} worked ({detail}) but the window did not take it: {res['content'][0]['text']}")
        return _ok(f"{label}: {detail}. The formpdf window now shows it ({data['pages']} pages); the person can undo your turn. Not saved to disk yet.", data)
    return _ok(f"{label}: {detail}. The open PDF {src.name} is now version {new_id} ({data['pages']} pages). Not saved to disk yet; save writes it.", data)


def _out_file(src: Source, raw, suffix: str, ext: str = ".pdf") -> Path:
    base = src.path.parent if not src.live else config.exports_dir()
    default = f"{src.stem}-{suffix}{ext}" if ext == ".pdf" else f"{src.stem}{ext}"
    out = _abs(raw, must_exist=False) if raw else base / default
    if out.is_dir():
        out = out / default
    if not out.parent.is_dir():
        raise ToolError(f"The folder {out.parent} does not exist.")
    return out


def _search(args: dict, pages) -> dict:
    return {"regex": bool(args.get("regex")), "preset": args.get("preset") or None, "case_sensitive": bool(args.get("caseSensitive")),
            "whole_word": bool(args.get("wholeWord")), "pages": pages}


def _organize_items(args: dict, n: int) -> list[dict]:
    order = [int(p) for p in (args.get("order") or [])] or list(range(1, n + 1))
    gone = {int(p) for p in (args.get("delete") or [])}
    rot = int(args.get("rotate") or 0)
    if rot % 90:
        raise ToolError("rotate is 90, 180 or 270.")
    which = set(pdfsvc.parse_pages(args.get("pages"), n)) if args.get("pages") else set(range(1, n + 1))
    blanks = {int(p) for p in (args.get("blank") or [])}
    items: list[dict] = [{"blank": True}] if 0 in blanks else []
    for p in order:
        if not 1 <= p <= n:
            raise ToolError(f"Page {p} is out of range (1 to {n}).")
        if p in gone:
            continue
        items.append({"src": "self", "page": p, "rotate": rot if p in which else 0})
        if p in blanks:
            items.append({"blank": True})
    if not any("page" in i for i in items):
        raise ToolError("That would leave no pages.")
    return items


async def _annotations(src: Source, args: dict) -> list[dict]:
    items = [dict(x) for x in (args.get("annotations") or []) if isinstance(x, dict)]
    if args.get("highlight"):
        got = await asyncio.to_thread(lambda: pdfsvc.find(src.path, str(args["highlight"]), case_sensitive=bool(args.get("caseSensitive")),
                                                           whole_word=bool(args.get("wholeWord")), passwords=src.passwords))
        by_page: dict[int, list] = {}
        for m in got["matches"]:
            by_page.setdefault(int(m["page"]), []).extend([r["x"], r["y"], r["w"], r["h"]] for r in m["rects"])
        items += [{"kind": "highlight", "page": p, "rects": rects, "color": args.get("color") or "#FFD400"} for p, rects in by_page.items()]
    if not items:
        raise ToolError("annotate needs annotations, or highlight with a word or phrase that appears in the PDF.")
    return items


async def _change(a: Agent, src: Source, action: str, args: dict, pages) -> dict:
    pw = src.passwords
    extra: dict = {}
    if action == "header_footer":
        fn, kw = pdfsvc.header_footer, dict(header=args.get("header"), footer=args.get("footer"), size=args.get("size"), color=str(args.get("color") or "#333333"),
                                           font=str(args.get("font") or "sans"), margins=args.get("margins"), pages=pages, start=args.get("start"),
                                           apply=str(args.get("apply") or "all"), bates=args.get("bates") or None, date=args.get("date") or None,
                                           file=src.name, passwords=pw)
    elif action == "page_numbers":
        fn, kw = pdfsvc.page_numbers, dict(position=str(args.get("position") or "bottom-center"), start=int(args.get("start") or 1),
                                          fmt=str(args.get("format") or "{n}"), size=float(args.get("size") or 10), color=str(args.get("color") or "#333333"),
                                          pages=pages, passwords=pw)
    elif action == "watermark":
        if not str(args.get("text") or "").strip():
            raise ToolError("watermark needs text.")
        fn, kw = pdfsvc.watermark, dict(text=str(args["text"]), opacity=float(args.get("opacity", 0.15)), angle=float(args.get("angle", 45)),
                                       size=float(args.get("size") or 64), color=str(args.get("color") or "#888888"), pages=pages, passwords=pw)
    elif action == "crop":
        fn, kw = pdfsvc.crop, dict(box=args.get("box"), margins=args.get("margins"), auto=bool(args.get("auto")), pages=pages, passwords=pw)
    elif action == "redact":
        areas = args.get("areas")
        if not areas:
            if not args.get("query") and not args.get("preset"):
                raise ToolError("redact needs areas, or a query or preset to redact every match.")
            got = await asyncio.to_thread(lambda: pdfsvc.find(src.path, None if args.get("preset") else args.get("query"), passwords=pw, **_search(args, pages)))
            if not got["count"]:
                return _ok("No matches, so nothing was redacted.", {"count": 0})
            areas, extra = pdfsvc.match_areas(got["matches"]), {"matches": got["count"]}
        fn, kw = pdfsvc.redact, dict(passwords=pw)
        kw["areas"] = areas
        extra["areas"] = len(areas)
    elif action == "organize":
        n = await asyncio.to_thread(pdfsvc.page_count, src.path, pw)
        items = _organize_items(args, n)
        fn, kw = pdfsvc.organize, dict(items=items, resolve=docs.path_of, passwords=pw)
    elif action == "protect":
        if not args.get("password") and not args.get("owner"):
            raise ToolError("protect needs password (and optionally owner and permissions).")
        fn, kw = pdfsvc.protect, dict(password=str(args.get("password") or ""), owner=args.get("owner") or None,
                                     permissions=args.get("permissions") if isinstance(args.get("permissions"), dict) else None, passwords=pw)
    elif action == "unlock":
        fn, kw = pdfsvc.unlock, dict(password=str(args.get("password") or (pw[0] if pw else "")))
    elif action == "metadata":
        fn, kw = pdfsvc.metadata, dict(title=args.get("title"), author=args.get("author"), subject=args.get("subject"), keywords=args.get("keywords"),
                                      strip=bool(args.get("strip")), passwords=pw)
    elif action == "compress":
        fn, kw = pdfsvc.compress, dict(quality=max(10, min(95, int(args.get("quality") or 70))), passwords=pw)
    elif action == "sanitize":
        remove = [str(r) for r in (args.get("remove") or ["metadata", "javascript", "attachments", "private", "thumbnails"])]
        fn, kw = pdfsvc.sanitize, dict(remove=remove, passwords=pw)
    elif action == "fill":
        if not isinstance(args.get("values"), dict) or not args["values"]:
            raise ToolError("fill needs values: {field name: value}. pdf {action: fields} lists the fields.")
        fn, kw = pdfsvc.fill_fields, dict(values={str(k): str(v) for k, v in args["values"].items()}, flatten=bool(args.get("flatten")), passwords=pw)
    elif action == "annotate":
        items = await _annotations(src, args)
        fn, kw = pdfsvc.annotate, dict(annotations=items, flatten=bool(args.get("flatten")), passwords=pw,
                                      author=str(config.read_settings().get("author") or a.name))
    elif action == "form":
        fn, kw = pdfsvc.prepare_form, dict(create=args.get("create") or [], rename=args.get("rename") or {}, delete=args.get("delete") or [], passwords=pw)
    elif action == "merge":
        return await _merge(a, src, args)
    elif actions.get(action) and actions.get(action).run:
        fn, kw = actions.get(action).run, dict(args=args, pages=pages, passwords=pw)
    else:
        raise ToolError(f"Unknown action {action}.")
    label = LABEL[action]
    if src.live:
        protect = action not in ("protect", "unlock")
        positional = [kw.pop(k) for k in ("items", "resolve") if k in kw] if action == "organize" else []
        if action == "redact":
            positional = [kw.pop("areas")]
        res = await _derive(src, fn, *positional, protect=protect, **kw)
        if action == "protect":
            docs.update_meta(res["id"], protect={"password": kw["password"], "owner": kw.get("owner") or "", "permissions": kw.get("permissions")})
        detail = _detail(res, extra)
        return await _land(a, src, res["id"], label, detail)
    out = _out_file(src, args.get("out"), SUFFIX[action])
    positional = [kw.pop(k) for k in ("items", "resolve") if k in kw] if action == "organize" else []
    if action == "redact":
        positional = [kw.pop("areas")]
    tmp = out.with_name(f".{out.name}.tmp")
    try:
        got = await asyncio.to_thread(lambda: fn(src.path, tmp, *positional, **kw))
        tmp.replace(out)
    finally:
        tmp.unlink(missing_ok=True)
    res = got if isinstance(got, dict) else {"pages": got}
    return _ok(f"{label}: wrote {out} ({_detail(res, extra)}).", {"path": str(out), **{k: v for k, v in res.items() if isinstance(v, (int, float, str, list))}, **extra})


def _detail(res: dict, extra: dict) -> str:
    n = res.get("pages")
    bits = [f"{n} page{'s' if n != 1 else ''}"] if n is not None else []
    for k, word in (("cropped", "cropped"), ("matches", "matches"), ("areas", "areas redacted"), ("created", "fields added"), ("flattened", "fields flattened"),
                    ("added", "added"), ("deleted", "deleted"), ("fixed", "spelling fixes")):
        v = res.get(k, extra.get(k))
        if v:
            bits.append(f"{v} {word}")
    if res.get("before") and res.get("after"):
        bits.append(f"{res['before'] // 1024} KB to {res['after'] // 1024} KB")
    if res.get("removed"):
        bits.append("removed " + ", ".join(str(x) for x in res["removed"]))
    return ", ".join(bits) or "done"


async def _merge(a: Agent, src: Source, args: dict) -> dict:
    paths = [_abs(p) for p in args.get("paths") or []]
    if not paths:
        raise ToolError("merge needs paths: the PDFs to append.")
    if not src.live:
        out = _abs(args.get("out"), must_exist=False) if args.get("out") else src.path.with_name(f"{src.stem}-merged.pdf")
        if out.is_dir():
            out = out / f"{src.stem}-merged.pdf"
        tmp = out.with_name(f".{out.name}.tmp")
        try:
            res = await asyncio.to_thread(pdfsvc.merge, [src.path, *paths], tmp)
            tmp.replace(out)
        finally:
            tmp.unlink(missing_ok=True)
        return _ok(f"Merged {len(paths) + 1} files into {out} ({res['pages']} pages).", {"path": str(out), "pages": res["pages"]})
    ids = [src.id]
    for p in paths:
        data = await asyncio.to_thread(p.read_bytes)
        ids.append(await asyncio.to_thread(docs.put_bytes, data, p.name, str(p)))
    try:
        res = await routes.merge({"ids": ids})
    except HTTPException as e:
        raise ToolError(str(e.detail)) from None
    return await _land(a, src, res["id"], LABEL["merge"], f"appended {len(paths)} PDF{'s' if len(paths) != 1 else ''}, {res['pages']} pages")


async def _export(src: Source, action: str, args: dict, pages) -> dict:
    pw = src.passwords
    if action == "split":
        ranges = [str(r) for r in (args.get("ranges") or ([args["pages"]] if args.get("pages") else []))]
        if not ranges:
            raise ToolError("split needs ranges, for example [\"1-3\", \"4-\"].")
        out = _abs(args.get("out"), must_exist=False) if args.get("out") else (src.path.parent if not src.live else config.exports_dir())
        if not out.is_dir():
            raise ToolError(f"split needs out to be an existing folder; {out} is not one.")
        tmp = out / f".split-{uuid.uuid4().hex[:8]}"
        try:
            got = await asyncio.to_thread(pdfsvc.split, src.path, ranges, tmp, pw)
            final = []
            for p in got:
                dest = out / Path(p).name.replace(src.path.stem, src.stem, 1)
                shutil.move(p, dest)
                final.append(str(dest))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        return _ok("Wrote " + ", ".join(final), {"paths": final})
    plug = actions.get(action)
    if plug and plug.run:
        out = _out_file(src, args.get("out"), plug.suffix or action, plug.ext or ".pdf")
        tmp = out.with_name(f".{out.name}.tmp{out.suffix}")
        try:
            got = await asyncio.to_thread(lambda: plug.run(src.path, tmp, args=args, pages=pages, passwords=pw))
            tmp.replace(out)
        finally:
            tmp.unlink(missing_ok=True)
        got = got if isinstance(got, dict) else {}
        return _ok(f"{plug.label}: wrote {out}.", {"path": str(out), **{k: v for k, v in got.items() if isinstance(v, (int, float, str, list))}})
    ext = ".docx" if action == "to_docx" else ".pptx"
    out = _out_file(src, args.get("out"), "", ext)
    tmp = out.with_name(f".{out.name}.tmp{ext}")
    try:
        if action == "to_docx":
            got = await asyncio.to_thread(lambda: pdfsvc.to_docx(src.path, tmp, pages=pages, passwords=pw))
        else:
            got = await asyncio.to_thread(lambda: pdfsvc.to_pptx(src.path, tmp, pages=pages, passwords=pw, text=args.get("text") is not False))
        tmp.replace(out)
    finally:
        tmp.unlink(missing_ok=True)
    if action == "to_docx":
        return _ok(f"Wrote {out} ({got['pages']} pages, {got['headings']} headings, {got['paragraphs']} paragraphs, {got['tables']} tables, {got['pictures']} pictures).",
                   {"path": str(out), **got})
    return _ok(f"Wrote {out} ({got['slides']} slides at {got['width']} by {got['height']} pt, {got['textboxes']} text boxes, {got['tables']} tables).",
               {"path": str(out), **got})


async def _read(src: Source, action: str, args: dict, pages) -> dict:
    pw = src.passwords
    if action == "info":
        info = await asyncio.to_thread(pdfsvc.info, src.path, pw)
        info["name"] = src.name
        return _ok(json.dumps(info, ensure_ascii=False, default=str)[:6000], {"pages": info.get("pages"), "locked": info.get("locked")})
    if action == "text":
        got = await asyncio.to_thread(pdfsvc.extract_text, src.path, pages, pw)
        return _ok(_text_out("\n\n".join(f"## Page {x.get('page')}\n{x.get('text', '')}" for x in got)))
    if action == "images":
        got = await asyncio.to_thread(lambda: pdfsvc.extract_images(src.path, pages, pw, name=src.name))
        lines = [f"p{x['page']} · {x['id']} · {x['w']}x{x['h']} · {x['mime']}" for x in got]
        return _ok("\n".join(lines) + (f"\nSaved in {config.media_dir()}" if got else "No pictures."), {"images": [{"id": x["id"], "page": x["page"], "w": x["w"], "h": x["h"]} for x in got]})
    if action == "tables":
        got = await asyncio.to_thread(pdfsvc.extract_tables, src.path, pages, pw)
        parts = []
        for x in got:
            rows = [x.get("header") or []] + (x.get("rows") or [])[:30]
            parts.append(f"p{x.get('page')}:\n" + "\n".join("| " + " | ".join(str(c) for c in r) + " |" for r in rows))
        return _ok(_text_out("\n\n".join(parts)) or "No tables.", {"tables": len(got)})
    if action == "find":
        got = await asyncio.to_thread(lambda: pdfsvc.find(src.path, None if args.get("preset") else args.get("query"), passwords=pw, **_search(args, pages)))
        lines = [f"p{m['page']} · {m['text']} · {m['context']}" for m in got["matches"][:200]]
        head = f"{got['count']} match{'es' if got['count'] != 1 else ''} on {got['pages']} page{'s' if got['pages'] != 1 else ''}"
        return _ok(head + (":\n" + "\n".join(lines) if lines else "."), {"count": got["count"], "truncated": got["truncated"], "matches": got["matches"][:500]})
    if action == "comments":
        got = await asyncio.to_thread(pdfsvc.comments, src.path, pw)
        lines = [f"p{c['page']} · {c['label']}{' · ' + c['author'] if c.get('author') else ''} · {c['status']} · {_clip(c.get('text') or '', 120)}"
                 + "".join(f"\n    reply {r.get('author') or ''}: {_clip(r.get('text') or '', 120)}" for r in c.get("replies") or []) for c in got[:300]]
        return _ok("\n".join(lines) or "No comments.", {"count": len(got)})
    if action == "fields":
        got = await asyncio.to_thread(pdfsvc.read_fields, src.path, pw)
        lines = [f"{f['name']} · {f['type']} · p{f['page']} · value {f.get('value')!r}{' · options ' + ', '.join(f['options']) if f.get('options') else ''}" for f in got]
        return _ok("\n".join(lines) or "No form fields.", {"fields": [{"name": f["name"], "type": f["type"], "page": f["page"], "value": f.get("value")} for f in got]})
    if action == "hidden":
        got = await asyncio.to_thread(pdfsvc.scan_hidden, src.path, pw)
        return _ok("\n".join(f"{it['key']} · {it['count']}{' · ' + it['note'] if it.get('note') else ''}" for it in got), {"items": got})
    if action == "compare":
        other = _abs(args.get("other"))
        got = await asyncio.to_thread(lambda: pdfsvc.compare(src.path, other, passwords=pw, other_is_newer=bool(args.get("otherIsNewer")), pictures=bool(args.get("pictures"))))
        s = got["summary"]
        lines = [f"{c['kind']} · p{c.get('page')} · {_clip(c.get('before') or '', 80)} -> {_clip(c.get('after') or '', 80)}" for c in got["changes"][:200]]
        return _ok(f"{s['changed']} pages changed, {s['added']} added, {s['removed']} removed, {s['same']} the same; {len(got['changes'])} differences:\n" + "\n".join(lines),
                   {"summary": s, "count": len(got["changes"])})
    plug = actions.get(action)
    if plug and plug.run:
        text, data = await asyncio.to_thread(lambda: plug.run(src.path, args=args, pages=pages, passwords=pw))
        return _ok(_text_out(str(text)), data if isinstance(data, dict) else None)
    raise ToolError(f"Unknown action {action}.")


async def t_get_context(a: Agent, args: dict) -> dict:
    win = bridge.window_doc()
    allowed = bool(config.read_settings().get("agentsAllowed")) or any(c.agents for c in bridge.windows())
    lines = [f"formpdf {config.VERSION} · engine 127.0.0.1:{config.port()} · data {config.data_dir()}"]
    if bridge.window_connected():
        lines.append(f"Window: open · agents {'allowed' if allowed else 'not allowed yet (your first change asks the person)'}")
        lines.append(f"Open PDF: {win['name']} · id {win['id']} · key {win.get('key')} · {win['pages']} pages · on page {win.get('page')} · tab {win.get('tab')}"
                     f"{' · unsaved changes' if win.get('dirty') else ''}{' · last change by an agent' if win.get('agentTurn') else ''}" if win else "Open PDF: none (open_pdf {path} opens one)")
    else:
        lines.append("Window: none open (headless: open_pdf opens PDFs in the engine; changes are kept as versions until save; ask the person to run ./formpdf to watch)")
    for e in sorted(OPEN.values(), key=lambda e: -e["at"])[:10]:
        if not win or e["key"] != win.get("key"):
            lines.append(f"Agent-opened: {e['name']} · id {e['id']} · key {e['key']} · {len(e['history'])} version{'s' if len(e['history']) != 1 else ''}")
    recent = docs.recent()[:10]
    if recent:
        lines.append("Recent: " + "; ".join(f"{r['name']} ({r['pages']} p, id {r['id']})" for r in recent))
    return _ok("\n".join(lines), {"window": bridge.window_connected(), "agentsAllowed": allowed, "doc": win, "open": list(OPEN.values())[:10], "recent": recent})


async def t_open_pdf(a: Agent, args: dict) -> dict:
    p = _abs(args.get("path"))
    if not p.is_file():
        raise ToolError(f"{p} is not a file.")
    data = await asyncio.to_thread(p.read_bytes)
    if b"%PDF-" not in data[:1024]:
        raise ToolError(f"{p.name} is not a PDF.")
    doc_id = await asyncio.to_thread(docs.put_bytes, data, p.name, str(p))
    info = await asyncio.to_thread(pdfsvc.info, docs.path_of(doc_id), routes._pw(doc_id))
    entry = docs.remember(doc_id, info.get("pages", 0))
    OPEN.pop(entry["key"], None)
    _track(entry["key"], doc_id, "Open", None, p.name)
    head = f"{p.name} · id {doc_id} · key {entry['key']} · {info.get('pages', 0)} pages{' · password protected' if info.get('locked') else ''}"
    if bridge.window_connected():
        res = await bridge.window_call("open", {"id": doc_id}, 60)
        if res and res.get("isError"):
            return _fail(f"Opened {head} in the engine, but the window did not switch: {res['content'][0]['text']}")
        return _ok(f"Opened {head} in the formpdf window.", {"id": doc_id, "key": entry["key"], "pages": info.get("pages", 0), "window": True})
    return _ok(f"Opened {head} in the engine (no window is open). pdf actions without a path now work on it.", {"id": doc_id, "key": entry["key"], "pages": info.get("pages", 0), "window": False})


async def t_pdf(a: Agent, args: dict) -> dict:
    action = args.get("action")
    if action not in ACTIONS:
        raise ToolError("action is one of " + ", ".join(ACTIONS) + ".")
    if action == "merge" and args.get("out") and not args.get("path") and not args.get("doc"):
        paths = [_abs(p) for p in args.get("paths") or []]
        if len(paths) < 2:
            raise ToolError("merge with out needs paths: two or more PDFs, merged in the order given.")
        out = _abs(args.get("out"), must_exist=False)
        res = await asyncio.to_thread(pdfsvc.merge, paths, out)
        return _ok(f"Merged {len(paths)} files into {out} ({res['pages']} pages).", {"path": str(out), "pages": res["pages"]})
    src = _source(args)
    pages = _pages(args.get("pages"))
    try:
        if action in READ_ACTIONS:
            return await _read(src, action, args, pages)
        if action in EXPORT_ACTIONS:
            return await _export(src, action, args, pages)
        return await _change(a, src, action, args, pages)
    except ToolError:
        raise
    except pdfsvc.Locked as exc:
        return _fail(f"pdf {action} failed: {exc} (pdf {{action: unlock, password}} on the open PDF, or ask the person).")
    except Exception as exc:
        return _fail(f"pdf {action} failed: {type(exc).__name__}: {_clip(str(exc), 300)}")


async def t_render_pages(a: Agent, args: dict) -> dict:
    src = _source(args)
    width = max(400, min(3200, int(args.get("width") or 1600)))
    data, idx = await asyncio.to_thread(pdfsvc.contact_sheet, src.path, _pages(args.get("pages")), src.passwords, width)
    n = await asyncio.to_thread(pdfsvc.page_count, src.path, src.passwords)
    more = f" (first 12 of the pages asked for)" if args.get("pages") and len(pdfsvc.parse_pages(_pages(args.get("pages")), n)) > 12 else ""
    return {"content": [{"type": "text", "text": f"{src.name}: pages {', '.join(map(str, idx))} of {n}{more}."},
                        {"type": "image", "data": base64.b64encode(data).decode("ascii"), "mimeType": "image/png"}],
            "structuredContent": {"pages": idx, "total": n}}


async def t_extract(a: Agent, args: dict) -> dict:
    kind = args.get("kind")
    if kind not in ("text", "tables", "images"):
        raise ToolError("kind is text, tables or images.")
    return await _read(_source(args), kind, args, _pages(args.get("pages")))


async def t_save(a: Agent, args: dict) -> dict:
    src = _source({k: v for k, v in args.items() if k != "path"})
    try:
        res = await routes.save(src.id, {"path": args.get("path") or ""})
    except HTTPException as e:
        raise ToolError(str(e.detail)) from None
    if src.window:
        await bridge.window_call("saved", {"id": src.id}, 20)
    return _ok(f"Saved {src.name} to {res['path']} ({res['bytes'] // 1024} KB).", res)


async def t_undo(a: Agent, args: dict) -> dict:
    src = _source(args)
    if src.window:
        res = await bridge.window_call("undo-turn", {}, 60)
        return res or _fail("The window did not answer.")
    entry = OPEN.get(src.key or "")
    hist = entry["history"] if entry else []
    if len(hist) < 2 or not hist[-1].get("turn"):
        return _ok("Nothing of yours to undo on this PDF.")
    turn = hist[-1]["turn"]
    n = 0
    while len(hist) > 1 and hist[-1].get("turn") == turn:
        hist.pop()
        n += 1
    entry["id"] = hist[-1]["id"]
    docs.remember(entry["id"], await asyncio.to_thread(pdfsvc.page_count, docs.path_of(entry["id"]), routes._pw(entry["id"])))
    return _ok(f"Undid your last turn ({n} change{'s' if n != 1 else ''}); the open PDF is back to {hist[-1]['label']}.", {"id": entry["id"]})


HANDLERS = {name[2:]: fn for name, fn in globals().items() if name.startswith("t_") and callable(fn)}


async def call_tool(a: Agent, name: str, args: dict) -> dict:
    if _mutating(name, args):
        refused = await _consent(a)
        if refused:
            return _fail(refused)
    try:
        return await HANDLERS[name](a, args)
    except ToolError as exc:
        return _fail(str(exc))
    except docs.NotFound:
        return _fail("That PDF is no longer in formpdf's working copies. Call get_context, or open it again.")
    except (ValueError, TypeError, KeyError) as exc:
        return _fail(f"{name}: bad arguments ({type(exc).__name__}: {_clip(str(exc), 200)}).")
    except Exception as exc:
        return _fail(f"{name} failed: {type(exc).__name__}: {_clip(str(exc), 300)}")


def prompt_text(args: dict) -> str:
    path = str(args.get("path") or "").strip()
    job = str(args.get("job") or "").strip()
    return "\n".join([
        "Do this PDF job in formpdf (MCP server formpdf).",
        f"PDF: {path or 'ask the person which PDF, as an absolute path'}",
        f"Job: {job or 'ask the person what to do'}",
        "", "Steps:", "1. get_context.", "2. open_pdf {path} unless it is already the open PDF.",
        "3. Do the job with the pdf tool (see resource formpdf://guide for the actions); run find before any redact and say what will go.",
        "4. render_pages on the pages you changed and look at them; fix anything wrong.",
        "5. Tell the person what changed; save only if they asked for a file. undo reverts your turn.",
    ])


@router.post("/mcp")
async def mcp(request: Request) -> Response:
    if not local_origin(request.headers.get("origin")):
        return Response(status_code=403, content=json.dumps(_err(None, -32600, "Origin not allowed")), media_type="application/json")
    try:
        msg = json.loads(await request.body())
    except ValueError:
        return Response(content=json.dumps(_err(None, -32700, "Parse error")), media_type="application/json", status_code=400)
    if isinstance(msg, list):
        return Response(content=json.dumps(_err(None, -32600, "Batches are not supported")), media_type="application/json", status_code=400)
    if not isinstance(msg, dict):
        return Response(content=json.dumps(_err(None, -32600, "Invalid request")), media_type="application/json", status_code=400)
    req_id, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if req_id is None:
        return Response(status_code=202)
    meta = params.get("_meta") or {}
    version = meta.get("io.modelcontextprotocol/protocolVersion") or request.headers.get("mcp-protocol-version") or "2025-11-25"
    modern = version == "2026-07-28"
    headers = {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        sid = uuid.uuid4().hex
        while len(SESSIONS) > 500:
            SESSIONS.pop(next(iter(SESSIONS)))
        SESSIONS[sid] = Agent(sid, (params.get("clientInfo") or {}).get("name") or "agent")
        headers["Mcp-Session-Id"] = sid
        out = _res(req_id, {"protocolVersion": asked if asked in VERSIONS + LEGACY else VERSIONS[1], "capabilities": CAPS, "serverInfo": SERVER, "instructions": INSTRUCTIONS}, False)
    elif version not in VERSIONS + LEGACY:
        out = _err(req_id, -32602, f"Unsupported protocol version {version}; supported: {', '.join(VERSIONS)}")
    elif method == "server/discover":
        out = _res(req_id, {"supportedVersions": VERSIONS, "capabilities": CAPS, "_meta": {"io.modelcontextprotocol/serverInfo": SERVER}, "instructions": INSTRUCTIONS}, True)
    elif method == "ping":
        out = _res(req_id, {}, modern)
    elif method == "tools/list":
        out = _res(req_id, {"tools": TOOLS}, modern)
    elif method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        if name not in NAMES or not isinstance(args, dict):
            out = _err(req_id, -32602, f"No tool named {name}")
        else:
            out = _res(req_id, await call_tool(_agent(request, params), name, args), modern)
    elif method == "resources/list":
        out = _res(req_id, {"resources": RESOURCES}, modern)
    elif method == "resources/templates/list":
        out = _res(req_id, {"resourceTemplates": []}, modern)
    elif method == "resources/read":
        uri = params.get("uri")
        if uri == "formpdf://guide":
            out = _res(req_id, {"contents": [{"uri": uri, "mimeType": "text/markdown", "text": GUIDE}]}, modern)
        else:
            out = _err(req_id, -32002, f"Resource not found: {uri}")
    elif method == "prompts/list":
        out = _res(req_id, {"prompts": PROMPTS}, modern)
    elif method == "prompts/get":
        if params.get("name") == "pdf-job":
            out = _res(req_id, {"description": PROMPTS[0]["description"], "messages": [{"role": "user", "content": {"type": "text", "text": prompt_text(params.get("arguments") or {})}}]}, modern)
        else:
            out = _err(req_id, -32602, f"No prompt named {params.get('name')}")
    else:
        out = _err(req_id, -32601, f"Method not found: {method}")
    return Response(content=json.dumps(out, ensure_ascii=False), media_type="application/json", headers=headers)


@router.get("/mcp")
def mcp_get() -> Response:
    return Response(status_code=405, headers={"Allow": "POST, DELETE"})


@router.delete("/mcp")
def mcp_delete(request: Request) -> Response:
    SESSIONS.pop(request.headers.get("mcp-session-id") or "", None)
    return Response(status_code=204)


def _res(req_id, result: dict, modern: bool) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": {**result, **({"resultType": "complete"} if modern else {})}}


def _err(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}
