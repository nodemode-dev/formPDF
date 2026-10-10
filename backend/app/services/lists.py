import asyncio
import json
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from app.core import config
from app.services.pdf import actions, core

MAX_STEPS = 40
BUILTIN = [
    {"id": "distribute", "name": "Prepare for distribution", "description": "Removes metadata, scripts, attached files, private data and thumbnails, then compresses.",
     "steps": [{"action": "sanitize", "args": {"remove": ["metadata", "javascript", "attachments", "private", "thumbnails"]}},
               {"action": "compress", "args": {"quality": 80}}]},
    {"id": "scans", "name": "Optimise scans", "description": "Makes scanned pages searchable, straightens them and compresses the file.",
     "steps": [{"action": "ocr", "args": {"skip_text": True, "deskew": True}}, {"action": "compress", "args": {"quality": 70}}]},
    {"id": "confidential", "name": "Mark confidential", "description": "Adds a CONFIDENTIAL watermark and a confidential footer with page numbers.",
     "steps": [{"action": "watermark", "args": {"text": "CONFIDENTIAL", "opacity": 0.12}},
               {"action": "header_footer", "args": {"footer": {"center": "Confidential · Page <<page>> of <<pages>>"}, "size": 9}}]},
    {"id": "accessible", "name": "Make accessible", "description": "Tags the PDF from its layout and applies every accessibility fix that does not need a person.",
     "steps": [{"action": "autotag", "args": {}}, {"action": "fix_accessibility", "args": {}}]},
    {"id": "archive", "name": "Archive as PDF/A", "description": "Converts to PDF/A-2u, embedding fonts and an output intent.", "steps": [{"action": "pdfa", "args": {"level": "2u"}}]},
]


def _dir() -> Path:
    d = config.data_dir() / "actions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _clean_steps(steps) -> list[dict]:
    if not isinstance(steps, list) or not steps:
        raise ValueError("An action list needs at least one step")
    if len(steps) > MAX_STEPS:
        raise ValueError(f"An action list can have at most {MAX_STEPS} steps")
    out = []
    for i, st in enumerate(steps, 1):
        if not isinstance(st, dict):
            raise ValueError(f"Step {i} is not an action")
        name = str(st.get("action") or "")
        act = actions.get(name)
        if act is None:
            raise ValueError(f"Step {i}: there is no action {name}")
        if name == "run_list" or act.kind == "export":
            raise ValueError(f"Step {i}: {act.label} cannot be a step; lists hold reading and changing actions")
        args = st.get("args") if isinstance(st.get("args"), dict) else {}
        args = {k: v for k, v in args.items() if k not in ("path", "out", "doc", "action")}
        out.append({"action": name, "args": json.loads(json.dumps(args))})
    return out


def all_lists() -> list[dict]:
    mine = []
    for f in sorted(_dir().glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("id") and data.get("steps"):
            mine.append({**data, "builtin": False})
    return [{**b, "builtin": True} for b in BUILTIN] + sorted(mine, key=lambda x: str(x.get("name", "")).lower())


def get(key: str) -> dict:
    key = str(key or "").strip()
    for item in all_lists():
        if item["id"] == key or str(item.get("name", "")).lower() == key.lower():
            return item
    raise ValueError(f"There is no action list {key}")


def save(name: str, steps, description: str = "", ident: str | None = None) -> dict:
    name = re.sub(r"\s+", " ", str(name or "")).strip()[:80]
    if not name:
        raise ValueError("Give the action list a name")
    if any(b["name"].lower() == name.lower() for b in BUILTIN):
        raise ValueError(f"{name} is a built-in list; choose another name")
    ident = ident if ident and re.fullmatch(r"[0-9a-f]{10}", ident) else None
    for item in all_lists():
        if not item["builtin"] and item["name"].lower() == name.lower():
            ident = ident or item["id"]
    data = {"id": ident or uuid.uuid4().hex[:10], "name": name, "description": str(description or "")[:400], "steps": _clean_steps(steps),
            "saved": time.strftime("%Y-%m-%d %H:%M")}
    (_dir() / f"{data['id']}.json").write_text(json.dumps(data, indent=1), encoding="utf-8")
    return {**data, "builtin": False}


def delete(ident: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{10}", ident or ""):
        raise ValueError("Built-in lists cannot be deleted")
    (_dir() / f"{ident}.json").unlink(missing_ok=True)


def run(src, out, *, args: dict | None = None, pages=None, passwords: list[str] | None = None) -> dict:
    from app.routers import mcp

    args = args or {}
    steps = _clean_steps(args["steps"]) if args.get("steps") else get(str(args.get("list") or ""))["steps"]
    agent = mcp.Agent("list", "Action list")
    work = Path(tempfile.mkdtemp(prefix=".list-", dir=str(config.data_dir())))
    log = []
    try:
        cur = Path(src)
        if passwords and core.reader(src, passwords).is_encrypted:
            raise ValueError("Remove the password before running an action list on this PDF")
        for i, st in enumerate(steps, 1):
            act = actions.get(st["action"])
            nxt = work / f"step{i}.pdf"
            call = {**st["args"], "action": st["action"], "path": str(cur)}
            if act.kind != "read":
                call["out"] = str(nxt)
            started = time.time()
            res = asyncio.run(mcp.t_pdf(agent, call))
            text = " ".join(p.get("text", "") for p in res.get("content", []) if p.get("type") == "text").replace(f"{work}/", "").replace(str(src), Path(src).name)
            ms = int((time.time() - started) * 1000)
            if res.get("isError"):
                log.append({"step": i, "action": st["action"], "label": act.label, "ok": False, "text": text[:400], "ms": ms})
                raise ValueError(f"Step {i} ({act.label}) failed: {text[:300]}")
            log.append({"step": i, "action": st["action"], "label": act.label, "ok": True, "text": text[:400], "ms": ms})
            if act.kind != "read" and nxt.is_file():
                cur = nxt
        shutil.copyfile(cur, out)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"pages": core.page_count(out), "steps": log}


actions.register(actions.Action("run_list", "change", "Run an action list", "processed", ("action wizard", "action list", "workflow", "automate", "macro"),
                                fields=(actions.Field("list", "Action list", hint="Name of a built-in or saved list, for example Prepare for distribution"),), run=run))
