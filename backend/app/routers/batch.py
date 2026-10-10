import asyncio
import csv
import io
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from app.core import config
from app.routers import mcp
from app.services.pdf import actions

router = APIRouter()
JOBS: dict[str, dict] = {}
TASKS: set = set()
KEEP = 20


def _inbox() -> Path:
    p = config.data_dir() / "Batch"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _prune(max_age: float = 86400) -> None:
    busy = {str(Path(r.get("path", "")).parent) for j in JOBS.values() if j["state"] == "running" for r in j["rows"]}
    for d in _inbox().iterdir():
        try:
            if d.is_dir() and str(d) not in busy and time.time() - d.stat().st_mtime > max_age:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            continue


def _safe(name: str) -> str:
    return re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", name).strip(" .") or "document.pdf"


def _nest(args: dict) -> dict:
    out: dict = {}
    for k, v in args.items():
        if v in (None, ""):
            continue
        parts = str(k).split(".")
        d = out
        for p in parts[:-1]:
            d = d.setdefault(p, {})
        d[parts[-1]] = v
    return out


def _target(outdir: Path, act, stem: str, used: set[str]) -> Path | None:
    if act.kind == "export" and not act.ext:
        return outdir
    name = f"{stem}{act.ext}" if act.kind == "export" else f"{stem}-{actions.SUFFIX.get(act.name, act.name)}.pdf"
    base, n = name, 2
    while name.lower() in used or (outdir / name).exists():
        name = re.sub(r"(\.[^.]+)$", f" ({n})\\1", base)
        n += 1
    used.add(name.lower())
    return outdir / name


@router.post("/batch/upload")
async def upload(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if len(data) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"{file.filename} is larger than 1 GB")
    if b"%PDF-" not in data[:1024]:
        raise HTTPException(415, f"{file.filename or 'That file'} is not a PDF")
    await asyncio.to_thread(_prune)
    folder = _inbox() / uuid.uuid4().hex[:12]
    folder.mkdir()
    dest = folder / _safe(file.filename or "document.pdf")
    await asyncio.to_thread(dest.write_bytes, data)
    return {"path": str(dest), "name": dest.name, "bytes": len(data)}


@router.post("/batch/run")
async def run(body: dict) -> dict:
    act = actions.get(str(body.get("action") or ""))
    if act is None or not act.batch:
        raise HTTPException(400, "Choose an action that can run on many files")
    paths = [Path(str(p)).expanduser() for p in body.get("paths") or []]
    if not paths:
        raise HTTPException(400, "Add at least one PDF")
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        raise HTTPException(404, f"{missing[0]} does not exist")
    if body.get("out"):
        outdir = Path(str(body["out"])).expanduser()
        if not outdir.is_dir():
            raise HTTPException(400, f"{outdir} is not a folder")
    else:
        outdir = config.exports_dir() / f"Batch {time.strftime('%Y-%m-%d %H%M%S')} {act.label}"
        outdir.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex[:10]
    rows = [{"key": f"{i}", "name": p.name, "path": str(p), "state": "waiting", "text": "", "outputs": []} for i, p in enumerate(paths)]
    JOBS[job_id] = {"id": job_id, "action": act.name, "label": act.label, "state": "running", "done": 0, "total": len(paths), "out": str(outdir),
                    "rows": rows, "started": time.time()}
    for old in sorted(JOBS, key=lambda k: JOBS[k]["started"])[:-KEEP]:
        JOBS.pop(old, None)
    task = asyncio.create_task(_work(JOBS[job_id], act, paths, _nest(dict(body.get("args") or {})), outdir))
    TASKS.add(task)
    task.add_done_callback(TASKS.discard)
    return {"id": job_id, "out": str(outdir), "total": len(paths)}


async def _work(job: dict, act, paths: list[Path], args: dict, outdir: Path) -> None:
    agent = mcp.Agent("batch", "Batch")
    used: set[str] = set()
    bates = _bates(act, args)
    number = bates["start"] if bates else 0
    ranges: list[tuple[str, str, str, str]] = []
    for row, p in zip(job["rows"], paths):
        row["state"] = "running"
        target = _target(outdir, act, p.stem, used)
        call = {**args, "action": act.name, "path": str(p), "out": str(target)}
        if bates:
            call["bates"] = {k: bates[k] for k in ("prefix", "suffix", "digits")} | {"start": number}
        try:
            res = await mcp.t_pdf(agent, call)
        except mcp.ToolError as exc:
            res = mcp._fail(str(exc))
        except Exception as exc:
            res = mcp._fail(f"{type(exc).__name__}: {exc}")
        text = " ".join(part.get("text", "") for part in res.get("content", []) if part.get("type") == "text")
        data = res.get("structuredContent") or {}
        row["state"] = "failed" if res.get("isError") else "done"
        row["text"] = text[:400]
        row["outputs"] = [str(x) for x in (data.get("paths") or ([data["path"]] if data.get("path") else []))]
        if bates and not res.get("isError"):
            count = await asyncio.to_thread(_numbered, p, args)
            if count:
                ranges.append((p.name, Path(row["outputs"][0]).name if row["outputs"] else "", _bates_text(bates, number), _bates_text(bates, number + count - 1)))
                row["note"] = f"{ranges[-1][2]} to {ranges[-1][3]}"
                if bates["across"]:
                    number += count
        job["done"] += 1
    if ranges:
        log = outdir / "Bates numbers.csv"
        with open(log, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerows([("File", "Numbered copy", "First", "Last"), *ranges])
        job["rows"][-1]["outputs"].append(str(log))
    job["state"] = "done"
    job["finished"] = time.time()


def _bates(act, args: dict) -> dict | None:
    raw = args.pop("bates", None) if act.name == "header_footer" else None
    if not isinstance(raw, dict) or raw.get("on") in (False, None, "", 0, "false"):
        return None
    return {"prefix": str(raw.get("prefix") or ""), "suffix": str(raw.get("suffix") or ""), "digits": int(raw.get("digits") or 6),
            "start": int(raw.get("start") or 1), "across": raw.get("across") not in (False, 0, "false")}


def _bates_text(b: dict, n: int) -> str:
    return f"{b['prefix']}{str(n).zfill(b['digits'])}{b['suffix']}"


def _numbered(path: Path, args: dict) -> int:
    from app.services import pdf as pdfsvc

    n = pdfsvc.page_count(path)
    idx = pdfsvc.parse_pages(args.get("pages"), n) if args.get("pages") else list(range(1, n + 1))
    apply = str(args.get("apply") or "all")
    return sum(1 for i in idx if apply == "all" or (apply == "odd") == (i % 2 == 1))


@router.get("/batch/{job_id}")
def status(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "That batch is no longer known; the engine may have restarted")
    return job


@router.get("/batch/{job_id}/zip")
def download(job_id: str) -> Response:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "That batch is no longer known; the engine may have restarted")
    files = [Path(o) for r in job["rows"] for o in r["outputs"] if Path(o).is_file()]
    if not files:
        raise HTTPException(404, "The batch wrote no files")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(f, f.name)
    name = _safe(f"{job['label']} batch.zip")
    return Response(buf.getvalue(), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})
