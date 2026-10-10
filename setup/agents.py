#!/usr/bin/env python3
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILLS = ["formpdf-harness", "formpdf-skillset"]
PORT = int(os.environ.get("FORMPDF_PORT") or 8198)
PY = "python" if os.name == "nt" else "python3"
USAGE = """usage: ./formpdf agents install [--dry-run]   set up Claude Code, Codex and Cursor here and in the folder you ran it from
       ./formpdf agents sync [--check]       copy the formpdf skills again (and mirror .claude/skills to .agents/skills)"""


def home() -> Path:
    return Path(os.environ.get("HOME") or Path.home())


def caller() -> Path:
    raw = os.environ.get("FORMPDF_CALLER_DIR")
    return Path(raw).resolve() if raw else ROOT


def entries(portable: bool) -> dict:
    script = "${CLAUDE_PROJECT_DIR:-.}/setup/mcp_stdio.py" if portable else str(ROOT / "setup" / "mcp_stdio.py")
    cursor = "${workspaceFolder}/setup/mcp_stdio.py" if portable else str(ROOT / "setup" / "mcp_stdio.py")
    if portable:
        codex = 'command = "sh"\nargs = ["-c", "exec python3 \\"$(git rev-parse --show-toplevel 2>/dev/null || pwd)/setup/mcp_stdio.py\\""]\n'
    else:
        codex = f"command = {json.dumps(PY)}\nargs = [{json.dumps(str(ROOT / 'setup' / 'mcp_stdio.py'))}]\n"
    return {
        "claude": {"formpdf": {"type": "http", "url": f"http://127.0.0.1:{PORT}/mcp"}, "formpdf-stdio": {"type": "stdio", "command": PY, "args": [script]}},
        "codex": "[mcp_servers.formpdf]\n" + codex + "startup_timeout_sec = 30\ntool_timeout_sec = 300\n",
        "cursor": {"formpdf": {"command": PY, "args": [cursor]}},
    }


def _backup(path: Path, dry: bool) -> None:
    if path.exists() and not dry:
        shutil.copy2(path, path.with_name(path.name + time.strftime(".bak-%Y%m%d-%H%M%S")))


def _write(path: Path, text: str, dry: bool, said: list) -> None:
    old = path.read_text(encoding="utf-8") if path.exists() else None
    if old == text:
        said.append(f"  {path} already set")
        return
    said.append(f"  {'update' if old is not None else 'write'} {path}")
    if dry:
        return
    _backup(path, dry)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def merge_json(path: Path, servers: dict, dry: bool, said: list) -> None:
    data: dict = {}
    if path.exists() and path.read_text(encoding="utf-8").strip():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            said.append(f"  {path} is not valid JSON; left as it is. Add under mcpServers: {json.dumps(servers)}")
            return
    if not isinstance(data, dict):
        said.append(f"  {path} is not a JSON object; left as it is")
        return
    have = data.get("mcpServers") if isinstance(data.get("mcpServers"), dict) else {}
    data["mcpServers"] = {**have, **servers}
    _write(path, json.dumps(data, indent=2) + "\n", dry, said)


def merge_toml(path: Path, block: str, dry: bool, said: list) -> None:
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    found = re.search(r"(?ms)^\[mcp_servers\.formpdf\]\s*\n.*?(?=^\[|\Z)", text)
    if found:
        new = text[:found.start()] + block + ("\n" if text[found.end():].strip() else "") + text[found.end():]
    else:
        new = (text.rstrip("\n") + "\n\n" if text.strip() else "") + block
    _write(path, new, dry, said)


def configure(folder: Path, portable: bool, dry: bool, said: list) -> None:
    e = entries(portable)
    said.append(f"{folder}:")
    merge_json(folder / ".mcp.json", e["claude"], dry, said)
    merge_toml(folder / ".codex" / "config.toml", e["codex"], dry, said)
    merge_json(folder / ".cursor" / "mcp.json", e["cursor"], dry, said)


def _files(folder: Path) -> dict:
    return {str(p.relative_to(folder)): p.read_bytes() for p in sorted(folder.rglob("*")) if p.is_file()} if folder.is_dir() else {}


def copy_skill(src: Path, to: Path, dry: bool, said: list) -> bool:
    if to.resolve() == src.resolve():
        return False
    if _files(to) == _files(src):
        said.append(f"  {to} already current")
        return False
    said.append(f"  skill -> {to}")
    if not dry:
        shutil.rmtree(to, ignore_errors=True)
        to.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, to)
    return True


def skills(dry: bool, said: list) -> int:
    targets = [home() / ".claude" / "skills", home() / ".agents" / "skills", ROOT / ".agents" / "skills"]
    if caller() != ROOT:
        targets += [caller() / ".claude" / "skills", caller() / ".agents" / "skills"]
    said.append("Skills:")
    changed = 0
    for name in SKILLS:
        src = ROOT / ".claude" / "skills" / name
        if not (src / "SKILL.md").is_file():
            said.append(f"  {name} is not in {src.parent} yet; skipped")
            continue
        for t in targets:
            changed += copy_skill(src, t / name, dry, said)
    return changed


def install(dry: bool) -> int:
    said: list = []
    configure(ROOT, True, dry, said)
    if caller() != ROOT:
        configure(caller(), False, dry, said)
    skills(dry, said)
    print(("Would do (dry run):\n" if dry else "") + "\n".join(said))
    if not dry:
        where = caller()
        print(f"""
Next:
  1. Start formpdf: ./formpdf (the window at http://localhost:5198; the engine at http://127.0.0.1:{PORT}).
  2. Open Claude Code, Codex or Cursor in {where} and approve the formpdf MCP server
     (Claude Code: /mcp; the formpdf-stdio entry starts the engine itself when it is not running).
  3. Ask: "Use formpdf: add page numbers and a CONFIDENTIAL watermark to ./report.pdf". The first change asks you once, in the formpdf window, to allow agents.""")
    return 0


def sync(check: bool) -> int:
    said: list = []
    n = skills(check, said)
    print("\n".join(said))
    if check:
        print("agents: in step" if n == 0 else "agents: skills drifted (run ./formpdf agents sync)")
        return 1 if n else 0
    print(f"agents: {n} skill cop{'ies' if n != 1 else 'y'} updated")
    return 0


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "install"
    rest = argv[1:]
    if cmd == "install":
        return install("--dry-run" in rest)
    if cmd == "sync":
        return sync("--check" in rest)
    print(USAGE)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
