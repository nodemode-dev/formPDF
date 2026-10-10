import hashlib
import importlib.util
import json
import re
import sys
import traceback
from pathlib import Path

from app.core import config
from app.services.pdf import actions

STATE: dict[str, dict] = {}
NAME = re.compile(r"[a-z][a-z0-9_-]{0,40}")


def plugins_dir() -> Path:
    d = config.data_dir() / "plugins"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _manifest(folder: Path) -> dict | None:
    try:
        m = json.loads((folder / "plugin.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return m if isinstance(m, dict) else None


def _file(folder: Path, rel) -> Path | None:
    if not rel:
        return None
    p = (folder / str(rel)).resolve()
    return p if p.is_file() and folder.resolve() in p.parents else None


def _hash(folder: Path, m: dict) -> str:
    h = hashlib.sha256(json.dumps(m, sort_keys=True).encode())
    for key in ("engine", "window"):
        p = _file(folder, m.get(key))
        if p is not None:
            h.update(p.read_bytes())
    return h.hexdigest()


def _consents() -> dict:
    got = config.read_settings().get("plugins")
    return got if isinstance(got, dict) else {}


def discover() -> list[dict]:
    out = []
    consents = _consents()
    for folder in sorted(p for p in plugins_dir().iterdir() if p.is_dir()):
        pid = folder.name.lower()
        m = _manifest(folder)
        if m is None or not NAME.fullmatch(pid):
            continue
        digest = _hash(folder, m)
        c = consents.get(pid) or {}
        state = "on" if c.get("allowed") and c.get("hash") == digest else "changed" if c.get("hash") and c.get("hash") != digest else "off" if c.get("hash") else "new"
        loaded = STATE.get(pid, {})
        out.append({"id": pid, "name": str(m.get("name") or pid)[:80], "version": str(m.get("version") or "")[:20], "description": str(m.get("description") or "")[:400],
                    "author": str(m.get("author") or "")[:80], "engine": bool(_file(folder, m.get("engine"))), "window": bool(_file(folder, m.get("window"))),
                    "state": state, "actions": loaded.get("actions", []), "error": loaded.get("error", ""), "hash": digest, "folder": str(folder)})
    return out


class API:
    def __init__(self, pid: str):
        self.pid = pid
        self.names: list[str] = []
        self.Field = actions.Field

    def action(self, name: str, kind: str, label: str, run, *, words=(), fields=(), ext: str = ".pdf", suffix: str = "") -> None:
        if not re.fullmatch(r"[a-z][a-z0-9_]{1,40}", name or ""):
            raise ValueError("Action names are lower case letters, digits and underscores")
        actions.register(actions.Action(name, kind, str(label)[:80], suffix, tuple(words), ext, tuple(fields), run, owner=self.pid))
        self.names.append(name)


def load(pid: str) -> None:
    unload(pid)
    folder = plugins_dir() / pid
    m = _manifest(folder) or {}
    STATE[pid] = {"actions": [], "error": ""}
    path = _file(folder, m.get("engine"))
    if path is None:
        return
    api = API(pid)
    try:
        spec = importlib.util.spec_from_file_location(f"formpdf_plugin_{pid.replace('-', '_')}", path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        if not callable(getattr(mod, "register", None)):
            raise ValueError("engine module has no register(api) function")
        mod.register(api)
    except Exception as e:
        for n in api.names:
            actions.unregister(n)
        STATE[pid] = {"actions": [], "error": f"{type(e).__name__}: {e}"[:400], "trace": traceback.format_exc()[-2000:]}
        return
    STATE[pid] = {"actions": api.names, "error": ""}


def unload(pid: str) -> None:
    for n in STATE.get(pid, {}).get("actions", []):
        actions.unregister(n)
    STATE.pop(pid, None)
    sys.modules.pop(f"formpdf_plugin_{pid.replace('-', '_')}", None)


def allow(pid: str, allowed: bool) -> dict:
    item = next((p for p in discover() if p["id"] == pid), None)
    if item is None:
        raise ValueError(f"There is no plug-in {pid} in {plugins_dir()}")
    consents = _consents()
    consents[pid] = {"allowed": bool(allowed), "hash": item["hash"]}
    config.write_settings({"plugins": consents})
    if allowed:
        load(pid)
    else:
        unload(pid)
    return next(p for p in discover() if p["id"] == pid)


def window_file(pid: str) -> Path | None:
    item = next((p for p in discover() if p["id"] == pid), None)
    if item is None or item["state"] != "on":
        return None
    folder = plugins_dir() / pid
    return _file(folder, (_manifest(folder) or {}).get("window"))


def start() -> None:
    for p in discover():
        if p["state"] == "on":
            load(p["id"])
