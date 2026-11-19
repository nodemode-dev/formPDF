import hmac
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import time
from pathlib import Path

from app.core import config
from app.services import terminal

TOKENS: dict[str, Path | None] = {}
LABELS: dict[str, str] = {}
KEEP_ENV = {"CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CONFIG_DIR"}
CANDIDATES = (".claude/local/claude", ".local/bin/claude", ".npm-global/bin/claude", ".bun/bin/claude", ".volta/bin/claude")
SYSTEM_PATHS = ("/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude")
INSTALL = "Claude Code is not installed: install it from https://claude.com/claude-code, run claude once in a terminal to sign in, then open it here again"
NOTE = ("You are Claude Code running in the agent dock inside formpdf, the PDF editor open on this computer. "
        "Work on PDFs with the formpdf MCP server's tools: start with get_context, open_pdf to show a file, the pdf tool for the job, "
        "render_pages to look before and after a change, and list_commands with run_command for anything the window can do (zoom, tabs, panels, dialogs). "
        "Changes to the open PDF land live in the window as one undoable turn. "
        "To rebuild or restructure a document (keep only some parts, relabel sections, make lists, shrink a picture, fit it on N pages), "
        "call pdf with action blocks, then once with action compose using the block ids, then render_pages and save; do not retype the text or remove it piece by piece. "
        "Use the formpdf-skillset skill when it is available.")


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
    for flags in (["-c"], ["-i", "-c"]):
        try:
            out = subprocess.run(terminal.login_shell() + flags + ["command -v claude"], capture_output=True, text=True, timeout=10, env=child_env(), stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            continue
        found = out.stdout.strip().splitlines()[-1:] if out.returncode == 0 else []
        if found and os.path.isabs(found[0]):
            return found[0]
    return None


def _runnable(path: str) -> bool:
    p = Path(path).expanduser()
    return p.is_file() and os.access(p, os.X_OK)


def _version_key(p: Path) -> tuple:
    parts = re.findall(r"\d+", p.name)
    return tuple(int(x) for x in parts) or (0,)


def _managed() -> list[Path]:
    home = Path.home()
    found: list[Path] = []
    for base, tail in ((home / ".nvm" / "versions" / "node", "bin"), (home / ".local" / "share" / "fnm" / "node-versions", "installation/bin"),
                       (home / "Library" / "Application Support" / "fnm" / "node-versions", "installation/bin"),
                       (home / ".asdf" / "installs" / "nodejs", "bin"), (home / ".local" / "share" / "mise" / "installs" / "node", "bin")):
        try:
            versions = sorted((d for d in base.iterdir() if d.is_dir()), key=_version_key, reverse=True)
        except OSError:
            continue
        found += [d / tail / "claude" for d in versions]
    return found + [home / ".claude" / "bin" / "claude"]


def cli() -> str | None:
    chosen = pref("claudeBin")
    if chosen and _runnable(chosen):
        return str(Path(chosen).expanduser())
    found = os.environ.get("FORMPDF_CLAUDE_BIN") or shutil.which("claude")
    if found:
        return found
    home = Path.home()
    for p in [home / c for c in CANDIDATES] + [Path(s) for s in SYSTEM_PATHS] + _managed():
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


def issue() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    folder = config.data_dir() / "AgentTokens"
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = folder / f"mcp-{secrets.token_hex(8)}.json"
    body = json.dumps({"mcpServers": {"formpdf": {"type": "http", "url": config.engine_url() + "/mcp", "headers": {"x-formpdf-inapp": token}}}})
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(body)
    TOKENS[token] = path
    return token, str(path)


def issue_env(name: str) -> str:
    token = secrets.token_urlsafe(32)
    TOKENS[token] = None
    LABELS[token] = name
    return token


def label(value) -> str:
    if not isinstance(value, str) or not value:
        return ""
    return next((LABELS[t] for t in list(LABELS) if hmac.compare_digest(value.encode("utf-8"), t.encode("utf-8"))), "")


def revoke(token: str) -> None:
    path = TOKENS.pop(token, None)
    LABELS.pop(token, None)
    if path is not None:
        try:
            path.unlink()
        except OSError:
            pass


def is_inapp(value) -> bool:
    if not isinstance(value, str) or not value:
        return False
    return any(hmac.compare_digest(value.encode("utf-8"), t.encode("utf-8")) for t in list(TOKENS))


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


def argv(path: str, prompt: str | None, resume: str | None, mcp_file: str) -> list[str]:
    cmd = [path, "--mcp-config", mcp_file, "--allowedTools", "mcp__formpdf", "--append-system-prompt", NOTE]
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
    token, mcp_file = issue()
    try:
        session = terminal.open_session(str(workdir()), cols or 100, rows or 30, title, argv(found["path"], prompt, resume, mcp_file), child_env(), "claude")
    except BaseException:
        revoke(token)
        raise
    session.on_close.append(lambda: revoke(token))
    return session.describe()
