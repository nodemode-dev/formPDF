import hashlib
import json
import re
import shutil
import threading
import time
from pathlib import Path

from app.core import config, ids

ID_RE = re.compile(r"pdf_[a-z0-9]{10}")
RECENT_LIMIT = 24
_lock = threading.Lock()


class NotFound(KeyError):
    pass


def root() -> Path:
    return config.pdf_dir()


def valid(doc_id: str) -> bool:
    return bool(ID_RE.fullmatch(doc_id or ""))


def path_of(doc_id: str) -> Path:
    if not valid(doc_id):
        raise NotFound(doc_id)
    path = root() / f"{doc_id}.pdf"
    if not path.is_file():
        raise NotFound(doc_id)
    return path


def meta(doc_id: str) -> dict:
    try:
        return json.loads((root() / f"{doc_id}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"id": doc_id, "name": f"{doc_id}.pdf", "root": doc_id}


def _write_meta(doc_id: str, data: dict) -> None:
    tmp = root() / f"{doc_id}.json.tmp"
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(root() / f"{doc_id}.json")


def clean_name(name: str) -> str:
    base = Path(str(name or "document.pdf").replace("\\", "/")).name.strip() or "document.pdf"
    base = re.sub(r"[\x00-\x1f<>:\"|?*]", "_", base)
    return base if base.lower().endswith(".pdf") else f"{base}.pdf"


def new_id() -> str:
    while True:
        cand = ids.short("pdf_", 10)
        if not (root() / f"{cand}.pdf").exists():
            return cand


def target(name: str, parent: str | None = None) -> tuple[str, Path]:
    doc_id = new_id()
    parent_meta = meta(parent) if parent else None
    data = {"id": doc_id, "name": clean_name(name or (parent_meta or {}).get("name", "document.pdf")), "parent": parent,
            "root": (parent_meta or {}).get("root", parent) if parent else doc_id, "created": time.time()}
    for key in ("path", "saved"):
        if parent_meta and parent_meta.get(key):
            data[key] = parent_meta[key]
    _write_meta(doc_id, data)
    return doc_id, root() / f"{doc_id}.pdf"


def update_meta(doc_id: str, **patch) -> dict:
    data = {**meta(doc_id), **patch}
    _write_meta(doc_id, data)
    return data


def derive(parent: str) -> tuple[str, Path]:
    return target(meta(parent).get("name", "document.pdf"), parent)


def _hashes() -> dict:
    try:
        return json.loads((root() / "hashes.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def put_bytes(data: bytes, name: str, path: str | None = None) -> str:
    digest = hashlib.sha256(data).hexdigest()
    with _lock:
        known = _hashes().get(digest)
        if known and valid(known) and (root() / f"{known}.pdf").is_file() and meta(known).get("name") == clean_name(name):
            if path:
                update_meta(known, path=path)
            return known
        doc_id, out = target(name)
        tmp = out.with_suffix(".pdf.tmp")
        tmp.write_bytes(data)
        tmp.replace(out)
        table = _hashes()
        table[digest] = doc_id
        hp = root() / "hashes.json"
        hp.with_suffix(".tmp").write_text(json.dumps(table), encoding="utf-8")
        hp.with_suffix(".tmp").replace(hp)
    if path:
        update_meta(doc_id, path=path)
    return doc_id


def _redaction_file(doc_id: str) -> Path:
    digest = hashlib.sha256((root() / f"{doc_id}.pdf").read_bytes()).hexdigest()
    return root() / f"redaction-{digest[:32]}.json"


def keep_redaction(doc_id: str, log: dict) -> None:
    """Keeps a redaction log (never the removed words) with the version, and by the bytes, so reopening the saved file finds it."""
    update_meta(doc_id, redaction=log)
    try:
        _redaction_file(doc_id).write_text(json.dumps(log), encoding="utf-8")
    except OSError:
        pass


def redaction(doc_id: str) -> dict | None:
    kept = meta(doc_id).get("redaction")
    if kept:
        return kept
    try:
        return json.loads(_redaction_file(doc_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def adopt(src: Path, name: str, parent: str | None = None) -> str:
    doc_id, out = target(name, parent)
    shutil.move(str(src), out)
    return doc_id


def discard(doc_id: str) -> None:
    from . import core

    core.forget(root() / f"{doc_id}.pdf")
    for suffix in (".pdf", ".json"):
        try:
            (root() / f"{doc_id}{suffix}").unlink()
        except OSError:
            pass


def _recent_path() -> Path:
    return root() / "recent.json"


def recent() -> list[dict]:
    try:
        items = json.loads(_recent_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [i for i in items if isinstance(i, dict) and valid(i.get("id", "")) and (root() / f"{i['id']}.pdf").is_file()]


def remember(doc_id: str, pages: int) -> dict:
    m = meta(doc_id)
    key = m.get("root") or doc_id
    entry = {"key": key, "id": doc_id, "name": m.get("name", "document.pdf"), "pages": pages, "opened": time.time()}
    if m.get("path"):
        entry["path"] = m["path"]
    with _lock:
        items = [i for i in recent() if i.get("key") != key]
        items.insert(0, entry)
        tmp = _recent_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(items[:RECENT_LIMIT]), encoding="utf-8")
        tmp.replace(_recent_path())
    return entry


def forget(key: str) -> None:
    with _lock:
        items = [i for i in recent() if i.get("key") != key]
        tmp = _recent_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(items), encoding="utf-8")
        tmp.replace(_recent_path())
