import json
import os
import subprocess
import time
import uuid
from pathlib import Path

from app.core import config
from app.services import agent_lookup, claude_code, terminal
from app.services.claude_code import AgentError

TOKEN_ENV = "FORMPDF_INAPP_TOKEN"
HEADER = "x-formpdf-inapp"
CLAUDE_INSTALL = agent_lookup.install("claude")
CLAUDE_KEYS = ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")
PROGRAMS = {
    "codex": {"bin": "codex", "title": "Codex", "client": "Codex in formpdf", "install": agent_lookup.install("codex"), "keys": ("OPENAI_API_KEY",)},
    "cursor": {"bin": "cursor-agent", "title": "Cursor", "client": "Cursor in formpdf", "install": agent_lookup.install("cursor"), "keys": ("CURSOR_API_KEY",)},
    "antigravity": {"bin": "agy", "title": "Antigravity", "client": "Antigravity in formpdf", "install": agent_lookup.install("antigravity"), "keys": ()},
}
_cache: dict = {"at": 0.0, "value": None}


def find(kind: str) -> str | None:
    return claude_code.located(kind).path


def _claude_signed_in(path: str) -> bool | None:
    if any(os.environ.get(k) for k in CLAUDE_KEYS):
        return True
    try:
        out = agent_lookup.run([path, "auth", "status"], claude_code.child_env(path), 15.0)
        data = json.loads(out.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return bool(data.get("loggedIn")) if isinstance(data, dict) and "loggedIn" in data else None


def status(fresh: bool = False) -> dict:
    if not fresh and _cache["value"] is not None and time.time() - _cache["at"] < 60:
        return _cache["value"]
    found = claude_code.info(fresh)
    out = {"claude": found | {"install": CLAUDE_INSTALL, "title": "Claude Code", "signedIn": _claude_signed_in(found["path"]) if found["installed"] else None}}
    for kind, p in PROGRAMS.items():
        seen = claude_code.located(kind, fresh)
        out[kind] = agent_lookup.answer(seen, p["install"], claude_code.otherwise(kind)) | {
            "install": p["install"], "title": p["title"], "signedIn": True if seen.state == "runs" and any(os.environ.get(k) for k in p["keys"]) else None}
    _cache["value"], _cache["at"] = out, time.time()
    return out


def codex_args() -> list[str]:
    url = config.engine_url() + "/mcp"
    return ["-c", f"mcp_servers.formpdf_tab.url={json.dumps(url)}", "-c", f"mcp_servers.formpdf_tab.env_http_headers={{{json.dumps(HEADER)}={json.dumps(TOKEN_ENV)}}}"]


def cursor_file(folder: Path) -> str:
    path = folder / ".cursor" / "mcp.json"
    entry = {"url": config.engine_url() + "/mcp", "headers": {HEADER: "${env:" + TOKEN_ENV + "}"}}
    body = {"mcpServers": {"formpdf_tab": entry}}
    try:
        if path.is_file():
            have = json.loads(path.read_text(encoding="utf-8"))
            if have == body:
                return "file"
            if not isinstance(have, dict) or list(have) != ["mcpServers"] or list(have["mcpServers"]) != ["formpdf_tab"] or have["mcpServers"]["formpdf_tab"] | {"url": ""} != entry | {"url": ""}:
                return "not written"
            path.unlink()
        path.parent.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(body, indent=2))
    except (OSError, ValueError, TypeError):
        return "not written"
    return "file"


def antigravity_file(folder: Path) -> Path:
    return folder / ".agents" / "mcp_config.json"


