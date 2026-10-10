#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8198
STATE = {"session": None, "version": None, "started": False}


def say(text: str) -> None:
    print(f"[formpdf mcp] {text}", file=sys.stderr, flush=True)


def data_dir() -> Path:
    raw = os.environ.get("FORMPDF_DATA_DIR")
    return Path(raw).expanduser() if raw else Path.home() / "Formpdf"


def port() -> int:
    if os.environ.get("FORMPDF_PORT"):
        return int(os.environ["FORMPDF_PORT"])
    try:
        return int(json.loads((data_dir() / "engine.json").read_text(encoding="utf-8")).get("port") or DEFAULT_PORT)
    except (OSError, ValueError, TypeError):
        return DEFAULT_PORT


def base() -> str:
    return f"http://127.0.0.1:{port()}"


def alive(timeout: float = 2) -> bool:
    try:
        with urllib.request.urlopen(base() + "/api/health", timeout=timeout) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def engine_command() -> tuple[list[str], str] | None:
    exe = ".exe" if os.name == "nt" else ""
    for frozen in (Path(__file__).resolve().parent / f"formpdf-engine{exe}", ROOT / f"formpdf-engine{exe}"):
        if frozen.is_file():
            return [str(frozen)], str(frozen.parent)
    backend = ROOT / "backend"
    for py in (backend / "venv" / "bin" / "python", backend / "venv" / "Scripts" / "python.exe"):
        if py.is_file():
            return [str(py), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port())], str(backend)
    return None


def start_engine() -> bool:
    if STATE["started"] or os.environ.get("FORMPDF_MCP_AUTOSTART", "1") == "0":
        return False
    STATE["started"] = True
    cmd = engine_command()
    if cmd is None:
        say("no engine found: run ./formpdf install in the formpdf folder")
        return False
    env = dict(os.environ)
    env.setdefault("FORMPDF_PORT", str(port()))
    dist = ROOT / "frontend" / "dist"
    if (dist / "index.html").is_file():
        env.setdefault("FORMPDF_DIST", str(dist))
    log = open(Path(tempfile.gettempdir()) / "formpdf-engine.log", "ab")
    say(f"starting the engine on port {port()}; log: {log.name}")
    kw = {"creationflags": 0x00000008 | 0x00000200} if os.name == "nt" else {"start_new_session": True}
    subprocess.Popen(cmd[0], cwd=cmd[1], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, **kw)
    deadline = time.time() + 20
    while time.time() < deadline:
        time.sleep(0.4)
        if alive(1):
            return True
    return False


def post(line: str, msg: dict) -> tuple[str, dict]:
    version = ((msg.get("params") or {}).get("_meta") or {}).get("io.modelcontextprotocol/protocolVersion") or STATE["version"] or (msg.get("params") or {}).get("protocolVersion") or "2025-11-25"
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": version}
    if STATE["session"] and msg.get("method") != "initialize":
        headers["Mcp-Session-Id"] = STATE["session"]
    req = urllib.request.Request(base() + "/mcp", data=line.encode("utf-8"), method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return r.read().decode("utf-8"), dict(r.headers)
    except urllib.error.HTTPError as exc:
        return exc.read().decode("utf-8", "replace"), dict(exc.headers or {})


def forward(line: str) -> str | None:
    try:
        msg = json.loads(line)
    except ValueError:
        return json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
    if not isinstance(msg, dict):
        return json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Batches are not supported"}})
    try:
        body, headers = post(line, msg)
    except (urllib.error.URLError, OSError) as exc:
        say(f"the engine is not answering at {base()}: {exc}")
        if not alive() and start_engine():
            return forward(line)
        if msg.get("id") is None:
            return None
        return json.dumps({"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32000, "message": "The formpdf engine is not running and could not be started: run ./formpdf in the formpdf folder (or open the formpdf app), then retry."}})
    sid = next((v for k, v in headers.items() if k.lower() == "mcp-session-id"), None)
    if sid:
        STATE["session"] = sid
    if msg.get("method") == "initialize":
        try:
            STATE["version"] = json.loads(body)["result"]["protocolVersion"]
        except (ValueError, KeyError, TypeError):
            pass
    if msg.get("id") is None:
        return None
    return body.strip() or None


def main() -> None:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        if not line.strip():
            continue
        out = forward(line.strip())
        if out:
            sys.stdout.write(out.replace("\n", " ") + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
