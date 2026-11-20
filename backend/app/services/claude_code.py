import hmac
import json
import os
import secrets
import sys
import time
from pathlib import Path

from app.core import config
from app.services import agent_lookup, terminal

TOKENS: dict[str, Path | None] = {}
LABELS: dict[str, str] = {}
OVERRIDES = {"claude": ("FORMPDF_CLAUDE_BIN",), "codex": ("FORMPDF_CODEX_BIN",), "cursor": ("FORMPDF_CURSOR_BIN",), "antigravity": ("FORMPDF_ANTIGRAVITY_BIN",)}
SETTINGS = {"claude": "claudeBin"}
OTHERWISE = "give its path in Preferences, Agents"
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


def setting(kind: str) -> str | None:
    return pref(SETTINGS[kind]) if kind in SETTINGS else None


def otherwise(kind: str) -> str:
    return OTHERWISE if kind in SETTINGS else ""


def child_env(path: str | None = None, extra: dict | None = None) -> dict:
    front = [] if os.name == "nt" or getattr(sys, "frozen", False) else [config.REPO_DIR]
    return agent_lookup.child_env(path, base=terminal.base_env(), extra=extra, front=front, shell_timeout=10.0)


def located(kind: str, fresh: bool = False) -> agent_lookup.Found:
    found = agent_lookup.find(kind, setting=setting(kind), override_vars=OVERRIDES.get(kind, ()), shell_timeout=10.0, fresh=fresh)
    return agent_lookup.check(found, child_env(found.path), 15.0, fresh)


def usable(kind: str) -> agent_lookup.Found:
    found = located(kind)
    return found if found.state == "runs" else located(kind, fresh=True)


def said(found: agent_lookup.Found) -> str:
    return agent_lookup.sentence(found, agent_lookup.install(found.program), otherwise(found.program))


def cli() -> str | None:
    return located("claude").path


def info(fresh: bool = False) -> dict:
    if not fresh and _cache["value"] is not None and time.time() - _cache["at"] < 60:
        return _cache["value"]
    found = located("claude", fresh)
    _cache["value"], _cache["at"] = agent_lookup.answer(found, agent_lookup.install("claude"), OTHERWISE), time.time()
    return _cache["value"]


def issue() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    folder = config.data_dir() / "AgentTokens"
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = folder / f"mcp-{secrets.token_hex(8)}.json"
    body = json.dumps({"mcpServers": {"formpdf_tab": {"type": "http", "url": config.engine_url() + "/mcp", "headers": {"x-formpdf-inapp": token}}}})
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
    return agent_lookup.start_argv(cmd)


def argv(path: str, prompt: str | None, resume: str | None, mcp_file: str) -> list[str]:
    cmd = [path, "--mcp-config", mcp_file, "--allowedTools", "mcp__formpdf_tab", "--append-system-prompt", NOTE]
    if resume:
        cmd += ["--resume", resume]
    if prompt:
        cmd.append(prompt)
    return wrap(cmd)


def status() -> dict:
    tab = next((s.describe() for s in terminal.SESSIONS.values() if s.kind == "claude"), None)
    chosen = pref("claudeBin")
    note = f"{chosen} is not a program formpdf can run, so it uses the one found on this computer" if chosen and not agent_lookup.runnable(chosen) else ""
    return info(fresh=True) | {"folder": str(workdir()), "terminal": tab, "binNote": note, "firstMessage": pref("claudeFirstMessage")}


def open_tab(prompt: str | None = None, cols: int | None = None, rows: int | None = None, fresh: bool = False, resume: str | None = None) -> dict:
    running = next((s for s in terminal.SESSIONS.values() if s.kind == "claude" and s.alive), None)
    if running is not None and not fresh and not resume:
        if prompt:
            terminal.write(running.id, prompt + "\r")
        return running.describe()
    found = info(fresh=True)
    if not found["installed"]:
        raise AgentError(found["said"], 400)
    prompt = prompt or pref("claudeFirstMessage") or None
    title = "Claude Code (from Chat)" if resume else "Claude Code"
    token, mcp_file = issue()
    try:
        session = terminal.open_session(str(workdir()), cols or 100, rows or 30, title, argv(found["path"], prompt, resume, mcp_file), child_env(found["path"]), "claude")
    except BaseException:
        revoke(token)
        raise
    session.on_close.append(lambda: revoke(token))
    return session.describe()
