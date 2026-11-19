import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

from app.core import config
from app.services import claude_code, terminal
from app.services.claude_code import AgentError

TOKEN_ENV = "FORMPDF_INAPP_TOKEN"
HEADER = "x-formpdf-inapp"
CLAUDE_INSTALL = "irm https://claude.ai/install.ps1 | iex" if sys.platform == "win32" else "curl -fsSL https://claude.ai/install.sh | bash"
CLAUDE_KEYS = ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")
PROGRAMS = {
    "codex": {"bin": "codex", "title": "Codex", "client": "Codex in formpdf", "install": "npm install -g @openai/codex", "keys": ("OPENAI_API_KEY",)},
    "cursor": {"bin": "cursor-agent", "title": "Cursor", "client": "Cursor in formpdf", "install": "curl https://cursor.com/install -fsS | bash", "keys": ("CURSOR_API_KEY",)},
}
_cache: dict = {"at": 0.0, "value": None}


def find(kind: str) -> str | None:
    binary = PROGRAMS[kind]["bin"]
    found = shutil.which(binary, path=terminal.base_env().get("PATH"))
    if found or os.name == "nt":
        return found
    try:
        out = subprocess.run(terminal.login_shell() + ["-c", f"command -v {shlex.quote(binary)}"], capture_output=True, text=True, timeout=10,
                             env=claude_code.child_env(), stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    lines = out.stdout.strip().splitlines()[-1:] if out.returncode == 0 else []
    return lines[0] if lines and os.path.isabs(lines[0]) and os.access(lines[0], os.X_OK) else None


def _version(path: str) -> str | None:
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=5, env=claude_code.child_env(), stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    hit = re.search(r"\d+(?:\.\d+)+[\w.+-]*", out.stdout)
    return hit.group(0) if hit else None


def _claude_signed_in(path: str) -> bool | None:
    if any(os.environ.get(k) for k in CLAUDE_KEYS):
        return True
    try:
        out = subprocess.run([path, "auth", "status"], capture_output=True, text=True, timeout=15, env=claude_code.child_env(), stdin=subprocess.DEVNULL)
        data = json.loads(out.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return bool(data.get("loggedIn")) if isinstance(data, dict) and "loggedIn" in data else None


def status(fresh: bool = False) -> dict:
    if not fresh and _cache["value"] is not None and time.time() - _cache["at"] < 60:
        return _cache["value"]
    found = claude_code.info(fresh)
    out = {"claude": {"installed": found["installed"], "path": found["path"], "version": found["version"], "install": CLAUDE_INSTALL, "title": "Claude Code",
                      "signedIn": _claude_signed_in(found["path"]) if found["installed"] else None}}
    for kind, p in PROGRAMS.items():
        path = find(kind)
        out[kind] = {"installed": path is not None, "path": path, "version": _version(path) if path else None, "install": p["install"], "title": p["title"],
                     "signedIn": True if path and any(os.environ.get(k) for k in p["keys"]) else None}
    _cache["value"], _cache["at"] = out, time.time()
    return out


def codex_args() -> list[str]:
    url = config.engine_url() + "/mcp"
    return ["-c", f"mcp_servers.formpdf.url={json.dumps(url)}", "-c", f"mcp_servers.formpdf.env_http_headers={{{json.dumps(HEADER)}={json.dumps(TOKEN_ENV)}}}"]


def cursor_file(folder: Path) -> str:
    path = folder / ".cursor" / "mcp.json"
    entry = {"url": config.engine_url() + "/mcp", "headers": {HEADER: "${env:" + TOKEN_ENV + "}"}}
    body = {"mcpServers": {"formpdf": entry}}
    try:
        if path.is_file():
            have = json.loads(path.read_text(encoding="utf-8"))
            if have == body:
                return "file"
            if not isinstance(have, dict) or list(have) != ["mcpServers"] or list(have["mcpServers"]) != ["formpdf"] or have["mcpServers"]["formpdf"] | {"url": ""} != entry | {"url": ""}:
                return "not written"
            path.unlink()
        path.parent.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(body, indent=2))
    except (OSError, ValueError, TypeError):
        return "not written"
    return "file"


def open_tab(kind: str, cols: int | None = None, rows: int | None = None, fresh: bool = False) -> dict:
    p = PROGRAMS[kind]
    running = next((s for s in terminal.SESSIONS.values() if s.kind == kind and s.alive), None)
    if running is not None and not fresh:
        return running.describe()
    path = find(kind)
    if path is None:
        raise AgentError(f"{p['title']} is not installed on this computer. Install it with: {p['install']}", 404)
    folder = claude_code.workdir()
    how, extra = ("arguments", codex_args()) if kind == "codex" else (cursor_file(folder), [])
    token = claude_code.issue_env(p["client"])
    try:
        session = terminal.open_session(str(folder), cols or 100, rows or 30, p["title"], claude_code.wrap([path] + extra), claude_code.child_env() | {TOKEN_ENV: token}, kind)
    except BaseException:
        claude_code.revoke(token)
        raise
    session.on_close.append(lambda: claude_code.revoke(token))
    return session.describe() | {"mcp": how}
