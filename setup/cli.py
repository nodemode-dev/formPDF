#!/usr/bin/env python3
import argparse
import asyncio
import base64
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("FORMPDF_DATA_DIR", str(Path.home() / "Formpdf"))
CALLER = Path(os.environ.get("FORMPDF_CALLER_DIR") or os.getcwd())
FLAGS = ("out", "pages", "query", "preset", "text", "password", "owner", "title", "author", "subject", "keywords", "position", "format",
         "other", "highlight", "color", "font", "apply", "date")
NUMBERS = ("quality", "start", "size", "opacity", "angle", "rotate")


def here(p: str) -> str:
    path = Path(p).expanduser()
    return str(path if path.is_absolute() else (CALLER / path).resolve())


def parse() -> tuple[argparse.Namespace, list[str]]:
    ap = argparse.ArgumentParser(prog="./formpdf run", description="Run one formpdf PDF action on files, without the window. "
                                 "Changing actions write [name]-[action].pdf beside the input unless --out is given; the input never changes.")
    ap.add_argument("action", help="a pdf action (info, text, find, header_footer, page_numbers, watermark, crop, redact, organize, protect, unlock, "
                                   "metadata, compress, sanitize, fill, annotate, form, merge, split, to_docx, to_pptx, ...), render, or actions to list them")
    ap.add_argument("files", nargs="*", help="the PDF (merge: two or more PDFs, or Office files and pictures to make one PDF)")
    for f in FLAGS:
        ap.add_argument(f"--{f}", dest=f)
    for f in NUMBERS:
        ap.add_argument(f"--{f}", dest=f, type=float)
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="any other argument; VALUE is read as JSON when it parses")
    ap.add_argument("--json", help="a JSON object of arguments, as the MCP pdf tool takes them")
    ap.add_argument("--regex", action="store_true")
    ap.add_argument("--case-sensitive", dest="caseSensitive", action="store_true")
    ap.add_argument("--whole-word", dest="wholeWord", action="store_true")
    ap.add_argument("--flatten", action="store_true")
    ap.add_argument("--auto", action="store_true")
    ap.add_argument("--strip", action="store_true")
    return ap.parse_known_args()


def main() -> int:
    a, extra = parse()
    from app.routers import mcp
    import app.services.ai
    import app.services.lists
    from app.services import plugins

    plugins.start()
    if a.action == "actions":
        print("Read:   " + ", ".join(mcp.READ_ACTIONS))
        print("Change: " + ", ".join(mcp.CHANGE_ACTIONS))
        print("Export: " + ", ".join(mcp.EXPORT_ACTIONS))
        print("Also:   render (a contact sheet PNG of up to 12 pages; --out sheet.png)")
        print("Arguments are the MCP pdf tool's; see the formpdf://guide text with: ./formpdf run guide")
        return 0
    if a.action == "guide":
        print(mcp.GUIDE)
        return 0
    if extra:
        print(f"[formpdf] unknown options: {' '.join(extra)}", file=sys.stderr)
        return 2
    args: dict = json.loads(a.json) if a.json else {}
    for f in FLAGS:
        v = getattr(a, f)
        if v is not None:
            args[f] = v
    for f in NUMBERS:
        v = getattr(a, f)
        if v is not None:
            args[f] = int(v) if v.is_integer() and f != "opacity" else v
    for f in ("regex", "caseSensitive", "wholeWord", "flatten", "auto", "strip"):
        if getattr(a, f):
            args[f] = True
    for kv in a.set:
        k, _, v = kv.partition("=")
        try:
            args[k] = json.loads(v)
        except ValueError:
            args[k] = v
    files = [here(f) for f in a.files]
    if args.get("out"):
        args["out"] = here(args["out"])
    if args.get("other"):
        args["other"] = here(args["other"])
    agent = mcp.Agent("cli", "formpdf run")
    if a.action == "render":
        if not files:
            print("[formpdf] render needs a PDF", file=sys.stderr)
            return 2
        res = asyncio.run(mcp.call_tool(agent, "render_pages", {"path": files[0], "pages": args.get("pages")}))
        if res.get("isError"):
            print(res["content"][0]["text"], file=sys.stderr)
            return 1
        out = Path(args.get("out") or here(Path(files[0]).stem + "-pages.png"))
        out.write_bytes(base64.b64decode(res["content"][1]["data"]))
        print(f"{res['content'][0]['text']} Wrote {out}")
        return 0
    if a.action == "merge" and (len(files) >= 2 or (files and not files[0].lower().endswith(".pdf"))):
        args["paths"] = files
        args.setdefault("out", here(Path(files[0]).stem + ("-merged.pdf" if len(files) > 1 else ".pdf")))
    elif files:
        args["path"] = files[0]
        if len(files) > 1:
            args["paths"] = files[1:]
    else:
        print("[formpdf] give the PDF to work on", file=sys.stderr)
        return 2
    args["action"] = a.action
    res = asyncio.run(mcp.call_tool(agent, "pdf", args))
    for part in res.get("content", []):
        if part.get("type") == "text":
            print(part["text"])
    return 1 if res.get("isError") else 0


if __name__ == "__main__":
    sys.exit(main())
