import json
import os
import secrets
import shlex
import shutil
import subprocess
import time
from pathlib import Path

from app.core import config
from app.services import terminal

INAPP_TOKEN = secrets.token_urlsafe(24)
KEEP_ENV = {"CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CONFIG_DIR"}
CANDIDATES = (".claude/local/claude", ".local/bin/claude", ".npm-global/bin/claude", ".bun/bin/claude", ".volta/bin/claude")
SYSTEM_PATHS = ("/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude")
INSTALL = "Claude Code is not installed: install it from https://claude.com/claude-code, run claude once in a terminal to sign in, then open it here again"
NOTE = ("You are Claude Code running in the agent dock inside formpdf, the PDF editor open on this computer. "
        "Work on PDFs with the formpdf MCP server's tools: start with get_context, open_pdf to show a file, the pdf tool for the job, "
        "render_pages to look before and after a change, and list_commands with run_command for anything the window can do (zoom, tabs, panels, dialogs). "
        "Changes to the open PDF land live in the window as one undoable turn. Use the formpdf-skillset skill when it is available.")


class AgentError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


_cache: dict = {"at": 0.0, "value": None}


def pref(key: str) -> str:
    value = config.read_settings().get(key)
    return value.strip() if isinstance(value, str) else ""


def child_env() -> dict:
    return {k: v for k, v in terminal.base_env().items() if not k.startswith("CLAUDE") or k in KEEP_ENV}


def _from_login_shell() -> str | None:
    if os.name == "nt":
        return None
    try:
        out = subprocess.run(terminal.login_shell() + ["-c", "command -v claude"], capture_output=True, text=True, timeout=10, env=child_env())
    except (OSError, subprocess.SubprocessError):
        return None
    found = out.stdout.strip().splitlines()[-1:] if out.returncode == 0 else []
    return found[0] if found and os.path.isabs(found[0]) else None


def _runnable(path: str) -> bool:
    p = Path(path).expanduser()
    return p.is_file() and os.access(p, os.X_OK)


def cli() -> str | None:
    chosen = pref("claudeBin")
    if chosen and _runnable(chosen):
        return str(Path(chosen).expanduser())
    found = os.environ.get("FORMPDF_CLAUDE_BIN") or shutil.which("claude")
    if found:
        return found
    home = Path.home()
    for p in [home / c for c in CANDIDATES] + [Path(s) for s in SYSTEM_PATHS]:
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return _from_login_shell()


def info(fresh: bool = False) -> dict:
    if not fresh and _cache["value"] is not None and time.time() - _cache["at"] < 60:
        return _cache["value"]
    path, version = cli(), None
    if path:
        try:
            out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=15, env=child_env())
            version = (out.stdout.strip().split() or [None])[0]
        except (OSError, subprocess.SubprocessError):
            path = None
    _cache["value"], _cache["at"] = {"installed": bool(path), "path": path, "version": version}, time.time()
    return _cache["value"]


def mcp_config() -> str:
    return json.dumps({"mcpServers": {"formpdf": {"type": "http", "url": config.engine_url() + "/mcp", "headers": {"x-formpdf-inapp": INAPP_TOKEN}}}})


def workdir() -> Path:
    raw = pref("claudeFolder") or os.environ.get("FORMPDF_AGENT_DIR", "").strip()
    folder = Path(raw).expanduser() if raw else config.data_dir() / "Agent"
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise AgentError(f"Claude Code cannot start in {folder}: {e.strerror or e}; choose another folder in Preferences, Agents", 400) from None
    return folder


def wrap(cmd: list[str]) -> list[str]:
    return cmd if os.name == "nt" else terminal.login_shell() + ["-c", "exec " + shlex.join(cmd)]


def argv(path: str, prompt: str | None, resume: str | None = None) -> list[str]:
    cmd = [path, "--mcp-config", mcp_config(), "--allowedTools", "mcp__formpdf", "--append-system-prompt", NOTE]
    if resume:
        cmd += ["--resume", resume]
    if prompt:
        cmd.append(prompt)
    return wrap(cmd)


def status() -> dict:
    tab = next((s.describe() for s in terminal.SESSIONS.values() if s.kind == "claude"), None)
    chosen = pref("claudeBin")
    note = f"{chosen} is not a program formpdf can run, so it uses the one found on this computer" if chosen and not _runnable(chosen) else ""
    return info(fresh=True) | {"folder": str(workdir()), "terminal": tab, "binNote": note, "firstMessage": pref("claudeFirstMessage")}


def open_tab(prompt: str | None = None, cols: int | None = None, rows: int | None = None, fresh: bool = False, resume: str | None = None) -> dict:
    running = next((s for s in terminal.SESSIONS.values() if s.kind == "claude" and s.alive), None)
    if running is not None and not fresh and not resume:
        if prompt:
            terminal.write(running.id, prompt + "\r")
        return running.describe()
    found = info(fresh=True)
    if not found["installed"]:
        raise AgentError(INSTALL, 400)
    prompt = prompt or pref("claudeFirstMessage") or None
    title = "Claude Code (from Chat)" if resume else "Claude Code"
    session = terminal.open_session(str(workdir()), cols or 100, rows or 30, title, argv(found["path"], prompt, resume), child_env(), "claude")
    return session.describe()
