import json
import time

from app.core import config
from app.services.pdf import docs

FIELDS = ("id", "key", "name", "page", "tab", "dirty", "path", "pages")
_last: dict = {"sig": None, "at": 0.0}


def _path():
    return config.data_dir() / "session.json"


def _write(data: dict) -> None:
    tmp = _path().with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(_path())
    except OSError:
        pass


def remember(doc: dict) -> None:
    state = {k: doc.get(k) for k in FIELDS}
    sig = (state["id"], state["tab"], bool(state["dirty"]))
    now = time.monotonic()
    if sig == _last["sig"] and now - _last["at"] < 2.0:
        return
    _last.update(sig=sig, at=now)
    _write({"doc": state, "at": time.time()})


def clear() -> None:
    _last.update(sig=None, at=0.0)
    _write({"doc": None, "at": time.time()})


def read() -> dict:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"doc": None}
    doc = data.get("doc") if isinstance(data, dict) else None
    if not isinstance(doc, dict) or not docs.valid(str(doc.get("id") or "")):
        return {"doc": None}
    try:
        docs.path_of(doc["id"])
    except docs.NotFound:
        return {"doc": None}
    return {"doc": doc, "at": data.get("at"), "recover": bool(doc.get("dirty"))}