def _servers(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8") or "{}") if path.exists() else {}
    if not isinstance(data, dict) or not isinstance(data.get("mcpServers", {}), dict):
        raise ValueError(f"{path} is not an MCP servers file formpdf can read")
    return data


def _replace(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + f".part-{os.getpid()}")
    with os.fdopen(os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
        f.write(json.dumps(data, indent=2) + "\n")
    os.replace(part, path)


def antigravity_entry(folder: Path, token: str) -> str:
    path = antigravity_file(folder)
    try:
        data = _servers(path)
        data.setdefault("mcpServers", {})["formpdf_tab"] = {"serverUrl": config.engine_url() + "/mcp", "headers": {HEADER: token}}
        _replace(path, data)
    except (OSError, ValueError, TypeError):
        return "not written"
    return "file"


def antigravity_entry_gone(folder: Path, token: str) -> None:
    path = antigravity_file(folder)
    try:
        data = _servers(path)
        entry = data.get("mcpServers", {}).get("formpdf_tab")
        if not isinstance(entry, dict) or (entry.get("headers") or {}).get(HEADER) != token:
            return
        del data["mcpServers"]["formpdf_tab"]
        _replace(path, data)
    except (OSError, ValueError, TypeError):
        return


def antigravity_folder() -> Path:
    folder = config.data_dir() / "agent-tabs" / "antigravity" / uuid.uuid4().hex[:12]
    try:
        folder.mkdir(parents=True, mode=0o700)
    except OSError as e:
        raise AgentError(f"Antigravity cannot start in {folder}: {e.strerror or e}", 400) from None
    return folder


def antigravity_folder_gone(folder: Path, token: str) -> None:
    antigravity_entry_gone(folder, token)
    path = antigravity_file(folder)
    try:
        if path.exists() and _servers(path) == {"mcpServers": {}}:
            path.unlink()
    except (OSError, ValueError, TypeError):
        return
    for emptied in (path.parent, folder):
        try:
            emptied.rmdir()
        except OSError:
            return


def sweep_antigravity_folders() -> list[str]:
    root = config.data_dir() / "agent-tabs" / "antigravity"
    owned = {os.path.normcase(os.path.abspath(s.cwd)) for s in list(terminal.SESSIONS.values()) if s.kind == "antigravity"}
    try:
        found = sorted(root.iterdir()) if root.is_dir() and not root.is_symlink() else []
    except OSError:
        return []
    swept = []
    for folder in found:
        if len(folder.name) != 12 or any(c not in "0123456789abcdef" for c in folder.name) or folder.is_symlink() or not folder.is_dir():
            continue
        if os.path.normcase(os.path.abspath(folder)) in owned:
            continue
        path = antigravity_file(folder)
        try:
            if path.parent.is_symlink() or path.is_symlink():
                continue
            for part in path.parent.glob(path.name + ".part-*") if path.parent.is_dir() else []:
                if part.is_file() and not part.is_symlink():
                    part.unlink()
            data = _servers(path)
            if "formpdf_tab" in data.get("mcpServers", {}):
                del data["mcpServers"]["formpdf_tab"]
                _replace(path, data)
            if path.exists() and data == {"mcpServers": {}}:
                path.unlink()
        except (OSError, ValueError, TypeError):
            continue
        for emptied in (path.parent, folder):
            try:
                emptied.rmdir()
            except FileNotFoundError:
                continue
            except OSError:
                break
        if not folder.exists():
            swept.append(folder.name)
    return swept


def open_tab(kind: str, cols: int | None = None, rows: int | None = None, fresh: bool = False) -> dict:
    p = PROGRAMS[kind]
    running = next((s for s in terminal.SESSIONS.values() if s.kind == kind and s.alive), None)
    if running is not None and not fresh:
        return running.describe()
    found = claude_code.usable(kind)
    if found.state != "runs":
        raise AgentError(agent_lookup.sentence(found, p["install"], claude_code.otherwise(kind)), 404)
    path = found.path
    folder = antigravity_folder() if kind == "antigravity" else claude_code.workdir()
    token = claude_code.issue_env(p["client"])
    try:
        how, extra = ("arguments", codex_args()) if kind == "codex" else (cursor_file(folder), []) if kind == "cursor" else (antigravity_entry(folder, token), [])
        session = terminal.open_session(str(folder), cols or 100, rows or 30, p["title"], claude_code.wrap([path] + extra), claude_code.child_env(path, {TOKEN_ENV: token}), kind)
    except BaseException:
        claude_code.revoke(token)
        if kind == "antigravity":
            antigravity_folder_gone(folder, token)
        raise
    session.on_close.append(lambda: claude_code.revoke(token))
    if kind == "antigravity":
        session.on_close.append(lambda: antigravity_folder_gone(folder, token))
    return session.describe() | {"mcp": how}
